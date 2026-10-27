/**
 * Tier 2: attach to a Chrome that has the DevTools protocol open.
 *
 * This is the only fallback that returns a *clean tab* screenshot without the
 * bridge, an extension, or macOS screen-recording permission.
 *
 * Two ways Chrome gets there:
 *  - new Chrome: `chrome://inspect/#remote-debugging` → tick "Remote debugging".
 *    Chrome starts a local server in approval mode, asks once for the app, and
 *    writes the chosen port to `<profile>/DevToolsActivePort` (which we read).
 *    Logins, tabs and extensions are untouched.
 *  - older setups / dev: launch with `--remote-debugging-port=9222`
 *    (`--user-data-dir` is required on Chrome 136+ for the default profile).
 *
 * One browser-level WebSocket per DSH process: flat-mode target sessions let us
 * probe several tabs and capture one without opening a socket per tab, so the
 * approval prompt happens once rather than on every click.
 */
import { CaptureError } from '../errors.js'
import { promises as fs } from 'node:fs'
import os from 'node:os'
import path from 'node:path'

const DEFAULT_PORTS = [9222, 9223]
const MAX_EVALUATED_TARGETS = 6

function activePortCandidates() {
  const home = os.homedir()
  if (process.platform === 'darwin') {
    const base = path.join(home, 'Library/Application Support')
    return [
      path.join(base, 'Google/Chrome/DevToolsActivePort'),
      path.join(base, 'Chromium/DevToolsActivePort'),
      path.join(base, 'Microsoft Edge/DevToolsActivePort'),
      path.join(base, 'BraveSoftware/Brave-Browser/DevToolsActivePort'),
    ]
  }
  if (process.platform === 'win32') {
    const base = process.env.LOCALAPPDATA ?? path.join(home, 'AppData/Local')
    return [path.join(base, 'Google/Chrome/User Data/DevToolsActivePort')]
  }
  const config = process.env.XDG_CONFIG_HOME ?? path.join(home, '.config')
  return [
    path.join(config, 'google-chrome/DevToolsActivePort'),
    path.join(config, 'chromium/DevToolsActivePort'),
    path.join(config, 'microsoft-edge/DevToolsActivePort'),
  ]
}

async function candidatePorts(env) {
  const ports = []
  const explicit = Number(env.DSH_CHROME_DEBUG_PORT)
  if (Number.isInteger(explicit) && explicit > 0 && explicit < 65536) ports.push(explicit)
  for (const file of activePortCandidates()) {
    try {
      const text = await fs.readFile(file, 'utf8')
      const port = Number(text.split('\n')[0])
      if (Number.isInteger(port) && port > 0 && port < 65536) ports.push(port)
    } catch {
      // No running browser with this profile: expected.
    }
  }
  ports.push(...DEFAULT_PORTS)
  return [...new Set(ports)]
}

async function fetchJson(url, timeoutMs) {
  const controller = new AbortController()
  const timer = setTimeout(() => controller.abort(), timeoutMs)
  try {
    const response = await fetch(url, { signal: controller.signal })
    if (!response.ok) throw new Error(`HTTP ${response.status}`)
    return await response.json()
  } finally {
    clearTimeout(timer)
  }
}

/** Minimal JSON-RPC over one WebSocket, with optional flat-mode sessionId. */
class CdpSession {
  constructor(socket) {
    this.socket = socket
    this.sequence = 0
    this.pending = new Map()
    this.closed = false
    socket.addEventListener('message', (event) => {
      let message
      try {
        message = JSON.parse(event.data)
      } catch {
        return
      }
      const entry = this.pending.get(message.id)
      if (entry === undefined) return
      this.pending.delete(message.id)
      if (message.error) entry.reject(new Error(message.error.message ?? 'CDP error'))
      else entry.resolve(message.result ?? {})
    })
    socket.addEventListener('close', () => {
      this.closed = true
      for (const entry of this.pending.values()) entry.reject(new Error('CDP socket closed'))
      this.pending.clear()
    })
  }

