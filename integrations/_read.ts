/**
 * The retrying `GET` of a public JSON answer that `reddit.ts` and `hackernews.ts` share: client
 * defaults, the redirect refusal, the byte cap and the retry rules in one place.
 *
 * A read changes nothing, so `429`, `5xx`, timeouts and transport failures are retried, at most
 * three attempts. `Retry-After` is waited exactly, up to 30 s. Any other `4xx` and a redirect are
 * not retried. Messages carry the status or the error class, never a body.
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

const DEFAULT_TIMEOUT_MS = 30_000

/** The retry policy every public read uses. */
export const READ_POLICY: RetryPolicy = {
  maxAttempts: 3,
  baseDelayMs: 1_000,
  maxDelayMs: 30_000,
  totalBudgetMs: 90_000,
  jitterRatio: 0.2,
}

/** Options every public reader takes. */
export interface ReadClientOptions {
  /** Defaults to `globalThis.fetch`. */
  fetch?: typeof fetch
  /** Limit for each request, body included; 30 s by default. */
  requestTimeoutMs?: number
  /** Waits between attempts; injected by tests so nothing sleeps. */
  sleep?: Sleeper
}

/** What a read produced: the parsed body, or a message saying why there is none. */
export type ReadOutcome = { ok: true; body: unknown } | { ok: false; message: string }

/** One `GET` to send. */
export interface ReadRequest {
  /** Service name for messages, e.g. `reddit`. */
  service: string
  url: string
  headers: Headers
  maxBytes: number
  /** Added to the message of an HTTP failure with this status, e.g. why Reddit answers `403`. */
  hints?: Record<number, string>
}

/** Checks the shared options; returns the transport, or the reason it cannot be built. */
export const createReadTransport = (options: ReadClientOptions): PostTransport | string => {
  const timeout = options.requestTimeoutMs ?? DEFAULT_TIMEOUT_MS
  if (!Number.isFinite(timeout) || timeout <= 0) {
    return "invalid options: requestTimeoutMs must be a positive number"
  }
  const transport = createPostTransport(READ_POLICY, {
    fetcher: options.fetch ?? ((input, init) => globalThis.fetch(input, init)),
    sleep: options.sleep,
    requestTimeoutMs: timeout,
  })
  const jittered = transport.backoff
  // `Retry-After` is waited exactly, capped at `maxDelayMs`: jitter could cut it short and spend
  // the next attempt on another 429.
  transport.backoff = (attempt, retryAfterMs) =>
    retryAfterMs === undefined ? jittered(attempt) : Math.min(retryAfterMs, READ_POLICY.maxDelayMs)
  return transport
}

type Attempt = ReadOutcome & { retryable?: boolean; retryAfterMs?: number }

const readOnce = async (
  transport: PostTransport,
  request: ReadRequest,
  remainingBudgetMs: number,
): Promise<Attempt> => {
  const { service } = request
  const timeoutMs = Math.max(Math.min(transport.requestTimeoutMs, remainingBudgetMs), 0)
  try {
    const response = await transport.fetcher(request.url, {
      method: "GET",
      headers: request.headers,
      redirect: "manual",
      signal: AbortSignal.timeout(timeoutMs),
    })
    if (response.type === "opaqueredirect" || (response.status >= 300 && response.status < 400)) {
      await releaseResponseBody(response).catch(() => undefined)
      return { ok: false, message: `${service} answered with a redirect (${response.status})` }
    }
    if (!response.ok) {
      const status = response.status
      const retryAfterMs = parseRetryAfterMs(response.headers.get("Retry-After"))
      await releaseResponseBody(response).catch(() => undefined)
      const hint = request.hints?.[status]
      return {
        ok: false,
        message: `${service} answered HTTP ${status}${hint === undefined ? "" : `: ${hint}`}`,
        retryable: status === 429 || status >= 500,
        retryAfterMs,
      }
    }
    try {
      return {
        ok: true,
        body: await readBoundedJson(response, { maxBytes: request.maxBytes, timeoutMs }),
      }
    } catch (cause) {
      const reason = cause instanceof SyntaxError ? "not JSON" : describeTransportError(cause)
      return { ok: false, message: `${service} answer unreadable (${reason})` }
    }
  } catch (cause) {
    return {
      ok: false,
      message: isRequestTimeout(cause)
        ? `${service} request timed out after ${timeoutMs} ms`
        : `${service} request failed (${describeTransportError(cause)})`,
      retryable: true,
    }
  }
}

/** Sends `request`, retrying what the rules above allow. Never throws. */
export const getJson = async (
  transport: PostTransport,
  request: ReadRequest,
): Promise<ReadOutcome> => {
  const run = await runWithRetry<Attempt>({
    policy: transport.policy,
    sleep: transport.sleep,
    clock: transport.clock,
    backoff: transport.backoff,
    attempt: async (_attempt, remainingBudgetMs) => {
      const value = await readOnce(transport, request, remainingBudgetMs)
      return { failed: value.retryable === true, retryAfterMs: value.retryAfterMs, value }
    },
  })
  const result = run.result
  return result.ok ? { ok: true, body: result.body } : { ok: false, message: result.message }
}
