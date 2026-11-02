/**
 * Browser half of the tab indicator.
 *
 * The host publishes the number of root agents that are currently running over
 * `GET /dsh-tab-indicator/events` (SSE). This script decorates the tab:
 *
 *   idle     original favicon, original title
 *   running  favicon with a blue count badge; `(N)` in the title when N > 1
 *   done     favicon with a green check; `✓` in the title
 *
 * The favicon is intentionally static between state changes. Chrome treats
 * every `<link rel=icon>` href change as a fresh favicon load, so continuously
 * animating it makes the browser's own loading indicator — including the one on
 * the bookmark bar — restart over and over. There is no native animated favicon
 * in Chrome, so the icon only repaints when the running count or state changes.
 *
 * The page title is owned by React (`DocumentTitle`), so a MutationObserver
 * re-applies the decoration whenever the application replaces the title.
 */
;(() => {
  'use strict'

  if (window.__DSH_TAB_INDICATOR__) return

  const DONE_MARK = '\u2713'
  // Strip our own decorations if the page was already decorated; `●` is kept
  // for pages that still have the previous version's title.
  const PREFIX = new RegExp(`^(?:\\u25CF(?:\\s*\\d+)?\\s*|${DONE_MARK}\\s*|\\(\\d+\\)\\s*)`, 'u')
  const EVENTS_URL = '/dsh-tab-indicator/events'
  const ICON_SIZE = 64
  const DONE_HOLD_MS = 1200
  const FLASH_MS = 1100

  /** @type {'idle' | 'running' | 'done'} */
  let phase = 'idle'
  let running = 0
  /** A completion is being shown while other work remains (visible tabs only). */
  let flash = false
  let baseTitle = stripPrefix(document.title || '')
  let doneTimer = 0
  let flashTimer = 0

  const originalIcons = new Map()
  let createdIcon = null
  let baseImage = null
  let baseIconState = 'idle'
  let baseCanvas = null
  /** Last painted icon identity, so a duplicate render does not reload it. */
  let lastIconKey = null

  const renderCanvas = document.createElement('canvas')
  renderCanvas.width = ICON_SIZE
  renderCanvas.height = ICON_SIZE
  const renderCtx = renderCanvas.getContext('2d')

  window.__DSH_TAB_INDICATOR__ = {
    version: 4,
    getState() {
      return { phase, running, flash, visible: isVisible() }
    },
  }

  function stripPrefix(value) {
    return String(value || '').replace(PREFIX, '')
  }

  function isVisible() {
    return document.visibilityState !== 'hidden'
  }

  function isAway() {
    if (!isVisible()) return true
    try {
      return typeof document.hasFocus === 'function' && !document.hasFocus()
    } catch {
      return false
    }
  }

  function labelOf(count) {
    return count > 9 ? '9+' : String(count)
  }

  // ---------------------------------------------------------------- title --

  function titlePrefix() {
    if (flash || phase === 'done') return `${DONE_MARK} `
    if (phase === 'running' && running > 1) return `(${running}) `
    return ''
  }

  function syncTitle() {
    const current = document.title || ''
    const currentBase = stripPrefix(current)
    if (currentBase !== baseTitle) baseTitle = currentBase
    const next = titlePrefix() + baseTitle
    if (current !== next) document.title = next
  }

  const titleObserver = new MutationObserver(() => syncTitle())
  if (document.head) {
    titleObserver.observe(document.head, { childList: true, characterData: true, subtree: true })
  }

  // --------------------------------------------------------------- favicon --

  function iconLinks() {
    return Array.from(document.querySelectorAll('link[rel~="icon"]'))
  }

  function rememberIcons() {
    const links = iconLinks()
    if (!links.length && !createdIcon) {
      const link = document.createElement('link')
      link.rel = 'icon'
      document.head.appendChild(link)
      createdIcon = link
      originalIcons.set(link, { href: '', type: '' })
      return
    }
    for (const link of links) {
      if (originalIcons.has(link)) continue
      originalIcons.set(link, {
        href: link.getAttribute('href') || '',
        type: link.getAttribute('type') || '',
      })
    }
  }

  function baseIconHref() {
    // The page may carry one icon per color scheme. Composite the variant the
    // browser is currently using, otherwise a light tab bar would get the
    // white dark-mode whale.
    for (const link of iconLinks()) {
      const media = link.getAttribute('media')
      if (!media || typeof window.matchMedia !== 'function') continue
      try {
        if (!window.matchMedia(media).matches) continue
      } catch {
        continue
      }
      const original = originalIcons.get(link)
      if (original && original.href) return new URL(original.href, document.baseURI).href
    }
    for (const [, original] of originalIcons) {
      if (original.href) return new URL(original.href, document.baseURI).href
    }
    return new URL('favicon.svg', document.baseURI).href
  }

  function fallbackBase(ctx) {
    ctx.fillStyle = '#4d6bfe'
    ctx.beginPath()
    const r = 12
    const [x, y, w, h] = [4, 4, ICON_SIZE - 8, ICON_SIZE - 8]
    ctx.moveTo(x + r, y)
    ctx.arcTo(x + w, y, x + w, y + h, r)
    ctx.arcTo(x + w, y + h, x, y + h, r)
    ctx.arcTo(x, y + h, x, y, r)
    ctx.arcTo(x, y, x + w, y, r)
    ctx.closePath()
    ctx.fill()
  }

  function rebuildBase() {
    const canvas = document.createElement('canvas')
    canvas.width = ICON_SIZE
    canvas.height = ICON_SIZE
    const ctx = canvas.getContext('2d')
    if (!ctx) {
      baseCanvas = null
      return
    }
    if (baseImage) {
      try {
        ctx.drawImage(baseImage, 0, 0, ICON_SIZE, ICON_SIZE)
      } catch {
        fallbackBase(ctx)
      }
    } else {
      fallbackBase(ctx)
    }
    baseCanvas = canvas
  }

  function loadBaseIcon() {
    if (baseIconState !== 'idle') return
    baseIconState = 'loading'
    const img = new Image()
    img.onload = () => {
      baseImage = img
      baseIconState = 'ready'
      rebuildBase()
      lastIconKey = null
      paintIcon()
    }
    img.onerror = () => {
      baseIconState = 'failed'
      rebuildBase()
      lastIconKey = null
      paintIcon()
    }
    img.src = baseIconHref()
  }

  function reloadBaseIcon() {
    baseImage = null
    baseIconState = 'idle'
    baseCanvas = null
    lastIconKey = null
    loadBaseIcon()
    paintIcon()
  }

  try {
    const scheme = window.matchMedia('(prefers-color-scheme: dark)')
    if (typeof scheme.addEventListener === 'function') scheme.addEventListener('change', reloadBaseIcon)
    else if (typeof scheme.addListener === 'function') scheme.addListener(reloadBaseIcon)
  } catch {}

  function circle(ctx, cx, cy, radius, fill) {
    ctx.beginPath()
    ctx.arc(cx, cy, radius, 0, Math.PI * 2)
    ctx.fillStyle = fill
    ctx.fill()
  }

  function drawBase(ctx) {
    if (baseCanvas) ctx.drawImage(baseCanvas, 0, 0, ICON_SIZE, ICON_SIZE)
    else fallbackBase(ctx)
  }

  function drawRunningBadge(ctx, label) {
    circle(ctx, 42.5, 42.5, 17, 'rgba(255, 255, 255, 0.96)')
    circle(ctx, 42.5, 42.5, 14.5, '#2f6fed')
    const text = label || '1'
    const size = text.length > 1 ? 13 : 16
    ctx.fillStyle = '#ffffff'
    ctx.font = `700 ${size}px -apple-system, BlinkMacSystemFont, "Segoe UI", system-ui, sans-serif`
    ctx.textAlign = 'center'
    ctx.textBaseline = 'middle'
    ctx.fillText(text, 42.5, 43)
  }

  function drawDoneBadge(ctx) {
    circle(ctx, 42.5, 42.5, 17, 'rgba(255, 255, 255, 0.96)')
    circle(ctx, 42.5, 42.5, 14.5, '#1f9d55')
    ctx.strokeStyle = '#ffffff'
    ctx.lineWidth = 4.5
    ctx.lineCap = 'round'
    ctx.lineJoin = 'round'
    ctx.beginPath()
    ctx.moveTo(36, 42.5)
    ctx.lineTo(41, 47.5)
    ctx.lineTo(49.5, 36.5)
    ctx.stroke()
  }

  function applyIconUrl(url) {
    rememberIcons()
    for (const [link, original] of originalIcons) {
      if (!link.isConnected) continue
      if (url) {
        link.setAttribute('href', url)
        link.setAttribute('type', 'image/png')
      } else if (original.href) {
        link.setAttribute('href', original.href)
        if (original.type) link.setAttribute('type', original.type)
        else link.removeAttribute('type')
      } else if (link === createdIcon) {
        link.remove()
        originalIcons.delete(link)
        createdIcon = null
      }
    }
  }

  function paintIcon() {
    const kind = flash || phase === 'done' ? 'done' : phase === 'running' ? 'running' : 'idle'
    const key = kind === 'running' ? `running:${running}` : kind
    if (key === lastIconKey) return
    lastIconKey = key

    if (kind === 'idle') {
      applyIconUrl(null)
      return
    }
    if (!renderCtx) return

    renderCtx.clearRect(0, 0, ICON_SIZE, ICON_SIZE)
    drawBase(renderCtx)
    if (kind === 'done') drawDoneBadge(renderCtx)
    else drawRunningBadge(renderCtx, labelOf(running))
    applyIconUrl(renderCanvas.toDataURL('image/png'))
  }

  // ------------------------------------------------------------------ state --

  function render() {
    syncTitle()
    paintIcon()
  }

  function scheduleDoneClear() {
    if (flash || phase !== 'done') return
    if (!isVisible()) return
    clearTimeout(doneTimer)
    doneTimer = setTimeout(() => {
      if (flash || phase !== 'done') return
      phase = 'idle'
      render()
    }, DONE_HOLD_MS)
  }

  function beginFlash() {
    flash = true
    clearTimeout(flashTimer)
    render()
    flashTimer = setTimeout(() => {
      flash = false
      if (running > 0) {
        phase = 'running'
        render()
      } else if (isAway()) {
        phase = 'done'
        render()
      } else {
        phase = 'idle'
        render()
      }
    }, FLASH_MS)
  }

  function setRunning(next) {
    const count = Number.isFinite(Number(next)) ? Math.max(0, Math.trunc(Number(next))) : 0
    const previous = running
    const hadRunning = previous > 0 || phase === 'running' || flash
    running = count

    if (count > 0) {
      // A duplicate snapshot while the completion flash runs must not cancel it.
      if (flash && previous === count) return
      clearTimeout(doneTimer)
      clearTimeout(flashTimer)
      flash = false
      if (previous > count && hadRunning && isVisible()) {
        beginFlash()
      } else {
        phase = 'running'
        render()
      }
      return
    }

    if (!hadRunning) {
      if (phase === 'done') render()
      return
    }

    // Reconnect snapshots can repeat the zero that already started a flash.
    if (flash && previous === 0) return

    clearTimeout(flashTimer)
    flash = false
    if (isVisible()) {
      beginFlash()
    } else {
      phase = 'done'
      render()
    }
  }

  document.addEventListener('visibilitychange', () => {
    if (!isVisible()) {
      if (flash) {
        flash = false
        clearTimeout(flashTimer)
        phase = running > 0 ? 'running' : 'done'
      } else if (phase === 'running' && running === 0) {
        phase = 'done'
      }
      render()
      return
    }

    render()
    if (phase === 'done' && !flash) scheduleDoneClear()
  })
  window.addEventListener('focus', scheduleDoneClear)

  // -------------------------------------------------------------------- SSE --

  let source = null

  function connect() {
    if (typeof EventSource === 'undefined') return
    if (location.protocol !== 'http:' && location.protocol !== 'https:') return
    try {
      source = new EventSource(EVENTS_URL)
    } catch {
      return
    }
    source.addEventListener('message', (event) => {
      let data
      try {
        data = JSON.parse(event.data)
      } catch {
        return
      }
      if (data && typeof data.running === 'number') setRunning(data.running)
    })
    // EventSource reconnects by itself; the next message is a full snapshot.
    source.addEventListener('error', () => {})
  }

  // ------------------------------------------------------------------- boot --

  rememberIcons()
  loadBaseIcon()
  syncTitle()
  connect()

  // Recover if the application replaces a favicon link after boot.
  const headObserver = new MutationObserver((records) => {
    let touched = false
    for (const record of records) {
      for (const node of [...record.addedNodes, ...record.removedNodes]) {
        if (node.nodeType === 1 && node.tagName === 'LINK' && /\bicon\b/.test(node.getAttribute('rel') || '')) {
          touched = true
        }
      }
    }
    if (!touched) return
    rememberIcons()
    reloadBaseIcon()
  })
  if (document.head) headObserver.observe(document.head, { childList: true, subtree: true })
})()
