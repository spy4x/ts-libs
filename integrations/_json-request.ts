/**
 * The JSON request the social and publishing clients (`mastodon.ts`, `bluesky.ts`, `hashnode.ts`,
 * `linkedin.ts`) share: one place for the redirect refusal, the byte caps, the secret redaction,
 * the `429` and `Retry-After` handling and the rule that a request which is not idempotent is
 * never sent again after a `5xx` or a lost answer. Each client keeps only what differs: its URL,
 * its headers and how it reads the answer.
 *
 * Not an entry point: nothing here is exported from the package.
 *
 * @module
 */

import { readBoundedJson } from "@spy4x/net/bounded-body"
import { createPostTransport, type PostTransport } from "./_post.ts"
import {
  type Clock,
  describeTransportError,
  isRequestTimeout,
  parseRetryAfterMs,
  releaseResponseBody,
  type RetryPolicy,
  runWithRetry,
  type Sleeper,
} from "./retry.ts"

/** What replaces a token, a client secret or an authorization code in any error text. */
export const REDACTED = "<REDACTED:TOKEN>"

const MAX_ERROR_BYTES = 64 * 1024
const MAX_MESSAGE_CHARS = 200
const DEFAULT_TIMEOUT_MS = 30_000

const POLICY: RetryPolicy = {
  maxAttempts: 3,
  baseDelayMs: 1_000,
  maxDelayMs: 30_000,
  totalBudgetMs: 90_000,
  jitterRatio: 0.2,
}

/** The transport settings every client of this kind takes. */
export interface JsonClientOptions {
  /** Defaults to `globalThis.fetch`. */
  fetch?: typeof fetch
  /** Limit for each request, body included; 30 s by default. */
  requestTimeoutMs?: number
  /** Waits between attempts; injected by tests so nothing sleeps. */
  sleep?: Sleeper
}

/** One request, and what may be done with its failure. */
export interface JsonRequest {
  /** Service name for messages, e.g. `mastodon`. */
  service: string
  method: "GET" | "POST"
  url: string
  /** Every header, credential included. */
  headers: Headers
  body?: string | Uint8Array<ArrayBuffer>
  /** Cap for a success answer's body. */
  maxBytes: number
  /** Whether a `5xx`, a timeout or a transport failure may be sent again. */
  idempotent: boolean
  /** `false`: a success answer's body is released unread and `body` is `null`. Default `true`. */
  readBody?: boolean
  /** Values that must never appear in an error: the token, a client secret, a code. */
  secrets: readonly string[]
  /**
   * Picks the provider's own message out of an error body; `undefined` when it has none. By
   * default, `error` and `message` joined with ": " (Mastodon's and Bluesky's shape).
   */
  detail?: (body: unknown) => string | undefined
}

/** Reads `{ error?, message? }`; anything else reads as no detail. */
const errorAndMessage = (body: unknown): string | undefined => {
  const { error, message } = (body ?? {}) as { error?: unknown; message?: unknown }
  const parts = [error, message].filter((part): part is string => typeof part === "string")
  return parts.length === 0 ? undefined : parts.join(": ")
}

/** What one request produced. */
export type JsonOutcome =
  | { ok: true; status: number; headers: Headers; body: unknown }
  | {
    ok: false
    status?: number
    message: string
    retryable: boolean
    /** True when the server may have acted anyway: a `5xx`, a lost answer, a timeout. */
    uncertain: boolean
    retryAfterMs?: number
  }

/** Removes control characters and every secret from provider text, then caps it. */
export const cleanText = (text: string, secrets: readonly string[]): string => {
  let clean = text.replace(/\p{Cc}+/gu, " ")
  for (const secret of secrets) if (secret !== "") clean = clean.split(secret).join(REDACTED)
  clean = clean.trim()
  return clean.length > MAX_MESSAGE_CHARS ? `${clean.slice(0, MAX_MESSAGE_CHARS)}...` : clean
}

/** `input` parsed as an `http`/`https` URL, or `undefined`. */
export const webUrl = (input: unknown): URL | undefined => {
  if (typeof input !== "string") return undefined
  try {
    const url = new URL(input)
    return url.protocol === "http:" || url.protocol === "https:" ? url : undefined
  } catch {
    return undefined
  }
}

/**
 * `input` as an `https` origin with nothing else (no path, query, fragment or credentials), or
 * `undefined`. A base URL with a path would be silently dropped by `new URL(path, base)`.
 */
export const httpsOrigin = (input: unknown): string | undefined => {
  if (typeof input !== "string") return undefined
  try {
    const url = new URL(input)
    const bare = url.username === "" && url.password === "" && url.search === "" &&
      url.hash === "" && url.pathname === "/"
    return url.protocol === "https:" && bare ? url.origin : undefined
  } catch {
    return undefined
  }
}

