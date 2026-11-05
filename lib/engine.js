// lib/engine.js — 流程引擎
//
// 流程怎么走、产物怎么传，都由这里的代码决定，不靠大模型一步步想，所以引擎本身不花 token。
//
//   场景  一组节点和它们的依赖
//   节点  要什么能力、候选工具有谁、怎么做、怎么算合格
//   版本  节点每做一次是一个版本，存在 nodes/<节点>/v<N>/，current 指向现在用的那个
//
// 支持的事：
//   并行      依赖满足的节点同时跑
//   比稿      compare 节点让所有候选都做，由 choose 选一个
//   换家      一家失败或不合格，自动换下一个候选
//   重做      redo 指定换哪家重做，只有下游会跟着重跑
//   断点续跑  状态存盘，进程死了再跑一次，做完的不重做
//   等人选    choose 传 null 时，比稿做完就停在那里，等 chooseVersion
//   停止      stop 终止正在跑的工具，再 run 接着做
//   卡片独立  每个节点都是单独的功能：只跑到某一步（run until）、手动填入内容（fill）、
//             从任意节点进入（上游没做时填入它的产物就行）、随时导出（exportNode）

import { appendFile, copyFile, mkdir, readdir, readFile, rename, stat, writeFile } from 'node:fs/promises'
import { basename, join } from 'node:path'

export class Flow {
  constructor({ scene, dir, invoke, choose, concurrency = 3, onEvent }) {
    this.scene = scene
    this.dir = dir
    this.invoke = invoke
    // null 表示由人来选：比稿节点做完后停下等 chooseVersion
    this.choose = choose === null ? null : (choose ?? (async (_node, versions) => versions[0].v))
    this.active = new Set()
    this.stopRequested = false
    this.abort = null
    this.concurrency = concurrency
    this.onEvent = onEvent ?? (() => {})
    this.nodes = new Map(scene.nodes.map((n) => [n.id, n]))
    for (const node of scene.nodes) {
      for (const need of node.needs ?? []) {
        if (!this.nodes.has(need)) throw new Error(`节点 ${node.id} 依赖不存在的节点 ${need}`)
      }
    }
    this.state = null
  }

  get statePath() {
    return join(this.dir, 'project.json')
  }

  async load() {
    await mkdir(this.dir, { recursive: true })
    try {
      this.state = JSON.parse(await readFile(this.statePath, 'utf8'))
    } catch (error) {
      if (error.code !== 'ENOENT') throw error
      this.state = { scene: this.scene.id, nodes: {} }
    }
    for (const node of this.scene.nodes) {
      this.state.nodes[node.id] ??= { pick: null, compareWith: null, waiting: false, error: null, dirty: false, current: null, versions: [] }
      // 上次进程死的时候还在跑的，算失败
      for (const version of this.state.nodes[node.id].versions) {
        if (version.status === 'running') {
          version.status = 'failed'
          version.error = '进程中断'
        }
      }
    }
    await this.save()
    return this
  }

  /** 并行节点会同时存盘，排队写，否则临时文件互相覆盖 */
  save() {
    const write = async () => {
      const tmp = `${this.statePath}.${process.pid}.tmp`
      await writeFile(tmp, JSON.stringify(this.state, null, 2))
      await rename(tmp, this.statePath)
    }
    this.saving = (this.saving ?? Promise.resolve()).then(write, write)
    return this.saving
  }

  async emit(event) {
    const line = { at: new Date().toISOString(), ...event }
    this.onEvent(line)
    await appendFile(join(this.dir, 'events.jsonl'), `${JSON.stringify(line)}\n`)
  }

  entry(id) {
    return this.state.nodes[id]
  }

  currentVersion(id) {
    const entry = this.entry(id)
    return entry.versions.find((v) => v.v === entry.current) ?? null
  }

  inputsOf(node) {
    return Object.fromEntries((node.needs ?? []).map((id) => [id, this.entry(id).current]))
  }

