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
 * **Canonical home: `net/bounded-body.ts`** (`@ts-libs/net/bounded-body`). This
 * module is a named re-export of that implementation plus the one genuinely
 * server-specific entry point, `parseBoundedFormData`. Until this collapse the
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
 * `@ts-libs/net/bounded-body`) rather than a bare `Error` — both are `Error`
 * subclasses, so an existing `catch (error: unknown)` keeps working — and
 * `maxBytes` is now optional, defaulting to 5 MiB. The injectable
 * `setTimer`/`clearTimer` surface is gone with the duplicate timer layer.
 *
 * The stall budget is deliberately the canonical per-chunk one, **not** a single
 * overall deadline: it bounds the wait for the *next* chunk, so a slow-but-live
 * upload may take as long as it needs while a hung one fails fast.
 */

import {
  type BodyReadOptions,
  PayloadTooLargeError,
  readBoundedBody,
  readBoundedText,
  readContentLength,
} from "@ts-libs/net/bounded-body"

export { PayloadTooLargeError, readBoundedBody, readBoundedText, readContentLength }

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
export type { BodySource } from "@ts-libs/net/bounded-body"

/**
 * Parse a `multipart/form-data` (or url-encoded) body under the same cap.
 *
 * Unlike `request.formData()`, the bounded read happens first, so a large
 * upload is rejected at `maxBytes` instead of being buffered in full.
 *
 * The bytes go to `Response` as a view, never as `body.buffer`: `Response` reads
 * `byteOffset..byteLength` of what it is handed, so the whole backing buffer
 * would have appended unrelated bytes had the reader ever returned a window onto
 * a larger allocation. `slice()` is what narrows the canonical reader's
 * `Uint8Array<ArrayBufferLike>` to the `Uint8Array<ArrayBuffer>` that `BodyInit`
 * demands — one copy, bounded by `maxBytes`, preferred over a cast that would
 * re-open the whole-buffer hazard. Annotating the canonical readers' return type
 * as `Uint8Array<ArrayBuffer>` removes the copy, but that is a change to `net/`.
 *
 * @throws `PayloadTooLargeError` Under the same conditions as `readBoundedBody`.
 * @throws `TypeError` When the request carries no `content-type`; without it the
 * multipart boundary is unknown and the parse could only return an empty body.
 */
export async function parseBoundedFormData(
  request: Request,
  options: BodyReadOptions = {},
): Promise<FormData> {
  const contentType = request.headers.get("content-type")
  if (!contentType) {
    throw new TypeError("parseBoundedFormData requires a content-type header")
  }
  const body = await readBoundedBody(request, options)

  return await new Response(body.slice(), { headers: { "content-type": contentType } }).formData()
}
