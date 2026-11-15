/**
 * Host half of the tab indicator.
 *
 * Tracks the root agents that are currently running, pushes the running count
 * to every open DSH page over a Server-Sent Events channel, and injects the
 * browser half into the page. The browser half owns the favicon and title
 * decoration; this side only publishes a small status snapshot.
 */
import fs from 'node:fs'
import path from 'node:path'
import { fileURLToPath } from 'node:url'

const PACKAGE_ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..')
const CLIENT_FILE = path.join(PACKAGE_ROOT, 'client.js')

const EVENTS_ROUTE = '/dsh-tab-indicator/events'
const CLIENT_ROUTE = '/dsh-tab-indicator/client.js'
const CLIENT_TAG = `<script defer src="${CLIENT_ROUTE}?v=1"></script>`

const KEEPALIVE_MS = 20_000
const RECONCILE_MS = 2_000

export const name = 'dsh-tab-indicator'
export const inject = ['webServer', 'agents', 'sessionProjections']

/** A subagent turn is part of a root turn, so only roots are counted. */
function isRootAgent(agent) {
  const header = agent && agent.session && agent.session.header
  // No header means we cannot prove it is a subagent; count it as a root.
  return !header || header.origin !== 'subagent'
}

function agentSessionId(agent) {
  const session = agent && agent.session
  return session && session.id ? String(session.id) : ''
}

function sseFrame(payload) {
  return `data: ${JSON.stringify(payload)}\n\n`
}

/**
 * @param {import('@deepseek-ai/cordis').Context} ctx - host context.
 */
