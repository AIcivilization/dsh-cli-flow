#!/usr/bin/env node
// 用免费工具真跑一遍"开源项目发布包"。用法：node scripts/run-launch-kit.mjs <工程目录>
//
// 第一轮：从头跑完。
// 第二轮：模拟用户不满意文章，换一家重写，看是不是只有下游重跑。
// 比稿的选择是脚本模拟的，真实产品里由用户在界面上选。

import { join, resolve } from 'node:path'
import { makeInvoke, registerTargets } from '../lib/bridge.js'
import { Flow } from '../lib/engine.js'
import { launchKit, TARGETS } from '../scenes/launch-kit.js'

const dir = resolve(process.argv[2] ?? 'launch-kit-project')
const dshHome = join(dir, '.dsh-home')
const env = { ...process.env, DSH_HOME: dshHome }

// 不含任何敏感内容：OpenCode 的免费模型可能用输入改进模型
const BRIEF = `dsh-cli 是 DeepSeek Harness 的一个开源插件。它让 DeepSeek Harness 能调用用户电脑上已经安装并登录的各种 AI 工具，用上用户已有的订阅。
要出视频时可以调用 MiniMax Code，要写代码时可以交给 Qoder。用户可以让模型自动选择工具，也可以指定某一家。
指定编程工具时可以直通：消息直接交给对方，不经过 DeepSeek Harness 的模型，不花它的 token。
会花钱的调用都会先弹确认框。插件不读取、不保存用户的登录凭证。`

registerTargets(TARGETS)

const prettify = (e) => {
  const time = e.at.slice(11, 19)
  if (e.type === 'attempt') return `${time}  ▶ ${e.node} v${e.v}  ${e.target}`
  if (e.type === 'ok') return `${time}  ✓ ${e.node} v${e.v}  ${e.target}  ${(e.ms / 1000).toFixed(1)}s`
  if (e.type === 'failed') return `${time}  ✗ ${e.node} v${e.v}  ${e.target}  ${e.error.slice(0, 90)}`
  if (e.type === 'switch') return `${time}  ⇄ ${e.node} 换家：${e.from} → ${e.to}`
  if (e.type === 'chosen') return `${time}  ★ ${e.node} 比稿 ${e.among.join(' / ')}，选中 ${e.target}`
  if (e.type === 'redo') return `${time}  ↻ ${e.node} 换 ${e.target} 重做`
  if (e.type === 'finished') return `${time}  ■ 本轮跑了 ${e.ran.length} 个节点：${e.ran.join(' ')}${e.failed.length ? `  失败：${e.failed}` : ''}${e.blocked.length ? `  阻塞：${e.blocked}` : ''}`
  return `${time}  ${JSON.stringify(e)}`
}

// 模拟用户：封面选 Blender 那版，配音选 Tingting，卖点选更长的
const choose = async (node, versions, flow) => {
  if (node.id === 'cover') return versions.find((v) => v.target === 'blender')?.v ?? versions[0].v
  if (node.id === 'voice') return versions.find((v) => v.target === 'say-tingting')?.v ?? versions[0].v
  const { readFile } = await import('node:fs/promises')
  const sized = await Promise.all(versions.map(async (v) => [v, (await readFile(join(flow.versionDir(node.id, v.v), 'points.md'), 'utf8')).length]))
  return sized.sort((a, b) => b[1] - a[1])[0][0].v
}

const flow = await new Flow({ scene: launchKit(BRIEF), dir, invoke: makeInvoke({ env }), choose, onEvent: (e) => console.log(prettify(e)) }).load()

console.log('—— 第一轮：从头跑 ——')
const first = await flow.run()
console.log(JSON.stringify({ complete: first.complete, failed: first.failed, blocked: first.blocked }))
if (first.complete) {
  console.log('\n—— 第二轮：对文章不满意，换一家重写 ——')
  const current = flow.currentVersion('article').target
  const other = ['opencode-deepseek', 'opencode-pickle', 'opencode-glm'].find((t) => t !== current)
  await flow.redo('article', { target: other })
  const second = await flow.run()
  console.log(JSON.stringify({ complete: second.complete, ran: second.ran }))
}
console.log('\n—— 总览 ——')
for (const n of flow.summary()) {
  console.log(`${n.fresh ? '✓' : '✗'} ${n.title.padEnd(12, '　')} ${String(n.target ?? '-').padEnd(20)} 当前 v${n.current}，共 ${n.versions} 版${n.failed ? `，失败 ${n.failed} 次` : ''}`)
}
