/**
 * Capture orchestrator: try the best available tier and degrade gracefully.
 *
 *   bridge  dsh-chrome-bridge (`cb`)      clean tab, no permissions, no ports
 *   cdp     Chrome with a debug port      clean tab, needs the Chrome-side switch
 *   window  macOS screencapture           window incl. browser UI, needs Screen
 *                                         Recording, briefly raises Chrome
 *
 * `DSH_CHROME_ATTACH_MODE=bridge|cdp|window` pins one tier; the default `auto`
 * walks the chain and only fails when every tier says no.
 */
import { CaptureError } from './errors.js'
import { captureWithBridge, probeBridge, resolveBridgeCli } from './providers/bridge.js'
import { captureWithCdp } from './providers/cdp.js'
import { captureWithWindow } from './providers/window.js'

const TIERS = ['bridge', 'cdp', 'window']

const LABELS = {
  bridge: 'Chrome 桥接',
  cdp: 'CDP 调试端口',
  window: 'macOS 窗口截图',
}

function runTier(tier, { full, env }) {
  if (tier === 'bridge') return captureWithBridge({ full, env })
  if (tier === 'cdp') return captureWithCdp({ full, env })
  if (tier === 'window') return captureWithWindow({ env })
  return Promise.reject(new CaptureError('bad-request', `未知的截图通道：${tier}`))
}

function summarize(failures) {
  const lines = failures
    .map(({ tier, error }) => `· ${LABELS[tier] ?? tier}：${error instanceof Error ? error.message : String(error)}`)
    .join('\n')
  return new CaptureError(
    'no-capture-provider',
    `没有可用的截图通道：\n${lines}`,
    '三选一即可：装 dsh-chrome-bridge；给 Chrome 开调试端口并用 DSH_CHROME_DEBUG_PORT 指定；或在 macOS 给 DSH 授予「屏幕录制」权限。',
  )
}

/**
 * @param options.full - whole page where the tier supports it.
 * @param options.env - environment (tests inject a fake PATH/mode).
 * @param options.mode - override `DSH_CHROME_ATTACH_MODE` for this call.
 */
export async function capturePage({ full = false, env = process.env, mode } = {}) {
  const pinned = String(mode ?? env.DSH_CHROME_ATTACH_MODE ?? 'auto').toLowerCase()
  const chain = TIERS.includes(pinned) ? [pinned] : TIERS

  if (chain.length === 1) {
    const shot = await runTier(chain[0], { full, env })
    return { ...shot, source: chain[0], degraded: chain[0] === 'window' }
  }

  const failures = []
  for (const tier of chain) {
    try {
      const shot = await runTier(tier, { full, env })
      return { ...shot, source: tier, degraded: tier === 'window' }
    } catch (error) {
      failures.push({ tier, error })
    }
  }
  throw summarize(failures)
}

/** Bridge-only helper kept for the README's standalone testing snippet. */
export const captureActiveTab = (options = {}) => captureWithBridge(options)

export { CaptureError, probeBridge, resolveBridgeCli }
