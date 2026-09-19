/**
 * Bounded request-body reading for HTTP servers.
 *
 * A `Request` body is an attacker-controlled stream. Reading it with
 * `await request.text()` lets a client (or a buggy proxy) hand the process an
 * unbounded allocation, and lets a stalled connection hold a worker forever.
 * Every function here enforces a hard byte cap, honours a declared
 * `content-length` before touching the body, and cancels the reader on any
 * failure — including a stalled-body timeout.
 *
 * Canonical home: this is a **temporary duplicate** of `net/bounded-body.ts`
 * (issue #1, a merge of `warthunder-stats`' stalled-body timeout and
 * `offer-lens`' hard byte cap). Issue #1 has not landed, so the implementation
 * lives here for now. Once `net/bounded-body.ts` exists, this module collapses
 * to a re-export (`export * from "@ts-libs/net/bounded-body"`) plus
 * `parseBoundedFormData`, which is the only genuinely server-specific piece:
 * `PayloadTooLargeError` must stay a single class, not two same-named ones.
 *
 * Deviations from the two sources, all covered by tests below:
 *  - a reader that threw is no longer reported as a `PayloadTooLargeError`
 *    ([`cancelReader`] used to mask the real error);
 *  - an oversized declared `content-length` is rejected *before* the body is
 *    read, and the case where the header lies but the stream does not (a
 *    truncated multipart client) is not;
 *  - `parseBoundedFormData` keeps the `content-type` header, including the
 *    multipart boundary, so it no longer returns an empty `FormData`.
 */

/** The only error a caller has to catch to answer `413 Payload Too Large`. */
export class PayloadTooLargeError extends Error {
  /** The cap that was exceeded, in bytes. */
  readonly maxBytes: number

  constructor(maxBytes: number) {
    super(`Payload exceeds ${maxBytes} bytes`)
    this.name = "PayloadTooLargeError"
    this.maxBytes = maxBytes
  }
}

/** The bound a stalled body read is given. */
export interface BoundedBodyTimeout {
  /**
   * Milliseconds with no chunk arriving before the read is abandoned. `0` or
   * omitted disables it. A single overall deadline, not an idle timer.
   */
  timeoutMs?: number
  /** Timer used for the deadline. Injected so tests need no wall-clock wait. */
  setTimer?: (handler: () => void, ms: number) => number
  /** Timer canceller matching `setTimer`. */
  clearTimer?: (handle: number) => void
}

/** Options for {@link readBoundedBody}. */
export interface ReadBoundedBodyOptions extends BoundedBodyTimeout {
  /** A `content-length` header greater than this is rejected without reading the body. */
  maxBytes: number
}

const defaultSetTimer = (handler: () => void, ms: number): number => setTimeout(handler, ms)
const defaultClearTimer = (handle: number): void => clearTimeout(handle)

/**
 * Read a declared `content-length` header.
 *
 * @returns The integer byte count, or `null` when the header is absent or not a
 * non-negative integer. A malformed header is ignored on purpose: the cap on
 * the stream is authoritative, the header is only an early-out.
 */
export function readContentLength(headers: Headers): number | null {
  const raw = headers.get("content-length")
  if (raw === null || raw.trim() === "") return null
  const declared = Number(raw)
  if (!Number.isInteger(declared) || declared < 0) return null
  return declared
}

/** Cancel a reader, never throwing on a stream that is already closed or errored. */
async function cancelReader(reader: ReadableStreamDefaultReader<Uint8Array>): Promise<void> {
  try {
    await reader.cancel()
  } catch {
    // The stream may already be closed, errored or locked elsewhere. Cancelling
    // is best-effort cleanup and must never replace the error being reported.
  }
}

/**
 * Read a request body as bytes, aborting the moment it exceeds `maxBytes`.
 *
 * Chunks are accumulated and concatenated once at the end, so the peak
 * allocation is `maxBytes` plus one chunk rather than the whole stream.
 *
 * @throws {PayloadTooLargeError} When `content-length` already exceeds the cap,
 * or when the streamed body crosses it. The reader is cancelled first.
 * @throws {Error} The reader's own error, unchanged, if the stream fails or the
 * `timeoutMs` deadline passes before a chunk arrives.
 */
