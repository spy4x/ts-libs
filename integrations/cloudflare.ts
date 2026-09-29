/**
 * Cloudflare cache purge by URL.
 *
 * Ported from `purgeCloudflare()` in `antonshubin.com/scripts/cloudflare-purge.ts`
 * (spy4x/antonshubin.com#300). The app-specific parts stay in the app: waiting for a
 * build id, mapping `static/` paths to URLs, and the git diff.
 *
 * Behaviour:
 *
 *  - The zone id is looked up by name (`GET /zones?name=`) unless `zoneId` is given. More than
 *    one match fails as ambiguous rather than guessing; the caller passes `zoneId` then.
 *  - URLs are purged in batches of {@link PURGE_BATCH_SIZE}, the API's per-call limit.
 *  - Every request is bounded by `AbortSignal.timeout`.
 *  - The function never throws. A `200` answer with `success: false` is a failure.
 *  - No error or output contains the token or a request header: transport failures are
 *    reported by class name only (`describeTransportError`), and API failures by the
 *    status and the error codes and messages Cloudflare returns, each with control characters
 *    removed, the token replaced by `<REDACTED:TOKEN>` and the length capped.
 *  - Answers are read under a 64 KiB cap; a larger or non-JSON body reports the status alone.
 * @module
 */

import { readBoundedJson } from "@spy4x/net/bounded-body"
import {
  DEFAULT_REQUEST_TIMEOUT_MS,
  describeTransportError,
  isRequestTimeout,
  releaseResponseBody,
} from "./retry.ts"

/** Cloudflare's purge-by-URL endpoint accepts at most this many files per call. */
export const PURGE_BATCH_SIZE = 30

/** A Cloudflare answer is a few hundred bytes; anything past this is not one. */
const MAX_RESPONSE_BYTES = 64 * 1024

/** Longest Cloudflare message copied into `error`, and the most messages copied. */
const MAX_MESSAGE_CHARS = 200
const MAX_MESSAGES = 5

const API = "https://api.cloudflare.com/client/v4"

/** Options for {@link purgeUrls}. Exactly one of `zoneName` and `zoneId` is required. */
export interface CloudflarePurgeOptions {
  /** API token with Zone Read (name lookup only) and Cache Purge. Never logged. */
  token: string
  /** Zone to look up by name. Mutually exclusive with `zoneId`. */
  zoneName?: string
  /** Zone id, which skips the lookup call. Mutually exclusive with `zoneName`. */
  zoneId?: string
  /** Absolute URLs to purge. An empty list succeeds without any request. */
  urls: readonly string[]
  /** Defaults to `globalThis.fetch`. */
  fetch?: typeof fetch
  /** Limit for each request, `DEFAULT_REQUEST_TIMEOUT_MS` (10 s) by default. */
  requestTimeoutMs?: number
}

/** Outcome of a purge: `output` describes what happened on success, `error` on failure. */
export interface CloudflarePurgeResult {
  success: boolean
  output: string
  error: string
}

const failure = (error: string): CloudflarePurgeResult => ({ success: false, output: "", error })

/**
 * Reads a JSON answer under a byte cap. A body that is too large, stalls or is not JSON
 * reads as `undefined`, so the caller reports the status line alone.
 */
const readJson = async (response: Response): Promise<unknown> => {
  try {
    return await readBoundedJson(response, { maxBytes: MAX_RESPONSE_BYTES, timeoutMs: 5_000 })
  } catch {
    await releaseResponseBody(response).catch(() => undefined)
    return undefined
  }
}

/** Replaces every occurrence of the token, and of its trimmed form, in `text`. */
const redactToken = (text: string, token: string): string => {
  let out = text
  for (const secret of new Set([token, token.trim()])) {
    if (secret !== "") out = out.split(secret).join("<REDACTED:TOKEN>")
  }
  return out
}

/** Makes one Cloudflare message safe for a log line: no control characters, no token, capped. */
const cleanMessage = (message: string, token: string): string => {
  // Redact before cutting, so a cut can never leave the front half of the token behind.
  const clean = redactToken(message.replace(/\p{Cc}+/gu, " "), token).trim()
  return clean.length > MAX_MESSAGE_CHARS ? `${clean.slice(0, MAX_MESSAGE_CHARS)}...` : clean
}