  /** 做完了，而且用的还是上游现在的版本 */
  isFresh(node) {
    const entry = this.entry(node.id)
    const current = this.currentVersion(node.id)
    if (!current || entry.dirty || entry.waiting) return false
    // 手动填入的内容不依赖上游：从任意节点进入时，上游根本没做过
    if (current.manual) return true
    return JSON.stringify(current.inputs) === JSON.stringify(this.inputsOf(node))
  }

  versionDir(id, v) {
    return join(this.dir, 'nodes', id, `v${v}`)
  }

  /** 给节点用的上下文：读上游产物、调工具 */
  context(node, dir, target, usage) {
    const flow = this
    const allowed = new Set(node.needs ?? [])
    const inputDir = (id) => {
      if (!allowed.has(id)) throw new Error(`节点 ${node.id} 没有声明依赖 ${id}`)
      return flow.versionDir(id, flow.entry(id).current)
    }
    return {
      dir,
      target,
      needs: node.needs ?? [],
      brief: this.scene.input,
      note: this.entry(node.id).note ?? '',
      promptOverride: this.entry(node.id).prompt ?? null,
      /** 读上游卡片的主要产物。节点用 produces 声明 */
      upstream: async (id) => {
        const file = flow.nodes.get(id)?.produces?.file
        // 一批文件（比如填入的图片）没有主要产物，下游拿到的是文件清单
        if (!file) return (await readdir(inputDir(id))).map((name) => join(inputDir(id), name)).join('\n')
        return readFile(join(inputDir(id), file), 'utf8')
      },
      inputDir,
      read: (id, file) => readFile(join(inputDir(id), file), 'utf8'),
      readJson: async (id, file) => JSON.parse(await readFile(join(inputDir(id), file), 'utf8')),
      write: (file, content) => writeFile(join(dir, file), content),
      invoke: async (tool, request) => {
        const result = await flow.invoke(tool, { ...request, signal: flow.abort?.signal })
        if (result?.usage) usage.push({ tool, ...result.usage })
        return result
      },
    }
  }

  /** 让一个候选做一次，产生一个版本。失败返回 null，不抛错 */
  async attempt(node, target) {
    const entry = this.entry(node.id)
    const v = entry.versions.length + 1
    const version = { v, target, inputs: this.inputsOf(node), status: 'running', startedAt: Date.now() }
    entry.versions.push(version)
    const dir = this.versionDir(node.id, v)
    await mkdir(dir, { recursive: true })
    await this.save()
    await this.emit({ type: 'attempt', node: node.id, v, target })
    const usage = []
    const ctx = this.context(node, dir, target, usage)
    try {
      await node.run(ctx)
      if (node.validate) await node.validate(ctx)
      version.status = 'ok'
      await this.emit({ type: 'ok', node: node.id, v, target, ms: Date.now() - version.startedAt })
      return version
    } catch (error) {
      version.status = 'failed'
      version.error = this.stopRequested ? '已停止' : String(error.message ?? error).slice(0, 400)
      await this.emit({ type: 'failed', node: node.id, v, target, error: version.error })
      return null
    } finally {
      version.ms = Date.now() - version.startedAt
      if (usage.length) version.usage = usage
      await this.save()
    }
  }

  /** 这个节点比稿时让哪几家做 */
  compareSet(node) {
    const entry = this.entry(node.id)
    return entry.compareWith ?? node.defaultCompare ?? node.candidates ?? ['local']
  }

