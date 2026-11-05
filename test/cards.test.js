// test/cards.test.js — 卡片：独立使用、从中间进入、只做到某步、导出，以及 AI 的操作
import assert from 'node:assert/strict'
import { existsSync } from 'node:fs'
import { mkdir, mkdtemp, readFile, readdir, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import test from 'node:test'
import { pathToFileURL } from 'node:url'
import { checkCardDefinition, compileFlow, deckHtml, renderPrompt, soloFlow } from '../lib/cards.js'
import { Projects } from '../lib/projects.js'
import { buildToolDefinitions, makeActions } from '../lib/tools.js'
import { rawTool } from 'dsh-cli/tools'
import { registerCardPack } from '../lib/packs.js'
import { allCards, CARD_LIBRARY, customScene, sceneCatalog, soloScene } from '../scenes/index.js'
import { DATA_FLOWS } from '../scenes/flows.js'
import { LABELS, subtitleLines } from '../scenes/launch-kit.js'

async function setup(t, script) {
  const root = await mkdtemp(join(tmpdir(), 'director-cards-'))
  t.after(() => rm(root, { recursive: true, force: true }))
  const prompts = []
  const invoke = async (target, args) => {
    prompts.push({ target, prompt: args.prompt })
    if (script) return script(target, args)
    return { reply: `这是 ${target} 写的足够长的内容，用来通过长度检查，内容不重要，只看流程对不对，再多写一点文字。`.repeat(4) }
  }
  const projects = new Projects({
    env: { DSH_HOME: root },
    scenes: sceneCatalog,
    soloScene,
    customScene,
    cardLibrary: CARD_LIBRARY,
    invoke,
    onError: (message, error) => { throw new Error(`${message} ${error?.message}`) },
  })
  return { projects, prompts, root }
}

const settle = async (projects, id) => {
  await projects.settled(id)
  return projects.state(id)
}
const statusOf = (state, id) => state.nodes.find((n) => n.id === id).status

const LINE = {
  id: 'line',
  title: '三步',
  cards: [
    { id: 'a', title: '甲', prompt: '写甲：{{brief}}' },
    { id: 'b', title: '乙', needs: ['a'], prompt: '写乙：{{up.a}}' },
    { id: 'c', title: '丙', needs: ['b'], prompt: '写丙：{{up.b}}' },
  ],
}
const custom = (projects) => projects.create({ flow: { title: LINE.title, cards: LINE.cards }, input: '主题' })

test('所有流程都能编出来，引用的上游都存在，候选都有显示名', () => {
  assert.ok(DATA_FLOWS.length >= 4)
  for (const scene of sceneCatalog) {
    const built = scene.build('输入')
    assert.ok(built.nodes.length >= 6, scene.id)
    const ids = new Set(built.nodes.map((n) => n.id))
    for (const node of built.nodes) {
      for (const need of node.needs ?? []) assert.ok(ids.has(need), `${scene.id}/${node.id} 需要 ${need}`)
      for (const target of node.candidates ?? []) {
        if (target !== 'local') assert.ok(LABELS[target], `${target} 没有显示名`)
      }
    }
  }
})

test('写错的卡片过不了检查', () => {
  assert.throws(() => checkCardDefinition({ id: 'a b', title: 'x', prompt: 'y' }))
  assert.throws(() => checkCardDefinition({ id: 'a', title: 'x' }))
  assert.throws(() => compileFlow({ cards: [{ id: 'a', title: 'x', prompt: '{{up.none}}' }] }, 'i'))
  assert.throws(() => compileFlow({ cards: [{ id: 'a', title: 'x', needs: ['none'], prompt: 'y' }] }, 'i'))
  assert.equal(renderPrompt('{{brief}}|{{up.a}}', { brief: '甲', up: { a: '乙' } }), '甲|乙')
})

test('每张有提示词的卡片都能单独用：输入就是全部上下文', async (t) => {
  const { projects, prompts } = await setup(t)
  assert.ok(CARD_LIBRARY.length >= 20)
  for (const entry of CARD_LIBRARY) {
    const built = soloFlow(entry.card)
    assert.equal(built.cards.length, 1, entry.id)
    assert.deepEqual(built.cards[0].needs ?? [], [], entry.id)
    assert.doesNotMatch(built.cards[0].prompt, /\{\{up\./, entry.id)
  }
  const meta = await projects.create({ card: 'short-drama/script', input: '我已有的大纲内容' })
  await projects.start(meta.id)
  const state = await settle(projects, meta.id)
  assert.equal(state.phase === 'done' || state.phase === 'waiting', true)
  assert.equal(state.nodes.length, 1)
  assert.match(prompts[0].prompt, /我已有的大纲内容/)
})

test('只做到某一步：后面的不做，之后还能接着做', async (t) => {
  const { projects, prompts } = await setup(t)
  const { id } = await custom(projects)
  await projects.start(id, { until: 'b' })
  let state = await settle(projects, id)
  assert.equal(statusOf(state, 'a'), 'done')
  assert.equal(statusOf(state, 'b'), 'done')
  assert.equal(statusOf(state, 'c'), 'pending')
  assert.equal(state.phase, 'paused')
  assert.equal(prompts.length, 2)
  await projects.start(id)
  state = await settle(projects, id)
  assert.equal(state.phase, 'done')
  assert.equal(prompts.length, 3, '做过的不重做')
})

test('从中间进入：填入中间的卡片，前面的不会被拉起来跑', async (t) => {
  const { projects, prompts } = await setup(t)
  const { id } = await custom(projects)
  await projects.fill(id, 'b', { text: '我自己写的乙' })
  await projects.start(id)
  const state = await settle(projects, id)
  assert.equal(statusOf(state, 'a'), 'skipped')
  assert.equal(statusOf(state, 'b'), 'done')
  assert.equal(statusOf(state, 'c'), 'done')
  assert.equal(state.phase, 'done')
  assert.equal(prompts.length, 1)
  assert.match(prompts[0].prompt, /我自己写的乙/)
})

test('中途导出并终止：导出的是做完的卡片，可以不走完', async (t) => {
  const { projects } = await setup(t)
  const { id } = await custom(projects)
  await projects.start(id, { until: 'a' })
  await settle(projects, id)
  await projects.fill(id, 'c', { text: '提前写好的丙' })
  const all = await projects.exportCards(id)
  assert.equal(all.count, 2)
  const folders = (await readdir(all.path)).sort()
  assert.equal(folders.length, 2)
  assert.match(folders[0], /甲/)
  const one = await projects.exportCards(id, { card: 'c' })
  assert.equal(await readFile(join(one.path, 'c.md'), 'utf8'), '提前写好的丙')
  await assert.rejects(projects.exportCards(id, { card: 'b' }), /还没有产物/)
})

test('要工具的卡片会停下等填入，文件保留原名，填完下游继续', async (t) => {
  const { projects, root, prompts } = await setup(t)
  const { id } = await projects.create({
    flow: { title: '含手动', cards: [
      { id: 'a', title: '甲', prompt: '写甲 {{brief}}' },
      { id: 'img', title: '出图', external: true, needs: ['a'] },
      { id: 'side', title: '旁支', needs: ['a'], prompt: '写旁支 {{up.a}}' },
      { id: 'z', title: '末尾', needs: ['img'], prompt: '收尾 {{up.img}}' },
    ] },
    input: '主题',
  })
  await projects.start(id)
  let state = await settle(projects, id)
  assert.equal(statusOf(state, 'img'), 'needs-input')
  assert.equal(statusOf(state, 'side'), 'done', '旁支不受影响')
  assert.equal(statusOf(state, 'z'), 'pending')
  assert.equal(state.phase, 'needs-input')

  await assert.rejects(projects.fill(id, 'img', { text: '文字' }), /文件路径/)
  const pics = join(root, 'pics')
  await mkdir(pics)
  await writeFile(join(pics, 'hero.png'), 'x')
  await projects.fill(id, 'img', { path: pics, by: 'dsh' })
  const files = await projects.files(id, 'img', 1)
  assert.deepEqual(files.map((f) => f.name), ['hero.png'])
  await projects.start(id)
  state = await settle(projects, id)
  assert.equal(state.phase, 'done')
  assert.equal(state.nodes.find((n) => n.id === 'img').target, 'dsh')
  assert.match(prompts.at(-1).prompt, /hero\.png/)
})

test('叫停不算失败：卡片回到没做的状态，做完的留着，之后能接着做', async (t) => {
  let hang = true
  const { projects } = await setup(t, (_target, { signal, prompt }) => {
    if (!hang || /写甲/.test(prompt)) return { reply: '足够长的内容'.repeat(20) }
    return new Promise((_, reject) => signal.addEventListener('abort', () => reject(new Error('被中止'))))
  })
  const { id } = await custom(projects)
  await projects.start(id)
  for (let i = 0; i < 100 && statusOf(await projects.state(id), 'b') !== 'running'; i += 1) await new Promise((r) => setTimeout(r, 20))
  await projects.stop(id)
  let state = await settle(projects, id)
  assert.equal(statusOf(state, 'a'), 'done')
  assert.equal(statusOf(state, 'b'), 'pending')
  assert.equal(state.nodes.find((n) => n.id === 'b').error, null)
  assert.equal(state.phase, 'paused')
  hang = false
  await projects.start(id)
  state = await settle(projects, id)
  assert.equal(state.phase, 'done')
})

test('卡片的要求和提示词：下次做时生效', async (t) => {
  const { projects, prompts } = await setup(t)
  const { id } = await custom(projects)
  await projects.editCard(id, 'a', { note: '必须提到猫' })
  await projects.start(id, { until: 'a' })
  await settle(projects, id)
  assert.match(prompts[0].prompt, /必须提到猫/)
  await projects.editCard(id, 'b', { prompt: '换一种写法：{{up.a}}' })
  await projects.start(id, { until: 'b' })
  await settle(projects, id)
  assert.match(prompts[1].prompt, /^换一种写法/)
})

test('AI 操作卡片：建流程、加卡片、填内容、读结果、导出', async (t) => {
  const { projects, prompts } = await setup(t)
  const act = makeActions(projects)
  const listed = await act.flows({})
  assert.ok(listed.flows.some((f) => f.id === 'presentation'))
  assert.ok(listed.cards.length >= 20)

  const created = await act.create({ cards: LINE.cards, title: 'AI 拼的', input: '主题' })
  const project = created.project
  assert.equal(created.cards.length, 3)

  const added = await act.add_card({ project, card_def: { id: 'd', title: '丁', needs: ['c'], prompt: '写丁 {{up.c}}' } })
  assert.equal(added.cards.length, 4)
  await assert.rejects(act.add_card({ project, card_def: { id: 'd', title: '丁', prompt: 'x' } }), /已经有/)
  await assert.rejects(act.add_card({ project, card_def: { id: 'e', title: '戊', prompt: '{{up.none}}' } }))

  await act.fill({ project, card: 'c', text: 'AI 写的丙' })
  const read = await act.read({ project, card: 'c' })
  assert.match(read.text, /AI 写的丙/)
  await act.run({ project })
  await projects.settled(project)
  const status = await act.status({ project })
  assert.equal(status.phase, 'done')
  assert.equal(status.cards.find((c) => c.id === 'c').tool, 'dsh')
  assert.equal(prompts.length, 1)
  assert.match((await act.export({ project })).text, /已导出 \d+ 个文件/)
  await assert.rejects(act.read({ project }), /card/)

  // 加的卡片重启后还在
  const again = new Projects({ env: projects.env, scenes: sceneCatalog, soloScene, customScene, cardLibrary: CARD_LIBRARY, invoke: async () => ({ text: '' }) })
  assert.equal((await again.state(project)).nodes.length, 4)
})

test('工具：只有一个，描述很短，全部操作都能走到', async (t) => {
  const { projects } = await setup(t)
  const defs = await buildToolDefinitions(projects, { defineTool: rawTool })
  assert.equal(defs.length, 1)
  assert.equal(defs[0].name, 'cli_flow')
  assert.ok(defs[0].description.length < 120)
  const result = await defs[0].execute({ action: 'flows' })
  assert.ok(result.flows.length >= 5)
  await assert.rejects(defs[0].execute({ action: 'constructor' }), /没有这个操作/)
})

test('幻灯片每页单独渲染，内容会转义', () => {
  const deck = { title: 't', slides: [{ heading: '<b>一', points: ['x'] }, { heading: '二', points: [] }] }
  assert.equal((deckHtml(deck).match(/<section>/g) ?? []).length, 2)
  const second = deckHtml(deck, 1)
  assert.equal((second.match(/<section>/g) ?? []).length, 1)
  assert.match(second, /2 \/ 2/)
  assert.match(deckHtml(deck, 0), /&lt;b&gt;一/)
})

// 假的 ctx 什么 schema 都收，要用真实的 DSH 校验一次（做法同 dsh-cli）
const DSH_TOOLS = process.env.DSH_MODULES ? join(process.env.DSH_MODULES, '@deepseek-ai', 'dsh-tools', 'lib', 'index.js') : ''

test('真实 DSH 校验：工具定义和退回格式都能通过，返回值无损', { skip: DSH_TOOLS && existsSync(DSH_TOOLS) ? false : '没设置 DSH_MODULES' }, async (t) => {
  const real = await import(pathToFileURL(DSH_TOOLS).href)
  const { projects } = await setup(t)
  const [strict] = await buildToolDefinitions(projects, { defineTool: real.defineTool })
  assert.equal(strict.name, 'cli_flow')
  const [raw] = await buildToolDefinitions(projects, { defineTool: rawTool })
  assert.doesNotThrow(() => real.assertSupportedJsonSchema(raw.parameters))
  assert.doesNotThrow(() => real.assertSupportedJsonSchema(raw.output.schema))
  const value = await strict.execute({ action: 'flows' }, { signal: new AbortController().signal })
  const rendered = strict.output.render({}, value)
  assert.equal(rendered[0].type, 'text')
})

test('字幕最后不会只剩一两个字', () => {
  const lines = subtitleLines('Harness 这样的英文单词也能读出来吗？')
  assert.ok(lines.every((line) => line.length > 2), lines.join('|'))
})

test('卡片包：登记后能单独用，也能接进流程；没装时说清楚', async (t) => {
  const { projects, prompts } = await setup(t)
  const dispose = registerCardPack({
    id: 'demo',
    title: '演示包',
    labels: { 'demo-tool': '演示工具' },
    cards: [{
      id: 'echo',
      title: '回声',
      needs: [],
      candidates: ['demo-tool'],
      produces: { file: 'echo.txt', kind: 'text' },
      show: /^echo\.txt$/,
      async run(ctx) {
        await ctx.write('echo.txt', ctx.needs.length ? await ctx.upstream(ctx.needs[0]) : ctx.brief)
      },
    }],
  })
  t.after(dispose)
  assert.equal(allCards()[0].id, 'demo/echo')
  const solo = await projects.create({ card: 'demo/echo', input: '单独用' })
  await projects.start(solo.id)
  assert.equal((await settle(projects, solo.id)).phase, 'done')

  const { id } = await projects.create({
    flow: { title: '接进流程', cards: [
      { id: 'a', title: '甲', prompt: '写甲 {{brief}}' },
      { id: 'say', use: 'demo/echo', needs: ['a'] },
    ] },
    input: '主题',
  })
  await projects.start(id)
  const state = await settle(projects, id)
  assert.equal(state.phase, 'done')
  assert.equal(state.labels['demo-tool'], '演示工具')
  assert.equal(state.nodes.find((n) => n.id === 'say').title, '回声')
  assert.equal(prompts.length, 1)
  assert.match(await readFile(join(projects.dirOf(id), 'nodes', 'say', 'v1', 'echo.txt'), 'utf8'), /写的足够长/)

  await assert.rejects(projects.create({ flow: { title: '没装', cards: [{ id: 'x', use: 'nope/none' }] }, input: '主题' }), /没有装对应的卡片包/)
  await assert.rejects(projects.create({ card: 'nope/none', input: '主题' }), /没有这个流程或卡片/)

  // 包被卸载后，用过它的工程要说清楚，不能静默坏掉
  dispose()
  const again = new Projects({ env: projects.env, scenes: sceneCatalog, soloScene, customScene, invoke: async () => ({ reply: '' }) })
  await assert.rejects(again.state(id), /没有装对应的卡片包/)
})
