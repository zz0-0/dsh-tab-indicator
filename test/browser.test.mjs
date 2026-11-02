/**
 * End-to-end check of the browser half in a real Chromium.
 *
 * Run with the Playwright core and Chromium paths available in this
 * environment, for example:
 *
 *   PLAYWRIGHT_CORE=/path/to/playwright-core/index.mjs \
 *   CHROMIUM_PATH=/path/to/chromium \
 *   node --test test/browser.test.mjs
 */
import assert from 'node:assert/strict'
import fs from 'node:fs'
import http from 'node:http'
import path from 'node:path'
import { fileURLToPath } from 'node:url'

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..')
const OUT = path.join(ROOT, 'test', 'out')
const CLIENT = fs.readFileSync(path.join(ROOT, 'client.js'), 'utf8')

const HTML = `<!doctype html>
<html lang="en">
<head>
  <meta charset="utf-8">
  <link rel="icon" type="image/svg+xml" href="/favicon-dark.svg" media="(prefers-color-scheme: dark)">
  <link rel="icon" type="image/svg+xml" href="/favicon.svg" media="(prefers-color-scheme: light)">
  <title>Session — DSH Local Build</title>
</head>
<body>
  <h1>DSH tab-indicator fixture</h1>
  <script defer src="/dsh-tab-indicator/client.js"></script>
</body>
</html>`

const FAVICON_LIGHT = `<svg xmlns="http://www.w3.org/2000/svg" width="50" height="50" viewBox="0 0 50 50">
  <rect width="50" height="50" rx="10" fill="#4d6bfe"/>
  <circle cx="25" cy="25" r="10" fill="#ffffff"/>
</svg>`

const FAVICON_DARK = `<svg xmlns="http://www.w3.org/2000/svg" width="50" height="50" viewBox="0 0 50 50">
  <rect width="50" height="50" rx="10" fill="#101827"/>
  <circle cx="25" cy="25" r="10" fill="#e5e7eb"/>
</svg>`

let running = 0
const clients = new Set()

function frame() {
  return `data: ${JSON.stringify({ type: 'state', running, sessions: [], at: Date.now() })}\n\n`
}

function broadcast() {
  for (const res of clients) res.write(frame())
}

const server = http.createServer((req, res) => {
  const url = new URL(req.url, 'http://127.0.0.1')
  if (url.pathname === '/') {
    res.writeHead(200, { 'content-type': 'text/html; charset=utf-8' })
    res.end(HTML)
    return
  }
  if (url.pathname === '/favicon.svg') {
    res.writeHead(200, { 'content-type': 'image/svg+xml' })
    res.end(FAVICON_LIGHT)
    return
  }
  if (url.pathname === '/favicon-dark.svg') {
    res.writeHead(200, { 'content-type': 'image/svg+xml' })
    res.end(FAVICON_DARK)
    return
  }
  if (url.pathname === '/dsh-tab-indicator/client.js') {
    res.writeHead(200, { 'content-type': 'application/javascript; charset=utf-8' })
    res.end(CLIENT)
    return
  }
  if (url.pathname === '/dsh-tab-indicator/events') {
    res.writeHead(200, {
      'content-type': 'text/event-stream; charset=utf-8',
      'cache-control': 'no-cache',
      'connection': 'keep-alive',
    })
    res.write('retry: 1000\n\n: connected\n\n')
    res.write(frame())
    clients.add(res)
    res.on('close', () => clients.delete(res))
    return
  }
  if (url.pathname === '/control') {
    running = Math.max(0, Number(url.searchParams.get('running')) || 0)
    broadcast()
    res.writeHead(200, { 'content-type': 'text/plain' })
    res.end('ok')
    return
  }
  res.writeHead(404)
  res.end()
})

function waitForClient(timeoutMs = 5000) {
  const started = Date.now()
  return new Promise((resolve, reject) => {
    const tick = () => {
      if (clients.size > 0) return resolve()
      if (Date.now() - started > timeoutMs) return reject(new Error('no SSE client connected'))
      setTimeout(tick, 25)
    }
    tick()
  })
}

function writeDataUrl(name, dataUrl) {
  const [, base64] = dataUrl.split(',')
  fs.writeFileSync(path.join(OUT, name), Buffer.from(base64, 'base64'))
}