  async runNode(node) {
    const entry = this.entry(node.id)
    entry.error = null
    // 还没接工具的卡片：停下等人或 dsh 的 AI 填入，不算失败
    if (node.external) {
      entry.waiting = true
      entry.awaiting = null
      await this.save()
      await this.emit({ type: 'needs-input', node: node.id })
      return
    }
    const candidates = [...new Set([...(entry.pick ? [entry.pick] : []), ...(node.candidates ?? ['local'])])]

    if (node.compare && !entry.pick && this.compareSet(node).length > 1) {
      const done = (await Promise.all(this.compareSet(node).map((t) => this.attempt(node, t)))).filter(Boolean)
      if (!done.length) throw new Error(`${node.title}：所有候选都失败了`)
      if (this.stopRequested) throw new Error('已停止')
      if (done.length > 1 && !this.choose) {
        entry.waiting = true
        entry.awaiting = done.map((d) => d.v)
        await this.save()
        await this.emit({ type: 'waiting', node: node.id, among: done.map((d) => d.target) })
        return
      }
      const chosen = done.length === 1 ? done[0].v : await this.choose(node, done, this)
      entry.current = chosen
      entry.dirty = false
      await this.emit({ type: 'chosen', node: node.id, v: chosen, target: done.find((d) => d.v === chosen)?.target, among: done.map((d) => d.target) })
      await this.save()
      return
    }

    const order = node.compare && !entry.pick ? this.compareSet(node) : candidates
    for (const [index, target] of order.entries()) {
      if (this.stopRequested) throw new Error('已停止')
      const version = await this.attempt(node, target)
      if (version) {
        entry.current = version.v
        entry.dirty = false
        await this.save()
        return
      }
      if (order[index + 1] && !this.stopRequested) await this.emit({ type: 'switch', node: node.id, from: target, to: order[index + 1] })
    }
    throw new Error(`${node.title}：所有候选都失败了`)
  }

  /** until 这一步和它还没做的上游。上游已经有效（比如手动填入）就不再往上走 */
  closureOf(id) {
    const wanted = new Set()
    const visit = (nodeId) => {
      if (wanted.has(nodeId)) return
      const node = this.nodes.get(nodeId)
      if (!node) throw new Error(`没有这个节点：${nodeId}`)
      wanted.add(nodeId)
      for (const need of node.needs ?? []) {
        if (!this.isFresh(this.nodes.get(need))) visit(need)
      }
    }
    visit(id)
    return wanted
  }

  /** 不用做的节点：下游都是手动填入的（或同样不用做）。从中间进入时，前面的卡片不会被拉起来跑 */
  skippedNodes() {
    const skipped = new Set()
    const cut = (node) => this.currentVersion(node.id)?.manual && !this.entry(node.id).dirty
    for (let changed = true; changed;) {
      changed = false
      for (const node of this.scene.nodes) {
        if (skipped.has(node.id) || this.isFresh(node)) continue
        const entry = this.entry(node.id)
        if (entry.error || entry.waiting || this.active.has(node.id)) continue
        const dependents = this.scene.nodes.filter((n) => n.needs?.includes(node.id))
        if (dependents.length && dependents.every((n) => cut(n) || skipped.has(n.id))) {
          skipped.add(node.id)
          changed = true
        }
      }
    }
    return skipped
  }

  /** 跑到所有能跑的都跑完。一个节点失败，只影响它的下游。until 表示做到这一步就停 */
  async run({ until } = {}) {
    if (!this.state) await this.load()
    const scope = until ? this.closureOf(until) : null
    const inScope = (node) => (scope ? scope.has(node.id) : !this.skippedNodes().has(node.id))
    this.stopRequested = false
    this.abort = new AbortController()
    const failed = new Set()
    const running = new Map()
    const ran = []
    for (;;) {
      const ready = this.stopRequested ? [] : this.scene.nodes.filter((node) =>
        !running.has(node.id)
        && inScope(node)
        && !failed.has(node.id)
        && !this.entry(node.id).waiting
        && !this.isFresh(node)
        && (node.needs ?? []).every((id) => this.isFresh(this.nodes.get(id))))
      for (const node of ready.slice(0, Math.max(0, this.concurrency - running.size))) {
        ran.push(node.id)
        this.active.add(node.id)
        const task = this.runNode(node)
          .catch(async (error) => {
            // 用户叫停不算失败：卡片回到没做的状态，下次接着做
            if (this.stopRequested) {
              await this.save()
              return
            }
            failed.add(node.id)
            this.entry(node.id).error = String(error.message ?? error).slice(0, 400)
            await this.save()
            await this.emit({ type: 'node-failed', node: node.id, error: error.message })
          })
          .finally(() => {
            running.delete(node.id)
            this.active.delete(node.id)
          })
        running.set(node.id, task)
      }
      if (!running.size) break
      await Promise.race(running.values())
    }
    const waiting = this.scene.nodes.filter((n) => this.entry(n.id).waiting).map((n) => n.id)
    const blocked = this.scene.nodes.filter((n) => inScope(n) && !this.isFresh(n) && !failed.has(n.id) && !waiting.includes(n.id)).map((n) => n.id)
    const stopped = this.stopRequested
    this.stopRequested = false
    await this.emit({ type: 'finished', ran, failed: [...failed], blocked, waiting, stopped, until })
    return { ran, failed: [...failed], blocked, waiting, stopped, until, complete: !failed.size && !blocked.length && !waiting.length }
  }

