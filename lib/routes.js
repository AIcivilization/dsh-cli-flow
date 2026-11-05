// lib/routes.js — 界面调 host 的接口
//
// 挂在 connection.fetch（/api 通道）：DSH 自己做 Host/Origin 围栏和登录校验（做法照 dsh-vps）。

export const API_PATH = '/api/dsh-cli-flow'
export const FILE_PATH = '/api/dsh-cli-flow.file'

const json = (body, status = 200) =>
  new Response(JSON.stringify(body), { status, headers: { 'content-type': 'application/json', 'cache-control': 'no-store' } })

export function createActions(projects) {
  return {
    scenes: async () => ({ scenes: projects.listScenes(), cards: projects.listCards() }),
    projects: async () => ({ projects: await projects.list() }),
    create: async ({ scene, card, input, title }) => ({ project: await projects.create({ scene, card, input, title }) }),
    state: async ({ id }) => ({ state: await projects.state(id) }),
    setCandidates: async ({ id, node, pick, compareWith }) => ({ state: await projects.setCandidates(id, node, { pick, compareWith }) }),
    start: async ({ id, until }) => {
      await projects.start(id, { until })
      return { state: await projects.state(id) }
    },
    stop: async ({ id }) => {
      await projects.stop(id)
      return { state: await projects.state(id) }
    },
    choose: async ({ id, node, v }) => ({ state: await projects.choose(id, node, v) }),
    redo: async ({ id, node, target }) => ({ state: await projects.redo(id, node, target) }),
    useVersion: async ({ id, node, v }) => ({ state: await projects.useVersion(id, node, v) }),
    files: async ({ id, node, v }) => ({ files: await projects.files(id, node, v) }),
    fill: async ({ id, node, text, path }) => ({ state: await projects.fill(id, node, { text, path }) }),
    editCard: async ({ id, node, note, prompt }) => ({ state: await projects.editCard(id, node, { note, prompt }) }),
    export: async ({ id, node }) => ({ exported: await projects.exportCards(id, { card: node }), state: await projects.state(id) }),
  }
}

export function createHandlers(projects) {
  const actions = createActions(projects)
  const read = async (request) => {
    try {
      return await request.json()
    } catch {
      return null
    }
  }
  return {
    actions,
    async api(request) {
      const body = await read(request)
      if (!body) return json({ ok: false, error: '请求格式不对' }, 400)
      const action = Object.hasOwn(actions, body.action) ? actions[body.action] : null
      if (!action) return json({ ok: false, error: '没有这个操作' }, 404)
      try {
        return json({ ok: true, ...(await action(body)) })
      } catch (error) {
        return json({ ok: false, error: error.message })
      }
    },
    async file(request) {
      const body = await read(request)
      if (!body) return json({ ok: false, error: '请求格式不对' }, 400)
      try {
        const { bytes, mime } = await projects.fileContent(body.id, body.node, body.v, body.name)
        return new Response(bytes, { headers: { 'content-type': mime, 'cache-control': 'no-store' } })
      } catch (error) {
        return json({ ok: false, error: error.message }, 404)
      }
    },
  }
}

export function registerRoutes(fetchApi, projects) {
  const { api, file } = createHandlers(projects)
  const disposers = [
    fetchApi.register({ path: API_PATH, methods: ['POST'], requestBody: 'buffered', fetch: api }),
    fetchApi.register({ path: FILE_PATH, methods: ['POST'], requestBody: 'buffered', fetch: file }),
  ]
  return () => disposers.forEach((dispose) => dispose?.())
}
