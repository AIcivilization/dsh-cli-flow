// lib/cards.js — 用数据定义的卡片和流程
//
// 卡片是独立的功能，流程只是把卡片连起来。大多数卡片只是一段提示词加一个产物文件，
// 用数据就能描述，所以 dsh 的 AI 和用户都能改提示词、加卡片、拼新流程，不用写代码。
//
// 卡片的字段：
//   title        名字
//   description  一句话说明
//   capability   要什么能力（text、image、video……），决定候选工具
//   file         产物文件名
//   prompt       提示词。{{brief}} 是用户的输入，{{up.卡片编号}} 是上游卡片的产物
//   compare      是否比稿
//   external     这张卡片的工具还没接：停下等人或 dsh 的 AI 填入
//   use          用卡片包里的卡片，如 audio/voice-subtitles

import { readFile } from 'node:fs/promises'
import { extname, join } from 'node:path'
import { checkCleanText, extractJson, renderHtml } from '../scenes/launch-kit.js'
import { findPackCard } from './packs.js'

export const WRITERS = ['opencode-deepseek', 'opencode-glm', 'opencode-pickle', 'lmstudio-local']
export const DEFAULT_COMPARE = ['opencode-deepseek', 'opencode-glm']

const KIND_BY_EXT = { '.md': 'text', '.txt': 'text', '.json': 'text', '.srt': 'text', '.png': '图片', '.jpg': '图片', '.mp4': '视频', '.m4a': '音频', '.mp3': '音频' }

const showFor = (file, external) => {
  if (external) return /\.(png|jpe?g|webp|mp4|m4a|mp3|wav|md|txt|json)$/i
  return new RegExp(`^${file.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}$`)
}

/** 把模板里的 {{brief}} 和 {{up.x}} 换掉 */
export function renderPrompt(template, { brief, up = {} }) {
  return template.replace(/\{\{\s*(brief|up\.[\w-]+)\s*\}\}/g, (_whole, key) => {
    if (key === 'brief') return brief
    const value = up[key.slice(3)]
    return value === undefined ? '（没有提供）' : value
  })
}

export function placeholders(template) {
  return [...template.matchAll(/\{\{\s*up\.([\w-]+)\s*\}\}/g)].map((m) => m[1])
}

/** 文字类卡片的通用做法：拼提示词、交给工具、存产物、检查 */
export function promptNode(def) {
  const { id, title, description, capability = 'text', file = `${id}.md`, prompt, compare, external, needs = [], candidates, minChars = 20 } = def
  const kind = KIND_BY_EXT[extname(file).toLowerCase()] ?? 'text'
  const node = {
    id,
    title,
    description,
    capability,
    needs,
    produces: { file, kind },
    show: showFor(file, external),
  }
  if (external) {
    // 产物是一批文件，用原来的文件名，不能当文字填
    return { ...node, produces: { kind: '文件' }, external: true, candidates: ['manual'], run: async () => {} }
  }
  if (def.builtin) return { ...node, ...BUILTINS[def.builtin](def) }
  return {
    ...node,
    compare: Boolean(compare),
    candidates: candidates ?? WRITERS,
    ...(compare ? { defaultCompare: DEFAULT_COMPARE } : {}),
    promptTemplate: prompt,
    async run(ctx) {
      const up = {}
      for (const need of needs) up[need] = await ctx.upstream(need)
      let text = renderPrompt(ctx.promptOverride ?? prompt, { brief: ctx.brief, up })
      if (ctx.note) text += `\n\n额外要求（必须遵守）：${ctx.note}`
      const { reply } = await ctx.invoke(ctx.target, { prompt: text })
      await ctx.write(file, reply)
    },
    async validate(ctx) {
      const text = await readFile(join(ctx.dir, file), 'utf8')
      if (text.trim().length < minChars) throw new Error(`${file} 只有 ${text.trim().length} 字，太短`)
      checkCleanText(text, file)
      if (file.endsWith('.json')) {
        const start = text.indexOf('{')
        const end = text.lastIndexOf('}')
        const arrStart = text.indexOf('[')
        const body = start >= 0 && (arrStart < 0 || start < arrStart) ? text.slice(start, end + 1) : text.slice(arrStart, text.lastIndexOf(']') + 1)
        JSON.parse(body)
      }
    },
  }
}

