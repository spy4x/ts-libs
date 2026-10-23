/**
 * Typed errors for request and response frames.
 *
 * The code set is closed on purpose: a client switches on it, so a server cannot invent a code the
 * client has never heard of. Anything a host cannot classify is `internal`, whose message is generic
 * so a thrown error's text never travels to a client by accident.
 *
 * @module
 */

import type { FieldErrors } from "@spy4x/validation"

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
 * The finer detail a refusal may carry beside its code, on the socket and over HTTP alike.
 *
 * A screen translates `reason ?? code`, and marks each field in `fields`. Both are optional, so a
 * peer that sends neither keeps working.
 */
export interface RealtimeRequestErrorOptions {
  /**
   * The host's own name for the refusal, finer than the closed code: `GROUP_NOT_FOUND` under
   * `not_found`, `quota_exceeded` under `forbidden`. Open, because it is the host's vocabulary.
   */
  reason?: string
  /** The fields a payload failed on, keyed by path, as `fieldErrors` from `@spy4x/validation` builds them. */
  fields?: FieldErrors
}

/**
 * The `reason` and `fields` of `options` that are set, and nothing else, so a frame or body built
 * by spreading it carries no `undefined` keys.
 */
export function errorExtras(options: RealtimeRequestErrorOptions): RealtimeRequestErrorOptions {
  return {
    ...(options.reason !== undefined ? { reason: options.reason } : {}),
    ...(options.fields !== undefined ? { fields: options.fields } : {}),
  }
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
  /** See {@link RealtimeRequestErrorOptions.reason}. */
  readonly reason?: string
  /** See {@link RealtimeRequestErrorOptions.fields}. */
  readonly fields?: FieldErrors

  constructor(
    code: RealtimeErrorCode,
    message: string,
    details?: unknown,
    options: RealtimeRequestErrorOptions = {},
  ) {
    super(message)
    this.name = "RealtimeRequestError"
    this.code = code
    this.details = details
    if (options.reason !== undefined) this.reason = options.reason
    if (options.fields !== undefined) this.fields = options.fields
  }
}

/**
 * What to tell the person about a failed request: the server's own message when it answered with
 * one, otherwise `fallback`.
 *
 * Only a {@link RealtimeRequestError} carries text that is meant for a person. Anything else that
 * a call can reject with, such as `ConnectionLostError` for a dropped socket or a bug's `TypeError`,
 * has a technical message, so the caller's `fallback` is shown in its place.
 *
 * @example
 * ```ts
 * try {
 *   await calls.command(`notes.create`, input)
 * } catch (cause) {
 *   formError.value = describeError(cause, `Could not create the note`)
 * }
 * ```
 *
 * @param error Whatever the failed call rejected with.
 * @param fallback The text for an error that is not a server answer.
 */
export function describeError(error: unknown, fallback: string): string {
  return error instanceof RealtimeRequestError ? error.message : fallback
}
