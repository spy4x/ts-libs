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
 * and 400), so every route does not repeat that mapping.
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

/**
 * Read a Hono request's body as JSON under the byte cap and stall budget, and turn each way it can
 * fail into the HTTP status a client should see. Use it in place of `c.req.json()`, which buffers a
 * body of any size and throws a plain `SyntaxError` that Hono answers with 500.
 *
 * It throws Hono's `HTTPException`, so a route with no `onError` answers with the right status on
 * its own, and a route with its own error shape catches it and reads `status`. The original error
 * is kept as `cause`. An empty body is not JSON and gets 400.
 *
 * The result is `unknown` by default: validate it (arktype) before using it.
 *
 * @param c The Hono context. Its raw request body is read once, so do not read it elsewhere.
 * @param options `maxBytes` (default 5 MiB) and `timeoutMs`, the per-chunk stall budget (default
 * 10 s).
 * @throws {HTTPException} 413 ({@link JSON_BODY_TOO_LARGE}) when the body, or its declared
 * `content-length`, is over `maxBytes`.
 * @throws {HTTPException} 408 ({@link JSON_BODY_TIMEOUT}) when no chunk arrives within
 * `timeoutMs`.
 * @throws {HTTPException} 400 ({@link JSON_BODY_INVALID}) when the body is not valid JSON.
 * @throws Any other error unchanged, such as the `RangeError` for a `maxBytes` that is not finite,
 * or a `TypeError` for a body that was already read.
 */
export async function readJsonBody<T = unknown>(
  c: Context,
  options: BodyReadOptions = {},
): Promise<T> {
  try {
    return await readBoundedJson<T>(c.req.raw, options)
  } catch (error) {
    if (error instanceof PayloadTooLargeError) {
      throw new HTTPException(413, { message: JSON_BODY_TOO_LARGE, cause: error })
    }
    if (error instanceof BodyReadTimeoutError) {
      throw new HTTPException(408, { message: JSON_BODY_TIMEOUT, cause: error })
    }
    if (error instanceof SyntaxError) {
      throw new HTTPException(400, { message: JSON_BODY_INVALID, cause: error })
    }
    throw error
  }
}