  /** 终止正在跑的工具。做完的留着，下次 run 接着做 */
  stop() {
    this.stopRequested = true
    this.abort?.abort()
  }

  /** 开始前或重做前改候选：pick 指定一家，compareWith 指定比稿的几家 */
  async setCandidates(id, { pick, compareWith } = {}) {
    if (!this.state) await this.load()
    const node = this.nodes.get(id)
    if (!node) throw new Error(`没有这个节点：${id}`)
    const known = new Set(node.candidates ?? ['local'])
    for (const target of [...(pick ? [pick] : []), ...(compareWith ?? [])]) {
      if (!known.has(target)) throw new Error(`${node.title} 没有候选 ${target}`)
    }
    if (pick !== undefined) this.entry(id).pick = pick
    if (compareWith !== undefined) this.entry(id).compareWith = compareWith?.length ? compareWith : null
    await this.save()
  }

  /** 比稿选中一个版本 */
  async chooseVersion(id, v) {
    await this.useVersion(id, v)
    const entry = this.entry(id)
    await this.emit({ type: 'chosen', node: id, v, target: this.currentVersion(id)?.target, among: (entry.awaiting ?? []).map((x) => entry.versions.find((y) => y.v === x)?.target) })
    entry.awaiting = null
    await this.save()
  }

  /** 换一家重做。下游因为上游版本变了，下次 run 会自动跟着重跑 */
  async redo(id, { target } = {}) {
    if (!this.state) await this.load()
    if (!this.nodes.has(id)) throw new Error(`没有这个节点：${id}`)
    const entry = this.entry(id)
    if (target) entry.pick = target
    entry.dirty = true
    entry.waiting = false
    entry.awaiting = null
    await this.save()
    await this.emit({ type: 'redo', node: id, target })
  }

  /**
   * 手动填入一个版本：人或 dsh 的 AI 自己写的内容，或者已有的文件。
   * text 写进这张卡片声明的产物；path 是本地文件或目录，复制过来。
   */
  async fill(id, { text, path, by = 'manual' } = {}) {
    if (!this.state) await this.load()
    const node = this.nodes.get(id)
    if (!node) throw new Error(`没有这个节点：${id}`)
    if (this.active.has(id)) throw new Error('这张卡片正在跑，等它结束或先停止')
    const entry = this.entry(id)
    const v = entry.versions.length + 1
    const dir = this.versionDir(id, v)
    await mkdir(dir, { recursive: true })
    if (typeof text === 'string' && text.trim()) {
      if (!node.produces?.file) throw new Error(`${node.title} 不能直接填文字，请给文件路径`)
      if (node.produces.kind && node.produces.kind !== 'text') throw new Error(`${node.title} 的产物是${node.produces.kind}，请给文件路径`)
      await writeFile(join(dir, node.produces.file), text)
    } else if (path) {
      const info = await stat(path).catch(() => null)
      if (!info) throw new Error(`找不到 ${path}`)
      if (info.isDirectory()) {
        for (const name of await readdir(path)) {
          if ((await stat(join(path, name))).isFile()) await copyFile(join(path, name), join(dir, name))
        }
      } else {
        await copyFile(path, join(dir, node.produces?.file ?? basename(path)))
      }
    } else {
      throw new Error('没有要填入的内容')
    }
    entry.versions.push({ v, target: by, manual: true, inputs: {}, status: 'ok', startedAt: Date.now(), ms: 0 })
    entry.current = v
    entry.dirty = false
    entry.waiting = false
    entry.awaiting = null
    entry.error = null
    await this.save()
    await this.emit({ type: 'filled', node: id, v, by })
    return v
  }

