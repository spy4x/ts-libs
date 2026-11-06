/**
 * The JSON request `mastodon.ts` and `bluesky.ts` share: one place for the redirect refusal, the
 * bounded and checked body, the token redaction and the retry rules of a social client.
 *
 * Not an entry point: nothing here is exported from the package.
 *
 * @module
 */

import { readBoundedJson } from "@spy4x/net/bounded-body"
import { createPostTransport, type PostTransport } from "./_post.ts"
import {
  describeTransportError,
  isRequestTimeout,
  parseRetryAfterMs,
  releaseResponseBody,
  type RetryPolicy,
  runWithRetry,
  type Sleeper,
} from "./retry.ts"

/** Error bodies are small; a larger one is read as "no detail". */
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

/** Printable ASCII without spaces, so `Headers` cannot throw on it. */
export const TOKEN_SHAPE = /^[\x21-\x7E]+$/

/** What the caller may inject: the same three settings every client takes. */
export interface JsonClientOptions {
  /** Defaults to `globalThis.fetch`. */
  fetch?: typeof fetch
  /** Limit for each request, body included; 30 s by default. */
  requestTimeoutMs?: number
  /** Waits between attempts; injected by tests so nothing sleeps. */
  sleep?: Sleeper
}

/** One request to send. */
export interface JsonRequest {
  /** Service name for messages, e.g. `mastodon`. */
  service: string
  method: "GET" | "POST"
  url: string
  headers: Headers
  body?: string | Uint8Array<ArrayBuffer>
  /** Cap for the 2xx body. */
  maxBytes: number
  /** Whether a `5xx`, a timeout or a transport failure may be sent again. */
  idempotent: boolean
  /** Values replaced by `<REDACTED:TOKEN>` in any error text the server sends back. */
  secrets: readonly string[]
}

/** What a request produced. */
export type JsonOutcome =
  | { ok: true; body: unknown }
  | {
    ok: false
    message: string
    /** HTTP status, when the server answered. */
    status?: number
    retryable: boolean
    /** True when the server may have acted anyway: a `5xx`, a lost answer, a timeout. */
    uncertain: boolean
    retryAfterMs?: number
  }

/** Builds the transport, or returns why the options are invalid. */
export const createJsonTransport = (options: JsonClientOptions): PostTransport | string => {
  const timeout = options.requestTimeoutMs ?? DEFAULT_TIMEOUT_MS
  if (!Number.isFinite(timeout) || timeout <= 0) {
    return "invalid options: requestTimeoutMs must be a positive number"
  }
  const transport = createPostTransport(POLICY, {
    fetcher: options.fetch ?? ((input, init) => globalThis.fetch(input, init)),
    sleep: options.sleep,
    requestTimeoutMs: timeout,
  })
  const jittered = transport.backoff
  // `Retry-After` is waited exactly, capped at `maxDelayMs`: jitter could cut it short and spend
  // the next attempt on another 429.
  transport.backoff = (attempt, retryAfterMs) =>
    retryAfterMs === undefined ? jittered(attempt) : Math.min(retryAfterMs, POLICY.maxDelayMs)
  return transport
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

/** Removes control characters and every secret from server text, then caps it. */
const cleanMessage = (text: string, secrets: readonly string[]): string => {
  let clean = text.replace(/\p{Cc}+/gu, " ")
  for (const secret of secrets) {
    if (secret !== "") clean = clean.split(secret).join("<REDACTED:TOKEN>")
  }
  clean = clean.trim()
  return clean.length > MAX_MESSAGE_CHARS ? `${clean.slice(0, MAX_MESSAGE_CHARS)}...` : clean
}

/** Both APIs answer `{ error, message? }` on failure; anything else reads as no detail. */
const describeHttpFailure = async (response: Response, request: JsonRequest): Promise<string> => {
  let detail = ""
  try {
    const body = await readBoundedJson(response, { maxBytes: MAX_ERROR_BYTES, timeoutMs: 5_000 })
    const { error, message } = (body ?? {}) as { error?: unknown; message?: unknown }
    const parts = [error, message].filter((part): part is string => typeof part === "string")
    detail = cleanMessage(parts.join(": "), request.secrets)
  } catch {
    // `readBoundedJson` cancels the body on every failure it throws for.
  }
  return `${request.service} answered HTTP ${response.status}${detail === "" ? "" : `: ${detail}`}`
}

/** A 3xx to a `redirect: "manual"` request; a browser reports it as `opaqueredirect`. */
const isRedirect = (response: Response): boolean =>
  response.type === "opaqueredirect" || (response.status >= 300 && response.status < 400)

/** Sends one request; never throws. */
const sendOnce = async (
  transport: PostTransport,
  request: JsonRequest,
  remainingBudgetMs: number,
): Promise<JsonOutcome> => {
  const timeoutMs = Math.max(Math.min(transport.requestTimeoutMs, remainingBudgetMs), 0)
  const service = request.service
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
        message: `${service} answered with a redirect (${response.status})`,
        status: response.status,
        retryable: false,
        uncertain: false,
      }
    }
    if (!response.ok) {
      const status = response.status
      const retryAfter = response.headers.get("Retry-After")
      return {
        ok: false,
        message: await describeHttpFailure(response, request),
        status,
        retryable: status === 429 || (request.idempotent && status >= 500),
        uncertain: status >= 500,
        retryAfterMs: parseRetryAfterMs(retryAfter),
      }
    }
    try {
      const body = await readBoundedJson(response, { maxBytes: request.maxBytes, timeoutMs })
      return { ok: true, body }
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
