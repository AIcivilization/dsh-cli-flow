// scenes/index.js — 场景目录。加一个场景就在这里加一行

import { compileFlow, soloFlow } from '../lib/cards.js'
import { packCards, packLabels } from '../lib/packs.js'
import { DATA_FLOWS } from './flows.js'
import { LABELS, launchKit, TARGETS } from './launch-kit.js'

const dataScene = (flow) => ({
  id: flow.id,
  title: flow.title,
  description: flow.description,
  placeholder: flow.placeholder,
  defaultInput: flow.defaultInput,
  targets: TARGETS,
  cardCount: flow.cards.length,
  build: (input, options = {}) => compileFlow(flow, input, { ...options, labels: { ...LABELS, ...packLabels() } }),
})

/** 能单独用的卡片：有提示词的都能。输入就是全部上下文 */
export const CARD_LIBRARY = DATA_FLOWS.flatMap((flow) => flow.cards
  .filter((card) => card.prompt)
  .map((card) => ({ id: `${flow.id}/${card.id}`, title: card.title, description: card.description, flow: flow.title, card })))

/** 全部卡片。专门装的卡片包排在最前面 */
export const allCards = () => [...packCards(), ...CARD_LIBRARY]

export function soloScene(cardRef) {
  const found = allCards().find((c) => c.id === cardRef)
  if (!found) return null
  return { ...dataScene(soloFlow(found.card)), id: `card:${cardRef}`, placeholder: '把这张卡片要处理的内容贴在这里。', hidden: true }
}

/** AI 或用户现场拼的流程，存在工程里 */
export const customScene = (flow) => dataScene({ id: 'custom', title: flow.title, description: flow.description ?? '', cards: flow.cards })

export const sceneCatalog = [
  ...DATA_FLOWS.map(dataScene),
  {
    id: 'launch-kit',
    title: '开源项目发布包',
    description: '输入产品介绍，产出讲解视频、封面、发布文章、英文版和社交文案。全程用免费工具。',
    placeholder: '介绍你的项目：它是什么、解决什么问题、有哪些特点。内容会发给免费模型，不要写敏感信息。',
    defaultInput: `dsh-cli 是 DeepSeek Harness 的一个开源插件。它让 DeepSeek Harness 能调用用户电脑上已经安装并登录的各种 AI 工具，用上用户已有的订阅。
要出视频时可以调用 MiniMax Code，要写代码时可以交给 Qoder。用户可以让模型自动选择工具，也可以指定某一家。
指定编程工具时可以直通：消息直接交给对方，不经过 DeepSeek Harness 的模型，不花它的 token。
会花钱的调用都会先弹确认框。插件不读取、不保存用户的登录凭证。`,
    targets: TARGETS,
    cardCount: 13,
    build: launchKit,
  },
]