  static async open(url, timeoutMs = 4000) {
    if (typeof WebSocket !== 'function') {
      throw new CaptureError('cdp-unavailable', '当前运行时没有 WebSocket，CDP 降级不可用')
    }
    const socket = new WebSocket(url)
    await new Promise((resolve, reject) => {
      const timer = setTimeout(() => {
        try {
          socket.close()
        } catch {
          // ignore
        }
        reject(new Error('CDP connect timeout'))
      }, timeoutMs)
      socket.addEventListener('open', () => {
        clearTimeout(timer)
        resolve()
      }, { once: true })
      socket.addEventListener('error', () => {
        clearTimeout(timer)
        reject(new Error('CDP connect failed'))
      }, { once: true })
    })
    return new CdpSession(socket)
  }

  send(method, params = {}, timeoutMs = 15_000, sessionId) {
    if (this.closed) return Promise.reject(new Error('CDP socket closed'))
    const id = ++this.sequence
    return new Promise((resolve, reject) => {
      const timer = setTimeout(() => {
        this.pending.delete(id)
        reject(new Error(`CDP ${method} timeout`))
      }, timeoutMs)
      this.pending.set(id, {
        resolve: (value) => {
          clearTimeout(timer)
          resolve(value)
        },
        reject: (error) => {
          clearTimeout(timer)
          reject(error)
        },
      })
      const message = { id, method, params }
      if (sessionId !== undefined) message.sessionId = sessionId
      try {
        this.socket.send(JSON.stringify(message))
      } catch (error) {
        clearTimeout(timer)
        this.pending.delete(id)
        reject(error)
      }
    })
  }

  close() {
    if (this.closed) return
    this.closed = true
    try {
      this.socket.close()
    } catch {
      // ignore
    }
  }
}

// One browser-level connection for the life of the host. Approval mode asks
// once per connection, so reopening per click would prompt every time.
let browserLink = null

/** Drop the cached browser connection (plugin teardown / host shutdown). */
export function closeCdp() {
  closeBrowserLink()
}

function closeBrowserLink() {
  if (browserLink !== null) {
    browserLink.session.close()
    browserLink = null
  }
}

async function findDebugPort(env) {
  const ports = await candidatePorts(env)
  const attempts = []
  for (const port of ports) {
    try {
      const version = await fetchJson(`http://127.0.0.1:${port}/json/version`, 900)
      if (typeof version.webSocketDebuggerUrl === 'string' && version.webSocketDebuggerUrl !== '') {
        return { port, webSocketDebuggerUrl: version.webSocketDebuggerUrl, version }
      }
      attempts.push(`${port}: no browser WebSocket`)
    } catch (error) {
      attempts.push(`${port}: ${error instanceof Error ? error.message : String(error)}`)
    }
  }
  throw new CaptureError(
    'cdp-unavailable',
    '没有找到开着调试端口的 Chrome',
    '在 Chrome 打开 chrome://inspect/#remote-debugging 勾选 Remote debugging（保留登录态，推荐）；或用 --remote-debugging-port=9222 --user-data-dir=<独立目录> 启动 Chrome；端口不标准时设置 DSH_CHROME_DEBUG_PORT。',
  )
}

async function getBrowserSession(env) {
  if (browserLink !== null && !browserLink.session.closed) return browserLink
  const found = await findDebugPort(env)
  const session = await CdpSession.open(found.webSocketDebuggerUrl, 5000)
  browserLink = { port: found.port, session, version: found.version }
  session.socket.addEventListener('close', () => {
    if (browserLink !== null && browserLink.session === session) browserLink = null
  })
  return browserLink
}

function pageTargets(targetInfos) {
  return targetInfos.filter(
    (target) => target !== null && typeof target === 'object' && target.type === 'page',
  )
}

async function attach(session, targetId) {
  const { sessionId } = await session.send('Target.attachToTarget', { targetId, flatten: true }, 5000)
  if (typeof sessionId !== 'string') throw new Error('CDP attach returned no sessionId')
  return sessionId
}