  /** 这张卡片的要求和提示词。AI 或人改了之后，下次做这张卡片才生效 */
  async editCard(id, { note, prompt } = {}) {
    if (!this.state) await this.load()
    if (!this.nodes.has(id)) throw new Error(`没有这个节点：${id}`)
    const entry = this.entry(id)
    if (note !== undefined) entry.note = String(note)
    if (prompt !== undefined) entry.prompt = prompt ? String(prompt) : null
    await this.save()
  }

  /** 把某张卡片的产物复制到 dir。没做过就报错 */
  async exportNode(id, dir, { v, filter } = {}) {
    if (!this.state) await this.load()
    const node = this.nodes.get(id)
    if (!node) throw new Error(`没有这个节点：${id}`)
    const version = v ?? this.entry(id).current
    if (!version) throw new Error(`${node.title} 还没有产物`)
    const source = this.versionDir(id, version)
    const manual = this.entry(id).versions.find((x) => x.v === version)?.manual
    const names = (await readdir(source)).filter((name) => (filter ?? (manual ? null : node.show) ?? /./).test(name))
    await mkdir(dir, { recursive: true })
    for (const name of names) {
      if ((await stat(join(source, name))).isFile()) await copyFile(join(source, name), join(dir, name))
    }
    return names
  }

  /** 选回某个已有的版本，不重做 */
  async useVersion(id, v) {
    if (!this.state) await this.load()
    const version = this.entry(id).versions.find((x) => x.v === v && x.status === 'ok')
    if (!version) throw new Error(`${id} 没有可用的版本 ${v}`)
    this.entry(id).current = v
    this.entry(id).dirty = false
    this.entry(id).waiting = false
    version.inputs = this.inputsOf(this.nodes.get(id))
    await this.save()
    await this.emit({ type: 'use-version', node: id, v })
  }

  /** pending 等待、running 在跑、waiting 等人选、done 完成、stale 上游变了要重跑、failed 失败、blocked 上游失败 */
  statusOf(node) {
    const entry = this.entry(node.id)
    if (this.active.has(node.id)) return 'running'
    if (entry.waiting) return node.external && !entry.awaiting?.length ? 'needs-input' : 'waiting'
    if (entry.error) return 'failed'
    if (this.isFresh(node)) return 'done'
    if (this.skippedNodes().has(node.id)) return 'skipped'
    const upstream = (node.needs ?? []).map((id) => this.statusOf(this.nodes.get(id)))
    if (upstream.some((s) => s === 'failed' || s === 'blocked')) return 'blocked'
    return entry.current ? 'stale' : 'pending'
  }

  /** 给界面和人看的总览 */
  summary() {
    return this.scene.nodes.map((node) => {
      const entry = this.entry(node.id)
      const current = this.currentVersion(node.id)
      return {
        id: node.id,
        title: node.title,
        status: this.statusOf(node),
        description: node.description ?? '',
        external: Boolean(node.external),
        produces: node.produces ?? null,
        editable: Boolean(node.promptTemplate),
        promptTemplate: node.promptTemplate ?? null,
        prompt: entry.prompt ?? null,
        note: entry.note ?? '',
        manual: Boolean(current?.manual),
        capability: node.capability ?? 'local',
        compare: Boolean(node.compare),
        candidates: node.candidates ?? ['local'],
        compareSet: node.compare ? this.compareSet(node) : null,
        pick: entry.pick,
        error: entry.error,
        needs: node.needs ?? [],
        awaiting: entry.awaiting ?? null,
        fresh: this.isFresh(node),
        target: current?.target ?? null,
        current: entry.current,
        versions: entry.versions.length,
        failed: entry.versions.filter((v) => v.status === 'failed').length,
        history: entry.versions.map(({ v, target, status, error, ms, usage, manual }) => ({ v, target, status, error, ms, usage, manual: Boolean(manual) })),
      }
    })
  }
}
