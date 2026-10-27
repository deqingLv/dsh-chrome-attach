/**
 * Host half of dsh-chrome-attach.
 *
 * One exact Fetch route, `/api/chrome-attach/shot`, behind the same browser
 * authentication as every other `/api` call (registered through the
 * `connection` service, so the Host/Origin fence and the session cookie are
 * handled for us). The client half is what turns the response into a draft
 * image; this half never touches the composer.
 *
 * The route asks capture.js for the best tier it can get; the response names
 * the tier so the UI can say when the image is a degraded window shot.
 */
import { CaptureError, capturePage } from './capture.js'
import { closeCdp } from './providers/cdp.js'

/** Cordis plugin name — must match the package name. */
export const name = 'dsh-chrome-attach'

/** The route rides on the authenticated browser transport. */
export const inject = ['connection']

const ROUTE = '/api/chrome-attach/shot'
const MAX_BODY_BYTES = 4 * 1024

function json(status, body) {
  return Response.json(body, {
    status,
    headers: { 'content-type': 'application/json; charset=utf-8' },
  })
}

function failure(error) {
  if (error instanceof CaptureError) {
    return json(502, {
      ok: false,
      error: { code: error.code, message: error.message, hint: error.hint },
    })
  }
  return json(500, {
    ok: false,
    error: { code: 'internal', message: error instanceof Error ? error.message : String(error) },
  })
}

async function readPayload(request) {
  const text = await request.text()
  if (text.length > MAX_BODY_BYTES) throw new CaptureError('bad-request', '请求体过大')
  if (text.trim() === '') return {}
  try {
    const parsed = JSON.parse(text)
    return parsed !== null && typeof parsed === 'object' ? parsed : {}
  } catch {
    throw new CaptureError('bad-request', '请求体不是合法 JSON')
  }
}

/** Plugin body: register the one exact route. */
export function apply(ctx) {
  ctx.effect(() => () => closeCdp(), 'dsh-chrome-attach: close CDP link')
  ctx.effect(
    () =>
      ctx.connection.fetch.register({
        path: ROUTE,
        methods: ['POST'],
        requestBody: 'buffered',
        fetch: async (request) => {
          try {
            const payload = await readPayload(request)
            const shot = await capturePage({
              full: payload.full === true,
              mode: typeof payload.mode === 'string' ? payload.mode : undefined,
            })
            return json(200, { ok: true, value: shot })
          } catch (error) {
            return failure(error)
          }
        },
      }),
    `dsh-chrome-attach: ${ROUTE}`,
  )
}
