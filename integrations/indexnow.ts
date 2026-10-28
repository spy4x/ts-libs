/**
 * IndexNow: tell search engines that pages on a site were added, changed or removed.
 *
 * One `POST` to `https://api.indexnow.org/indexnow` reaches every engine that takes part (Bing,
 * Yandex, Seznam, Naver and others share submissions), as https://www.indexnow.org/documentation
 * describes.
 *
 *  - Up to {@link INDEXNOW_MAX_URLS} addresses per call, the protocol's limit; more is refused
 *    rather than split, so one call is one request.
 *  - Every address must be an `http`/`https` URL on `host`; the engine would answer `422` anyway.
 *  - The request is bounded by `AbortSignal.timeout`.
 *  - The function never throws, and the answer's body is never read. `200` and `202` (key not yet
 *    checked) succeed; any other status fails with the status and what IndexNow says it means.
 *  - The key is not a secret: the site serves it in a public file, so it may appear in `error`.
 *
 * @module
 */

import {
  DEFAULT_REQUEST_TIMEOUT_MS,
  describeTransportError,
  isRequestTimeout,
  releaseResponseBody,
} from "./retry.ts"

/** The most addresses IndexNow accepts in one submission. */
export const INDEXNOW_MAX_URLS = 10_000

const ENDPOINT = "https://api.indexnow.org/indexnow"

/** A key is 8 to 128 letters, digits and dashes. */
const KEY_SHAPE = /^[A-Za-z0-9-]{8,128}$/

/** What IndexNow says each failure status means. */
const STATUS_MEANING: Record<number, string> = {
  400: "bad request",
  403: "key not valid: the key file is missing or does not hold the key",
  422: "URLs do not belong to the host, or the key does not match the protocol",
  429: "too many requests",
}

/** Options for {@link submitIndexNow}. */
export interface IndexNowOptions {
  /** The site's host name, such as `www.example.com`. Every URL must be on it. */
  host: string
  /** The site's IndexNow key: 8 to 128 letters, digits and dashes. */
  key: string
  /** Absolute address of the key file, when it is not served at `https://<host>/<key>.txt`. */
  keyLocation?: string
  /** Absolute addresses of the pages that changed, at most {@link INDEXNOW_MAX_URLS}. */
  urls: readonly string[]
  /** Defaults to `globalThis.fetch`. */
  fetch?: typeof fetch
  /** Limit for the request, `DEFAULT_REQUEST_TIMEOUT_MS` (10 s) by default. */
  requestTimeoutMs?: number
}

/** Outcome of a submission: `output` describes what happened on success, `error` on failure. */
export interface IndexNowResult {
  success: boolean
  output: string
  error: string
}

const failure = (error: string): IndexNowResult => ({ success: false, output: "", error })

/** `input` parsed as an `http`/`https` URL, or `undefined`. */
const webUrl = (input: unknown): URL | undefined => {
  if (typeof input !== "string") return undefined
  try {
    const url = new URL(input)
    return url.protocol === "http:" || url.protocol === "https:" ? url : undefined
  } catch {
    return undefined
  }
}

/**
 * Submits `urls` to IndexNow and reports the outcome. Never throws: a caller that pings after a
 * deploy or a catalog change logs `error` and carries on.
 *
 * An empty `urls` list succeeds with nothing to do and sends no request.
 *
 * @example
 * ```ts
 * const result = await submitIndexNow({
 *   host: "shop.example",
 *   key: "0123456789abcdef",
 *   urls: ["https://shop.example/shirts/linen"],
 * })
 * if (!result.success) console.warn(result.error)
 * ```
 */
export const submitIndexNow = async (options: IndexNowOptions): Promise<IndexNowResult> => {
  if (typeof options !== "object" || options === null) {
    return failure("invalid options: expected an options object")
  }
  const { host, key, keyLocation, urls } = options
  const doFetch = options.fetch ?? globalThis.fetch
  const requestTimeoutMs = options.requestTimeoutMs ?? DEFAULT_REQUEST_TIMEOUT_MS

  if (typeof host !== "string" || host.trim() === "") {
    return failure("invalid options: host is empty")
  }
  const hostname = host.trim().toLowerCase()
  if (typeof key !== "string" || !KEY_SHAPE.test(key)) {
    return failure("invalid options: key must be 8 to 128 letters, digits and dashes")
  }
  if (keyLocation !== undefined && webUrl(keyLocation)?.hostname !== hostname) {
    return failure(`invalid options: keyLocation must be an http or https URL on ${hostname}`)
  }
  if (!Array.isArray(urls)) return failure("invalid options: urls must be a list")
  if (urls.length > INDEXNOW_MAX_URLS) {
    return failure(`invalid options: ${urls.length} URLs, IndexNow takes ${INDEXNOW_MAX_URLS}`)
  }
  const offHost = urls.find((url) => webUrl(url)?.hostname !== hostname)
  if (offHost !== undefined) {
    return failure(`invalid options: not an http or https URL on ${hostname}: ${String(offHost)}`)
  }
  if (!Number.isFinite(requestTimeoutMs) || requestTimeoutMs <= 0) {
    return failure("invalid options: requestTimeoutMs must be a positive number")
  }
  if (urls.length === 0) return { success: true, output: "nothing to submit", error: "" }

  try {
    const response = await doFetch(ENDPOINT, {
      method: "POST",
      headers: { "Content-Type": "application/json; charset=utf-8" },
      body: JSON.stringify({
        host: hostname,
        key,
        ...(keyLocation === undefined ? {} : { keyLocation }),
        urlList: urls,
      }),
      signal: AbortSignal.timeout(requestTimeoutMs),
    })
    await releaseResponseBody(response)
    if (response.status === 200 || response.status === 202) {
      return { success: true, output: `submitted ${urls.length} URL(s)`, error: "" }
    }
    const meaning = STATUS_MEANING[response.status]
    return failure(`submission failed (HTTP ${response.status}${meaning ? `: ${meaning}` : ""})`)
  } catch (cause) {
    return failure(
      `request failed (${
        isRequestTimeout(cause)
          ? `request timed out after ${requestTimeoutMs} ms`
          : describeTransportError(cause)
      })`,
    )
  }
}
