import assert from 'node:assert/strict'
import { mkdtemp, readFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { test } from 'node:test'
import { Flow } from '../lib/engine.js'
import { buildSrt, checkCleanText, checkScript, checkSpeechLength, extractJson, launchKit, subtitleLines } from '../scenes/launch-kit.js'

const tempDir = () => mkdtemp(join(tmpdir(), 'dsh-cli-flow-test-'))

/** 每个节点把上游内容和工具名写进 out.txt，方便检查谁用了谁 */
function node(id, needs = [], extra = {}) {
  return {
    id,
    title: id,
    needs,
    candidates: ['a'],
    async run(ctx) {
      extra.onRun?.(ctx)
      const parts = await Promise.all(needs.map((n) => ctx.read(n, 'out.txt')))
      await ctx.write('out.txt', `${id}:${ctx.target}[${parts.join(',')}]`)
    },
    ...extra,
  }
}

const scene = (nodes) => ({ id: 's', title: 's', input: 'brief', nodes })
const failing = (targets) => ({
  onRun(ctx) {
    if (targets.includes(ctx.target)) throw new Error(`${ctx.target} 坏了`)
  },
})

test('依赖：按顺序跑，产物传到下游', async () => {
  const dir = await tempDir()
  const flow = await new Flow({ scene: scene([node('a'), node('b', ['a']), node('c', ['a', 'b'])]), dir }).load()
  const result = await flow.run()
  assert.equal(result.complete, true)
  assert.deepEqual(result.ran, ['a', 'b', 'c'])
  assert.equal(await readFile(join(dir, 'nodes/c/v1/out.txt'), 'utf8'), 'c:a[a:a[],b:a[a:a[]]]')
})

test('依赖：声明不存在的节点直接报错；读没声明的上游也报错', async () => {
  assert.throws(() => new Flow({ scene: scene([node('a', ['nope'])]), dir: '/tmp/x' }), /不存在的节点/)
  const dir = await tempDir()
  const flow = await new Flow({ scene: scene([node('a'), { id: 'b', title: 'b', needs: [], async run(ctx) { await ctx.read('a', 'out.txt') } }]), dir }).load()
  const result = await flow.run()
  assert.deepEqual(result.failed, ['b'])
})

test('并行：同时跑，不超过并发上限', async () => {
  let active = 0
  let peak = 0
  const slow = (id) => ({
    id,
    title: id,
    async run(ctx) {
      active += 1
      peak = Math.max(peak, active)
      await new Promise((r) => setTimeout(r, 40))
      active -= 1
      await ctx.write('out.txt', id)
    },
  })
  const flow = await new Flow({ scene: scene(['a', 'b', 'c', 'd', 'e'].map(slow)), dir: await tempDir(), concurrency: 2 }).load()
  assert.equal((await flow.run()).complete, true)
  assert.equal(peak, 2)
})

test('换家：失败或不合格自动换下一个候选', async () => {
  const flow = await new Flow({
    scene: scene([
      node('a', [], { candidates: ['bad', 'ugly', 'good'], ...failing(['bad']), validate: (ctx) => { if (ctx.target === 'ugly') throw new Error('不合格') } }),
    ]),
    dir: await tempDir(),
  }).load()
  assert.equal((await flow.run()).complete, true)
  assert.equal(flow.currentVersion('a').target, 'good')
  const versions = flow.entry('a').versions
  assert.deepEqual(versions.map((v) => v.status), ['failed', 'failed', 'ok'])
  assert.match(versions[1].error, /不合格/)
})

test('失败：所有候选都不行时只影响下游，别的分支继续', async () => {
  const flow = await new Flow({
    scene: scene([node('a', [], { candidates: ['x', 'y'], ...failing(['x', 'y']) }), node('b', ['a']), node('c')]),
    dir: await tempDir(),
  }).load()
  const result = await flow.run()
  assert.equal(result.complete, false)
  assert.deepEqual(result.failed, ['a'])
  assert.deepEqual(result.blocked, ['b'])
  assert.equal(flow.summary().find((n) => n.id === 'c').fresh, true)
})

test('比稿：所有候选都做，由 choose 选；有一家失败也能选', async () => {
  const seen = []
  const flow = await new Flow({
    scene: scene([node('a', [], { compare: true, candidates: ['x', 'y', 'bad'], ...failing(['bad']) }), node('b', ['a'])]),
    dir: await tempDir(),
    choose: async (_n, versions) => {
      seen.push(versions.map((v) => v.target))
      return versions.find((v) => v.target === 'y').v
    },
  }).load()
  await flow.run()
  assert.deepEqual(seen, [['x', 'y']])
  assert.equal(flow.currentVersion('a').target, 'y')
  assert.match(await readFile(join(flow.dir, 'nodes/b/v1/out.txt'), 'utf8'), /a:y/)
})

test('比稿：只有一家成功时不用选', async () => {
  let asked = false
  const flow = await new Flow({
    scene: scene([node('a', [], { compare: true, candidates: ['x', 'bad'], ...failing(['bad']) })]),
    dir: await tempDir(),
    choose: async () => { asked = true; return 1 },
  }).load()
  await flow.run()
  assert.equal(asked, false)
  assert.equal(flow.currentVersion('a').target, 'x')
})

test('重做：换一家重做，只有下游重跑，无关节点不动', async () => {
  const flow = await new Flow({
    scene: scene([node('a', [], { candidates: ['x', 'y'] }), node('b', ['a']), node('c', ['b']), node('other')]),
    dir: await tempDir(),
  }).load()
  await flow.run()
  await flow.redo('a', { target: 'y' })
  const second = await flow.run()
  assert.deepEqual(second.ran, ['a', 'b', 'c'])
  assert.equal(flow.currentVersion('a').target, 'y')
  assert.equal(flow.entry('a').versions.length, 2)
  assert.equal(flow.entry('other').versions.length, 1)
  assert.match(await readFile(join(flow.dir, 'nodes/c/v2/out.txt'), 'utf8'), /a:y/)
})

test('重做：比稿节点指定一家后只跑那一家', async () => {
  const flow = await new Flow({ scene: scene([node('a', [], { compare: true, candidates: ['x', 'y'] })]), dir: await tempDir() }).load()
  await flow.run()
  await flow.redo('a', { target: 'y' })
  await flow.run()
  assert.equal(flow.entry('a').versions.length, 3)
  assert.equal(flow.currentVersion('a').target, 'y')
})

test('选回旧版本：不重做，下游跟着重跑', async () => {
  const flow = await new Flow({ scene: scene([node('a', [], { candidates: ['x', 'y'] }), node('b', ['a'])]), dir: await tempDir() }).load()
  await flow.run()
  await flow.redo('a', { target: 'y' })
  await flow.run()
  await flow.useVersion('a', 1)
  const third = await flow.run()
  assert.deepEqual(third.ran, ['b'])
  assert.match(await readFile(join(flow.dir, 'nodes/b/v3/out.txt'), 'utf8'), /a:x/)
  await assert.rejects(flow.useVersion('a', 99), /没有可用的版本/)
})

test('断点续跑：进程死了再跑，做完的不重做，中断的算失败并重试', async () => {
  const dir = await tempDir()
  const nodes = [node('a'), node('b', ['a']), node('c', ['b'])]
  const first = await new Flow({ scene: scene([nodes[0]]), dir }).load()
  await first.run()
  // 模拟 b 跑到一半进程死了
  first.state.nodes.b = { pick: null, dirty: false, current: null, versions: [{ v: 1, target: 'a', inputs: { a: 1 }, status: 'running' }] }
  await first.save()

  const again = await new Flow({ scene: scene(nodes), dir }).load()
  assert.equal(again.entry('b').versions[0].status, 'failed')
  const result = await again.run()
  assert.deepEqual(result.ran, ['b', 'c'])
  assert.equal(result.complete, true)
  assert.equal(again.entry('a').versions.length, 1)
  assert.equal(again.currentVersion('b').v, 2)
})

test('已经完成的流程再跑一次什么都不做', async () => {
  const dir = await tempDir()
  const nodes = [node('a'), node('b', ['a'])]
  await (await new Flow({ scene: scene(nodes), dir }).load()).run()
  const result = await (await new Flow({ scene: scene(nodes), dir }).load()).run()
  assert.deepEqual(result.ran, [])
  assert.equal(result.complete, true)
})

test('事件和用量都记下来', async () => {
  const dir = await tempDir()
  const events = []
  const flow = await new Flow({
    scene: scene([{ id: 'a', title: 'a', candidates: ['t'], async run(ctx) { await ctx.invoke('t', {}) } }]),
    dir,
    invoke: async () => ({ usage: { cost: 0 } }),
    onEvent: (e) => events.push(e.type),
  }).load()
  await flow.run()
  assert.deepEqual(events, ['attempt', 'ok', 'finished'])
  assert.deepEqual(flow.currentVersion('a').usage, [{ tool: 't', cost: 0 }])
  const log = await readFile(join(dir, 'events.jsonl'), 'utf8')
  assert.equal(log.trim().split('\n').length, 3)
})

// —— 场景 ——

test('场景：依赖都合法，没有环，覆盖多种能力', () => {
  const kit = launchKit('x')
  const flow = new Flow({ scene: kit, dir: '/tmp/x' })
  const seen = new Set()
  let progress = true
  while (progress) {
    progress = false
    for (const n of kit.nodes) {
      if (!seen.has(n.id) && (n.needs ?? []).every((d) => seen.has(d))) {
        seen.add(n.id)
        progress = true
      }
    }
  }
  assert.equal(seen.size, kit.nodes.length, '有环')
  assert.ok(flow)
  const caps = new Set(kit.nodes.map((n) => n.capability).filter(Boolean))
  for (const cap of ['text', 'render', 'tts', 'media-edit']) assert.ok(caps.has(cap))
  assert.ok(kit.nodes.filter((n) => n.compare).length >= 2)
})

test('场景：能从带说明的回复里取出 JSON；不合格的讲稿被拒绝', () => {
  assert.deepEqual(extractJson('好的：\n```json\n{"a":1}\n```\n以上'), { a: 1 })
  assert.throws(() => extractJson('我不会写'), /没有 JSON/)
  const scene1 = { heading: 'h', points: ['p'], narration: 'n' }
  assert.doesNotThrow(() => checkScript({ title: 't', scenes: [scene1, scene1, scene1] }))
  assert.throws(() => checkScript({ title: 't', scenes: [scene1] }), /3 到 6/)
  assert.throws(() => checkScript({ scenes: [scene1, scene1, scene1] }), /标题/)
  assert.throws(() => checkScript({ title: 't', scenes: [scene1, scene1, { heading: 'h', points: ['p'] }] }), /缺 narration/)
})

test('场景：字幕按标点切行、不超长，英文单词不切开，时间连续', () => {
  const text = '这是第一句，这是第二句。这是一段非常非常非常非常非常非常长的没有标点的句子'
  const lines = subtitleLines(text)
  assert.ok(lines.every((l) => l.length <= 21))
  assert.ok(subtitleLines('指定编程工具时还能直通：消息直接发给对方，不经过模型').every((l) => !/^[，。]/.test(l)), '标点不放行首')
  assert.equal(lines.join(''), text)
  // 回归：实测把 DeepSeek Harness 切成了 "DeepSeek H" 和 "arness"
  const mixed = subtitleLines('dsh-cli 是 DeepSeek Harness 的开源插件，让它能直接调用你电脑上的 AI 工具。')
  assert.ok(mixed.every((l) => l.length <= 21), mixed.join(' | '))
  for (const word of ['dsh-cli', 'DeepSeek', 'Harness', 'AI']) assert.ok(mixed.some((l) => l.includes(word)), `${word} 被切开了：${mixed.join(' | ')}`)
  assert.equal(mixed.join('').replace(/\s/g, ''), 'dsh-cli是DeepSeekHarness的开源插件，让它能直接调用你电脑上的AI工具。')
  const srt = buildSrt([{ narration: '第一句。' }, { narration: '第二句。' }], [2, 3])
  assert.match(srt, /00:00:00,000 --> 00:00:02,000/)
  assert.match(srt, /00:00:02,000 --> 00:00:05,000/)
})

test('场景回归：声音没读中文时，靠时长拦下（文件能生成，退出码也是 0）', () => {
  const narration = '凡是花钱的调用，都先弹确认框，插件也绝不读取或保存你的登录凭证，放心花，安心用。'
  assert.throws(() => checkSpeechLength(narration, 0.01), /没有被读出来/)
  assert.throws(() => checkSpeechLength('dsh-cli 是 DeepSeek Harness 的开源插件，让它能直接调用你电脑上已装好、已登录的 AI 工具，把已有的能力都串起来。', 3.26), /没有被读出来/)
  assert.doesNotThrow(() => checkSpeechLength(narration, 9.58))
  assert.doesNotThrow(() => checkSpeechLength(narration, 8.88))
})

test('场景回归：进度条和思考过程混进产物时拦下', () => {
  assert.throws(() => checkCleanText('Loading huihui-9b 0% ⠋第一条'), /混进了工具输出/)
  assert.throws(() => checkCleanText('<think>想一想</think>第一条'), /混进了工具输出/)
  assert.throws(() => checkCleanText('带\u001b[2K控制符'), /混进了工具输出/)
  assert.doesNotThrow(() => checkCleanText('进度 100%，加载完成'))
})
