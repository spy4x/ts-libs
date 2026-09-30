/**
 * Typed errors for request and response frames.
 *
 * The code set is closed on purpose: a client switches on it, so a server cannot invent a code the
 * client has never heard of. Anything a host cannot classify is `internal`, whose message is generic
 * so a thrown error's text never travels to a client by accident.
 *
 * @module
 */

/** Every error code a `server.error` frame may carry. Closed: adding one is a protocol change. */
export const REALTIME_ERROR_CODES = [
  "bad_request",
  "unauthorized",
  "forbidden",
  "not_found",
  "conflict",
  "rate_limited",
  "internal",
  "timeout",
] as const

/** One of {@link REALTIME_ERROR_CODES}. */
export type RealtimeErrorCode = typeof REALTIME_ERROR_CODES[number]

/** Whether an unknown value is one of the closed error codes. */
export function isRealtimeErrorCode(value: unknown): value is RealtimeErrorCode {
  return typeof value === "string" && (REALTIME_ERROR_CODES as readonly string[]).includes(value)
}

/**
 * A request that failed with a typed code.
 *
 * Two places raise it. A server-side dispatcher throws it to answer with a specific code (the
 * registry sends `{ code, message, details }` to the client). The client transport rejects a pending
 * call with it when the server answered `server.error`, and with code `timeout` when no answer came
 * in time. A dropped socket is *not* this error: the outcome of a request in flight is then unknown,
 * so it rejects with `ConnectionLostError` and the caller decides whether a retry is safe (a command
 * carrying an idempotency key always is).
 */
export class RealtimeRequestError extends Error {
  readonly code: RealtimeErrorCode
  /** Structured, JSON-safe extra detail, such as validation issues. */
  readonly details: unknown

  constructor(code: RealtimeErrorCode, message: string, details?: unknown) {
    super(message)
    this.name = "RealtimeRequestError"
    this.code = code
    this.details = details
  }
}