/** Summarises Cloudflare's `errors` array. Codes and messages carry no secret; still cleaned. */
const describeApiFailure = (body: unknown, status: number, token: string): string => {
  const errors = (body as { errors?: unknown } | undefined)?.errors
  const detail = Array.isArray(errors)
    ? errors
      .slice(0, MAX_MESSAGES)
      .map((entry) => {
        const { code, message } = (entry ?? {}) as { code?: unknown; message?: unknown }
        return `${typeof code === "number" ? code : "?"} ${
          typeof message === "string" ? cleanMessage(message, token) : ""
        }`.trim()
      })
      .join("; ")
    : ""
  return `HTTP ${status}${detail === "" ? "" : `: ${detail}`}`
}

const describeThrown = (cause: unknown, requestTimeoutMs: number): string =>
  isRequestTimeout(cause)
    ? `request timed out after ${requestTimeoutMs} ms`
    : describeTransportError(cause)

/**
 * Purges `urls` from a Cloudflare zone, 30 per call, and reports the outcome.
 *
 * Stops at the first failed call and says how many URLs were purged before it. An
 * empty `urls` list is a success with nothing to do and makes no request.
 *
 * @example
 * ```ts
 * const result = await purgeUrls({
 *   token,
 *   zoneName: "example.com",
 *   urls: ["https://example.com/sw.js"],
 * })
 * if (!result.success) console.warn(result.error)
 * ```
 */
export const purgeUrls = async (
  options: CloudflarePurgeOptions,
): Promise<CloudflarePurgeResult> => {
  if (typeof options !== "object" || options === null) {
    return failure("invalid options: expected an options object")
  }
  const { token, zoneName, zoneId, urls } = options
  const doFetch = options.fetch ?? globalThis.fetch
  const requestTimeoutMs = options.requestTimeoutMs ?? DEFAULT_REQUEST_TIMEOUT_MS

  if (typeof token !== "string" || token.trim() === "") {
    return failure("invalid options: token is empty")
  }
  const hasName = typeof zoneName === "string" && zoneName.trim() !== ""
  const hasId = typeof zoneId === "string" && zoneId.trim() !== ""
  if (hasName === hasId) {
    return failure("invalid options: give exactly one of zoneName and zoneId")
  }
  if (!Array.isArray(urls) || urls.some((url) => typeof url !== "string" || url.trim() === "")) {
    return failure("invalid options: urls must be a list of non-empty strings")
  }
  if (!Number.isFinite(requestTimeoutMs) || requestTimeoutMs <= 0) {
    return failure("invalid options: requestTimeoutMs must be a positive number")
  }
  if (urls.length === 0) {
    return { success: true, output: "nothing to purge", error: "" }
  }

  try {
    const headers = { Authorization: `Bearer ${token}`, "Content-Type": "application/json" }

    let zone: string
    if (hasId) {
      zone = zoneId!.trim()
    } else {
      const name = zoneName!.trim()
      const response = await doFetch(`${API}/zones?name=${encodeURIComponent(name)}`, {
        headers,
        signal: AbortSignal.timeout(requestTimeoutMs),
      })
      const body = await readJson(response)
      const result = (body as { result?: unknown } | undefined)?.result
      const matches = Array.isArray(result) ? result : []
      const id = (matches[0] as { id?: unknown } | undefined)?.id
      if (!response.ok || matches.length !== 1 || typeof id !== "string" || id === "") {
        const why = !response.ok
          ? describeApiFailure(body, response.status, token)
          : matches.length > 1
          ? `ambiguous: ${matches.length} zones match, pass zoneId instead`
          : "no such zone"
        return failure(`zone lookup for ${name} failed (${why})`)
      }
      zone = id
    }

    let purged = 0
    for (let start = 0; start < urls.length; start += PURGE_BATCH_SIZE) {
      const files = urls.slice(start, start + PURGE_BATCH_SIZE)
      const response = await doFetch(`${API}/zones/${encodeURIComponent(zone)}/purge_cache`, {
        method: "POST",
        headers,
        body: JSON.stringify({ files }),
        signal: AbortSignal.timeout(requestTimeoutMs),
      })
      const body = await readJson(response)
      if (!response.ok || (body as { success?: unknown } | undefined)?.success !== true) {
        return failure(
          `purge failed after ${purged} of ${urls.length} URL(s) (${
            describeApiFailure(body, response.status, token)
          })`,
        )
      }
      purged += files.length
    }
    return { success: true, output: `purged ${purged} URL(s)`, error: "" }
  } catch (cause) {
    return failure(`request failed (${describeThrown(cause, requestTimeoutMs)})`)
  }
}