export function apply(ctx) {
  const clients = new Set()
  /** sessionId -> startedAt (ms); insertion order is the run order. */
  const running = new Map()
  /**
   * Blocking question and approval requests, tracked until their waterfall
   * promise settles. Timed questions live in the `userQuestions` projection
   * instead; counting both here would double-report them.
   */
  const pendingInputs = new Set()
  let lastWaiting = 0
  let disposed = false

  /**
   * Answerable timed questions in every live root Session, not just the one
   * currently shown in a browser tab. The projection is the durable source;
   * legacy blocking questions have no projection entry and are tracked below.
   */
  const timedWaiting = () => {
    let count = 0
    let roots = []
    try {
      roots = ctx.agents && typeof ctx.agents.roots === 'function' ? ctx.agents.roots() : []
    } catch (err) {
      console.warn(`[dsh-tab-indicator] could not list agents: ${err && err.message ? err.message : err}`)
      return 0
    }
    for (const agent of roots) {
      const session = agent && agent.session
      if (!session) continue
      try {
        const values = ctx.sessionProjections.snapshot(session, ['userQuestions']).values
        const view = values && values.userQuestions
        if (view && Array.isArray(view.active)) count += view.active.length
      } catch (err) {
        console.warn(`[dsh-tab-indicator] could not read pending questions: ${err && err.message ? err.message : err}`)
      }
    }
    return count
  }

  const waitingCount = () => pendingInputs.size + timedWaiting()

  const snapshot = () => ({
    type: 'state',
    running: running.size,
    waiting: waitingCount(),
    sessions: [...running.keys()],
    at: Date.now(),
  })

  const publish = () => {
    if (disposed || clients.size === 0) return
    const current = snapshot()
    lastWaiting = current.waiting
    const frame = sseFrame(current)
    for (const res of [...clients]) {
      try {
        res.write(frame)
      } catch {
        clients.delete(res)
      }
    }
  }

  const trackInput = (request) => {
    if (!request || typeof request !== 'object' || pendingInputs.has(request)) return
    pendingInputs.add(request)
    publish()
  }

  const settleInput = (request) => {
    if (pendingInputs.delete(request)) publish()
  }

  /**
   * Keep one blocking waterfall request counted until its answer, cancellation,
   * or abort settles it. `next()` continues the composed answerer chain.
   */
  const holdInput = (request, next) => {
    trackInput(request)
    let result
    try {
      result = next()
    } catch (err) {
      settleInput(request)
      throw err
    }
    return Promise.resolve(result).finally(() => settleInput(request))
  }

  const remember = (agent) => {
    const id = agentSessionId(agent)
    if (!id || !isRootAgent(agent) || running.has(id)) return false
    running.set(id, Date.now())
    return true
  }

  const forget = (agent) => {
    const id = agentSessionId(agent)
    return Boolean(id) && running.delete(id)
  }

  /**
   * Reconcile against the live Agent registry. `agent/status` normally keeps
   * this exact, but a plugin reload can observe an Agent after its last status
   * transition; without this pass that session would stay "running" forever.
   */
  const reconcile = () => {
    if (disposed) return
    let roots = []
    try {
      roots = ctx.agents && typeof ctx.agents.roots === 'function' ? ctx.agents.roots() : []
    } catch (err) {
      console.warn(`[dsh-tab-indicator] could not list agents: ${err && err.message ? err.message : err}`)
      return
    }
    const actual = new Set()
    for (const agent of roots) {
      if (!agent || agent.status !== 'running' || !isRootAgent(agent)) continue
      const id = agentSessionId(agent)
      if (id) actual.add(id)
    }
    let changed = false
    for (const id of [...running.keys()]) {
      if (actual.has(id)) continue
      running.delete(id)
      changed = true
    }
    for (const id of actual) {
      if (running.has(id)) continue
      running.set(id, Date.now())
      changed = true
    }
    // A Session that disappeared can still hold the last known question count;
    // comparing against the last published snapshot repairs that without frames
    // on every quiet tick.
    if (waitingCount() !== lastWaiting) changed = true
    if (changed) publish()
  }

  reconcile()
  const reconcileTimer = setInterval(reconcile, RECONCILE_MS)
  if (typeof reconcileTimer.unref === 'function') reconcileTimer.unref()

  ctx.on('agent/status', (payload) => {
    const agent = payload && payload.agent
    const status = payload && payload.status
    const changed = status === 'running' ? remember(agent) : forget(agent)
    if (changed) publish()
  })

  ctx.on('agent/disposed', (payload) => {
    if (forget(payload && payload.agent)) publish()
  })

  // Timed questions are answerable in any root Session, not only the one the
  // browser is showing. The projection change feed is the cross-Session signal.
  ctx.sessionProjections.onChanged((session, key) => {
    if (key === 'userQuestions') publish()
  })

  // Blocking questions and approvals have no projection entry; hold them for
  // the lifetime of the composed answerer waterfall.
  ctx.on('user-questions/request', (request, next) => {
    if (request && request.wait !== undefined) return next()
    return holdInput(request, next)
  })
  ctx.on('approval/request', (request, next) => holdInput(request, next))

  const rejection = (req) => {
    let connection
    try {
      connection = ctx.get('connection')
    } catch {}
    if (!connection || typeof connection.requestRejection !== 'function') return undefined
    try {
      return connection.requestRejection(req)
    } catch {
      return 403
    }
  }

  const disposeEvents = ctx.webServer.register({
    kind: 'exact',
    path: EVENTS_ROUTE,
    handler: (req, res) => {
      if (req.method !== 'GET' && req.method !== 'HEAD') {
        res.writeHead(405, { 'content-type': 'text/plain; charset=utf-8' })
        res.end('method not allowed\n')
        return
      }
      const code = rejection(req)
      if (code !== undefined && code !== null && code !== false) {
        res.writeHead(typeof code === 'number' ? code : 403, { 'content-type': 'text/plain; charset=utf-8' })
        res.end('forbidden\n')
        return
      }
      if (req.method === 'HEAD') {
        res.writeHead(200, { 'content-type': 'text/event-stream; charset=utf-8' })
        res.end()
        return
      }

      res.writeHead(200, {
        'content-type': 'text/event-stream; charset=utf-8',
        'cache-control': 'no-cache, no-transform',
        'connection': 'keep-alive',
        'x-accel-buffering': 'no',
      })
      // Reconnect quickly after a host restart, and force a live channel even
      // when no state changes for a while.
      res.write('retry: 3000\n\n')
      res.write(': connected\n\n')
      clients.add(res)

      let ping
      const cleanup = () => {
        if (ping !== undefined) clearInterval(ping)
        clients.delete(res)
      }

      try {
        res.write(sseFrame(snapshot()))
      } catch {
        cleanup()
        return
      }

      ping = setInterval(() => {
        try {
          res.write(': ping\n\n')
        } catch {
          cleanup()
        }
      }, KEEPALIVE_MS)
      if (typeof ping.unref === 'function') ping.unref()

      res.on('close', cleanup)
      res.on('error', cleanup)
    },
  })

  const disposeClient = ctx.webServer.register({
    kind: 'exact',
    path: CLIENT_ROUTE,
    handler: (req, res) => {
      if (req.method !== 'GET' && req.method !== 'HEAD') {
        res.writeHead(405, { 'content-type': 'text/plain; charset=utf-8' })
        res.end('method not allowed\n')
        return
      }
      let js
      try {
        js = fs.readFileSync(CLIENT_FILE)
      } catch (err) {
        res.writeHead(404, { 'content-type': 'text/plain; charset=utf-8' })
        res.end(`client.js unavailable: ${err && err.message ? err.message : err}\n`)
        return
      }
      res.writeHead(200, {
        'content-type': 'application/javascript; charset=utf-8',
        'cache-control': 'no-store',
        'content-length': Buffer.byteLength(js),
      })
      res.end(req.method === 'HEAD' ? undefined : js)
    },
  })

  const disposeTap = typeof ctx.webServer.tapIndex === 'function'
    ? ctx.webServer.tapIndex((html) => {
      if (typeof html !== 'string' || html.indexOf(CLIENT_ROUTE) !== -1) return html
      return html.indexOf('</body>') !== -1
        ? html.replace('</body>', `${CLIENT_TAG}</body>`)
        : html + CLIENT_TAG
    })
    : undefined

  ctx.effect(() => () => {
    disposed = true
    clearInterval(reconcileTimer)
    for (const res of [...clients]) {
      try {
        res.end()
      } catch {}
    }
    clients.clear()
    try {
      disposeEvents()
    } catch {}
    try {
      disposeClient()
    } catch {}
    try {
      if (typeof disposeTap === 'function') disposeTap()
    } catch {}
  })

  console.log('[dsh-tab-indicator] ready')
}
