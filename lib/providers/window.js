/**
 * Tier 3 (macOS): screenshot the Chrome window itself.
 *
 * No bridge, no extension, no debug port. The price is real and worth stating:
 *  - the image is the *window* — tab strip and address bar included, not just
 *    the page;
 *  - macOS requires Screen Recording permission for DSH;
 *  - Chrome is brought forward for the capture (a screen-region grab cannot see
 *    a window that another window covers), then DSH is brought back.
 *
 * Reading the bounds goes through Chrome's own AppleScript dictionary, which
 * needs no Accessibility grant (System Events would).
 */
import { execFile } from 'node:child_process'
import { promises as fs } from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { promisify } from 'node:util'
import { CaptureError } from '../errors.js'

const exec = promisify(execFile)

const OSASCRIPT = process.env.DSH_OSASCRIPT_BIN ?? '/usr/bin/osascript'
const SCREENCAPTURE = process.env.DSH_SCREENCAPTURE_BIN ?? '/usr/sbin/screencapture'

const CHROME_INFO_SCRIPT = `tell application "Google Chrome"
  set w to front window
  set b to bounds of w
  set t to title of active tab of w
  set u to URL of active tab of w
  return (item 1 of b as text) & "," & (item 2 of b as text) & "," & (item 3 of b as text) & "," & (item 4 of b as text) & (ASCII character 1) & t & (ASCII character 1) & u
end tell`

function delay(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms))
}

function osascript(lines, timeoutMs = 5000) {
  return exec(OSASCRIPT, lines.flatMap((line) => ['-e', line]), { timeout: timeoutMs, maxBuffer: 1024 * 1024 })
}

function parseChromeInfo(stdout) {
  const [boundsPart, title = '', url = ''] = stdout.trim().split('\u0001')
  const bounds = String(boundsPart ?? '')
    .split(',')
    .map((value) => Number(value.trim()))
  if (bounds.length !== 4 || bounds.some((value) => !Number.isFinite(value))) {
    throw new CaptureError('window-capture-failed', `Chrome 返回的窗口坐标无法解析：${boundsPart}`)
  }
  const [x1, y1, x2, y2] = bounds
  const width = Math.round(x2 - x1)
  const height = Math.round(y2 - y1)
  if (width < 80 || height < 80) {
    throw new CaptureError('window-capture-failed', 'Chrome 窗口太小，无法截图')
  }
  return { x: Math.round(x1), y: Math.round(y1), width, height, title, url }
}

/** macOS only, and only while Chrome is running. */
export async function probeWindowCapture() {
  if (process.platform !== 'darwin') {
    return { available: false, reason: '系统窗口截图目前只在 macOS 上实现' }
  }
  try {
    await exec('/usr/bin/pgrep', ['-x', 'Google Chrome'], { timeout: 2000 })
    return { available: true }
  } catch {
    return { available: false, reason: 'Google Chrome 没有在运行' }
  }
}

function restoreDsh() {
  // Best effort: the app-managed bundle id, then the display name.
  return osascript(['tell application id "com.deepseek.dsh" to activate'], 3000).catch(() =>
    osascript(['tell application "DeepSeek Harness" to activate'], 3000).catch(() => undefined),
  )
}

/** Capture the frontmost Chrome window as a PNG. */
export async function captureWithWindow({ env = process.env } = {}) {
  const probe = await probeWindowCapture()
  if (!probe.available) {
    throw new CaptureError('window-unavailable', probe.reason)
  }

  let info
  try {
    const { stdout } = await osascript([CHROME_INFO_SCRIPT])
    info = parseChromeInfo(stdout)
  } catch (error) {
    if (error instanceof CaptureError) throw error
    const detail = String(error?.stderr ?? error?.message ?? error).trim()
    throw new CaptureError('chrome-not-running', `读不到 Chrome 窗口：${detail.split('\n')[0]}`)
  }

  const dir = await fs.mkdtemp(path.join(os.tmpdir(), 'dsh-chrome-attach-'))
  const file = path.join(dir, 'window.png')
  let raised = false
  try {
    try {
      await osascript(['tell application "Google Chrome" to activate'], 4000)
      raised = true
      await delay(450)
    } catch {
      // Not being able to raise Chrome is not fatal; the pixels may still be
      // visible, and screencapture reports the real failure below.
    }

    try {
      await exec(
        SCREENCAPTURE,
        ['-x', '-R', `${info.x},${info.y},${info.width},${info.height}`, file],
        { timeout: 15_000, maxBuffer: 1024 * 1024, env },
      )
    } catch (error) {
      const detail = String(error?.stderr ?? '').trim() || String(error?.message ?? error)
      if (/could not create image|not authorized|denied|permission/i.test(detail)) {
        throw new CaptureError(
          'screen-recording-denied',
          'macOS 没有授予屏幕录制权限，窗口截图不可用',
          '系统设置 → 隐私与安全性 → 屏幕录制 → 勾选 DeepSeek Harness，然后完全退出并重开应用。',
        )
      }
      throw new CaptureError('window-capture-failed', `窗口截图失败：${detail.split('\n')[0]}`)
    }

    // A Retina multi-display window lands at 3840×1920 and ~9 MB PNG; the
    // composer accepts it (20 MiB limit) but it is needlessly heavy for the
    // model and the draft rail. sips is part of macOS, so cap the long edge at
    // 2200px and keep the result a PNG (text stays crisp).
    const resized = path.join(dir, 'window-resized.png')
    try {
      await exec('/usr/bin/sips', ['-Z', '2200', file, '--out', resized], {
        timeout: 15_000,
        maxBuffer: 1024 * 1024,
      })
      await fs.rename(resized, file)
    } catch {
      // No sips or a conversion failure: the original screenshot is still valid.
    }

    const png = await fs.readFile(file)
    if (png.length < 8 || png[0] !== 0x89 || png.toString('latin1', 1, 4) !== 'PNG') {
      throw new CaptureError('window-capture-failed', 'screencapture 没有写出有效的 PNG')
    }
    return {
      dataUrl: `data:image/png;base64,${png.toString('base64')}`,
      title: info.title,
      url: info.url,
      bytes: png.length,
      full: false,
    }
  } finally {
    if (raised) await restoreDsh()
    await fs.rm(dir, { recursive: true, force: true })
  }
}
