import assert from 'node:assert/strict'
import { mkdtemp, readFile, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { beforeEach, test } from 'node:test'
import vm from 'node:vm'
import { Flow } from '../lib/engine.js'
import { _resetInstanceGuard, apply, inject, name } from '../lib/index.js'
import { previewKind, Projects } from '../lib/projects.js'
import { createHandlers } from '../lib/routes.js'
import { launchKit, TARGETS } from '../scenes/launch-kit.js'
import { sceneCatalog } from '../scenes/index.js'

const tempDir = () => mkdtemp(join(tmpdir(), 'dsh-cli-flow-panel-'))
const makeEnv = async () => ({ HOME: await tempDir(), DSH_HOME: await tempDir(), PATH: process.env.PATH })

/** 一个小场景：a 比稿，b 依赖 a，c 可换家 */
function miniScene(hooks = {}) {
  return {
    id: 'mini',
    title: '小场景',
    description: 'd',
    defaultInput: '默认输入',
    build: (input) => ({
      id: 'mini',
      title: '小场景',
      input,
      labels: { x: '家 X', y: '家 Y', z: '家 Z' },
      nodes: [
        {
          id: 'a',
          title: '比稿',
          compare: true,
          candidates: ['x', 'y', 'z'],
          defaultCompare: ['x', 'y'],
          show: /\.md$/,
          async run(ctx) {
            await hooks.a?.(ctx)
            await ctx.write('out.md', `${ctx.target}:${ctx.brief}`)
            await ctx.write('secret.py', 'x')
          },
        },
        {
          id: 'b',
          title: '下游',
          needs: ['a'],
          candidates: ['x', 'y'],
          show: /\.md$/,
          async run(ctx) {
            await hooks.b?.(ctx)
            await ctx.write('out.md', `${ctx.target}<${await ctx.read('a', 'out.md')}`)
          },
        },
      ],
    }),
  }
}

async function setup(hooks) {
  const env = await makeEnv()
  const projects = new Projects({ env, scenes: [miniScene(hooks)], invoke: async () => ({}) })
  const { id } = await projects.create({ scene: 'mini', input: '做一件事' })
  return { env, projects, id }
}

const statusOf = (state, node) => state.nodes.find((n) => n.id === node).status

beforeEach(() => _resetInstanceGuard())

// —— 引擎：等人选 ——

test('等人选：比稿做完停下，下游不跑，选了才继续', async () => {
  const { projects, id } = await setup()
  await projects.start(id)
  await projects.settled(id)
  let state = await projects.state(id)
  assert.equal(state.phase, 'waiting')
  assert.equal(statusOf(state, 'a'), 'waiting')
  assert.equal(statusOf(state, 'b'), 'pending')
  assert.deepEqual(state.nodes[0].awaiting, [1, 2])

  await projects.choose(id, 'a', 2)
  await projects.settled(id)
  state = await projects.state(id)
  assert.equal(state.phase, 'done')
  assert.equal(state.nodes[0].target, 'y')
  const { bytes } = await projects.fileContent(id, 'b', 1, 'out.md')
  assert.equal(bytes.toString(), 'x<y:做一件事')
})

test('等人选：选了不存在或失败的版本会报错，状态不变', async () => {
  const { projects, id } = await setup({ a: (ctx) => { if (ctx.target === 'y') throw new Error('坏了') } })
  await projects.start(id)
  await projects.settled(id)
  // 只有一家成功时不用选，直接继续
  const state = await projects.state(id)
  assert.equal(state.phase, 'done')
  assert.equal(state.nodes[0].target, 'x')
  await assert.rejects(projects.choose(id, 'a', 2), /没有可用的版本/)
  await assert.rejects(projects.choose(id, 'a', 99), /没有可用的版本/)
})

test('比稿：开始前可以改让谁做；只留一家就不比', async () => {
  const { projects, id } = await setup()
  await projects.setCandidates(id, 'a', { compareWith: ['y', 'z'] })
  assert.deepEqual((await projects.state(id)).nodes[0].compareSet, ['y', 'z'])
  await projects.start(id)
  await projects.settled(id)
  assert.deepEqual((await projects.state(id)).nodes[0].history.map((v) => v.target), ['y', 'z'])

  const second = await setup()
  await second.projects.setCandidates(second.id, 'a', { compareWith: ['z'] })
  await second.projects.start(second.id)
  await second.projects.settled(second.id)
  const state = await second.projects.state(second.id)
  assert.equal(state.phase, 'done')
  assert.equal(state.nodes[0].target, 'z')
  assert.equal(state.nodes[0].versions, 1)
})

test('候选：只能选场景列出的', async () => {
  const { projects, id } = await setup()
  await assert.rejects(projects.setCandidates(id, 'a', { compareWith: ['evil'] }), /没有候选/)
  await assert.rejects(projects.setCandidates(id, 'b', { pick: 'evil' }), /没有候选/)
  await assert.rejects(projects.setCandidates(id, 'nope', { pick: 'x' }), /没有这个节点/)
})

// —— 换家、回退 ——

test('换家重做：新版本生效，下游跟着重跑；可以选回旧版本', async () => {
  const { projects, id } = await setup()
  await projects.start(id)
  await projects.settled(id)
  await projects.choose(id, 'a', 1)
  await projects.settled(id)

  await projects.redo(id, 'b', 'y')
  await projects.settled(id)
  let state = await projects.state(id)
  assert.equal(state.nodes[1].target, 'y')
  assert.equal(state.nodes[1].versions, 2)

  await projects.useVersion(id, 'b', 1)
  await projects.settled(id)
  state = await projects.state(id)
  assert.equal(state.nodes[1].current, 1)
  assert.equal(state.phase, 'done')

  // 上游换家，下游重跑
  await projects.redo(id, 'a', 'z')
  await projects.settled(id)
  state = await projects.state(id)
  assert.equal(state.nodes[0].target, 'z')
  assert.equal(state.nodes[1].versions, 3)
  assert.match((await projects.fileContent(id, 'b', 3, 'out.md')).bytes.toString(), /z:/)
})

test('比稿节点重做时只跑指定那一家', async () => {
  const { projects, id } = await setup()
  await projects.start(id)
  await projects.settled(id)
  await projects.choose(id, 'a', 1)
  await projects.settled(id)
  await projects.redo(id, 'a', 'y')
  await projects.settled(id)
  const state = await projects.state(id)
  assert.equal(state.nodes[0].versions, 3)
  assert.equal(state.phase, 'done', '不再等选')
})

// —— 运行 ——

test('停止：终止正在跑的工具，再开始接着做', async () => {
  let release
  const gate = new Promise((resolve) => { release = resolve })
  let calls = 0
  const { projects, id } = await setup({
    b: async (ctx) => {
      calls += 1
      if (calls === 1) {
        // 模拟真实工具：收到取消信号才退出
        await new Promise((resolve, reject) => {
          gate.then(resolve)
          ctx.signalForTest?.addEventListener('abort', () => reject(new Error('已取消')))
        })
        throw new Error('已取消')
      }
    },
  })
  await projects.setCandidates(id, 'a', { compareWith: ['x'] })
  await projects.start(id)
  for (let i = 0; i < 50 && calls === 0; i += 1) await new Promise((r) => setTimeout(r, 10))
  assert.equal((await projects.state(id)).phase, 'running')
  assert.equal(statusOf(await projects.state(id), 'b'), 'running')
  const stopping = projects.stop(id)
  release()
  await stopping
  let state = await projects.state(id)
  assert.equal(state.phase, 'paused')
  assert.equal(state.nodes[0].versions, 1)
  await projects.start(id)
  await projects.settled(id)
  state = await projects.state(id)
  assert.equal(state.phase, 'done')
  assert.equal(state.nodes[0].versions, 1, '做完的不重做')
})

test('重复开始不会开两份', async () => {
  let runs = 0
  const { projects, id } = await setup({ a: async () => { runs += 1; await new Promise((r) => setTimeout(r, 30)) } })
  await projects.setCandidates(id, 'a', { compareWith: ['x'] })
  await projects.start(id)
  await projects.start(id)
  await projects.settled(id)
  assert.equal(runs, 1)
})

test('DSH 重启：工程还在，做完的不用重做，等选的还在等', async () => {
  const { env, projects, id } = await setup()
  await projects.start(id)
  await projects.settled(id)
  const again = new Projects({ env, scenes: [miniScene()], invoke: async () => ({}) })
  assert.deepEqual((await again.list()).map((p) => [p.id, p.phase]), [[id, 'waiting']])
  await again.choose(id, 'a', 1)
  await again.settled(id)
  assert.equal((await again.state(id)).phase, 'done')
})

// —— 产物 ——

test('产物：只列场景声明要展示的，中间文件不列；不能走出目录', async () => {
  const { projects, id } = await setup()
  await projects.start(id)
  await projects.settled(id)
  assert.deepEqual(await projects.files(id, 'a', 1), [{ name: 'out.md', kind: 'text' }])
  for (const name of ['secret.py', '../../meta.json', '../v2/out.md', '/etc/passwd']) {
    await assert.rejects(projects.fileContent(id, 'a', 1, name), /不能读这个文件/, name)
  }
  await assert.rejects(projects.files(id, 'nope', 1), /没有这个节点/)
  await assert.rejects(projects.files(id, 'a', 9), /没有版本/)
  await assert.rejects(projects.state('../../etc'), /不合法/)
})

test('预览类型', () => {
  assert.equal(previewKind('a.png'), 'image')
  assert.equal(previewKind('a.MP4'), 'video')
  assert.equal(previewKind('a.m4a'), 'audio')
  assert.equal(previewKind('a.md'), 'text')
  assert.equal(previewKind('a.py'), null)
  assert.equal(previewKind('a.aiff'), null, '浏览器放不了')
})

// —— 接口 ——

test('接口：走完创建、状态、读文件；操作不存在、格式错都有回应', async () => {
  const env = await makeEnv()
  const projects = new Projects({ env, scenes: [miniScene()], invoke: async () => ({}) })
  const { api, file } = createHandlers(projects)
  const call = async (body) => (await api(new Request('http://x/api', { method: 'POST', body: JSON.stringify(body) }))).json()
  assert.equal((await call({ action: 'scenes' })).scenes[0].defaultInput, '默认输入')
  const created = await call({ action: 'create', scene: 'mini', input: '内容' })
  const id = created.project.id
  assert.equal((await call({ action: 'create', scene: 'mini', input: '  ' })).ok, false)
  assert.equal((await call({ action: 'create', scene: 'nope', input: 'x' })).ok, false)
  assert.equal((await call({ action: 'state', id })).state.phase, 'ready')
  await call({ action: 'start', id })
  await projects.settled(id)
  assert.equal((await call({ action: 'state', id })).state.phase, 'waiting')
  assert.equal((await call({ action: 'projects' })).projects.length, 1)
  assert.deepEqual((await call({ action: 'files', id, node: 'a', v: 1 })).files, [{ name: 'out.md', kind: 'text' }])

  const res = await file(new Request('http://x', { method: 'POST', body: JSON.stringify({ id, node: 'a', v: 1, name: 'out.md' }) }))
  assert.equal(await res.text(), 'x:内容')
  assert.match(res.headers.get('content-type'), /markdown/)
  const denied = await file(new Request('http://x', { method: 'POST', body: JSON.stringify({ id, node: 'a', v: 1, name: '../../meta.json' }) }))
  assert.equal(denied.status, 404)

  assert.equal((await api(new Request('http://x', { method: 'POST', body: '{oops' }))).status, 400)
  assert.equal((await api(new Request('http://x', { method: 'POST', body: JSON.stringify({ action: 'constructor' }) }))).status, 404)
})

// —— 场景 ——

test('发布包场景：都声明了展示内容，比稿默认不勾本地模型，工具都注册了', () => {
  const kit = launchKit('x')
  const points = kit.nodes.find((n) => n.id === 'points')
  assert.ok(!points.defaultCompare.includes('lmstudio-local'))
  assert.ok(points.candidates.includes('lmstudio-local'))
  for (const node of kit.nodes) assert.ok(node.show, `${node.id} 没声明 show`)
  assert.ok(kit.nodes.some((n) => n.deliverable))
  const pseudo = new Set(['local', 'blender', 'chrome', 'ffmpeg', 'say-tingting', 'say-meijia'])
  for (const node of kit.nodes) {
    for (const target of node.candidates ?? []) assert.ok(TARGETS[target] || pseudo.has(target), `${target} 没注册`)
    for (const target of node.candidates ?? []) assert.ok(kit.labels[target], `${target} 没有显示名`)
  }
  const scene = sceneCatalog.find((s) => s.id === 'launch-kit')
  assert.equal(scene.build, launchKit)
  assert.ok(scene.defaultInput)
})

test('语音节点产出浏览器能放的格式', async () => {
  const voice = launchKit('x').nodes.find((n) => n.id === 'voice')
  assert.ok(voice.show.test('voice-0.m4a'))
  assert.ok(!voice.show.test('voice-0.aiff'))
})

// —— 插件 ——

test('插件：只给模型加一个工具，注册接口和 skill；同进程第二份让路', async () => {
  const env = await makeEnv()
  const routes = []
  const tools = []
  const skills = []
  const ctx = {
    effect: () => {},
    tools: { register: (def) => { tools.push(def.name); return () => {} } },
    inject(names, fn) {
      if (names[0] === 'skills') return fn({ skills: { register: (def) => { skills.push(def.name) } } })
      assert.deepEqual(names, ['connection'])
      return fn({ connection: { fetch: { register: (def) => { routes.push(def.path); return () => {} } } }, effect: () => {} })
    },
    logger: { warn() {} },
  }
  assert.equal(name, 'dsh-cli-flow')
  assert.deepEqual(inject, ['tools'])
  apply(ctx, { env })
  assert.deepEqual(routes, ['/api/dsh-cli-flow', '/api/dsh-cli-flow.file'])
  apply(ctx, { env })
  assert.equal(routes.length, 2)
  await new Promise((resolve) => setTimeout(resolve, 50))
  assert.deepEqual(tools, ['cli_flow'])
  assert.deepEqual(skills, ['dsh-cli-flow'])
})

// —— 界面 ——

async function loadClient() {
  const source = await readFile(new URL('../lib/client.js', import.meta.url), 'utf8')
  let loaded
  const window = { __ModuleLoader__: { load: (def) => { loaded = def } } }
  vm.runInNewContext(source, { window, console, document: {} })
  const React = { useCallback: () => {}, useEffect: () => {}, useRef: () => ({}), useState: () => [], createElement: () => null }
  return { id: loaded.id, client: loaded.factory(() => React) }
}

test('界面：能加载，注册右侧栏和顶部入口；注册失败不影响', async () => {
  const { id, client } = await loadClient()
  assert.equal(id, 'dsh-cli-flow')
  const slots = []
  client.apply({ slots: { inject: (slot, fn) => { fn(); slots.push(slot) }, register: () => () => {} } })
  assert.deepEqual(slots, ['conversation.session.header.actions'])
  assert.doesNotThrow(() => client.apply({ slots: { inject: () => { throw new Error('boom') } } }))
})

test('界面：进度、焦点节点、要展示的版本', async () => {
  const { progress, attentionNodes, phaseText, versionsToShow, prettyText, isBusy } = (await loadClient()).client.__test
  const copy = (x) => JSON.parse(JSON.stringify(x))
  assert.deepEqual(copy(progress([{ status: 'done' }, { status: 'pending' }])), { done: 1, total: 2, percent: 50 })
  assert.equal(progress([]).percent, 0)
  const nodes = [{ id: 'a', status: 'failed' }, { id: 'b', status: 'waiting' }, { id: 'c', status: 'waiting' }, { id: 'd', status: 'done' }]
  assert.deepEqual(copy(attentionNodes(nodes)).map((n) => n.id), ['b', 'c', 'a'], '等选的优先，全部都要展开')
  assert.equal(attentionNodes([{ id: 'd', status: 'done' }]).length, 0)
  assert.equal(phaseText('waiting', nodes), '还有 2 步等你选')
  assert.equal(phaseText('running-waiting', nodes), '运行中，还有 2 步等你选')
  assert.equal(phaseText('waiting', [{ status: 'waiting' }]), '等你选')
  assert.equal(phaseText('done', []), '全部完成')
  const history = [{ v: 1, status: 'failed' }, { v: 2, status: 'ok' }, { v: 3, status: 'ok' }]
  assert.deepEqual(copy(versionsToShow({ status: 'waiting', awaiting: [2, 3], history })).map((v) => v.v), [2, 3], '等选时只看这次比稿的')
  assert.deepEqual(copy(versionsToShow({ status: 'done', history })).map((v) => v.v), [3, 2, 1], '平时最新的在前')
  assert.equal(prettyText('a.md', '原文'), '原文')
  assert.match(prettyText('script.json', JSON.stringify({ title: 'T', scenes: [{ heading: 'H', narration: 'N' }] })), /T\n\n1\. H\nN/)
  assert.equal(prettyText('x.json', '{oops'), '{oops')
  assert.equal(isBusy('running-waiting'), true)
  assert.equal(isBusy('waiting'), false)
})

test('引擎：interactive 模式下 Flow 也能直接用', async () => {
  const dir = await tempDir()
  await writeFile(join(dir, 'x'), '')
  const flow = await new Flow({ scene: miniScene().build('i'), dir, choose: null, invoke: async () => ({}) }).load()
  const result = await flow.run()
  assert.equal(result.complete, false)
  assert.deepEqual(result.waiting, ['a'])
})

test('卡片操作：跑的时候不能动，有结果才能导出，要工具的不能只做到这一步', async () => {
  const { client } = await loadClient()
  const { cardActions, aiDraft, attentionNodes, progress } = client.__test
  const text = { id: 'a', title: '甲', status: 'pending', editable: true, produces: { file: 'a.md', kind: 'text' } }
  assert.equal(cardActions(text, 'ready').runTo, true)
  assert.equal(cardActions(text, 'ready').export, false)
  assert.equal(cardActions(text, 'ready').fillText, true)
  assert.equal(cardActions(text, 'running').runTo, false)
  assert.equal(cardActions(text, 'running').fill, false)
  const done = { ...text, status: 'done', current: 1 }
  assert.equal(cardActions(done, 'paused').export, true)
  assert.equal(cardActions(done, 'running').export, true)
  assert.equal(cardActions(done, 'paused').runTo, false)
  const external = { id: 'img', title: '出图', status: 'needs-input', external: true, editable: false, produces: { kind: '文件' } }
  assert.equal(cardActions(external, 'needs-input').runTo, false)
  assert.equal(cardActions(external, 'needs-input').fillText, false)
  assert.equal(cardActions(external, 'needs-input').fill, true)
  assert.deepEqual([...attentionNodes([text, external]).map((n) => n.id)], ['img'])
  assert.deepEqual({ ...progress([{ status: 'skipped' }, { status: 'done' }]) }, { done: 1, total: 1, percent: 100 })
  const state = { id: 'p1', title: '工程' }
  assert.match(aiDraft(state, external), /cli_run/)
  assert.match(aiDraft(state, external), /等我同意/)
  assert.match(aiDraft(state, done), /我同意后/)
  assert.match(aiDraft(state, null), /p1/)
})