export async function readBoundedBody(
  request: Request,
  options: ReadBoundedBodyOptions,
): Promise<Uint8Array<ArrayBuffer>> {
  const { maxBytes } = options
  const timeoutMs = options.timeoutMs ?? 0
  const setTimer = options.setTimer ?? defaultSetTimer
  const clearTimer = options.clearTimer ?? defaultClearTimer

  if (!Number.isInteger(maxBytes) || maxBytes < 0) {
    throw new RangeError(`maxBytes must be a non-negative integer, got ${maxBytes}`)
  }

  const declared = readContentLength(request.headers)
  if (declared !== null && declared > maxBytes) {
    // Reject before reading: a body that declares 4 GiB must not be streamed
    // into the process just to be rejected at the end. The request body is
    // cancelled directly — taking a reader would be pointless work on a stream
    // that is never read.
    await request.body?.cancel().catch(() => undefined)
    throw new PayloadTooLargeError(maxBytes)
  }

  if (!request.body) return new Uint8Array(0)

  const reader = request.body.getReader()
  const chunks: Uint8Array[] = []
  let total = 0
  let timer: number | null = null
  let timedOut = false

  try {
    while (true) {
      const read = reader.read()
      // `Promise.race` never loses a rejection: a timeout that fires while the
      // read is still pending wins, and the reader is cancelled in `finally`.
      const { done, value } = timeoutMs > 0
        ? await Promise.race([
          read,
          new Promise<never>((_, reject) => {
            timer = setTimer(() => {
              timedOut = true
              reject(new Error(`Body read timed out after ${timeoutMs}ms`))
            }, timeoutMs)
          }),
        ])
        : await read
      if (done) break
      if (!value) continue
      total += value.byteLength
      if (total > maxBytes) throw new PayloadTooLargeError(maxBytes)
      chunks.push(value)
    }
  } finally {
    if (timer !== null) clearTimer(timer)
    // Cancel from the outside: the pending `read()` will never settle on its
    // own for a stalled stream, and leaving the reader open leaks the
    // connection the request arrived on.
    if (timedOut || total > maxBytes) await cancelReader(reader)
    try {
      reader.releaseLock()
    } catch {
      // Released by `cancel()` already.
    }
  }

  return concatChunks(chunks, total)
}

/**
 * Copy accumulated chunks into one right-sized buffer.
 *
 * The result's backing `ArrayBuffer` is exactly `total` bytes at offset 0, so
 * `body.buffer` is safe to hand to `new Response(...)` — the multipart parser
 * needs the whole buffer to be the body, not a window onto a bigger one.
 */
function concatChunks(chunks: Uint8Array[], total: number): Uint8Array<ArrayBuffer> {
  const body = new Uint8Array(total)
  let offset = 0
  for (const chunk of chunks) {
    body.set(chunk, offset)
    offset += chunk.byteLength
  }
  return body
}

/**
 * Read a request body as UTF-8 text under the same cap and timeout.
 *
 * Decoding is not fatal: a truncated multi-byte sequence at the cap yields the
 * replacement character instead of a `TypeError`, so a caller can still answer
 * `413` rather than `500`.
 */
export async function readBoundedText(
  request: Request,
  options: ReadBoundedBodyOptions,
): Promise<string> {
  const body = await readBoundedBody(request, options)
  return new TextDecoder("utf-8", { fatal: false }).decode(body)
}

/**
 * Parse a `multipart/form-data` (or url-encoded) body under the same cap.
 *
 * Unlike `request.formData()`, the bounded read happens first, so a large
 * upload is rejected at `maxBytes` instead of being buffered in full.
 *
 * @throws {PayloadTooLargeError} Under the same conditions as {@link readBoundedBody}.
 * @throws {TypeError} When the request carries no `content-type`; without it the
 * multipart boundary is unknown and the parse could only return an empty body.
 */
export async function parseBoundedFormData(
  request: Request,
  options: ReadBoundedBodyOptions,
): Promise<FormData> {
  const contentType = request.headers.get("content-type")
  if (!contentType) {
    throw new TypeError("parseBoundedFormData requires a content-type header")
  }
  const body = await readBoundedBody(request, options)

  // The source built the `Response` from `body.buffer`, which hands over the
  // whole backing `ArrayBuffer`. `readBoundedBody` returns an exactly sized
  // array so the two agree today, but the contract is `byteOffset..byteLength`,
  // and a view over a larger buffer would have appended unrelated bytes.
  return await new Response(body.buffer, {
    headers: { "content-type": contentType },
  }).formData()
}
