/**
 * Bounded body reading — a hard byte cap plus a stalled-body timeout.
 *
 * Merges two behaviours that lived in separate source repos:
 *  - `offer-lens/libs/scraper/mod.ts` streamed a `Response` body and threw the
 *    moment the accumulated bytes passed a hard cap.
 *  - `warthunder-stats/libs/server/http/body.ts` read a `Request` body with the
 *    same cap and pre-checked a declared `Content-Length`.
 *  - The stalled-body half — a timer that cancels the reader — was
 *    `offer-lens`-only and applies to both here.
 *
 * Zero dependencies: `ReadableStream`, `TextDecoder` and `setTimeout` are all
 * platform APIs. Bodies are decoded incrementally so a huge payload never lands
 * in memory as one string, and the reader is always cancelled and unlocked.
 * @module
 */

/** Finite failure kinds a bounded read can raise. */
export enum BodyReadErrorCode {
  PayloadTooLarge = "payload_too_large",
  BodyReadTimeout = "body_read_timeout",
}

/** Body exceeded the byte cap. */
export class PayloadTooLargeError extends Error {
  /** Discriminant matching {@link BodyReadErrorCode.PayloadTooLarge}. */
  readonly code = BodyReadErrorCode.PayloadTooLarge
  /**
   * Builds the error for the cap that was exceeded.
   * @param maxBytes The byte cap that was exceeded.
   */
  constructor(public readonly maxBytes: number) {
    super(`Payload exceeds ${maxBytes} bytes`)
    this.name = "PayloadTooLargeError"
  }
}

/**
 * No chunk arrived within the stall budget.
 *
 * Thrown for both a body that never produced a first chunk and one that went
 * quiet midway. The read is abandoned — a stalled stream cannot be drained, so
 * the body is cancelled instead.
 */
export class BodyReadTimeoutError extends Error {
  /** Discriminant matching {@link BodyReadErrorCode.BodyReadTimeout}. */
  readonly code = BodyReadErrorCode.BodyReadTimeout
  /**
   * Builds the error for the stall budget that was exceeded.
   * @param timeoutMs The stall budget that was exceeded.
   */
  constructor(public readonly timeoutMs: number) {
    super(`Body read stalled for ${timeoutMs}ms`)
    this.name = "BodyReadTimeoutError"
  }
}

/** Default ceiling for a body read: 5 MiB. */
export const DEFAULT_MAX_BYTES: number = 5 * 1024 * 1024

/**
 * Default stall budget: 10s without a chunk.
 *
 * This is the value a read uses when the caller passes no `timeoutMs`. A caller
 * who wants no stall budget at all asks for it with `timeoutMs: 0`; a default of
 * "wait forever" is not something anybody would choose deliberately, and a
 * response that stops mid-body is exactly what a hostile server sends.
 */
export const DEFAULT_BODY_TIMEOUT_MS: number = 10_000

/**
 * The read surface shared by `Request` and `Response`.
 *
 * Structural on purpose: both platform types carry these two members, so one
 * reader serves an inbound request body and an outbound response body. Only the
 * members this module touches are named, which keeps `Headers` out of the
 * module's public surface.
 */
export interface BodySource {
  /** Header reader, used to pre-check a declared `Content-Length`. */
  readonly headers: { get(name: string): string | null }
  /** The body stream, or `null` when the source carries none. */
  readonly body: ReadableStream<Uint8Array> | null
}

/** Per-call overrides for a bounded body read. */
export interface BodyReadOptions {
  /**
   * Stall budget in ms: the maximum time to wait for the next chunk. Defaults
   * to `DEFAULT_BODY_TIMEOUT_MS` (10s). `0` turns the budget off and leaves the
   * byte cap alone governing, which means a body that goes quiet is waited on
   * for as long as the connection lives.
   */
  timeoutMs?: number
  /**
   * Byte cap for this read. Defaults to `DEFAULT_MAX_BYTES`. Must be a
   * positive finite number: `NaN` and `Infinity` both compare false against
   * a running total, which switches the cap off instead of raising it, so
   * both are rejected before the reader is taken.
   */
  maxBytes?: number
}

/**
 * Read the declared `Content-Length`, if the sender provided a usable one.
 *
 * The value must be bare decimal digits. `Number()` alone also accepts `1e3`,
 * `0x10`, `+5` and `" 5"`, none of which are legal field values (RFC 9110
 * §8.6) — and a pre-check that reads a bogus header as a number is a pre-check
 * that can be talked out of doing its job.
 *
 * @returns The declared length, or `null` when the header is absent, not a
 * non-negative integer, or malformed. A malformed length is treated as
 * "unknown" rather than as zero, so it never becomes an accidental allowance.
 */
export function readContentLength(headers: { get(name: string): string | null }): number | null {
  const raw = headers.get("content-length")
  if (!raw || !/^\d+$/.test(raw)) return null
  const n = Number(raw)
  if (!Number.isSafeInteger(n)) return null
  return n
}

/**
 * Read a body into chunks, enforcing the hard cap and the stall budget.
 *
 * The cap is checked against the declared `Content-Length` before a single byte
 * is read, and again against the running total while streaming, so a lying or
 * absent header cannot get past it. The stall budget covers waiting for the
 * *next* chunk, so a slow-but-live transfer may take as long as it needs while
 * a hung one fails fast. Both limits apply whether or not the caller asked for
 * them: the defaults are 5 MiB and 10s.
 *
 * The reader is cancelled and unlocked on every exit path, including the two
 * throws — a failed bounded read must not leave the socket open.
 *
 * @throws `RangeError` when `maxBytes` is not a finite number (`NaN` or
 * `Infinity`), before the reader is taken.
 * @throws `PayloadTooLargeError` when the body exceeds `maxBytes`.
 * @throws `BodyReadTimeoutError` when no chunk arrives within `timeoutMs`.
 */
