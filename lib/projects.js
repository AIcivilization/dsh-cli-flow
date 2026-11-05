// lib/projects.js — 工程管理：创建工程、后台运行、读产物
//
// 每个工程一个目录 $DSH_HOME/dsh-cli-flow/projects/<id>/，流程状态在 project.json。
// 流程在 DSH 进程里后台跑，界面只是来看状态和做选择。DSH 重启后，做完的不用重做。

import { randomBytes } from 'node:crypto'
import { mkdir, readdir, readFile, stat, writeFile } from 'node:fs/promises'
import { homedir } from 'node:os'
import { basename, extname, join } from 'node:path'
import { makeInvoke, registerTargets } from './bridge.js'
import { checkCardDefinition } from './cards.js'
import { Flow } from './engine.js'

const PROJECT_ID = /^[a-f0-9]{12}$/
const MAX_FILE_BYTES = 300 * 1024 * 1024

const MIME = {
  '.md': 'text/markdown; charset=utf-8',
  '.txt': 'text/plain; charset=utf-8',
  '.srt': 'text/plain; charset=utf-8',
  '.json': 'application/json; charset=utf-8',
  '.png': 'image/png',
  '.jpg': 'image/jpeg',
  '.jpeg': 'image/jpeg',
  '.webp': 'image/webp',
  '.mp4': 'video/mp4',
  '.m4a': 'audio/mp4',
  '.mp3': 'audio/mpeg',
  '.wav': 'audio/wav',
  '.html': 'text/html; charset=utf-8',
}

/** 界面按这个决定怎么预览 */
export function previewKind(file) {
  const mime = MIME[extname(file).toLowerCase()] ?? ''
  if (mime.startsWith('image/')) return 'image'
  if (mime.startsWith('video/')) return 'video'
  if (mime.startsWith('audio/')) return 'audio'
  if (mime.startsWith('text/html')) return 'file'
  return mime ? 'text' : null
}

export function dataRoot(env = process.env) {
  const dshHome = env.DSH_HOME?.trim() || join(env.HOME?.trim() || homedir(), '.dsh')
  return join(dshHome, 'dsh-cli-flow')
}

export class Projects {
  constructor({ env = process.env, scenes, invoke, onError, soloScene, customScene, cardLibrary = [] }) {
    this.env = env
    this.scenes = new Map(scenes.map((s) => [s.id, s]))
    this.soloScene = soloScene ?? (() => null)
    this.customScene = customScene ?? null
    this.cardLibrary = cardLibrary
    this.invoke = invoke ?? makeInvoke({ env })
    this.onError = onError ?? (() => {})
    this.flows = new Map()
    this.running = new Map()
    for (const scene of scenes) if (scene.targets) registerTargets(scene.targets)
  }

  get root() {
    return join(dataRoot(this.env), 'projects')
  }

  dirOf(id) {
    if (!PROJECT_ID.test(String(id))) throw new Error(`工程编号不合法：${id}`)
    return join(this.root, id)
  }

  listScenes() {
    return [...this.scenes.values()].map(({ id, title, description, placeholder, defaultInput, cardCount }) => ({ id, title, description, placeholder, defaultInput, cardCount }))
  }

  listCards() {
    const library = typeof this.cardLibrary === 'function' ? this.cardLibrary() : this.cardLibrary
    return library.map(({ id, title, description, flow }) => ({ id, title, description, flow }))
  }

  sceneOf(meta) {
    if (meta.customFlow && this.customScene) return this.customScene(meta.customFlow)
    return this.scenes.get(meta.scene) ?? (String(meta.scene).startsWith('card:') ? this.soloScene(meta.scene.slice(5)) : null)
  }

  async metaOf(id) {
    try {
      return JSON.parse(await readFile(join(this.dirOf(id), 'meta.json'), 'utf8'))
    } catch (error) {
      if (error.code === 'ENOENT') throw new Error(`没有这个工程：${id}`)
      throw error
    }
  }

