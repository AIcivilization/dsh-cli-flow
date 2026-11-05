// lib/packs.js — 卡片包的登记处
//
// 第三层插件（比如 dsh-cli-flow-audio）只往这里登记卡片，不给模型加工具，
// 所以装多少个包，每次请求的 token 都不会再涨。
// 用全局表：插件加载顺序不固定，同一个包也可能被装到不同目录，模块实例不一定是同一份。

import { registerTargets } from 'dsh-cli/actions'

const KEY = Symbol.for('dsh-cli-flow.packs')
const store = () => (globalThis[KEY] ??= new Map())
store() // dsh-cli 靠这张表判断流程层装了没有

/** 登记一个卡片包，返回撤销函数。卡片可以只有提示词，也可以带 run 写代码 */
export function registerCardPack(pack) {
  if (!/^[a-z][a-z0-9-]*$/.test(String(pack?.id ?? ''))) throw new Error('卡片包的编号只能用小写字母、数字和横线')
  if (!pack.title || !Array.isArray(pack.cards) || !pack.cards.length) throw new Error(`卡片包 ${pack.id} 要有名字和卡片`)
  if (pack.targets) registerTargets(pack.targets)
  store().set(pack.id, pack)
  return () => {
    if (store().get(pack.id) === pack) store().delete(pack.id)
  }
}

export const listPacks = () => [...store().values()]

export const packCards = () => listPacks().flatMap((pack) => pack.cards.map((card) => ({
  id: `${pack.id}/${card.id}`,
  title: card.title,
  description: card.description,
  flow: pack.title,
  card,
})))

export const findPackCard = (ref) => packCards().find((c) => c.id === ref)?.card ?? null

export const packLabels = () => Object.assign({}, ...listPacks().map((pack) => pack.labels ?? {}))