/** Printable ASCII without spaces, so `Headers` cannot throw on it. */
export const TOKEN_SHAPE = /^[\x21-\x7E]+$/

/** Checks the transport settings; returns the transport, or the reason it cannot be built. */
export const createJsonTransport = (
  options: JsonClientOptions & { clock?: Clock },
): PostTransport | string => {
  const timeout = options.requestTimeoutMs ?? DEFAULT_TIMEOUT_MS
  if (!Number.isFinite(timeout) || timeout <= 0) {
    return "invalid options: requestTimeoutMs must be a positive number"
  }
  const transport = createPostTransport(POLICY, {
    fetcher: options.fetch ?? ((input, init) => globalThis.fetch(input, init)),
    sleep: options.sleep,
    clock: options.clock,
    requestTimeoutMs: timeout,
  })
  const jittered = transport.backoff
  // `Retry-After` is waited exactly, capped at `maxDelayMs`: jitter could cut it short and
  // spend the next attempt on another 429.
  transport.backoff = (attempt, retryAfterMs) =>
    retryAfterMs === undefined ? jittered(attempt) : Math.min(retryAfterMs, POLICY.maxDelayMs)
  return transport
}

/** A 3xx to a `redirect: "manual"` request; a browser reports it as `opaqueredirect`. */
const isRedirect = (response: Response): boolean =>
  response.type === "opaqueredirect" || (response.status >= 300 && response.status < 400)

const describeHttpFailure = async (response: Response, request: JsonRequest) => {
  let detail = ""
  try {
    const body = await readBoundedJson(response, { maxBytes: MAX_ERROR_BYTES, timeoutMs: 5_000 })
    const text = (request.detail ?? errorAndMessage)(body)
    if (text !== undefined) detail = cleanText(text, request.secrets)
  } catch {
    // `readBoundedJson` cancels the body on every failure it throws for.
  }
  return `${request.service} answered HTTP ${response.status}${detail === "" ? "" : `: ${detail}`}`
}

/** Sends one request; never throws. */
const sendOnce = async (
  transport: PostTransport,
  request: JsonRequest,
  remainingBudgetMs: number,
): Promise<JsonOutcome> => {
  const timeoutMs = Math.max(Math.min(transport.requestTimeoutMs, remainingBudgetMs), 0)
  const { service } = request
  try {
    const response = await transport.fetcher(request.url, {
      method: request.method,
      headers: request.headers,
      body: request.body,
      // Following a redirect would carry the token to wherever `Location` points.
      redirect: "manual",
      signal: AbortSignal.timeout(timeoutMs),
    })
    if (isRedirect(response)) {
      await releaseResponseBody(response).catch(() => undefined)
      return {
        ok: false,
        status: response.status,
        message: `${service} answered with a redirect (${response.status})`,
        retryable: false,
        uncertain: false,
      }
    }
    if (!response.ok) {
      const status = response.status
      const retryAfter = response.headers.get("Retry-After")
      return {
        ok: false,
        status,
        message: await describeHttpFailure(response, request),
        retryable: status === 429 || (request.idempotent && status >= 500),
        uncertain: status >= 500,
        retryAfterMs: parseRetryAfterMs(retryAfter),
      }
    }
    if (request.readBody === false) {
      await releaseResponseBody(response).catch(() => undefined)
      return { ok: true, status: response.status, headers: response.headers, body: null }
    }
    try {
      const body = await readBoundedJson(response, { maxBytes: request.maxBytes, timeoutMs })
      return { ok: true, status: response.status, headers: response.headers, body }
    } catch (cause) {
      return {
        ok: false,
        message: `${service} answer unreadable (${
          cause instanceof SyntaxError ? "not JSON" : describeTransportError(cause)
        })`,
        retryable: false,
        uncertain: true,
      }
    }
  } catch (cause) {
    // Only the error class: `fetch` puts the whole URL in its error text.
    return {
      ok: false,
      message: isRequestTimeout(cause)
        ? `${service} request timed out after ${timeoutMs} ms`
        : `${service} request failed (${describeTransportError(cause)})`,
      retryable: request.idempotent,
      uncertain: true,
    }
  }
}

/** Sends `request`, retrying what {@link sendOnce} marks retryable. Never throws. */
export const sendJson = async (
  transport: PostTransport,
  request: JsonRequest,
): Promise<JsonOutcome> => {
  const run = await runWithRetry<JsonOutcome>({
    policy: transport.policy,
    sleep: transport.sleep,
    clock: transport.clock,
    backoff: transport.backoff,
    attempt: async (_attempt, remainingBudgetMs) => {
      const value = await sendOnce(transport, request, remainingBudgetMs)
      return {
        failed: !value.ok && value.retryable,
        retryAfterMs: value.ok ? undefined : value.retryAfterMs,
        value,
      }
    },
  })
  return run.result
}

/** The failure half of every result in these clients. */
export const failure = (error: string) => ({ success: false as const, output: null, error })