  /** scene 是流程编号；card 是单独用一张卡片；flow 是现场拼的流程（{ title, cards }） */
  async create({ scene, card, flow, input, title }) {
    const text = String(input ?? '').trim()
    if (!text) throw new Error('请先写输入内容')
    let sceneId = scene
    let customFlow
    if (flow) {
      if (!Array.isArray(flow.cards) || !flow.cards.length) throw new Error('流程至少要有一张卡片')
      customFlow = { title: String(flow.title ?? '自定义流程'), description: flow.description, cards: flow.cards.map(checkCardDefinition) }
      this.customScene(customFlow).build(text)
      sceneId = 'custom'
    } else if (card) {
      sceneId = `card:${card}`
    }
    const meta0 = { scene: sceneId, customFlow }
    const def = this.sceneOf(meta0)
    if (!def) throw new Error(`没有这个流程或卡片：${scene ?? card}`)
    const id = randomBytes(6).toString('hex')
    await mkdir(this.dirOf(id), { recursive: true })
    const meta = { id, scene: sceneId, title: String(title ?? '').trim() || `${def.title}：${text.slice(0, 16)}`, input: text, createdAt: Date.now(), ...(customFlow ? { customFlow } : {}) }
    await writeFile(join(this.dirOf(id), 'meta.json'), JSON.stringify(meta, null, 2))
    await this.flowOf(id)
    return meta
  }

  async flowOf(id) {
    if (this.flows.has(id)) return this.flows.get(id)
    const meta = await this.metaOf(id)
    const def = this.sceneOf(meta)
    if (!def) throw new Error(`这个工程的流程 ${meta.scene} 已经不存在`)
    const flow = new Flow({ scene: def.build(meta.input, { customCards: meta.customCards ?? [] }), dir: this.dirOf(id), invoke: this.invoke, choose: null })
    await flow.load()
    this.flows.set(id, flow)
    return flow
  }

  isRunning(id) {
    return this.running.has(id)
  }

  /** 后台跑，马上返回。已经在跑就不重复开。until 表示做到这张卡片就停 */
  async start(id, { until } = {}) {
    const flow = await this.flowOf(id)
    if (this.running.has(id)) return
    if (until && !flow.nodes.has(until)) throw new Error(`没有这张卡片：${until}`)
    const task = flow.run({ until })
      .catch((error) => this.onError(`工程 ${id} 运行出错`, error))
      .finally(() => this.running.delete(id))
    this.running.set(id, task)
  }

  async stop(id) {
    const flow = await this.flowOf(id)
    flow.stop()
    await this.running.get(id)
  }

  /** 等当前这一轮跑完，测试和重做时用 */
  async settled(id) {
    await this.running.get(id)
  }

  async list() {
    let names = []
    try {
      names = await readdir(this.root)
    } catch (error) {
      if (error.code !== 'ENOENT') throw error
    }
    const rows = []
    for (const id of names.filter((n) => PROJECT_ID.test(n))) {
      try {
        const meta = await this.metaOf(id)
        const nodes = (await this.flowOf(id)).summary()
        rows.push({ id, title: meta.title, scene: meta.scene, createdAt: meta.createdAt, phase: this.phaseOf(id, nodes), done: nodes.filter((n) => n.status === 'done').length, total: nodes.filter((n) => n.status !== 'skipped').length })
      } catch (error) {
        this.onError(`读取工程 ${id} 失败`, error)
      }
    }
    return rows.sort((a, b) => b.createdAt - a.createdAt)
  }

  /** ready 还没开始、running 在跑、waiting 等你选、failed 有失败、done 全部完成、paused 其余 */
  phaseOf(id, nodes) {
    if (this.isRunning(id)) return nodes.some((n) => n.status === 'waiting') ? 'running-waiting' : 'running'
    if (nodes.some((n) => n.status === 'waiting')) return 'waiting'
    if (nodes.some((n) => n.status === 'failed')) return 'failed'
    if (nodes.some((n) => n.status === 'needs-input')) return 'needs-input'
    if (nodes.every((n) => n.status === 'done' || n.status === 'skipped')) return 'done'
    return nodes.every((n) => n.versions === 0) ? 'ready' : 'paused'
  }

  async state(id) {
    const meta = await this.metaOf(id)
    const flow = await this.flowOf(id)
    const nodes = flow.summary()
    const deliverable = flow.scene.nodes.find((n) => n.deliverable)
    const delivered = deliverable && flow.isFresh(deliverable)
      ? join(flow.versionDir(deliverable.id, flow.entry(deliverable.id).current), deliverable.deliverable)
      : null
    return { ...meta, labels: flow.scene.labels ?? {}, phase: this.phaseOf(id, nodes), nodes, delivered }
  }

  /** 手动填入：人或 dsh 的 AI 写的内容，或者已有的文件 */
  async fill(id, node, { text, path, by }) {
    const flow = await this.flowOf(id)
    await flow.fill(node, { text, path, by })
    return this.state(id)
  }