async function evaluate(session, sessionId, expression, timeoutMs = 3000) {
  const result = await session.send(
    'Runtime.evaluate',
    { expression, returnByValue: true },
    timeoutMs,
    sessionId,
  )
  return result?.result?.value
}

/**
 * Pick the tab the person is looking at. A background tab reports
 * `visibilityState === 'hidden'`; among visible tabs the focused window's tab
 * also reports `hasFocus() === true`.
 */
async function pickVisibleTarget(session, targets) {
  let visibleFallback = null
  for (const target of targets.slice(0, MAX_EVALUATED_TARGETS)) {
    let sessionId
    try {
      sessionId = await attach(session, target.targetId)
      const value = await evaluate(
        session,
        sessionId,
        '({visibility: document.visibilityState, focused: document.hasFocus()})',
      )
      if (value?.visibility === 'visible' && value?.focused === true) {
        if (visibleFallback !== null) {
          await session.send('Target.detachFromTarget', { sessionId: visibleFallback.sessionId }, 3000).catch(() => {})
        }
        return { target, sessionId }
      }
      if (value?.visibility === 'visible' && visibleFallback === null) {
        visibleFallback = { target, sessionId }
        continue
      }
      await session.send('Target.detachFromTarget', { sessionId }, 3000).catch(() => {})
    } catch {
      if (sessionId !== undefined) {
        await session.send('Target.detachFromTarget', { sessionId }, 3000).catch(() => {})
      }
    }
  }
  if (visibleFallback !== null) return visibleFallback

  const first = targets[0]
  if (first === undefined) throw new CaptureError('cdp-unavailable', '可调试的 Chrome 里没有页面标签')
  return { target: first, sessionId: await attach(session, first.targetId) }
}

/** Screenshot the visible tab over the cached browser connection. */
export async function captureWithCdp({ full = false, env = process.env } = {}) {
  let link
  try {
    link = await getBrowserSession(env)
  } catch (error) {
    closeBrowserLink()
    throw error
  }

  let sessionId
  try {
    const { targetInfos } = await link.session.send('Target.getTargets', {}, 5000)
    const targets = pageTargets(Array.isArray(targetInfos) ? targetInfos : [])
    if (targets.length === 0) throw new CaptureError('cdp-unavailable', '可调试的 Chrome 里没有页面标签')

    const picked = await pickVisibleTarget(link.session, targets)
    sessionId = picked.sessionId

    const meta = await evaluate(
      link.session,
      sessionId,
      '({title: document.title, url: location.href})',
      4000,
    )

    const params = { format: 'png', fromSurface: true, captureBeyondViewport: full === true }
    if (full) {
      const metrics = await link.session.send('Page.getLayoutMetrics', {}, 5000, sessionId)
      const size = metrics.cssContentSize ?? metrics.contentSize
      if (size !== undefined && Number.isFinite(size.width) && Number.isFinite(size.height)) {
        params.clip = {
          x: 0,
          y: 0,
          width: Math.ceil(size.width),
          height: Math.ceil(Math.min(size.height, 20_000)),
          scale: 1,
        }
      }
    }

    const shot = await link.session.send('Page.captureScreenshot', params, 30_000, sessionId)
    const base64 = typeof shot.data === 'string' ? shot.data : ''
    const bytes = Buffer.from(base64, 'base64')
    if (bytes.length < 8 || bytes[0] !== 0x89 || bytes.toString('latin1', 1, 4) !== 'PNG') {
      throw new CaptureError('capture-failed', 'CDP 没有返回有效的 PNG')
    }
    return {
      dataUrl: `data:image/png;base64,${base64}`,
      title: typeof meta?.title === 'string' ? meta.title : '',
      url: typeof meta?.url === 'string' ? meta.url : '',
      bytes: bytes.length,
      full: full === true,
    }
  } catch (error) {
    // A closed socket is recoverable on the next click; do not keep a dead link.
    if (link.session.closed) closeBrowserLink()
    throw error
  } finally {
    if (sessionId !== undefined) {
      await link.session
        .send('Target.detachFromTarget', { sessionId }, 3000)
        .catch(() => {})
    }
  }
}
