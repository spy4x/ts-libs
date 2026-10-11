/**
 * Bounded request-body reading for HTTP servers.
 *
 * A `Request` body is an attacker-controlled stream. Reading it with
 * `await request.text()` lets a client (or a buggy proxy) hand the process an
 * unbounded allocation, and lets a stalled connection hold a worker forever.
 * Every reader here enforces a hard byte cap, honours a declared
 * `content-length` before touching the body, and cancels the reader on failure —
 * including a stall that outlives the budget.
 *
 * **Canonical home: `net/bounded-body.ts`** (`@spy4x/net/bounded-body`). This
 * module is a named re-export of that implementation, `parseBoundedFormData`
 * included: it lived here until #222 moved it to `net` so a caller that only caps
 * a form body does not depend on the whole server package. Until this collapse the
 * module carried a byte-identical copy of the reader, which meant two distinct
 * classes named `PayloadTooLargeError`: `instanceof` against one was false for
 * an error thrown by the other, so a caller that caught the error from this
 * module did not catch the one from `net`. The copies had also drifted apart on
 * `readContentLength`. One class object now sits behind both specifiers.
 *
 * The re-export is **named**, not `export *`: `BodyReadErrorCode`,
 * `BodyReadTimeoutError`, `readBoundedJson`, `DEFAULT_MAX_BYTES` and
 * `DEFAULT_BODY_TIMEOUT_MS` are canonical-module surface this package never
 * promised, and leaking them is not the same as publishing them.
 *
 * Two shape changes came with the collapse, both documented in the PR: a stall
 * rejects with the canonical `BodyReadTimeoutError` (importable from
 * `@spy4x/net/bounded-body`) rather than a bare `Error` — both are `Error`
 * subclasses, so an existing `catch (error: unknown)` keeps working — and
 * `maxBytes` is now optional, defaulting to 5 MiB. The injectable
 * `setTimer`/`clearTimer` surface is gone with the duplicate timer layer.
 *
 * The stall budget is deliberately the canonical per-chunk one, **not** a single
 * overall deadline: it bounds the wait for the *next* chunk, so a slow-but-live
 * upload may take as long as it needs while a hung one fails fast.
 *
 * `readJsonBody` is this module's own addition for Hono apps: it reads a request's JSON body
 * through the canonical `readBoundedJson` and turns its failures into `HTTPException`s (413, 408
 * and 400), so every route does not repeat that mapping. `readFormBody` does the same for a form
 * post, from a plain `Request`.
 *
 * @module
 */

import type { Context } from "hono"
import { HTTPException } from "hono/http-exception"
import {
  type BodyReadOptions,
  BodyReadTimeoutError,
  parseBoundedFormData,
  PayloadTooLargeError,
  readBoundedBody,
  readBoundedJson,
  readBoundedText,
  readContentLength,
} from "@spy4x/net/bounded-body"

export {
  parseBoundedFormData,
  PayloadTooLargeError,
  readBoundedBody,
  readBoundedText,
  readContentLength,
}

/**
 * The options this package accepts, which is the canonical shape verbatim:
 * `maxBytes` optional (defaults to 5 MiB) and `timeoutMs` the per-chunk stall
 * budget.
 */
export type { BodyReadOptions as ReadBoundedBodyOptions }

/**
 * The stall budget, kept under this package's historical name so an existing
 * `import type { BoundedBodyTimeout }` keeps compiling.
 *
 * What changed: the injectable `setTimer`/`clearTimer` members are gone with the
 * duplicate timer layer — the canonical reader owns its timer, so only the
 * budget is left to configure. That is the one breaking part of this name: a
 * caller that supplied its own timer pair must drop it and pass `timeoutMs`, and
 * a test that needed a fake clock now waits on a real one.
 */
export type BoundedBodyTimeout = Pick<BodyReadOptions, "timeoutMs">

/**
 * Re-published because it is what a server caller can rely on passing: the
 * canonical readers take this structural shape rather than a `Request`, and
 * `Request` and `Response` both satisfy it.
 */
export type { BodySource } from "@spy4x/net/bounded-body"

/** Message of the 413 {@link readJsonBody} throws when the body is over the cap. */
export const JSON_BODY_TOO_LARGE = "Request body too large"

/** Message of the 408 {@link readJsonBody} throws when the body stalls. */
export const JSON_BODY_TIMEOUT = "Request body timed out"

/** Message of the 400 {@link readJsonBody} throws when the body is not JSON. */
export const JSON_BODY_INVALID = "Request body is not valid JSON"

/** Message of the 415 {@link readJsonBody} throws when `requireJsonContentType` is set and the request is not declared as JSON. */
export const JSON_BODY_CONTENT_TYPE = "Content type must be JSON"

/** Options of {@link readJsonBody}: the reader's own, and how a failure is reported. */
export interface ReadJsonBodyOptions extends BodyReadOptions {
  /**
   * Refuse a request whose `content-type` does not contain `application/json` (any case) before
   * reading the body. Off by default.
   */
  requireJsonContentType?: boolean
  /**
   * Builds the error to throw instead of the `HTTPException`, so a route answers in its own error
   * shape. It gets the message ({@link JSON_BODY_CONTENT_TYPE}, {@link JSON_BODY_TOO_LARGE},
   * {@link JSON_BODY_TIMEOUT} or {@link JSON_BODY_INVALID}) and the status the `HTTPException`
   * would have carried (415, 413, 408 or 400). The reader's error is not kept, so set `cause`
   * yourself if you need it. Other errors, such as the `RangeError` for a bad `maxBytes`, still
   * pass through unchanged.
   */
  fail?: (message: string, status: 400 | 408 | 413 | 415) => Error
}

