// lib/bridge.js — 通过 dsh-cli 这座桥调工具
//
// 完整版不自己启动任何工具，所有调用都走桥。失败抛错，由引擎决定换家。

import { registerTargets, runAction } from 'dsh-cli/actions'

export { registerTargets }

export function makeInvoke({ env = process.env, signal } = {}) {
  return async (target, { prompt, argv, cwd, model, signal: requestSignal } = {}) => {
    const result = await runAction({
      target,
      prompt,
      args: argv ? { argv } : undefined,
      cwd,
      model,
      waitUntilDone: true,
      ctx: {},
      env,
      signal: requestSignal ?? signal,
    })
    if (!result.ok) {
      const detail = [result.hint, result.reply, result.stderr].filter(Boolean).join(' ').slice(0, 500)
      throw new Error(`${target} 失败：${detail || result.state}`)
    }
    return result
  }
}
