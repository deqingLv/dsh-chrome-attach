/**
 * dsh-chrome-attach — browser half.
 *
 * Registers one entry in the composer's `+` menu (the same list as "Add files")
 * via the `commandUi` service. Picking it captures the active Chrome tab and
 * drops the PNG into the current draft:
 *
 *   POST /api/chrome-attach/shot  →  { dataUrl, title, url, source, ... }
 *   dataUrl → File → synthetic drop on document
 *   title + url → one text line in the same draft
 *
 * The drop is the same path a real drag-and-drop takes: DSH's attachment
 * intake validates type/count/size, shows the thumbnail rail, and serializes
 * the image only when the message is sent.
 *
 * The image carries no page text: the model reads pixels, not the tab's URL.
 * So the row also writes `title — url` into the draft through the composer's
 * own input facade (`inputActions`), which the conversation publishes to
 * session slots as a prop. That facade owns the phase/revision guards, so the
 * note can only land while the draft is actually editable; when it refuses,
 * the image still attaches and the toast says the page line was skipped.
 * Nothing here talks to the session directly, and there is no toolbar button.
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
        menuDescription: '截图当前页面，附带标题和地址',
        busy: '正在截取 Chrome 页面…',
        attached: '已附上',
        windowNote: '窗口截图，含浏览器界面',
        pagePrefix: 'Chrome 标签页：',
        noteSkipped: '（页面地址未能写入输入框）',
      },
      en: {
        menuLabel: 'Attach Chrome',
        menuDescription: 'Screenshot the page, plus its title and URL',
        busy: 'Capturing the Chrome page…',
        attached: 'Attached',
        windowNote: 'window shot, browser UI included',
        pagePrefix: 'Chrome tab: ',
        noteSkipped: '(page address not written into the composer)',
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

    // ── page title + URL as draft text ─────────────────────────────────────
    // The dialogue only ever sees the image, so the row also types the page
    // line the user would otherwise have to copy by hand. The composer's input
    // facade is published to session slots as the `inputActions` prop (see
    // ctx.uiSession.provide in dsh-client-ui-conversation); an always-mounted
    // dock entry is the cheapest way to hold on to it for a non-React action.
    const actionsBySession = new Map()
    let lastActions = null

    /** Headless dock entry: remembers the input facade of every open session. */
    function ChromeAttachDock(props) {
      const sessionId = props && (props.sessionId ?? (props.session && props.session.sessionId))
      const actions = props ? props.inputActions : undefined
      React.useEffect(() => {
        if (actions === undefined || actions === null) return undefined
        lastActions = actions
        if (sessionId !== undefined) actionsBySession.set(sessionId, actions)
        return () => {
          if (lastActions === actions) lastActions = null
          if (sessionId !== undefined && actionsBySession.get(sessionId) === actions) {
            actionsBySession.delete(sessionId)
          }
        }
      }, [sessionId, actions])
      return null
    }

    function actionsFor(session) {
      const sessionId = session && session.sessionId
      const own = sessionId === undefined ? undefined : actionsBySession.get(sessionId)
      return own ?? lastActions ?? null
    }

    /** `Chrome tab: title — url`, minus whatever the shot could not read. */
    function pageLine(t, shot) {
      const parts = []
      if (typeof shot.title === 'string' && shot.title.trim() !== '') parts.push(shot.title.trim())
      if (typeof shot.url === 'string' && shot.url.trim() !== '') parts.push(shot.url.trim())
      return parts.length === 0 ? '' : `${t.pagePrefix}${parts.join(' — ')}`
    }

    /**
     * Insert the page line at the caret as one undo step.
     * @returns whether the draft accepted it (false while frozen/busy).
     */
    function writePageLine(session, line) {
      if (line === '') return false
      const actions = actionsFor(session)
      if (actions === null) return false
      if (typeof actions.captureInsertion !== 'function' || typeof actions.insertText !== 'function') return false
      try {
        return actions.insertText(`${line} `, actions.captureInsertion()) !== false
      } catch {
        return false
      }
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
    async function attachChromePage(session) {
      if (busy) return
      busy = true
      const t = copy()
      showToast(t.busy, false)
      try {
        const shot = await requestShot(false)
        await deliverToComposer(shot.dataUrl, sanitizeName(shot.title, clockStamp()))
        const wrote = writePageLine(session, pageLine(t, shot))
        const note = shot.source === 'window' ? `（${t.windowNote}）` : ''
        const skipped = wrote ? '' : t.noteSkipped
        showToast(`${t.attached}${note}${skipped}${shot.title ? `：${shot.title}` : ''}`, false)
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
      ctx.inject(['commandUi', 'slots'], (scope) => {
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
              ui: { kind: 'action', run: (session) => attachChromePage(session) },
            }),
          'dsh-chrome-attach: attach-chrome action',
        )
        // Hold the composer's input facade so the action can type the page
        // line; `slots.inject` waits for the conversation to declare the dock.
        const slots = scope.get('slots')
        let dockEntry = null
        const registerDock = () => {
          const dispose = () => {
            if (dockEntry === null) return
            const drop = dockEntry
            dockEntry = null
            drop()
          }
          if (dockEntry === null) {
            dockEntry = slots.register(
              { name: 'conversation.input.dock', id: 'chrome-attach' },
              ChromeAttachDock,
            )
          }
          return dispose
        }
        scope.effect(
          () =>
            typeof slots.inject === 'function'
              ? slots.inject('conversation.input.dock', registerDock)
              : registerDock(),
          'dsh-chrome-attach: input facade dock',
        )
      })
    }

    exports.apply = apply
    exports.inject = []
    return module.exports
  },
})