/**
 * Read a Hono request's body as JSON under the byte cap and stall budget, and turn each way it can
 * fail into the HTTP status a client should see. Use it in place of `c.req.json()`, which buffers a
 * body of any size and throws a plain `SyntaxError` that Hono answers with 500.
 *
 * It throws Hono's `HTTPException`, so a route with no `onError` answers with the right status on
 * its own, and a route with its own error shape catches it and reads `status`, or passes
 * `options.fail` to have its own error thrown instead. The original error is kept as `cause` on
 * the `HTTPException`. An empty body is not JSON and gets 400.
 *
 * The result is `unknown` by default: validate it (arktype) before using it.
 *
 * @param c The Hono context. Its raw request body is read once, so do not read it elsewhere.
 * @param options `maxBytes` (default 5 MiB) and `timeoutMs`, the per-chunk stall budget (default
 * 10 s); `requireJsonContentType` and `fail`, see {@link ReadJsonBodyOptions}.
 * @throws {HTTPException} 415 ({@link JSON_BODY_CONTENT_TYPE}) when `requireJsonContentType` is
 * set and the request is not declared as JSON.
 * @throws {HTTPException} 413 ({@link JSON_BODY_TOO_LARGE}) when the body, or its declared
 * `content-length`, is over `maxBytes`.
 * @throws {HTTPException} 408 ({@link JSON_BODY_TIMEOUT}) when no chunk arrives within
 * `timeoutMs`.
 * @throws {HTTPException} 400 ({@link JSON_BODY_INVALID}) when the body is not valid JSON.
 * @throws The error `options.fail` returns, in place of each `HTTPException` above.
 * @throws Any other error unchanged, such as the `RangeError` for a `maxBytes` that is not finite,
 * or a `TypeError` for a body that was already read.
 */
export async function readJsonBody<T = unknown>(
  c: Context,
  options: ReadJsonBodyOptions = {},
): Promise<T> {
  const { requireJsonContentType, fail, ...reader } = options
  const refuse = (message: string, status: 400 | 408 | 413 | 415, cause?: unknown): never => {
    throw fail ? fail(message, status) : new HTTPException(status, { message, cause })
  }
  if (
    requireJsonContentType &&
    !c.req.header("content-type")?.toLowerCase().includes("application/json")
  ) {
    return refuse(JSON_BODY_CONTENT_TYPE, 415)
  }
  try {
    return await readBoundedJson<T>(c.req.raw, reader)
  } catch (error) {
    if (error instanceof PayloadTooLargeError) return refuse(JSON_BODY_TOO_LARGE, 413, error)
    if (error instanceof BodyReadTimeoutError) return refuse(JSON_BODY_TIMEOUT, 408, error)
    if (error instanceof SyntaxError) return refuse(JSON_BODY_INVALID, 400, error)
    throw error
  }
}

/** Message of the 413 {@link readFormBody} throws when the body is over the cap. */
export const FORM_BODY_TOO_LARGE = "Request body too large"

/** Message of the 408 {@link readFormBody} throws when the body stalls. */
export const FORM_BODY_TIMEOUT = "Request body timed out"

/** Message of the 400 {@link readFormBody} throws when the body is not a form. */
export const FORM_BODY_INVALID = "Request body is not a form"

/**
 * Read a form post (`application/x-www-form-urlencoded` or `multipart/form-data`) under the byte
 * cap and stall budget, and turn each way it can fail into the HTTP status a client should see.
 * The form twin of {@link readJsonBody}. It takes a plain `Request`, so it also serves a server
 * that is not Hono; a Hono route passes `c.req.raw`.
 *
 * It throws Hono's `HTTPException`: a Hono route with no `onError` answers with the right status
 * on its own, and any other server catches it and reads `status` and `message`. The original
 * error is kept as `cause`.
 *
 * Every value in the result is what the client sent: validate it (arktype) before using it.
 *
 * @param request The request. Its body is read once, so do not read it elsewhere.
 * @param options `maxBytes` (default 5 MiB) and `timeoutMs`, the per-chunk stall budget (default
 * 10 s).
 * @throws {HTTPException} 413 ({@link FORM_BODY_TOO_LARGE}) when the body, or its declared
 * `content-length`, is over `maxBytes`.
 * @throws {HTTPException} 408 ({@link FORM_BODY_TIMEOUT}) when no chunk arrives within
 * `timeoutMs`.
 * @throws {HTTPException} 400 ({@link FORM_BODY_INVALID}) when the request has no `content-type`,
 * names a type that is not a form, or its body does not parse as that form.
 * @throws TypeError when the body was already read: that is a mistake in the server, not in the
 * request, so it is not turned into a 400.
 * @throws Any other error unchanged, such as the `RangeError` for a `maxBytes` that is not finite.
 */
export async function readFormBody(
  request: Request,
  options: BodyReadOptions = {},
): Promise<FormData> {
  if (request.bodyUsed) throw new TypeError("readFormBody: the request body was already read")
  try {
    return await parseBoundedFormData(request, options)
  } catch (error) {
    if (error instanceof PayloadTooLargeError) {
      throw new HTTPException(413, { message: FORM_BODY_TOO_LARGE, cause: error })
    }
    if (error instanceof BodyReadTimeoutError) {
      throw new HTTPException(408, { message: FORM_BODY_TIMEOUT, cause: error })
    }
    if (error instanceof TypeError) {
      throw new HTTPException(400, { message: FORM_BODY_INVALID, cause: error })
    }
    throw error
  }
}