const core = process.env.PLAYWRIGHT_CORE
const executablePath = process.env.CHROMIUM_PATH
if (!core || !executablePath) {
  console.error('PLAYWRIGHT_CORE and CHROMIUM_PATH are required')
  process.exit(2)
}
const { chromium } = await import(core)

fs.mkdirSync(OUT, { recursive: true })
await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve))
const base = `http://127.0.0.1:${server.address().port}`

const browser = await chromium.launch({ headless: true, executablePath, args: ['--no-sandbox'] })
const context = await browser.newContext({ colorScheme: 'light' })

async function setRunning(count) {
  await fetch(`${base}/control?running=${count}`)
}

async function titleOf(page) {
  return page.evaluate(() => document.title)
}

async function stateOf(page) {
  return page.evaluate(() => window.__DSH_TAB_INDICATOR__.getState())
}

async function iconsOf(page) {
  return page.evaluate(() => [...document.querySelectorAll('link[rel~="icon"]')].map((link) => ({
    href: link.getAttribute('href'),
    resolved: link.href,
    type: link.getAttribute('type'),
    media: link.getAttribute('media'),
  })))
}

async function basePixelOf(page, dataUrl) {
  return page.evaluate(async (href) => {
    const img = new Image()
    img.src = href
    await img.decode()
    const canvas = document.createElement('canvas')
    canvas.width = 64
    canvas.height = 64
    const ctx = canvas.getContext('2d')
    ctx.drawImage(img, 0, 0, 64, 64)
    return [...ctx.getImageData(32, 8, 1, 1).data]
  }, dataUrl)
}