const escapeHtml = (text) => String(text).replace(/[&<>"]/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' }[c]))

export function deckHtml(deck, only) {
  const pages = deck.slides
    .map((s, i) => `<section><div class="n">${i + 1} / ${deck.slides.length}</div><h1>${escapeHtml(s.heading)}</h1><ul>${(s.points ?? []).map((p) => `<li>${escapeHtml(p)}</li>`).join('')}</ul></section>`)
    .filter((_, i) => only === undefined || i === only)
  return `<!doctype html><meta charset="utf-8"><title>${escapeHtml(deck.title ?? '')}</title><style>
*{margin:0;box-sizing:border-box}body{background:#0b1220;font-family:"PingFang SC","Hiragino Sans GB",sans-serif}
section{width:1280px;height:720px;padding:72px 88px;background:linear-gradient(135deg,#0f172a,#1e3a5f);color:#f8fafc;display:flex;flex-direction:column;overflow:hidden;margin:0 auto 16px;page-break-after:always}
.n{color:#38bdf8;font-size:24px;margin-bottom:20px}h1{font-size:56px;line-height:1.25;margin-bottom:40px}li{font-size:32px;line-height:1.5;margin:0 0 18px 36px;color:#e2e8f0}
@page{size:1280px 720px;margin:0}@media print{section{margin:0}}
</style>${pages.join('')}`
}

/** 不靠大模型的卡片 */
const BUILTINS = {
  'render-deck': (def) => ({
    candidates: ['chrome'],
    show: /^(deck\.html|page-\d+\.png)$/,
    produces: { file: 'deck.html', kind: '文件' },
    async run(ctx) {
      const deck = extractJson(await ctx.upstream(def.needs[0]))
      if (!Array.isArray(deck.slides) || !deck.slides.length) throw new Error('幻灯片内容是空的')
      await ctx.write('deck.html', deckHtml(deck))
      for (const [i] of deck.slides.entries()) await renderHtml(ctx, deckHtml(deck, i), `page-${i + 1}.png`)
    },
  }),
}

/** 把 { use } 换成卡片包里的卡片。包没装就说清楚 */
function resolveUse(card) {
  if (!card.use) return card
  const found = findPackCard(card.use)
  if (!found) throw new Error(`卡片 ${card.id} 要用 ${card.use}，但没有装对应的卡片包`)
  return { ...found, id: card.id, title: card.title ?? found.title, needs: card.needs ?? [] }
}

/** 把流程的数据变成引擎能跑的场景。自定义卡片接在后面 */
export function compileFlow(flow, input, { customCards = [], labels = {} } = {}) {
  const cards = [...flow.cards, ...customCards].map(resolveUse)
  const ids = new Set(cards.map((c) => c.id))
  for (const card of cards) {
    for (const need of card.needs ?? []) {
      if (!ids.has(need)) throw new Error(`卡片 ${card.id} 依赖不存在的卡片 ${need}`)
    }
    if (card.prompt) {
      for (const ref of placeholders(card.prompt)) {
        if (!(card.needs ?? []).includes(ref)) throw new Error(`卡片 ${card.id} 的提示词用了 {{up.${ref}}}，但没有声明依赖它`)
      }
    }
  }
  return {
    id: flow.id,
    title: flow.title,
    description: flow.description,
    labels,
    input,
    nodes: cards.map((card) => (card.run ? card : promptNode(card))),
  }
}

/** 单独用一张卡片：不要上游，用户的输入就是全部上下文 */
export function soloFlow(card) {
  const prompt = String(card.prompt ?? '').replace(/\{\{\s*up\.[\w-]+\s*\}\}/g, '{{brief}}')
  return {
    id: `card:${card.id}`,
    title: card.title,
    description: card.description,
    cards: [{ ...card, needs: [], prompt, compare: false }],
  }
}

/** 检查 AI 或用户给的卡片，不合格就说清楚哪里不对 */
export function checkCardDefinition(card) {
  if (!/^[a-z][a-z0-9-]{0,30}$/.test(String(card?.id ?? ''))) throw new Error('卡片编号只能用小写字母、数字和横线，并以字母开头')
  if (card.use) {
    if (!findPackCard(card.use)) throw new Error(`没有装对应的卡片包：${card.use}`)
    return { id: card.id, use: card.use, ...(card.title ? { title: card.title } : {}), ...(card.needs ? { needs: card.needs } : {}) }
  }
  if (!String(card.title ?? '').trim()) throw new Error('卡片要有名字')
  if (!card.external && !String(card.prompt ?? '').trim()) throw new Error('卡片要有提示词，或者声明 external')
  if (card.file && !/^[\w.-]+\.[a-z0-9]+$/i.test(card.file)) throw new Error(`产物文件名不合法：${card.file}`)
  const { id, title, description, capability, file, prompt, compare, external, needs } = card
  return { id, title, ...(description ? { description } : {}), ...(capability ? { capability } : {}), ...(file ? { file } : {}), ...(prompt ? { prompt } : {}), ...(compare ? { compare: true } : {}), ...(external ? { external: true } : {}), needs: needs ?? [] }
}
