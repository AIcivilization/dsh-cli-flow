/* global window, document, navigator, fetch, URL, Blob, setInterval, clearInterval, AbortSignal */
// lib/client.js — 流程面板
//
// 手写单文件，没有构建链，供 DSH web 客户端的 ModuleLoader 注入（写法照 dsh-vps、dsh-xfyun）。
// 放在右侧栏：开始前改候选，运行时看进度，比稿时亲眼看、亲耳听后选，不满意就换一家重做。
// 每张卡片都是独立功能：能只做到这一步、导出、手动填入、加要求，也能交给 dsh 的 AI 接手。
// 硬约束：界面出错不能影响 DSH，注册一律包在 try/catch 里。

window.__ModuleLoader__.load({
  id: 'dsh-cli-flow',
  factory: (require) => {
    const module = { exports: {} }
    const React = require('react')
    const { useCallback, useEffect, useRef, useState } = React
    const h = React.createElement

    const T = {
      border: 'var(--dsw-alias-border-l3, rgba(127,127,127,0.25))',
      field: 'var(--dsw-alias-border-l4, rgba(127,127,127,0.32))',
      text: 'var(--dsw-alias-label-primary, inherit)',
      secondary: 'var(--dsw-alias-label-secondary, inherit)',
      tertiary: 'var(--dsw-alias-label-tertiary, #81858c)',
      layer: 'var(--dsw-alias-bg-layer-1, rgba(127,127,127,0.08))',
      hover: 'var(--dsw-alias-bg-layer-2, rgba(127,127,127,0.12))',
      ok: 'var(--dsw-alias-state-success-primary, #2ea043)',
      danger: 'var(--dsw-alias-state-error-primary, #e5534b)',
      busy: '#d99a16',
      accent: 'var(--primary, #3b82f6)',
    }
    const S = {
      button: { height: 26, padding: '0 10px', borderRadius: 6, border: `1px solid ${T.field}`, background: 'transparent', color: T.text, fontSize: 12, cursor: 'pointer', whiteSpace: 'nowrap' },
      primary: { height: 28, padding: '0 14px', borderRadius: 6, border: 'none', background: T.accent, color: '#fff', fontSize: 12, fontWeight: 600, cursor: 'pointer', whiteSpace: 'nowrap' },
      input: { width: '100%', boxSizing: 'border-box', padding: '6px 8px', borderRadius: 6, border: `1px solid ${T.field}`, background: 'transparent', color: T.text, fontSize: 12, outline: 'none', fontFamily: 'inherit' },
      muted: { fontSize: 12, color: T.secondary, lineHeight: 1.6 },
    }
    const POLL_BUSY_MS = 1200
    const POLL_IDLE_MS = 5000
    const STYLE_ID = 'dsh-cli-flow-style'

    function ensureStyle() {
      if (document.getElementById(STYLE_ID)) return
      const style = document.createElement('style')
      style.id = STYLE_ID
      style.textContent = '@keyframes dsh-cli-flow-pulse{0%,100%{opacity:1}50%{opacity:.4}}'
      document.head.appendChild(style)
    }

    async function api(action, body = {}, timeoutMs = 30000) {
      const res = await fetch('/api/dsh-cli-flow', {
        method: 'POST',
        credentials: 'same-origin',
        cache: 'no-store',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ action, ...body }),
        signal: AbortSignal.timeout(timeoutMs),
      })
      let data = null
      try {
        data = await res.json()
      } catch {
        throw new Error(res.status === 404 ? '接口不存在：装了新版本要重启 DSH 才生效' : `HTTP ${res.status}`)
      }
      if (!data?.ok) throw new Error(data?.error || `HTTP ${res.status}`)
      return data
    }

    async function fetchFile(id, node, v, name) {
      const res = await fetch('/api/dsh-cli-flow.file', {
        method: 'POST',
        credentials: 'same-origin',
        cache: 'no-store',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ id, node, v, name }),
      })
      if (!res.ok) throw new Error(`读不了 ${name}`)
      return res.blob()
    }

    // —— 给界面用的纯逻辑，便于测试 ——

    const STATUS = {
      pending: { text: '等待', color: T.tertiary },
      running: { text: '运行中', color: T.busy, pulse: true },
      waiting: { text: '等你选', color: T.accent, pulse: true },
      'needs-input': { text: '等你填入', color: T.accent, pulse: true },
      skipped: { text: '不用做', color: T.tertiary },
      done: { text: '完成', color: T.ok },
      stale: { text: '要重跑', color: T.busy },
      failed: { text: '失败', color: T.danger },
      blocked: { text: '被上游挡住', color: T.tertiary },
    }

    const PHASE = {
      ready: '还没开始，可以先改每一步用谁',
      running: '运行中',
      'running-waiting': '运行中，有一步等你选',
      waiting: '等你选',
      failed: '有步骤失败',
      'needs-input': '有卡片等你填入',
      paused: '已停下，做完的可以导出，也可以继续',
      done: '全部完成',
    }

    const isBusy = (phase) => phase === 'running' || phase === 'running-waiting'

    function progress(nodes) {
      const done = nodes.filter((n) => n.status === 'done').length
      const total = nodes.filter((n) => n.status !== 'skipped').length
      return { done, total, percent: total ? Math.round((done / total) * 100) : 0 }
    }

    /** 需要人看的节点：等选的在前，其次失败的。这些要自动展开 */
    function attentionNodes(nodes) {
      return [...nodes.filter((n) => n.status === 'waiting'), ...nodes.filter((n) => n.status === 'needs-input'), ...nodes.filter((n) => n.status === 'failed')]
    }

    /** 顶部那一行状态文字 */
    function phaseText(phase, nodes) {
      const waiting = nodes.filter((n) => n.status === 'waiting').length
      if (phase === 'waiting' && waiting > 1) return `还有 ${waiting} 步等你选`
      if (phase === 'running-waiting' && waiting > 1) return `运行中，还有 ${waiting} 步等你选`
      return PHASE[phase] ?? phase
    }

    /** 这个节点有哪些版本可比：等选时只看这次比稿的，否则看全部做成的 */
    function versionsToShow(node) {
      const history = [...(node.history ?? [])]
      if (node.status === 'waiting' && node.awaiting?.length) return history.filter((v) => node.awaiting.includes(v.v))
      return history.reverse()
    }

    /** 这张卡片现在能做什么。流程在跑时只能看 */
    function cardActions(node, phase) {
      const locked = isBusy(phase) || node.status === 'running'
      const hasResult = Boolean(node.current) && node.status !== 'waiting'
      return {
        runTo: !locked && !node.external && !['done', 'waiting'].includes(node.status),
        export: hasResult,
        fill: !locked,
        fillText: Boolean(node.produces?.file) && (node.produces.kind ?? 'text') === 'text',
        edit: !locked && node.editable,
        redo: !locked && hasResult && !node.external,
      }
    }

    /** 交给 AI 时放进对话框的话。只放进去不发送：发送要花 token，也让用户能补充 */
    function aiDraft(state, node) {
      const where = `流程工程 ${state.id}「${state.title}」`
      if (!node) return `用 cli_flow 工具看一下${where}的进度，告诉我下一步该做什么、缺什么卡片。`
      const card = `卡片 ${node.id}（${node.title}）`
      if (node.external) return `用 cli_flow 工具看一下${where}的${card}。用 cli_list 找合适的工具，先告诉我要生成什么、用哪家，等我同意后用 cli_run 生成，再用 fill 填进卡片。`
      if (node.current) return `用 cli_flow 工具读一下${where}的${card}，告诉我哪里可以改进，我同意后再改。`
      return `用 cli_flow 工具处理${where}的${card}：`
    }

    const labelOf = (state, target) => state?.labels?.[target] ?? target
    const seconds = (ms) => (ms === undefined ? '' : `${(ms / 1000).toFixed(ms < 10000 ? 1 : 0)}s`)

    // —— 产物预览 ——

    const blobCache = new Map()

    function useArtifact(id, node, v, file) {
      const key = `${id}/${node}/${v}/${file.name}`
      const [value, setValue] = useState(() => blobCache.get(key) ?? null)
      const [error, setError] = useState('')
      useEffect(() => {
        if (blobCache.has(key)) {
          setValue(blobCache.get(key))
          return undefined
        }
        let alive = true
        fetchFile(id, node, v, file.name)
          .then(async (blob) => {
            const loaded = file.kind === 'text' ? { text: await blob.text() } : { url: URL.createObjectURL(blob) }
            blobCache.set(key, loaded)
            if (alive) setValue(loaded)
          })
          .catch((e) => alive && setError(e.message))
        return () => {
          alive = false
        }
      }, [key])
      return { value, error }
    }

    /** 讲稿这类 JSON 显示成人能读的样子 */
    function prettyText(name, text) {
      if (!name.endsWith('.json')) return text
      try {
        const data = JSON.parse(text)
        if (Array.isArray(data.scenes)) {
          return [data.title, '', ...data.scenes.map((s, i) => `${i + 1}. ${s.heading}\n${s.narration}`)].join('\n')
        }
        return JSON.stringify(data, null, 2)
      } catch {
        return text
      }
    }

    async function downloadFile(id, node, v, name) {
      const url = URL.createObjectURL(await fetchFile(id, node, v, name))
      const link = document.createElement('a')
      link.href = url
      link.download = name
      link.click()
      window.setTimeout?.(() => URL.revokeObjectURL(url), 10000)
    }

    const LINK = { border: 'none', background: 'transparent', padding: 0, color: T.secondary, fontSize: 11, cursor: 'pointer', textDecoration: 'underline' }

    function Artifact(props) {
      const { id, node, v, file } = props
      const { value } = useArtifact(id, node, v, file)
      const [copied, setCopied] = useState(false)
      return h('div', { style: { minWidth: 0 } },
        h(ArtifactBody, props),
        h('div', { style: { display: 'flex', gap: 10, marginTop: 3 } },
          h('button', { type: 'button', 'data-flow-download': file.name, onClick: () => downloadFile(id, node, v, file.name), style: LINK }, '下载'),
          value?.text !== undefined ? h('button', {
            type: 'button',
            'data-flow-copy': file.name,
            onClick: () => navigator.clipboard?.writeText(value.text).then(() => { setCopied(true); window.setTimeout?.(() => setCopied(false), 1500) }),
            style: LINK,
          }, copied ? '已复制' : '复制') : null))
    }

    function ArtifactBody({ id, node, v, file, onZoom }) {
      const { value, error } = useArtifact(id, node, v, file)
      if (error) return h('div', { style: { ...S.muted, color: T.danger } }, error)
      if (!value) return h('div', { style: S.muted }, '读取中…')
      if (file.kind === 'file') return h('a', { 'data-flow-open-file': file.name, href: value.url, target: '_blank', rel: 'noreferrer', style: { fontSize: 12, color: T.accent } }, `打开 ${file.name}`)
      if (file.kind === 'image') {
        return h('img', { 'data-flow-image': file.name, src: value.url, alt: file.name, onClick: () => onZoom(value.url), style: { width: '100%', display: 'block', borderRadius: 6, cursor: 'zoom-in' } })
      }
      if (file.kind === 'video') return h('video', { 'data-flow-video': file.name, src: value.url, controls: true, style: { width: '100%', display: 'block', borderRadius: 6, background: '#000' } })
      if (file.kind === 'audio') {
        return h('div', null,
          h('div', { style: { fontSize: 11, color: T.tertiary } }, file.name),
          h('audio', { 'data-flow-audio': file.name, src: value.url, controls: true, style: { width: '100%', height: 32 } }))
      }
      return h('div', { 'data-flow-text': file.name, style: { maxHeight: 220, overflowY: 'auto', whiteSpace: 'pre-wrap', fontSize: 12, lineHeight: 1.6, padding: 8, borderRadius: 6, background: T.layer, color: T.text } }, prettyText(file.name, value.text))
    }

    function VersionCard({ id, state, node, version, onChoose, onZoom, busy }) {
      const [files, setFiles] = useState(null)
      const failed = version.status !== 'ok'
      useEffect(() => {
        if (failed) return undefined
        let alive = true
        api('files', { id, node: node.id, v: version.v }).then((r) => alive && setFiles(r.files)).catch(() => alive && setFiles([]))
        return () => {
          alive = false
        }
      }, [id, node.id, version.v, failed, version.status])
      const isCurrent = node.current === version.v && node.status !== 'waiting'
      return h('div', {
        'data-flow-version': `${node.id}-${version.v}`,
        style: { minWidth: 0, padding: 8, borderRadius: 8, border: `1px solid ${isCurrent ? T.ok : T.border}` },
      },
        h('div', { style: { display: 'flex', alignItems: 'center', gap: 6, marginBottom: 6, fontSize: 12 } },
          h('span', { style: { fontWeight: 600, minWidth: 0, overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap', flex: '1 1 auto' } }, labelOf(state, version.target)),
          h('span', { style: { color: T.tertiary, fontSize: 11, flex: '0 0 auto' } }, `v${version.v} ${seconds(version.ms)}`),
          isCurrent ? h('span', { style: { color: T.ok, fontSize: 11, flex: '0 0 auto' } }, '在用') : null),
        failed
          ? h('div', { style: { ...S.muted, color: version.status === 'running' ? T.busy : T.danger, wordBreak: 'break-word' } }, version.status === 'running' ? '运行中…' : version.error)
          : h('div', { style: { display: 'grid', gap: 6 } }, (files ?? []).map((file) => h(Artifact, { key: file.name, id, node: node.id, v: version.v, file, onZoom }))),
        !failed && !isCurrent
          ? h('button', { type: 'button', 'data-flow-choose': `${node.id}-${version.v}`, disabled: busy, onClick: () => onChoose(version.v), style: { ...S.primary, width: '100%', marginTop: 8 } }, node.status === 'waiting' ? '选这个' : '用这版')
          : null)
    }

    function CandidatePicker({ state, node, onChange, disabled }) {
      if (node.candidates.length <= 1) return null
      if (node.compare) {
        const selected = node.pick ? [node.pick] : node.compareSet
        return h('div', { 'data-flow-candidates': node.id, style: { marginBottom: 8 } },
          h('div', { style: { ...S.muted, marginBottom: 4 } }, '让谁来做（选几家就比几家）'),
          node.candidates.map((target) => h('label', { key: target, style: { display: 'flex', gap: 6, alignItems: 'center', fontSize: 12, padding: '2px 0', cursor: disabled ? 'not-allowed' : 'pointer' } },
            h('input', {
              type: 'checkbox',
              'data-flow-candidate': target,
              disabled,
              checked: selected.includes(target),
              onChange: (event) => {
                const next = event.target.checked ? [...new Set([...selected, target])] : selected.filter((t) => t !== target)
                if (next.length) onChange({ pick: null, compareWith: next })
              },
            }),
            labelOf(state, target))))
      }
      const value = node.pick ?? node.candidates[0]
      return h('div', { 'data-flow-candidates': node.id, style: { marginBottom: 8 } },
        h('div', { style: { ...S.muted, marginBottom: 4 } }, '先用谁（失败时自动换下一个）'),
        h('select', {
          'data-flow-select': node.id,
          disabled,
          value,
          onChange: (event) => onChange({ pick: event.target.value }),
          style: { ...S.input, height: 28, padding: '0 6px' },
        }, node.candidates.map((target) => h('option', { key: target, value: target }, labelOf(state, target)))))
    }

    /** 手动填入：写文字，或者给本机文件路径。上游没做也能填，这就是从中间进入 */
    function FillBox({ node, busy, onFill, canText }) {
      const [text, setText] = useState('')
      const [path, setPath] = useState('')
      return h('div', { 'data-flow-fill': node.id, style: { display: 'grid', gap: 6, marginBottom: 8 } },
        canText ? h('textarea', { 'data-flow-fill-text': node.id, rows: 5, value: text, placeholder: '把内容写在这里', onChange: (e) => setText(e.target.value), style: { ...S.input, resize: 'vertical', lineHeight: 1.6 } }) : null,
        h('input', { 'data-flow-fill-path': node.id, value: path, placeholder: canText ? '或者填本机文件路径' : '本机文件或文件夹的路径', onChange: (e) => setPath(e.target.value), style: S.input }),
        h('button', {
          type: 'button',
          'data-flow-fill-save': node.id,
          disabled: busy || !(text.trim() || path.trim()),
          onClick: () => onFill(text.trim() ? { text } : { path: path.trim() }),
          style: { ...S.button, justifySelf: 'start' },
        }, '填入'))
    }

    /** 这张卡片的要求和提示词，下次做它时生效 */
    function EditBox({ node, busy, onSave }) {
      const [note, setNote] = useState(node.note ?? '')
      const [prompt, setPrompt] = useState(node.prompt ?? node.promptTemplate ?? '')
      return h('div', { 'data-flow-edit': node.id, style: { display: 'grid', gap: 6, marginBottom: 8 } },
        h('textarea', { 'data-flow-note': node.id, rows: 2, value: note, placeholder: '对这张卡片的额外要求', onChange: (e) => setNote(e.target.value), style: { ...S.input, resize: 'vertical', lineHeight: 1.6 } }),
        h('textarea', { 'data-flow-prompt': node.id, rows: 6, value: prompt, onChange: (e) => setPrompt(e.target.value), style: { ...S.input, resize: 'vertical', lineHeight: 1.6, fontSize: 11 } }),
        h('div', { style: { ...S.muted, fontSize: 11 } }, '保存后，下次做这张卡片时生效。已经做完的要点「重做」。'),
        h('button', { type: 'button', 'data-flow-edit-save': node.id, disabled: busy, onClick: () => onSave({ note, prompt: prompt === node.promptTemplate ? '' : prompt }), style: { ...S.button, justifySelf: 'start' } }, '保存'))
    }

    function NodeRow({ id, state, node, open, onToggle, onAction, busy, onZoom, onTellAi }) {
      const status = STATUS[node.status] ?? STATUS.pending
      const [redoTarget, setRedoTarget] = useState('')
      const [panel, setPanel] = useState('')
      const can = cardActions(node, state.phase)
      const versions = versionsToShow(node)
      const hasWork = node.history?.length > 0
      const running = isBusy(state.phase)
      const others = node.candidates.filter((t) => t !== 'local' && t !== 'manual')
      const togglePanel = (name) => setPanel((p) => (p === name ? '' : name))
      return h('div', { 'data-flow-node': node.id, 'data-flow-status': node.status, style: { borderBottom: `1px solid ${T.border}` } },
        h('button', {
          type: 'button',
          onClick: onToggle,
          style: { display: 'flex', width: '100%', alignItems: 'center', gap: 8, padding: '8px 4px', border: 'none', background: 'transparent', color: T.text, cursor: 'pointer', textAlign: 'left', fontSize: 13 },
        },
          h('span', { style: { width: 8, height: 8, borderRadius: '50%', flex: '0 0 auto', background: status.color, animation: status.pulse ? 'dsh-cli-flow-pulse 1.1s ease-in-out infinite' : 'none' } }),
          h('span', { style: { flex: '1 1 auto', minWidth: 0 } },
            h('span', { style: { display: 'block', overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' } }, node.title),
            h('span', { style: { display: 'block', fontSize: 11, color: T.tertiary, overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' } },
              node.target ? labelOf(state, node.target) : node.compare ? `比稿：${(node.pick ? [node.pick] : node.compareSet).map((t) => labelOf(state, t)).join(' / ')}` : labelOf(state, node.pick ?? node.candidates[0]))),
          h('span', { style: { flex: '0 0 auto', fontSize: 11, color: status.color } }, status.text),
          h('span', { style: { flex: '0 0 auto', color: T.tertiary, fontSize: 11 } }, open ? '▾' : '▸')),
        open ? h('div', { style: { padding: '0 4px 12px 20px' } },
          node.description ? h('div', { style: { ...S.muted, marginBottom: 8 } }, node.description) : null,
          node.status === 'waiting' ? h('div', { style: { ...S.muted, color: T.accent, marginBottom: 8 } }, '几家都做好了，看看后选一个，流程才会继续。') : null,
          node.status === 'needs-input' ? h('div', { style: { ...S.muted, color: T.accent, marginBottom: 8 } }, '这张卡片的工具还没接进流程。把做好的文件填进来，或者交给 AI 去找工具生成。') : null,
          node.note ? h('div', { style: { ...S.muted, marginBottom: 8 } }, `要求：${node.note}`) : null,
          h('div', { 'data-flow-card-actions': node.id, style: { display: 'flex', flexWrap: 'wrap', gap: 6, marginBottom: 8 } },
            can.runTo ? h('button', { type: 'button', 'data-flow-run-to': node.id, disabled: busy, onClick: () => onAction('start', { until: node.id }), style: S.button }, '只做到这一步') : null,
            can.export ? h('button', { type: 'button', 'data-flow-export': node.id, disabled: busy, onClick: () => onAction('export', { node: node.id }), style: S.button }, '导出') : null,
            can.fill ? h('button', { type: 'button', 'data-flow-fill-open': node.id, onClick: () => togglePanel('fill'), style: S.button }, '填入内容') : null,
            can.edit ? h('button', { type: 'button', 'data-flow-edit-open': node.id, onClick: () => togglePanel('edit'), style: S.button }, '要求和提示词') : null,
            h('button', { type: 'button', 'data-flow-ai': node.id, onClick: () => onTellAi(node), style: S.button }, '交给 AI')),
          panel === 'fill' && can.fill ? h(FillBox, { node, busy, canText: can.fillText, onFill: (body) => { onAction('fill', { node: node.id, ...body }); setPanel('') } }) : null,
          panel === 'edit' && can.edit ? h(EditBox, { key: `${node.note}|${node.prompt}`, node, busy, onSave: (body) => { onAction('editCard', { node: node.id, ...body }); setPanel('') } }) : null,
          node.error ? h('div', { style: { ...S.muted, color: T.danger, marginBottom: 8, wordBreak: 'break-word' } }, node.error) : null,
          !hasWork ? h(CandidatePicker, { state, node, disabled: running || busy, onChange: (options) => onAction('setCandidates', { node: node.id, ...options }) }) : null,
          hasWork ? h('div', { style: { display: 'grid', gridTemplateColumns: node.status === 'waiting' ? 'repeat(auto-fit, minmax(150px, 1fr))' : '1fr', gap: 8 } },
            versions.map((version) => h(VersionCard, { key: version.v, id, state, node, version, onZoom, busy: busy || running, onChoose: (v) => onAction(node.status === 'waiting' ? 'choose' : 'useVersion', { node: node.id, v }) }))) : null,
          can.redo && others.length && node.status !== 'waiting'
            ? h('div', { style: { display: 'flex', gap: 6, marginTop: 8 } },
              h('select', {
                'data-flow-redo-target': node.id,
                value: redoTarget || node.target || others[0],
                disabled: running || busy,
                onChange: (event) => setRedoTarget(event.target.value),
                style: { ...S.input, height: 26, padding: '0 6px', flex: '1 1 auto', minWidth: 0 },
              }, others.map((t) => h('option', { key: t, value: t }, labelOf(state, t)))),
              h('button', {
                type: 'button',
                'data-flow-redo': node.id,
                disabled: running || busy,
                onClick: () => onAction('redo', { node: node.id, target: redoTarget || node.target || others[0] }),
                style: S.button,
              }, '用这家重做'))
            : null) : null)
    }

    function ProjectView({ id, onBack }) {
      const [state, setState] = useState(null)
      const [error, setError] = useState('')
      const [busy, setBusy] = useState(false)
      const [opened, setOpened] = useState({})
      const [zoom, setZoom] = useState('')
      const [notice, setNotice] = useState('')
      const autoOpened = useRef(new Set())

      const refresh = useCallback(async () => {
        try {
          const r = await api('state', { id })
          setState(r.state)
          setError('')
        } catch (e) {
          setError(e.message)
        }
      }, [id])

      const phase = state?.phase
      useEffect(() => {
        refresh()
        const timer = setInterval(refresh, isBusy(phase) ? POLL_BUSY_MS : POLL_IDLE_MS)
        return () => clearInterval(timer)
      }, [refresh, isBusy(phase)])

      // 等选的和失败的节点自动展开并滚过去。每个状态只做一次，用户收起后不再打开
      useEffect(() => {
        if (!state) return
        const fresh = attentionNodes(state.nodes).filter((n) => !autoOpened.current.has(`${n.id}:${n.status}:${n.versions}`))
        if (!fresh.length) return
        for (const n of fresh) autoOpened.current.add(`${n.id}:${n.status}:${n.versions}`)
        setOpened((o) => ({ ...o, ...Object.fromEntries(fresh.map((n) => [n.id, true])) }))
        window.setTimeout?.(() => {
          document.querySelector?.(`[data-flow-node="${fresh[0].id}"]`)?.scrollIntoView?.({ block: 'start', behavior: 'smooth' })
        }, 100)
      }, [state])

      const act = async (action, body = {}) => {
        setBusy(true)
        setError('')
        try {
          const r = await api(action, { id, ...body }, 60000)
          if (r.state) setState(r.state)
          if (r.exported) setNotice(`已导出 ${r.exported.count} 个文件到：${r.exported.path}`)
          // 选完就收起，让下一个等选的节点露出来
          if (action === 'choose') setOpened((o) => ({ ...o, [body.node]: false }))
        } catch (e) {
          setError(e.message)
        } finally {
          setBusy(false)
        }
      }

      const tellAi = (node) => {
        const outcome = putInComposer(aiDraft(state, node))
        setNotice({
          ok: '已放进对话框，补充后发送。发送会花 dsh 的 token。',
          draft: '对话框里还有没发的内容，先处理掉再试。',
          none: '找不到对话框：先打开一个对话，并点一下对话顶部的「流程」。',
        }[outcome])
      }

      if (!state) {
        return h('div', { style: { padding: 12, ...S.muted, color: error ? T.danger : T.secondary } }, error || '读取中…')
      }
      const { done, total, percent } = progress(state.nodes)
      const running = isBusy(state.phase)
      const canStart = !running && state.phase !== 'done' && state.phase !== 'waiting'
      const anyDone = state.nodes.some((n) => n.current && n.status !== 'waiting')
      return h('div', { 'data-flow-project': id, 'data-flow-phase': state.phase, style: { padding: 12, color: T.text } },
        h('div', { style: { display: 'flex', alignItems: 'center', gap: 8, marginBottom: 10 } },
          h('button', { type: 'button', 'data-flow-back': '', onClick: onBack, style: { ...S.button, padding: '0 8px' } }, '‹'),
          h('div', { style: { fontSize: 14, fontWeight: 600, flex: '1 1 auto', minWidth: 0, overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' } }, state.title),
          running ? h('button', { type: 'button', 'data-flow-stop': '', disabled: busy, onClick: () => act('stop'), style: S.button }, '停止') : null,
          canStart ? h('button', { type: 'button', 'data-flow-start': '', disabled: busy, onClick: () => act('start'), style: S.primary }, state.phase === 'ready' ? '开始' : '继续') : null),
        h('div', { style: { height: 4, borderRadius: 2, background: T.layer, overflow: 'hidden', marginBottom: 6 } },
          h('div', { style: { height: '100%', width: `${percent}%`, background: state.phase === 'failed' ? T.danger : T.ok } })),
        h('div', { 'data-flow-progress': '', style: { ...S.muted, marginBottom: 8 } }, `${phaseText(state.phase, state.nodes)} · ${done}/${total}`),
        h('div', { style: { display: 'flex', gap: 6, marginBottom: 8 } },
          anyDone ? h('button', { type: 'button', 'data-flow-export-all': '', disabled: busy, onClick: () => act('export'), style: S.button }, '导出已完成的') : null,
          h('button', { type: 'button', 'data-flow-ai-project': '', onClick: () => tellAi(null), style: S.button }, '交给 AI')),
        notice ? h('div', { 'data-flow-notice': '', style: { ...S.muted, padding: 8, borderRadius: 6, background: T.layer, marginBottom: 8, wordBreak: 'break-all' } }, notice) : null,
        error ? h('div', { style: { ...S.muted, color: T.danger, marginBottom: 8 } }, error) : null,
        state.delivered ? h('div', { 'data-flow-delivered': '', style: { ...S.muted, padding: 8, borderRadius: 6, background: T.layer, marginBottom: 8, wordBreak: 'break-all' } }, `成品目录：${state.delivered}`) : null,
        state.nodes.map((node) => h(NodeRow, {
          key: node.id,
          id,
          state,
          node,
          busy,
          open: Boolean(opened[node.id]),
          onToggle: () => setOpened((o) => ({ ...o, [node.id]: !o[node.id] })),
          onAction: act,
          onZoom: setZoom,
          onTellAi: tellAi,
        })),
        zoom ? h('div', {
          'data-flow-zoom': '',
          onClick: () => setZoom(''),
          style: { position: 'fixed', inset: 0, zIndex: 2000, background: 'rgba(0,0,0,0.8)', display: 'flex', alignItems: 'center', justifyContent: 'center', cursor: 'zoom-out', padding: 24 },
        }, h('img', { src: zoom, alt: '', style: { maxWidth: '100%', maxHeight: '100%', borderRadius: 8 } })) : null)
    }

    function Home({ onOpen }) {
      const [scenes, setScenes] = useState([])
      const [cards, setCards] = useState([])
      const [mode, setMode] = useState('flow')
      const [card, setCard] = useState('')
      const [projects, setProjects] = useState(null)
      const [scene, setScene] = useState('')
      const [input, setInput] = useState('')
      const [error, setError] = useState('')
      const [busy, setBusy] = useState(false)

      useEffect(() => {
        api('scenes').then((r) => {
          setScenes(r.scenes)
          setCards(r.cards ?? [])
          if (r.cards?.[0]) setCard(r.cards[0].id)
          if (r.scenes[0]) {
            setScene(r.scenes[0].id)
            setInput(r.scenes[0].defaultInput ?? '')
          }
        }).catch((e) => setError(e.message))
        api('projects').then((r) => setProjects(r.projects)).catch((e) => setError(e.message))
      }, [])

      const current = scenes.find((s) => s.id === scene)
      const currentCard = cards.find((c) => c.id === card)
      const switchMode = (next) => {
        setMode(next)
        setInput(next === 'flow' ? current?.defaultInput ?? '' : '')
      }
      const create = async () => {
        setBusy(true)
        setError('')
        try {
          onOpen((await api('create', mode === 'flow' ? { scene, input } : { card, input })).project.id)
        } catch (e) {
          setError(e.message)
        } finally {
          setBusy(false)
        }
      }

      return h('div', { 'data-flow-home': '', style: { padding: 12, color: T.text } },
        h('div', { style: { fontSize: 14, fontWeight: 600, marginBottom: 8 } }, '要做一件什么事'),
        h('div', { style: { display: 'flex', gap: 6, marginBottom: 8 } },
          [['flow', '整个流程'], ['card', '只用一张卡片']].map(([value, label]) => h('button', {
            key: value,
            type: 'button',
            'data-flow-mode': value,
            onClick: () => switchMode(value),
            style: { ...S.button, flex: '1 1 0', background: mode === value ? T.hover : 'transparent', fontWeight: mode === value ? 600 : 400 },
          }, label))),
        mode === 'card'
          ? h('select', { 'data-flow-card-select': '', value: card, onChange: (e) => setCard(e.target.value), style: { ...S.input, height: 28, marginBottom: 8 } },
            cards.map((c) => h('option', { key: c.id, value: c.id }, `${c.flow} · ${c.title}`)))
          : scenes.length > 1
          ? h('select', { 'data-flow-scene-select': '', value: scene, onChange: (e) => { setScene(e.target.value); setInput(scenes.find((s) => s.id === e.target.value)?.defaultInput ?? '') }, style: { ...S.input, height: 28, marginBottom: 8 } },
            scenes.map((s) => h('option', { key: s.id, value: s.id }, s.title)))
          : current ? h('div', { style: { fontSize: 13, marginBottom: 8 } }, current.title) : null,
        h('div', { style: { ...S.muted, marginBottom: 8 } }, mode === 'flow' ? current?.description ?? '' : currentCard?.description ?? ''),
        h('textarea', { 'data-flow-input': '', value: input, rows: 7, placeholder: mode === 'flow' ? current?.placeholder : '把这张卡片要处理的内容写在这里。',  onChange: (e) => setInput(e.target.value), style: { ...S.input, resize: 'vertical', lineHeight: 1.6, marginBottom: 8 } }),
        h('div', { style: { ...S.muted, fontSize: 11, marginBottom: 8 } }, '文字卡片默认用免费模型，它们可能用输入改进模型，不要写敏感信息。每张卡片都可以换工具。'),
        h('button', { type: 'button', 'data-flow-create': '', disabled: busy || !input.trim(), onClick: create, style: { ...S.primary, width: '100%' } }, mode === 'flow' ? '下一步：看流程' : '下一步：看卡片'),
        error ? h('div', { style: { ...S.muted, color: T.danger, marginTop: 8 } }, error) : null,
        projects?.length
          ? h('div', { style: { marginTop: 16 } },
            h('div', { style: { ...S.muted, marginBottom: 4 } }, '之前的工程'),
            projects.map((p) => h('button', {
              key: p.id,
              type: 'button',
              'data-flow-open': p.id,
              onClick: () => onOpen(p.id),
              style: { display: 'block', width: '100%', textAlign: 'left', padding: '8px 4px', border: 'none', borderBottom: `1px solid ${T.border}`, background: 'transparent', color: T.text, cursor: 'pointer', fontSize: 12 },
            },
              h('span', { style: { display: 'block', overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' } }, p.title),
              h('span', { style: { color: T.tertiary, fontSize: 11 } }, `${PHASE[p.phase] ?? p.phase} · ${p.done}/${p.total}`))))
          : null)
    }

    function FlowPanel() {
      const [project, setProject] = useState('')
      useEffect(ensureStyle, [])
      return project
        ? h(ProjectView, { key: project, id: project, onBack: () => setProject('') })
        : h(Home, { onOpen: setProject })
    }

    // 交给 AI：把话放进当前对话的输入框（同 dsh-xfyun），不替用户发送
    let activeSession = ''
    let composerOf = null
    function putInComposer(text) {
      let input = null
      try {
        input = activeSession ? composerOf?.(activeSession) : null
      } catch {
        input = null
      }
      if (!input) return 'none'
      const draft = String(input.snapshot?.draft ?? input.state?.get?.()?.draft ?? '').trim()
      if (draft) return 'draft'
      input.setDraft(text)
      return 'ok'
    }

    const SIDEBAR_TAB_ID = 'dsh-cli-flow/panel'
    const SIDEBAR_KIND = 'dsh-cli-flow-panel'
    let openSidebar = null

    /** 对话顶部的入口：点一下打开流程面板 */
    function HeaderButton(props) {
      if (props?.sessionId) activeSession = String(props.sessionId)
      return h('button', {
        type: 'button',
        'data-flow-header': '',
        title: '打开流程面板：把一件事从头做到完',
        onClick: () => {
          if (props?.sessionId) activeSession = String(props.sessionId)
          openSidebar?.()
        },
        style: { height: 25, padding: '0 8px', borderRadius: 8, border: `1px solid ${T.border}`, background: 'transparent', color: T.secondary, fontSize: 12, cursor: 'pointer', whiteSpace: 'nowrap' },
      }, '流程')
    }

    const name = 'dsh-cli-flow-client'
    const inject = ['slots']

    function apply(ctx) {
      try {
        ctx.inject?.(['sessions', 'conversation'], (scope) => {
          const sessions = scope.get?.('sessions') ?? scope.sessions
          const reader = (sessionId) => {
            const actx = sessions?.scope?.(sessionId)
            const input = actx?.get?.('conversation')?.input?.for?.(actx)
            return typeof input?.setDraft === 'function' ? input : null
          }
          composerOf = reader
          scope.effect?.(() => () => {
            if (composerOf === reader) composerOf = null
          }, 'dsh-cli-flow: composer')
        })
      } catch (error) {
        console.warn('[dsh-cli-flow] 拿不到对话输入框', error)
      }
      try {
        ctx.inject?.(['sidebarRight', 'sidebarRightTabs'], (scope) => {
          const right = scope.get?.('sidebarRight') ?? scope.sidebarRight
          const tabs = scope.get?.('sidebarRightTabs') ?? scope.sidebarRightTabs
          if (!right?.openTab || !tabs?.register) return
          openSidebar = () => right.openTab(SIDEBAR_KIND)
          const effect = (fn, label) => (scope.effect ? scope.effect(fn, label) : fn())
          effect(() => tabs.register({
            id: SIDEBAR_TAB_ID,
            kind: SIDEBAR_KIND,
            priority: 'extension',
            keepMounted: true,
            title: () => '流程',
            guide: [{ id: 'dsh-cli-flow', order: 72, title: () => '流程', description: () => '把一件事从头做到完，每一步都能选工具', icon: () => h('span', { style: { fontSize: 20 } }, '🎬') }],
          }), 'dsh-cli-flow: sidebar type')
          const slots = scope.slots ?? ctx.slots
          const body = () => slots.register({ name: 'sidebar.right.pane.tab', key: SIDEBAR_TAB_ID }, FlowPanel)
          effect(() => (slots.inject ? slots.inject('sidebar.right.pane.tab', body) : body()), 'dsh-cli-flow: sidebar body')
        })
      } catch (error) {
        console.warn('[dsh-cli-flow] 右侧栏注册失败', error)
      }
      try {
        ctx.slots.inject('conversation.session.header.actions', () =>
          ctx.slots.register({ name: 'conversation.session.header.actions', id: 'dsh-cli-flow', order: 36 }, HeaderButton))
      } catch (error) {
        console.warn('[dsh-cli-flow] 对话顶部入口注册失败', error)
      }
    }

    module.exports = { name, inject, apply, __test: { progress, attentionNodes, phaseText, versionsToShow, prettyText, isBusy, cardActions, aiDraft } }
    return module.exports
  },
})
