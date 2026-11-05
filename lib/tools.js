// lib/tools.js — 让 dsh 的 AI 操作卡片
//
// 只有一个工具，靠 action 区分。描述保持短：这段文字每次请求都带，不用这个插件的对话也要付。
// 用法写在 skill（lib/skills/dsh-cli-flow.md）里，需要时才读。

import { readFile } from 'node:fs/promises'
import { join } from 'node:path'
import { rawTool } from 'dsh-cli/tools'

const MAX_READ_CHARS = 12000
const ACTIONS = ['flows', 'projects', 'create', 'status', 'read', 'fill', 'note', 'prompt', 'add_card', 'run', 'stop', 'choose', 'redo', 'export']

async function loadDefineTool() {
  try {
    const mod = await import('@deepseek-ai/dsh-tools')
    return mod.defineTool ?? rawTool
  } catch {
    return rawTool // 链接安装时取不到，退回完整 JSON Schema
  }
}

function compactState(state) {
  return {
    project: state.id,
    title: state.title,
    phase: state.phase,
    ...(state.delivered ? { delivered: state.delivered } : {}),
    cards: state.nodes.map((n) => ({
      id: n.id,
      title: n.title,
      status: n.status,
      ...(n.target ? { tool: n.target } : {}),
      ...(n.versions ? { versions: n.versions, current: n.current } : {}),
      ...(n.awaiting?.length ? { awaiting: n.awaiting } : {}),
      ...(n.external ? { external: true } : {}),
      ...(n.needs.length ? { needs: n.needs } : {}),
      ...(n.candidates.length > 1 ? { candidates: n.candidates } : {}),
      ...(n.note ? { note: n.note } : {}),
      ...(n.error ? { error: n.error } : {}),
    })),
  }
}

function renderText(value) {
  if (typeof value.text === 'string') return value.text
  if (value.cards && value.project) {
    const lines = value.cards.map((c) => `${c.id}（${c.title}）${c.status}${c.tool ? ` · ${c.tool}` : ''}${c.versions ? ` · v${c.current}/${c.versions}` : ''}${c.awaiting ? ` · 等选 ${c.awaiting.join(',')}` : ''}${c.external ? ' · 需要填入' : ''}${c.error ? ` · ${c.error}` : ''}`)
    return `工程 ${value.project}「${value.title}」${value.phase}\n${lines.join('\n')}${value.delivered ? `\n成品：${value.delivered}` : ''}`
  }
  return JSON.stringify(value)
}

export function makeActions(projects) {
  const need = (value, name) => {
    if (value === undefined || value === null || value === '') throw new Error(`action 需要参数 ${name}`)
    return value
  }
  const stateOf = async (id) => compactState(await projects.state(need(id, 'project')))
  return {
    flows: async () => ({
      flows: projects.listScenes().map(({ id, title, description, cardCount }) => ({ id, title, description, cardCount })),
      cards: projects.listCards().map(({ id, title }) => ({ id, title })),
    }),
    projects: async () => ({ projects: await projects.list() }),
    create: async ({ flow, card, cards, title, input }) => {
      const meta = await projects.create({
        scene: flow,
        card,
        input: need(input, 'input'),
        title,
        ...(cards ? { flow: { title, cards } } : {}),
      })
      return stateOf(meta.id)
    },
    status: ({ project }) => stateOf(project),
    read: async ({ project, card, v }) => {
      const flow = await projects.flowOf(need(project, 'project'))
      const node = flow.nodes.get(need(card, 'card'))
      if (!node) throw new Error(`没有这张卡片：${card}`)
      const version = Number(v) || flow.entry(card).current
      if (!version) throw new Error(`${node.title} 还没有产物`)
      const files = await projects.files(project, card, version)
      const dir = flow.versionDir(card, version)
      const parts = []
      for (const file of files) {
        if (file.kind === 'text') parts.push(`--- ${file.name} ---\n${(await readFile(join(dir, file.name), 'utf8')).slice(0, MAX_READ_CHARS)}`)
        else parts.push(`--- ${file.name}：${join(dir, file.name)}`)
      }
      return { text: parts.join('\n\n') || '没有可看的产物' }
    },
    fill: async ({ project, card, text, path }) => {
      await projects.fill(need(project, 'project'), need(card, 'card'), { text, path, by: 'dsh' })
      return stateOf(project)
    },
    note: async ({ project, card, text }) => {
      await projects.editCard(need(project, 'project'), need(card, 'card'), { note: text ?? '' })
      return stateOf(project)
    },
    prompt: async ({ project, card, text }) => {
      await projects.editCard(need(project, 'project'), need(card, 'card'), { prompt: text ?? '' })
      return stateOf(project)
    },
    add_card: async ({ project, card_def: cardDef }) => {
      await projects.addCard(need(project, 'project'), need(cardDef, 'card_def'))
      return stateOf(project)
    },
    run: async ({ project, card }) => {
      await projects.start(need(project, 'project'), { until: card })
      return stateOf(project)
    },
    stop: async ({ project }) => {
      await projects.stop(need(project, 'project'))
      return stateOf(project)
    },
    choose: async ({ project, card, v }) => {
      await projects.choose(need(project, 'project'), need(card, 'card'), need(v, 'v'))
      return stateOf(project)
    },
    redo: async ({ project, card, tool }) => {
      await projects.redo(need(project, 'project'), need(card, 'card'), tool)
      return stateOf(project)
    },
    export: async ({ project, card }) => {
      const { path, count } = await projects.exportCards(need(project, 'project'), { card })
      return { text: `已导出 ${count} 个文件到 ${path}` }
    },
  }
}

export async function buildToolDefinitions(projects, deps = {}) {
  const defineTool = deps.defineTool ?? await loadDefineTool()
  const actions = makeActions(projects)
  return [
    defineTool({
      name: 'cli_flow',
      description: '操作流程和卡片，把短剧、PPT、短视频这类多步骤的工作做完。每张卡片都能单独做、改要求、填内容、换工具重做、导出，不必走完全程。先读 skill dsh-cli-flow。',
      parameters: {
        action: { type: 'string', enum: ACTIONS, required: true },
        project: { type: 'string', description: '工程编号' },
        flow: { type: 'string', description: 'create：流程编号' },
        card: { type: 'string', description: '卡片编号。create 时是单张卡片的编号' },
        cards: { type: 'array', items: { type: 'object', additionalProperties: true }, description: 'create：现场拼流程的卡片' },
        card_def: { type: 'object', additionalProperties: true, description: 'add_card：卡片定义' },
        title: { type: 'string', description: 'create：工程名' },
        input: { type: 'string', description: 'create：用户的输入' },
        text: { type: 'string', description: 'fill 的内容；note 的要求；prompt 的提示词' },
        path: { type: 'string', description: 'fill：本地文件或目录' },
        tool: { type: 'string', description: 'redo：换哪家' },
        v: { type: 'integer', description: 'choose、read：版本' },
      },
      output: { schema: { type: 'json' }, render: (_a, value) => [{ type: 'text', text: renderText(value) }] },
      async execute(args) {
        const action = Object.hasOwn(actions, args.action) ? actions[args.action] : null
        if (!action) throw new Error(`没有这个操作：${args.action}`)
        return JSON.parse(JSON.stringify(await action(args)))
      },
    }),
  ]
}

export async function registerTools(ctx, projects, deps = {}) {
  const defs = await buildToolDefinitions(projects, deps)
  return defs.map((def) => ctx.tools.register(def))
}
