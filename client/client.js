/**
 * dsh-chrome-attach — browser half.
 *
 * Registers one entry in the composer's `+` menu (the same list as "Add files")
 * via the `commandUi` service. Picking it captures the active Chrome tab and
 * drops the PNG into the current draft:
 *
 *   POST /api/chrome-attach/shot  →  { dataUrl, title, url, source, ... }
 *   dataUrl → File → synthetic drop on document
 *
 * The drop is the same path a real drag-and-drop takes: DSH's attachment
 * intake validates type/count/size, shows the thumbnail rail, and serializes
 * the image only when the message is sent. Nothing here talks to the session
 * directly, and there is no extra toolbar button.
 */
window.__ModuleLoader__.load({
  id: 'dsh-chrome-attach',
  factory: (require) => {
    const module = { exports: {} }
    const exports = module.exports
    const React = require('react')

    const API = '/api/chrome-attach/shot'

    const COPY = {
      zh: {
        menuLabel: '附加 Chrome',
        menuDescription: '把当前页面截图放进输入框',
        busy: '正在截取 Chrome 页面…',
        attached: '已附上',
        windowNote: '窗口截图，含浏览器界面',
      },
      en: {
        menuLabel: 'Attach Chrome',
        menuDescription: 'Screenshot the page into the composer',
        busy: 'Capturing the Chrome page…',
        attached: 'Attached',
        windowNote: 'window shot, browser UI included',
      },
    }

    function copy() {
      const lang = String(document.documentElement.lang || navigator.language || 'en').toLowerCase()
      return lang.startsWith('zh') ? COPY.zh : COPY.en
    }

    function ensureStyle() {
      const id = 'dsh-chrome-attach/style'
      if (document.querySelector(`style[data-plugin-css="${id}"]`) !== null) return
      const style = document.createElement('style')
      style.dataset.plugin = 'dsh-chrome-attach'
      style.dataset.pluginCss = id
      style.textContent = `
        .dca-toast {
          position: fixed; left: 50%; bottom: 88px; transform: translateX(-50%);
          max-width: 72vw; padding: 7px 14px; border-radius: 8px; z-index: 10000;
          font-size: 13px; line-height: 20px; pointer-events: none;
          background: var(--dsw-alias-interactive-bg-hover-solid, #1f1f24);
          color: var(--dsw-alias-label-primary, #fff);
          box-shadow: 0 6px 24px rgba(0,0,0,.18);
          white-space: nowrap; overflow: hidden; text-overflow: ellipsis;
          animation: dca-fade .15s ease-out;
        }
        .dca-toast[data-error="true"] { color: var(--dsw-alias-state-error-primary, #ff5c5c); }
        @keyframes dca-fade { from { opacity: 0; } to { opacity: 1; } }
        @media (prefers-reduced-motion: reduce) { .dca-toast { animation: none; } }
      `
      document.head.appendChild(style)
    }

    // ── toast (no component tree: the action runs from a menu row) ─────────
    let toastNode = null
    let toastTimer = 0

    function showToast(text, error) {
      if (toastNode !== null) toastNode.remove()
      const node = document.createElement('div')
      node.className = 'dca-toast'
      node.dataset.error = error ? 'true' : 'false'
      node.setAttribute('role', 'status')
      node.textContent = text
      document.body.appendChild(node)
      toastNode = node
      window.clearTimeout(toastTimer)
      toastTimer = window.setTimeout(() => {
        node.remove()
        if (toastNode === node) toastNode = null
      }, error ? 6000 : 2400)
    }

    function sanitizeName(title, stamp) {
      const base = String(title || 'chrome-tab')
        .replace(/[\\/:*?"<>|]+/g, ' ')
        .replace(/\s+/g, '-')
        .replace(/^-+|-+$/g, '')
        .slice(0, 48)
      return `${base === '' ? 'chrome-tab' : base}-${stamp}.png`
    }

    /** One data URL + name → a real image attachment in the current draft. */
    async function deliverToComposer(dataUrl, filename) {
      const blob = await (await fetch(dataUrl)).blob()
      const file = new File([blob], filename, { type: blob.type || 'image/png' })
      const transfer = new DataTransfer()
      transfer.items.add(file)
      document.dispatchEvent(
        new DragEvent('drop', { bubbles: true, cancelable: true, dataTransfer: transfer }),
      )
    }

    async function requestShot(full) {
      const response = await fetch(API, {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ full }),
      })
      let body
      try {
        body = await response.json()
      } catch {
        throw new Error(`HTTP ${response.status}`)
      }
      if (body === null || body.ok !== true || body.value === undefined) {
        const error = body && body.error ? body.error : {}
        const hint = typeof error.hint === 'string' ? `（${error.hint}）` : ''
        throw new Error(`${error.message || `HTTP ${response.status}`}${hint}`)
      }
      return body.value
    }

    function clockStamp() {
      const now = new Date()
      const pad = (n) => String(n).padStart(2, '0')
      return `${pad(now.getHours())}${pad(now.getMinutes())}${pad(now.getSeconds())}`
    }

    let busy = false

    /** The `+` menu row's action: capture, then hand the image to the composer. */
    async function attachChromePage() {
      if (busy) return
      busy = true
      const t = copy()
      showToast(t.busy, false)
      try {
        const shot = await requestShot(false)
        await deliverToComposer(shot.dataUrl, sanitizeName(shot.title, clockStamp()))
        const note = shot.source === 'window' ? `（${t.windowNote}）` : ''
        showToast(`${t.attached}${note}${shot.title ? `：${shot.title}` : ''}`, false)
      } catch (error) {
        showToast(error instanceof Error ? error.message : String(error), true)
      } finally {
        busy = false
      }
    }

    /** The Chrome mark itself, so the row says "Chrome" without spelling it. */
    function ChromeIcon(props) {
      const size = props && Number.isFinite(props.size) ? props.size : 16
      return React.createElement(
        'svg',
        { width: size, height: size, viewBox: '0 0 16 16', fill: 'none', 'aria-hidden': 'true' },
        React.createElement('path', {
          d: 'M8 8 L1.94 4.5 A7 7 0 0 1 14.06 4.5 Z',
          fill: '#EA4335',
          stroke: '#fff',
          strokeWidth: 0.6,
        }),
        React.createElement('path', {
          d: 'M8 8 L14.06 4.5 A7 7 0 0 1 8 15 Z',
          fill: '#FBBC05',
          stroke: '#fff',
          strokeWidth: 0.6,
        }),
        React.createElement('path', {
          d: 'M8 8 L8 15 A7 7 0 0 1 1.94 4.5 Z',
          fill: '#34A853',
          stroke: '#fff',
          strokeWidth: 0.6,
        }),
        React.createElement('circle', { cx: 8, cy: 8, r: 3.3, fill: '#4285F4' }),
        React.createElement('circle', {
          cx: 8, cy: 8, r: 4.0, fill: 'none', stroke: '#fff', strokeWidth: 0.9,
        }),
      )
    }

    // The '+' menu hard-codes which rows belong to the Add section
    // (file/goal/plan/feedback); every other contribution is appended to
    // Commands. This action belongs with the attachments, so wrap the service's
    // candidate builder and move the row right after "Add files". Typed
    // queries are ranked without section labels and are left untouched.
    const ADD_SECTION_NAMES = ['file', 'goal', 'plan', 'feedback']

    function promoteToAddSection(commands) {
      const original = commands.candidates
      if (typeof original !== 'function' || original.__dcaPromote === true) return () => {}
      const patched = async function candidates(session, req) {
        const rows = await original.call(commands, session, req)
        if (!Array.isArray(rows) || rows.length === 0) return rows
        const index = rows.findIndex(
          (row) => row !== null && typeof row === 'object' && row.name === 'attach',
        )
        if (index === -1) return rows
        const anchorRow = rows.find(
          (row) =>
            row !== null &&
            typeof row === 'object' &&
            ADD_SECTION_NAMES.includes(row.name) &&
            typeof row.section === 'string',
        )
        if (anchorRow === undefined) return rows
        const [row] = rows.splice(index, 1)
        row.section = anchorRow.section
        const at = rows.indexOf(anchorRow)
        rows.splice(at + 1, 0, row)
        return rows
      }
      patched.__dcaPromote = true
      try {
        commands.candidates = patched
      } catch {
        return () => {}
      }
      return () => {
        if (commands.candidates === patched) commands.candidates = original
      }
    }

    function apply(ctx) {
      ensureStyle()
      ctx.inject(['commandUi'], (scope) => {
        const commands = scope.get('commandUi')
        const restoreCandidates = promoteToAddSection(commands)
        scope.effect(() => () => restoreCandidates(), 'dsh-chrome-attach: restore candidates')
        scope.effect(
          () =>
            commands.register({
              name: 'attach',
              label: () => copy().menuLabel,
              description: () => copy().menuDescription,
              icon: ChromeIcon,
              available: () => true,
              ui: { kind: 'action', run: () => attachChromePage() },
            }),
          'dsh-chrome-attach: attach-chrome action',
        )
      })
    }

    exports.apply = apply
    exports.inject = []
    return module.exports
  },
})
