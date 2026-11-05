// lib/index.js — 插件入口（挂载方式照 dsh-vps）
//
// 给模型加一个 cli_flow 工具，让 dsh 的 AI 能操作卡片。一个工具带 action 参数，
// 不用的对话每次请求多约 400 token（工具定义加 skill 目录一行）；详细用法放 skill，需要时才读。流程本身不经过模型。

import { readFile } from 'node:fs/promises'
import { Projects } from './projects.js'
import { registerRoutes } from './routes.js'
import { registerTools } from './tools.js'
import { allCards, customScene, sceneCatalog, soloScene } from '../scenes/index.js'

export const name = 'dsh-cli-flow'
export const inject = ['tools']

const RUNNING = Symbol.for('dsh-cli-flow.running')
export function _resetInstanceGuard() {
  delete globalThis[RUNNING]
}

function warn(ctx, message, error) {
  const text = `[dsh-cli-flow] ${message}${error ? `：${error.message ?? error}` : ''}`
  if (ctx?.logger?.warn) ctx.logger.warn(text)
  else console.warn(text)
}

export async function registerSkill(skillCtx) {
  const content = await readFile(new URL('./skills/dsh-cli-flow.md', import.meta.url), 'utf8')
  return skillCtx.skills.register({
    name: 'dsh-cli-flow',
    source: 'runtime',
    description: '用流程和卡片把一件事做完（短剧、PPT、短视频、商品上架等），用 cli_flow 工具之前读它',
    whenToUse: '用户要做短剧、PPT、短视频、商品上架这类多步骤的工作，提到流程、卡片或节点，或者让你改进、补充、操作某张卡片时',
    content,
    invocation: { modelInvocable: true, userInvocable: false },
  })
}

export function apply(ctx, config = {}) {
  const running = globalThis[RUNNING]
  if (running && !running.released) {
    warn(ctx, '同一个 DSH 里已经有一份本插件在运行，这一份不再重复注册')
    return
  }
  const instance = { released: false }
  globalThis[RUNNING] = instance
  const release = () => {
    instance.released = true
    if (globalThis[RUNNING] === instance) delete globalThis[RUNNING]
  }
  try {
    ctx.effect?.(() => release, 'dsh-cli-flow: single instance')
    ctx.on?.('dispose', release)
  } catch {
    // 老版本 cordis 没有这些，等重启
  }

  const projects = new Projects({
    env: config.env ?? process.env,
    scenes: sceneCatalog,
    soloScene,
    customScene,
    cardLibrary: allCards,
    invoke: config.invoke,
    onError: (message, error) => warn(ctx, message, error),
  })

  registerTools(ctx, projects, config).catch((error) => warn(ctx, '工具注册失败', error))

  if (typeof ctx.inject !== 'function') return
  ctx.inject(['skills'], (skillCtx) => {
    registerSkill(skillCtx).catch((error) => warn(ctx, 'skill 注册失败', error))
  })
  ctx.inject(['connection'], (connCtx) => {
    const fetchApi = connCtx.connection?.fetch ?? connCtx.get?.('connection')?.fetch
    if (typeof fetchApi?.register !== 'function') {
      warn(ctx, 'DSH 没有提供 connection.fetch，流程面板不可用')
      return
    }
    try {
      const dispose = registerRoutes(fetchApi, projects)
      connCtx.effect?.(() => dispose, 'dsh-cli-flow: routes')
    } catch (error) {
      warn(ctx, '界面接口注册失败', error)
    }
  })
}
