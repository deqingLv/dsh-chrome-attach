/**
 * Tier 1: dsh-chrome-bridge's `cb` CLI.
 *
 * The only tier that needs zero system permissions and no remote-debugging
 * switch: native messaging + chrome.debugger already own the hard part, and
 * the screenshot is the bare tab content. When it is installed and connected
 * there is no reason to fall back.
 */
import { execFile } from 'node:child_process'
import { constants as fsConstants } from 'node:fs'
import { promises as fs } from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { promisify } from 'node:util'
import { CaptureError } from '../errors.js'

const exec = promisify(execFile)

export const BRIDGE_HINT = '在「插件」页安装 dsh-chrome-bridge，并在 Chrome 里装好 DSH Bridge 扩展（点一次连接）。'

async function isExecutable(candidate) {
  if (typeof candidate !== 'string' || candidate === '') return false
  try {
    const stat = await fs.stat(candidate)
    if (!stat.isFile()) return false
    await fs.access(candidate, fsConstants.X_OK)
    return true
  } catch {
    return false
  }
}

/**
 * Locate the `cb` CLI. Order: explicit override, the bridge's own install
 * locations, then PATH. The bridge installs to `~/.dsh/bin/cb` and links
 * `~/.local/bin/cb`; a GUI-launched DSH may have a shorter PATH than a shell,
 * so the fixed paths come first.
 */
export async function resolveBridgeCli(env = process.env) {
  const home = os.homedir()
  const candidates = []
  if (env.DSH_CHROME_BRIDGE_CB) candidates.push(env.DSH_CHROME_BRIDGE_CB)
  candidates.push(path.join(home, '.dsh/bin/cb'), path.join(home, '.local/bin/cb'))
  for (const dir of String(env.PATH ?? '').split(path.delimiter)) {
    if (dir !== '') candidates.push(path.join(dir, 'cb'))
  }
  for (const candidate of candidates) {
    if (await isExecutable(candidate)) return candidate
  }
  throw new CaptureError('bridge-not-installed', '没有找到 dsh-chrome-bridge 的 cb 命令', BRIDGE_HINT)
}

/**
 * Fast connectivity probe. `cb shot` can sit in its own timeout when the
 * extension is missing, so the auto chain asks `cb status` first and skips
 * this tier in about a second instead of half a minute.
 */
export async function probeBridge({ env = process.env, timeoutMs = 4000 } = {}) {
  const cb = await resolveBridgeCli(env)
  try {
    const { stdout } = await exec(cb, ['status'], { timeout: timeoutMs, maxBuffer: 1024 * 1024, env })
    if (stdout.includes('✅')) return { cb, connected: true }
    return { cb, connected: false, detail: stdout.trim().split('\n')[0] }
  } catch (error) {
    return { cb, connected: false, detail: String(error?.stderr ?? error?.message ?? error).trim() }
  }
}

function isPng(bytes) {
  return bytes.length > 8 && bytes[0] === 0x89 && bytes.toString('latin1', 1, 4) === 'PNG'
}

function parseMeta(stdout) {
  try {
    const parsed = JSON.parse(stdout)
    return parsed !== null && typeof parsed === 'object' ? parsed : {}
  } catch {
    return {}
  }
}

/** Screenshot the active tab through the bridge. */
export async function captureWithBridge({ full = false, env = process.env, timeoutMs = 30_000 } = {}) {
  const probe = await probeBridge({ env })
  if (!probe.connected) {
    throw new CaptureError('bridge-not-connected', 'Chrome 桥接尚未连接' + (probe.detail ? `：${probe.detail}` : ''), BRIDGE_HINT)
  }

  const dir = await fs.mkdtemp(path.join(os.tmpdir(), 'dsh-chrome-attach-'))
  const file = path.join(dir, 'shot.png')
  try {
    let stdout = ''
    try {
      const result = await exec(
        probe.cb,
        ['shot', 'active', '--out', file, '--json', ...(full ? ['--full'] : [])],
        { timeout: timeoutMs, maxBuffer: 16 * 1024 * 1024, env },
      )
      stdout = result.stdout
    } catch (error) {
      const detail = String(error?.stderr ?? '').trim() || String(error?.message ?? error)
      throw new CaptureError('capture-failed', `桥接截图失败：${detail.split('\n')[0]}`)
    }

    const meta = parseMeta(stdout)
    const png = await fs.readFile(file)
    if (!isPng(png)) {
      throw new CaptureError('capture-failed', 'cb 没有写出有效的 PNG', '确认当前标签页不是 chrome:// 等受保护页面。')
    }
    return {
      dataUrl: `data:image/png;base64,${png.toString('base64')}`,
      title: typeof meta.title === 'string' ? meta.title : '',
      url: typeof meta.url === 'string' ? meta.url : '',
      bytes: png.length,
      full: meta.full === true || full,
    }
  } finally {
    await fs.rm(dir, { recursive: true, force: true })
  }
}