const page = await context.newPage()
try {
  await page.goto(base)
  await page.waitForFunction(() => Boolean(window.__DSH_TAB_INDICATOR__?.getState))
  await waitForClient()

  assert.equal(await titleOf(page), 'Session — DSH Local Build')
  let state = await stateOf(page)
  assert.equal(state.phase, 'idle')
  assert.equal(state.running, 0)

  let icons = await iconsOf(page)
  assert.deepEqual(icons.map((icon) => icon.href), ['/favicon-dark.svg', '/favicon.svg'])
  assert.ok(icons.every((icon) => icon.type === 'image/svg+xml'))

  // ---- one run ------------------------------------------------------------
  await setRunning(1)
  await page.waitForFunction(() => window.__DSH_TAB_INDICATOR__.getState().running === 1)
  assert.equal(await titleOf(page), 'Session — DSH Local Build')
  icons = await iconsOf(page)
  assert.ok(icons.every((icon) => icon.resolved.startsWith('data:image/png;base64,')))
  assert.ok(icons.every((icon) => icon.type === 'image/png'))
  writeDataUrl('running-1.png', icons[1].resolved)

  // The favicon must stay static between state changes; otherwise the
  // browser's own loading indicator (including the bookmark icon) restarts.
  const steadyHref = await page.evaluate(() => document.querySelectorAll('link[rel~="icon"]')[1].href)
  await page.waitForTimeout(500)
  const steadyAgain = await page.evaluate(() => document.querySelectorAll('link[rel~="icon"]')[1].href)
  assert.equal(steadyAgain, steadyHref, 'running favicon is static while the count is steady')

  // Light mode must composite the light favicon.
  const lightPixel = await basePixelOf(page, icons[1].resolved)
  assert.equal(lightPixel[3], 255)
  assert.ok(lightPixel[2] > 180 && lightPixel[0] < 140, `light favicon used: ${lightPixel}`)

  // ---- two runs -----------------------------------------------------------
  await setRunning(2)
  await page.waitForFunction(() => {
    const state = window.__DSH_TAB_INDICATOR__.getState()
    return state.running === 2
  })
  await page.waitForFunction(() => document.title === '(2) Session — DSH Local Build')
  icons = await iconsOf(page)
  writeDataUrl('running-2.png', icons[1].resolved)

  // React replaces the title; the decoration must follow.
  await page.evaluate(() => { document.title = 'Renamed — DSH' })
  await page.waitForFunction(() => document.title === '(2) Renamed — DSH')

  // ---- one of two completes: show the check, then resume running -----------
  await setRunning(1)
  await page.waitForFunction(() => window.__DSH_TAB_INDICATOR__.getState().flash === true)
  await page.waitForFunction(() => document.title === '\u2713 Renamed — DSH')
  await page.waitForFunction(() => {
    const state = window.__DSH_TAB_INDICATOR__.getState()
    return state.flash === false && state.running === 1 && state.phase === 'running'
  }, undefined, { timeout: 5000 })
  await page.waitForFunction(() => document.title === 'Renamed — DSH')

  // ---- done while away ----------------------------------------------------
  const other = await context.newPage()
  await other.goto('about:blank')
  await other.bringToFront()
  await page.waitForTimeout(200)
  const away = await page.evaluate(() => ({
    visibility: document.visibilityState,
    focus: typeof document.hasFocus === 'function' ? document.hasFocus() : null,
  }))
  console.log('page after bringToFront:', away)

  if (away.visibility !== 'hidden' && away.focus !== false) {
    // Headless Chromium can keep every page "visible"; emulate a backgrounded
    // tab so the away-completion branch is still exercised.
    await page.evaluate(() => {
      Object.defineProperty(Document.prototype, 'visibilityState', { configurable: true, get: () => 'hidden' })
      Object.defineProperty(Document.prototype, 'hidden', { configurable: true, get: () => true })
    })
  }

  await setRunning(0)
  await page.waitForFunction(() => {
    const state = window.__DSH_TAB_INDICATOR__.getState()
    return state.phase === 'done' && state.flash === false
  })
  await page.waitForFunction(() => document.title === '\u2713 Renamed — DSH')
  icons = await iconsOf(page)
  writeDataUrl('done.png', icons[1].resolved)

  // ---- returning clears the done mark ------------------------------------
  await page.evaluate(() => {
    if (Object.getOwnPropertyDescriptor(Document.prototype, 'visibilityState')?.get?.toString().includes('hidden')) {
      Object.defineProperty(Document.prototype, 'visibilityState', { configurable: true, get: () => 'visible' })
      Object.defineProperty(Document.prototype, 'hidden', { configurable: true, get: () => false })
      document.dispatchEvent(new Event('visibilitychange'))
    }
  })
  await page.bringToFront()
  await page.waitForFunction(() => document.title === 'Renamed — DSH', undefined, { timeout: 5000 })
  await page.waitForFunction(() => [...document.querySelectorAll('link[rel~="icon"]')]
    .every((link) => !(link.getAttribute('href') || '').startsWith('data:')))
  icons = await iconsOf(page)
  assert.deepEqual(icons.map((icon) => icon.href), ['/favicon-dark.svg', '/favicon.svg'])
  assert.ok(icons.every((icon) => icon.type === 'image/svg+xml'))

  // ---- a completion while focused flashes, then goes idle -----------------
  await page.evaluate(() => {
    Object.defineProperty(Document.prototype, 'hasFocus', { configurable: true, value: () => true })
  })
  await setRunning(1)
  await page.waitForFunction(() => window.__DSH_TAB_INDICATOR__.getState().running === 1)
  await setRunning(0)
  await page.waitForFunction(() => window.__DSH_TAB_INDICATOR__.getState().flash === true)
  await page.waitForFunction(() => document.title === '\u2713 Renamed — DSH')
  await page.waitForFunction(() => {
    const state = window.__DSH_TAB_INDICATOR__.getState()
    return state.phase === 'idle' && state.flash === false
  }, undefined, { timeout: 5000 })
  await page.waitForFunction(() => document.title === 'Renamed — DSH')

  await page.screenshot({ path: path.join(OUT, 'page.png'), fullPage: true })

  // ---- dark scheme picks the dark favicon ---------------------------------
  await setRunning(1)
  const darkContext = await browser.newContext({ colorScheme: 'dark' })
  const darkPage = await darkContext.newPage()
  await darkPage.goto(base)
  await darkPage.waitForFunction(() => Boolean(window.__DSH_TAB_INDICATOR__?.getState))
  await darkPage.waitForFunction(() => window.__DSH_TAB_INDICATOR__.getState().running === 1)
  const darkIcons = await iconsOf(darkPage)
  assert.ok(darkIcons.every((icon) => icon.resolved.startsWith('data:image/png;base64,')))
  const darkPixel = await basePixelOf(darkPage, darkIcons[0].resolved)
  assert.equal(darkPixel[3], 255)
  assert.ok(darkPixel[0] < 60 && darkPixel[2] < 100, `dark favicon used: ${darkPixel}`)
  await darkContext.close()
  await setRunning(0)

  console.log('browser test passed')
} finally {
  await browser.close()
  for (const res of clients) res.end()
  await new Promise((resolve) => server.close(resolve))
}
