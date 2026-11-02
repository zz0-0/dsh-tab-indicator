import assert from 'node:assert/strict'
import { EventEmitter } from 'node:events'
import test from 'node:test'

import { apply } from '../lib/index.js'

class MockResponse extends EventEmitter {
  constructor() {
    super()
    this.status = 0
    this.headers = {}
    this.chunks = []
    this.ended = false
  }

  writeHead(status, headers = {}) {
    this.status = status
    this.headers = { ...this.headers, ...headers }
  }

  write(chunk) {
    this.chunks.push(String(chunk))
    return true
  }

  end(chunk) {
    if (chunk !== undefined) this.chunks.push(String(chunk))
    if (this.ended) return
    this.ended = true
    this.emit('close')
  }
}

function createContext({ roots = [], rejection } = {}) {
  const routes = new Map()
  const taps = []
  const listeners = new Map()
  const disposers = []

  const ctx = {
    agents: {
      roots: () => roots,
    },
    webServer: {
      register(route) {
        routes.set(route.path, route)
        return () => routes.delete(route.path)
      },
      tapIndex(fn) {
        taps.push(fn)
        return () => {}
      },
    },
    on(name, fn) {
      const list = listeners.get(name)
      if (list) list.push(fn)
      else listeners.set(name, [fn])
      return () => {}
    },
    get(name) {
      if (name !== 'connection') return undefined
      return {
        requestRejection: rejection || (() => undefined),
      }
    },
    effect(fn) {
      disposers.push(fn())
    },
  }

  return { ctx, routes, taps, listeners, disposers }
}

function rootAgent(id, status = 'running') {
  return {
    id,
    status,
    session: { id, header: { id, origin: undefined } },
  }
}

function subagent(id) {
  return {
    id,
    status: 'running',
    session: { id, header: { id, origin: 'subagent' } },
  }
}

function emit(listeners, name, payload) {
  for (const fn of listeners.get(name) || []) fn(payload)
}

function stateFrames(response) {
  return response.chunks
    .join('')
    .split('\n\n')
    .map((frame) => frame.trim())
    .filter((frame) => frame.startsWith('data: '))
    .map((frame) => JSON.parse(frame.slice('data: '.length)))
}

function openStream(routes) {
  const route = routes.get('/dsh-tab-indicator/events')
  const response = new MockResponse()
  route.handler({ method: 'GET', headers: {} }, response)
  return response
}

test('streams the initial empty snapshot', () => {
  const { ctx, routes } = createContext()
  apply(ctx)

  const response = openStream(routes)
  assert.equal(response.status, 200)
  assert.match(response.headers['content-type'], /text\/event-stream/)
  assert.match(response.chunks.join(''), /^retry: 3000\n\n: connected\n\n/)
  const [state] = stateFrames(response)
  assert.equal(state.type, 'state')
  assert.equal(state.running, 0)
  assert.deepEqual(state.sessions, [])
})

test('counts running roots and ignores subagents', () => {
  const { ctx, routes, listeners } = createContext()
  apply(ctx)
  const response = openStream(routes)

  const root = rootAgent('root-1')
  emit(listeners, 'agent/status', { agent: root, status: 'running' })
  let frames = stateFrames(response)
  assert.equal(frames.at(-1).running, 1)
  assert.deepEqual(frames.at(-1).sessions, ['root-1'])

  emit(listeners, 'agent/status', { agent: rootAgent('root-2'), status: 'running' })
  frames = stateFrames(response)
  assert.equal(frames.at(-1).running, 2)
  assert.deepEqual(frames.at(-1).sessions, ['root-1', 'root-2'])

  // A child turn is part of its root turn: it must not inflate the count.
  emit(listeners, 'agent/status', { agent: subagent('child-1'), status: 'running' })
  frames = stateFrames(response)
  assert.equal(frames.at(-1).running, 2)

  emit(listeners, 'agent/status', { agent: root, status: 'idle' })
  frames = stateFrames(response)
  assert.equal(frames.at(-1).running, 1)
  assert.deepEqual(frames.at(-1).sessions, ['root-2'])
})

test('initial scan includes roots that are already running', () => {
  const already = rootAgent('warm-1')
  const idle = rootAgent('warm-2', 'idle')
  const { ctx, routes } = createContext({ roots: [already, idle] })
  apply(ctx)

  const response = openStream(routes)
  const [state] = stateFrames(response)
  assert.equal(state.running, 1)
  assert.deepEqual(state.sessions, ['warm-1'])
})

test('disposal removes a running agent from the snapshot', () => {
  const { ctx, routes, listeners } = createContext()
  apply(ctx)
  const response = openStream(routes)
  const agent = rootAgent('gone-1')

  emit(listeners, 'agent/status', { agent, status: 'running' })
  assert.equal(stateFrames(response).at(-1).running, 1)

  emit(listeners, 'agent/disposed', { agent })
  assert.equal(stateFrames(response).at(-1).running, 0)
})

test('honors the connection trust rejection', () => {
  const { ctx, routes } = createContext({ rejection: () => 401 })
  apply(ctx)

  const response = openStream(routes)
  assert.equal(response.status, 401)
  assert.equal(response.chunks.join(''), 'forbidden\n')
})

test('injects the client script once', () => {
  const { ctx, taps } = createContext()
  apply(ctx)

  assert.equal(taps.length, 1)
  const html = '<!doctype html><html><head></head><body></body></html>'
  const injected = taps[0](html)
  assert.match(injected, /<script defer src="\/dsh-tab-indicator\/client\.js\?v=1"><\/script><\/body>/)
  assert.equal(taps[0](injected), injected)
})

test('serves the browser script with no-store', () => {
  const { ctx, routes } = createContext()
  apply(ctx)

  const route = routes.get('/dsh-tab-indicator/client.js')
  const response = new MockResponse()
  route.handler({ method: 'GET', headers: {} }, response)

  assert.equal(response.status, 200)
  assert.match(response.headers['content-type'], /javascript/)
  assert.equal(response.headers['cache-control'], 'no-store')
  assert.match(response.chunks.join(''), /__DSH_TAB_INDICATOR__/)
})

test('dispose ends open streams and removes routes', () => {
  const { ctx, routes, disposers } = createContext()
  apply(ctx)
  const response = openStream(routes)
  assert.equal(response.ended, false)

  for (const dispose of disposers) dispose()

  assert.equal(response.ended, true)
  assert.equal(routes.has('/dsh-tab-indicator/events'), false)
  assert.equal(routes.has('/dsh-tab-indicator/client.js'), false)
})
