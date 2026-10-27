/** Shared error shape: a stable code, a user-facing message, and an optional next step. */
export class CaptureError extends Error {
  constructor(code, message, hint) {
    super(message)
    this.name = 'CaptureError'
    this.code = code
    this.hint = hint
  }
}