  async editCard(id, node, { note, prompt }) {
    const flow = await this.flowOf(id)
    await flow.editCard(node, { note, prompt })
    return this.state(id)
  }

  /** 给工程加一张卡片。流程在跑时不能改 */
  async addCard(id, card) {
    if (this.isRunning(id)) throw new Error('流程正在跑，先停止或等它结束')
    const meta = await this.metaOf(id)
    const clean = checkCardDefinition(card)
    const flow = await this.flowOf(id)
    if (flow.nodes.has(clean.id)) throw new Error(`已经有卡片 ${clean.id}`)
    const next = { ...meta, customCards: [...(meta.customCards ?? []), clean] }
    this.sceneOf(next).build(next.input, { customCards: next.customCards })
    await writeFile(join(this.dirOf(id), 'meta.json'), JSON.stringify(next, null, 2))
    this.flows.delete(id)
    return this.state(id)
  }

  /** 导出：card 不传就导出所有已完成的卡片。流程不用走完，随时可以导出 */
  async exportCards(id, { card } = {}) {
    const flow = await this.flowOf(id)
    const stamp = new Date().toISOString().replace(/[:.]/g, '-').slice(0, 19)
    const root = join(this.dirOf(id), 'exports', stamp)
    const nodes = card ? [flow.nodes.get(card)] : flow.scene.nodes.filter((n) => flow.entry(n.id).current)
    if (card && !nodes[0]) throw new Error(`没有这张卡片：${card}`)
    let count = 0
    for (const [index, node] of nodes.entries()) {
      const folder = card ? root : join(root, `${String(index + 1).padStart(2, '0')}-${node.title.replace(/[\\/:*?"<>|]/g, '')}`)
      count += (await flow.exportNode(node.id, folder)).length
    }
    if (!count) throw new Error(card ? '这张卡片还没有产物' : '还没有做完的卡片可以导出')
    return { path: root, count }
  }

  /** 改候选前先确认这个节点没在跑 */
  async setCandidates(id, node, options) {
    const flow = await this.flowOf(id)
    await flow.setCandidates(node, options)
    return this.state(id)
  }

  async choose(id, node, v) {
    const flow = await this.flowOf(id)
    await flow.chooseVersion(node, Number(v))
    await this.start(id)
    return this.state(id)
  }

  async redo(id, node, target) {
    const flow = await this.flowOf(id)
    if (flow.active.has(node)) throw new Error('这个节点正在跑，等它结束或先停止')
    await this.settled(id)
    await flow.redo(node, { target: target || undefined })
    await this.start(id)
    return this.state(id)
  }

  async useVersion(id, node, v) {
    const flow = await this.flowOf(id)
    await this.settled(id)
    await flow.useVersion(node, Number(v))
    await this.start(id)
    return this.state(id)
  }

  /** 某个版本能看的产物。只列场景声明要展示的，中间文件不列 */
  async files(id, nodeId, v) {
    const flow = await this.flowOf(id)
    const node = flow.nodes.get(nodeId)
    if (!node) throw new Error(`没有这个节点：${nodeId}`)
    const version = flow.entry(nodeId).versions.find((x) => x.v === Number(v))
    if (!version) throw new Error(`${nodeId} 没有版本 ${v}`)
    let names = []
    try {
      names = await readdir(flow.versionDir(nodeId, version.v))
    } catch {
      return []
    }
    const isManual = version.manual
    const shown = names.filter((name) => (isManual || !node.show || node.show.test(name)) && previewKind(name)).sort((a, b) => a.localeCompare(b, undefined, { numeric: true }))
    return shown.map((name) => ({ name, kind: previewKind(name) }))
  }

  /** 读产物。名字必须在 files 列出的范围内，不能走出目录 */
  async fileContent(id, nodeId, v, name) {
    const allowed = await this.files(id, nodeId, v)
    if (basename(String(name)) !== name || !allowed.some((f) => f.name === name)) throw new Error(`不能读这个文件：${name}`)
    const flow = await this.flowOf(id)
    const path = join(flow.versionDir(nodeId, Number(v)), name)
    const info = await stat(path)
    if (info.size > MAX_FILE_BYTES) throw new Error('文件太大，请到目录里打开')
    return { bytes: await readFile(path), mime: MIME[extname(name).toLowerCase()] ?? 'application/octet-stream' }
  }
}