async function* readBoundedChunks(
  source: BodySource,
  options: BodyReadOptions,
): AsyncGenerator<Uint8Array> {
  const maxBytes = options.maxBytes ?? DEFAULT_MAX_BYTES
  const timeoutMs = options.timeoutMs ?? DEFAULT_BODY_TIMEOUT_MS

  if (!Number.isFinite(maxBytes)) {
    throw new RangeError(`maxBytes must be a finite number, got ${maxBytes}`)
  }

  const declaredLength = readContentLength(source.headers)
  if (declaredLength !== null && declaredLength > maxBytes) {
    throw new PayloadTooLargeError(maxBytes)
  }

  if (!source.body) return

  const reader = source.body.getReader()
  let total = 0

  /** `Promise.race` against a per-chunk timer; the timer covers one read only. */
  const readNext = (): Promise<ReadableStreamReadResult<Uint8Array>> => {
    if (timeoutMs <= 0) return reader.read()
    // `ReturnType<typeof setTimeout>`, not `number`: the id is a `number` under
    // Deno's typings and a `Timeout` object under Node's, and one import of a
    // `node:` builtin is enough to pull the latter into the same compilation.
    let timer: ReturnType<typeof setTimeout> | undefined
    return Promise.race([
      reader.read(),
      new Promise<never>((_resolve, reject) => {
        timer = setTimeout(() => reject(new BodyReadTimeoutError(timeoutMs)), timeoutMs)
      }),
    ]).finally(() => {
      if (timer !== undefined) clearTimeout(timer)
    })
  }

  try {
    while (true) {
      const { done, value } = await readNext()
      if (done) return
      if (!value) continue
      total += value.byteLength
      if (total > maxBytes) throw new PayloadTooLargeError(maxBytes)
      yield value
    }
  } catch (error) {
    // An abandoned read must not keep the socket alive: cancel, then rethrow.
    await cancelQuietly(reader)
    throw error
  } finally {
    // `releaseLock` throws while a read is still pending, which is exactly the
    // stalled case, so it stays best-effort.
    try {
      reader.releaseLock()
    } catch {
      // Pending read on an abandoned stream.
    }
  }
}

/**
 * Read a body into bytes under the hard cap and stall budget.
 *
 * @throws `RangeError` when `maxBytes` is not a finite number.
 * @throws `PayloadTooLargeError` when the body exceeds `maxBytes`.
 * @throws `BodyReadTimeoutError` when no chunk arrives within `timeoutMs`.
 */
export async function readBoundedBody(
  source: BodySource,
  options: BodyReadOptions = {},
): Promise<Uint8Array> {
  const chunks: Uint8Array[] = []
  let total = 0
  for await (const chunk of readBoundedChunks(source, options)) {
    chunks.push(chunk)
    total += chunk.byteLength
  }

  const body = new Uint8Array(total)
  let offset = 0
  for (const chunk of chunks) {
    body.set(chunk, offset)
    offset += chunk.byteLength
  }
  return body
}

/**
 * Read a body as text, decoding incrementally so the cap is enforced before the
 * whole payload is materialised as one string.
 *
 * @throws `RangeError` when `maxBytes` is not a finite number.
 * @throws `PayloadTooLargeError` when the body exceeds `maxBytes`.
 * @throws `BodyReadTimeoutError` when no chunk arrives within `timeoutMs`.
 */
export async function readBoundedText(
  source: BodySource,
  options: BodyReadOptions = {},
): Promise<string> {
  const decoder = new TextDecoder("utf-8", { fatal: false })
  let text = ""
  for await (const chunk of readBoundedChunks(source, options)) {
    text += decoder.decode(chunk, { stream: true })
  }
  return text + decoder.decode()
}

/**
 * Read a body as JSON under the same cap and stall budget as
 * `readBoundedText`.
 *
 * Lets the platform `SyntaxError` from `JSON.parse` escape on malformed JSON,
 * so callers do not need a third error type to branch on.
 */
export async function readBoundedJson<T = unknown>(
  source: BodySource,
  options: BodyReadOptions = {},
): Promise<T> {
  return JSON.parse(await readBoundedText(source, options)) as T
}

/**
 * Parse a `multipart/form-data` (or url-encoded) request body under the same cap
 * and stall budget as `readBoundedBody`.
 *
 * Unlike `request.formData()`, the bounded read happens first, so a large upload
 * is rejected at `maxBytes` instead of being buffered in full.
 *
 * The bytes go to `Response` as a view, never as `body.buffer`: `Response` reads
 * `byteOffset..byteLength` of what it is handed, so the whole backing buffer
 * would append unrelated bytes if the reader ever returned a window onto a larger
 * allocation. The one cast is on the view only: `readBoundedBody` declares
 * `Uint8Array<ArrayBufferLike>` while `BodyInit` demands `Uint8Array<ArrayBuffer>`.
 *
 * Moved here from `@spy4x/server/http/bounded-body` (#222), which still
 * re-exports this same function, so a caller that only needs a form cap does not
 * depend on the whole server package.
 *
 * @throws `PayloadTooLargeError` under the same conditions as `readBoundedBody`.
 * @throws `BodyReadTimeoutError` when no chunk arrives within `timeoutMs`.
 * @throws `TypeError` when the request carries no `content-type`; without it the
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

  return await new Response(body as Uint8Array<ArrayBuffer>, {
    headers: { "content-type": contentType },
  }).formData()
}

async function cancelQuietly(
  reader: ReadableStreamDefaultReader<Uint8Array>,
): Promise<void> {
  try {
    await reader.cancel()
  } catch {
    // Already errored or cancelled; nothing to clean up.
  }
}
