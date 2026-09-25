/**
 * The error vocabulary a store or a form reports with, the helpers that build it, and the
 * `Result` used to return one.
 *
 * `ErrType` is the discriminant: a caller switches on `error.type` and gets a narrowed interface,
 * never a bare `Error` string. `ErrType` and `ValidationError` are *re-exported* from
 * `@spy4x/validation` rather than redeclared: that package tags its own error, and it cannot import
 * this one, because this package already imports it and a cycle between the two fails
 * `deno publish`.
 *
 * @module
 */

import {
  ErrType,
  VALIDATION_MESSAGE,
  type ValidationError as ValidationErrorShape,
} from "@spy4x/validation"

export { ErrType }

/** Canonical copy for each category, so the same failure reads the same in every product. */
export const ERR_MESSAGE = {
  validation: VALIDATION_MESSAGE,
  connection:
    "There seems to be a problem with connection to the server. Check your internet connection.",
} as const

/** Base shape every error shares: a category and human-readable copy. */
export interface Err {
  type: ErrType
  /** What went wrong, in the user's words. */
  message: string
}

/**
 * A rejected input: its kind, one sentence for the user, the issues per field path, and arktype's
 * own errors.
 *
 * Alias of `@spy4x/validation`'s `ValidationError` — kept under this name because
 * {@link ServerError} / {@link ConnectionError} live here and a caller should be able to import
 * the whole vocabulary from one place. It is not a second envelope.
 */
export type ValidationError = ValidationErrorShape

/** The request never reached the server. */
export interface ConnectionError extends Err {
  type: ErrType.Connection
  message: string
}

/** The server answered with a failure status. */
export interface ServerError extends Err {
  type: ErrType.Server
  status: number
  message: string
}

/** An error this package has no category for. */
export interface OtherError extends Err {
  type: ErrType.Other
  message: string
}

/** A payload a schema rejected: a response body, or a remote feed item. */
export interface PayloadError extends Err {
  type: ErrType.Payload
  message: string
}

/** Every error {@link Result} can carry. */
export type AnyError = ValidationError | ConnectionError | ServerError | OtherError

/** Every error a store operation can settle with. Discriminate on `type`. */
export type StoreError = ValidationError | ConnectionError | ServerError | PayloadError

/**
 * Errors a request itself can produce.
 *
 * A payload that does not match the model schema counts as unusable server data rather than a
 * transport failure, so it gets its own kind.
 */
export type RequestError = ConnectionError | ServerError | PayloadError

/** Errors from a response that never reached a usable body. */
export type ResponseError = ConnectionError | ServerError

/** Result of an operation that can fail: exactly one of `result` / `error` is non-null. */
export type OperationResult<T, E = unknown> =
  | { error: null; result: T }
  | { error: E; result: null }

/** In-flight state of an operation, for a store or a form to render. */
export interface OperationState<T, E = unknown> {
  inProgress: boolean
  result: null | T
  error: null | E
}

/** Idle state of an operation. */
export function idleOperationState<T, E = unknown>(): OperationState<T, E> {
  return { inProgress: false, result: null, error: null }
}

/** Wrap a message the caller already has into a {@link ConnectionError}. */
export function connectionError(message: string): ConnectionError {
  return { type: ErrType.Connection, message }
}

/**
 * Turn a failed response into a structured error.
 *
 * A status of `0` is `Response.error()` — the request never left — and becomes a
 * {@link ConnectionError} with {@link ERR_MESSAGE}`.connection`. Anything else becomes a
 * {@link ServerError} carrying the server's own message when the JSON body holds one (`"error"`,
 * `"message"` or `"detail"`, or the body is a bare string), falling back to the status text, then
 * to `HTTP <status>`. Only the standard `Response` is used, so this runs in a browser and on a
 * server alike. Reading the body consumes it, which is fine: the caller has already decided the
 * response failed.
 */
export async function responseError(response: Response): Promise<ResponseError> {
  const { status, statusText } = response
  if (status === 0) return connectionError(ERR_MESSAGE.connection)
  return {
    type: ErrType.Server,
    status,
    message: await readErrorMessage(response) || statusText || `HTTP ${status}`,
  }
}

/**
 * Whether an error should stay quiet.
 *
 * Connection failures and server crashes (status 500) are reported once by the transport or the
 * global error surface, so a per-operation toast for them would only add noise. Validation
 * failures, payload errors and ordinary server rejections are always shown.
 */
export function isSilentError(error: AnyError | StoreError): boolean {
  return error.type === ErrType.Connection ||
    (error.type === ErrType.Server && error.status === 500)
}

/** Body-derived message, or `null` when the body is absent, unparseable or empty. */
async function readErrorMessage(response: Response): Promise<string | null> {
  try {
    const body: unknown = await response.json()
    if (typeof body === "string") return body || null
    if (body !== null && typeof body === "object") {
      for (const key of ["error", "message", "detail"]) {
        const value = (body as Record<string, unknown>)[key]
        if (typeof value === "string" && value) return value
      }
    }
    return null
  } catch {
    return null
  }
}
