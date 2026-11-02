# dsh-tab-indicator

A DeepSeek Harness plugin for:

- a running / done indicator on the DSH browser tab
- a numeric badge for concurrent root sessions
- a `(N)` title prefix when more than one session is running
- a green check when a run finishes while you are on another tab

![screenshot](./screenshot.png)

## Install

Public install:

```bash
dsh plugin --profile web add github:zz0-0/dsh-tab-indicator
systemctl --user restart dsh-web
```

Local development install:

```bash
dsh plugin --profile web add link:/path/to/dsh-tab-indicator-plugin
systemctl --user restart dsh-web
```

The restart closes the open Web UI; reload the page after it comes back.

Remove:

```bash
dsh plugin --profile web remove dsh-tab-indicator
systemctl --user restart dsh-web
```

## Behavior

- Counts **root agents** only. Subagent turns are part of their root turn and do
  not inflate the number. Counts above 9 show `9+`.
- Running sessions show a blue count badge in the favicon. The title is left
  alone for one run and gets `(N)` only when N > 1. There is no title dot.
- When a run finishes, the tab shows a green check for about a second. If other
  runs are still active, the count badge comes back. If nothing remains, the
  check stays only when the tab is hidden or unfocused; a run you were watching
  clears back to the normal title.
- State arrives over a Server-Sent Events channel. There is no polling, so
  background-tab timer throttling cannot delay the update, and the tab catches
  up automatically after a host restart.
- The page title is owned by React (`DocumentTitle`). A `MutationObserver`
  re-applies the decoration whenever the application rewrites the title.
- The favicon uses the light or dark variant the browser is currently showing,
  and is regenerated if the color scheme changes. The original `<link>` elements
  are restored when the run ends.
- The stream route reuses the page's existing cookie trust check, so it is not
  readable anonymously.

## Why the favicon is static

The icon is repainted only when the running count or the running/done state
changes. It is intentionally not animated between those changes.

Chrome treats every `<link rel="icon">` href change as a fresh favicon load. Its
own loading indicator — including the one on the bookmark bar — restarts for
each load, so a continuously animated favicon makes the bookmark icon churn.
Chrome has no native animated favicon (GIF favicons show the first frame only,
and SVG/CSS animation is ignored), so there is no way to animate the icon
without that reload behavior. A static badge is the deliberate trade-off.

## How it works

The host half injects one deferred script into the Web UI index and publishes a
tiny status snapshot:

```
GET /dsh-tab-indicator/events   text/event-stream
data: {"type":"state","running":1,"sessions":["…"],"at":…}
```

- `ctx.agents.roots()` seeds the snapshot for agents that are already running
  when the plugin loads.
- `agent/status` (`idle` / `running`) and `agent/disposed` keep it current.
- A 2-second reconciliation against `ctx.agents.roots()` repairs a transition
  missed across a plugin reload and removes a session whose agent is no longer
  running.
- `connection.requestRejection` guards the stream with the same browser cookie
  used by the rest of the Web API.
- `ctx.webServer.tapIndex` inserts
  `<script defer src="/dsh-tab-indicator/client.js?v=1">`.

The browser half (`client.js`) consumes the stream, decorates the title, and
paints a count/check badge on a 64×64 canvas over the page's original favicon.
It repaints only when the count or state changes.

## UI hooks

The browser half does not patch React. It uses the stable browser surfaces:

- `link[rel~="icon"]`, including the `media="(prefers-color-scheme: …)"` light
  and dark variants supplied by the DSH page
- `document.title`, which `DocumentTitle` owns; a `MutationObserver` keeps the
  `(N)` / `✓` decoration after the application rewrites it
- `/dsh-tab-indicator/events` for the host snapshot
- `ctx.webServer.tapIndex` for the injected client script

## Files

| File | Role |
|---|---|
| `package.json` | DSH bundle metadata |
| `cordis.patch.yml` | Inserts the plugin into the web profile |
| `lib/index.js` | Host: agent tracking, SSE route, client injection |
| `client.js` | Browser: title count/check, static favicon badge, flash/done state |
| `test/host.test.mjs` | Node tests for the host half |
| `test/browser.test.mjs` | Chromium test for title/favicon/done behavior |

## Editing

- `client.js` is served with `Cache-Control: no-store`: edit it, then reload the
  browser.
- `lib/index.js` is host-side: edit it, then `systemctl --user restart dsh-web`.
- The plugin is installed from a link or a GitHub checkout; reinstall when the
  installation source changes.

Run the host tests:

```bash
node --test test/host.test.mjs
```

Run the browser test (point the variables at a local Playwright core and
Chromium; the DSH development checkout ships both):

```bash
PLAYWRIGHT_CORE=/path/to/playwright-core/index.mjs \
CHROMIUM_PATH=/path/to/chromium \
node --test test/browser.test.mjs
```

Generated test artifacts land in `test/out/` and are git-ignored.

## Limitations

- It tracks **turn-level** activity. A background job that outlives its turn is
  not counted; adding the jobs service would be the next step if that matters.
- It is a Web-profile plugin: it needs `webServer` and `agents`.
- The favicon is a `data:image/png` URL. If a deployment adds a Content Security
  Policy, `img-src` must allow `data:` (the current Web index has no CSP).
- A fully closed browser cannot show anything, by definition.
- The favicon is static between state changes; see “Why the favicon is static”.
