/**
 * The retrying `POST` that `ntfy.ts` and `healthchecks.ts` share: one place for the client
 * defaults, the redirect refusal, the status mapping and the timeout and transport failures.
 * Each client keeps only what differs, which is how it reads a 2xx answer.
 *
 * Not an entry point: nothing here is exported from the package.
 *
 * @module
 */

import {
  type BackoffFn,
  createExponentialBackoff,
  DEFAULT_REQUEST_TIMEOUT_MS,
  describeTransportError,
  isRequestTimeout,
  isTransientStatus,
  parseRetryAfterMs,
  releaseResponseBody,
  type RetryPolicy,
  runWithRetry,
  type Sleeper,
} from "./retry.ts"
import type { RandomSource } from "@spy4x/platform/universal/async"
import type { NowFn } from "@spy4x/platform/universal/time"

/** Failure codes every client can produce. */
export type SharedPostCode = "http_error" | "network_error" | "timeout" | "redirected"

/** An attempt the provider accepted. */
export interface PostSuccess {
  ok: true
  httpStatus: number
}

/** An attempt that failed; `retryable` decides whether another one follows. */
export interface PostFailure<Code extends string> {
  ok: false
  code: Code
  message: string
  retryable: boolean
  status?: number
  retryAfterMs?: number
}

/** What one attempt produced. */
export type PostOutcome<Code extends string> = PostSuccess | PostFailure<Code>

/** The construction options both clients take; their exported option types match this shape. */
export interface PostClientOptions {
  fetcher?: typeof fetch
  sleep?: Sleeper
  clock?: NowFn
  backoff?: BackoffFn
  retry?: Partial<Omit<RetryPolicy, "onDelay">>
  onDelay?: (delayMs: number, attempt: number) => void
  requestTimeoutMs?: number
  random?: RandomSource
}

/** The resolved transport a client posts through. */
export interface PostTransport {
  fetcher: typeof fetch
  sleep: Sleeper
  clock: NowFn
  policy: RetryPolicy
  backoff: BackoffFn
  requestTimeoutMs: number
}

/**
 * Resolves `options` over the real defaults. A retry override set to `undefined` keeps the
 * default: spreading it as is replaced `maxAttempts` with `undefined`, so no attempt ran and the
 * client threw on the missing result.
 */
export const createPostTransport = (
  defaults: RetryPolicy,
  options: PostClientOptions,
): PostTransport => {
  const overrides = Object.fromEntries(
    Object.entries(options.retry ?? {}).filter(([, value]) => value !== undefined),
  )
  const policy: RetryPolicy = { ...defaults, ...overrides, onDelay: options.onDelay }
  return {
    fetcher: options.fetcher ?? ((input, init) => fetch(input, init)),
    sleep: options.sleep ?? ((ms) => new Promise((resolve) => setTimeout(resolve, ms))),
    clock: options.clock ?? (() => Date.now()),
    policy,
    backoff: options.backoff ?? createExponentialBackoff(policy, options.random),
    requestTimeoutMs: options.requestTimeoutMs ?? DEFAULT_REQUEST_TIMEOUT_MS,
  }
}

/** One request to send, and how to read the provider's 2xx answer. */
export interface PostRequest<Code extends string> {
  /** Service name for messages, e.g. `ntfy`. */
  service: string
  /** Which setting a redirect means is wrong, e.g. `base URL`. */
  urlSetting: string
  url: string
  headers?: Headers
  body: string
  /** Decides a 2xx answer and releases its body. */
  accepted: (response: Response) => Promise<PostOutcome<Code>>
}

/** The last attempt's outcome, with the attempt count and the time waited between attempts. */
export interface PostRun<Code extends string> {
  settled: PostOutcome<Code>
  attempts: number
  waitedMs: number
}

/** Sends `request`, retrying transient failures under the transport's policy. Never throws. */
export const postWithRetry = async <Code extends string>(
  transport: PostTransport,
  request: PostRequest<Code>,
): Promise<PostRun<Code | SharedPostCode>> => {
  const run = await runWithRetry<PostOutcome<Code | SharedPostCode>>({
    policy: transport.policy,
    sleep: transport.sleep,
    clock: transport.clock,
    backoff: transport.backoff,
    attempt: async (_attempt, remainingBudgetMs) => {
      const outcome = await postOnce(transport, request, remainingBudgetMs)
      return {
        failed: !outcome.ok && outcome.retryable,
        retryAfterMs: outcome.ok ? undefined : outcome.retryAfterMs,
        value: outcome,
      }
    },
  })
  return { settled: run.result, attempts: run.attempts, waitedMs: run.waitedMs }
}

/**
 * A 3xx answer to a `redirect: "manual"` request. Deno hands back the real status; a browser
 * hands back an `opaqueredirect` response with status 0.
 */
const isRedirect = (response: Response): boolean =>
  response.type === "opaqueredirect" || (response.status >= 300 && response.status < 400)

/** Issues one HTTP attempt, bounded by whichever is smaller of the request timeout or budget. */
const postOnce = async <Code extends string>(
  transport: PostTransport,
  request: PostRequest<Code>,
  remainingBudgetMs: number,
): Promise<PostOutcome<Code | SharedPostCode>> => {
  // Never longer than what `totalBudgetMs` has left: a per-request timeout alone bounds one
  // request, but not the operation the client promises to bound.
  const timeoutMs = Math.max(Math.min(transport.requestTimeoutMs, remainingBudgetMs), 0)
  try {
    const response = await transport.fetcher(request.url, {
      method: "POST",
      headers: request.headers,
      body: request.body,
      // Following a 301/302/303 re-sends the POST as a bodiless GET, which a provider may answer
      // with a 200: a lost request reported as delivered. Following it with the method kept would
      // carry any credential to wherever `Location` points. So a redirect is a failure.
      redirect: "manual",
      signal: AbortSignal.timeout(timeoutMs),
    })
    if (isRedirect(response)) {
      await releaseResponseBody(response)
      // Neither `Location` nor the URL goes into the message: the URL can carry a credential.
      return {
        ok: false,
        code: "redirected",
        message: `${request.service} answered with a redirect (${response.status}); ` +
          `set the ${request.urlSetting} to its final address`,
        status: response.status,
        retryable: false,
      }
    }
    if (response.ok) {
      return await request.accepted(response)
    }
    const outcome: PostFailure<SharedPostCode> = {
      ok: false,
      code: "http_error",
      message: `${response.status} ${response.statusText}`.trim(),
      status: response.status,
      retryable: isTransientStatus(response.status),
      retryAfterMs: parseRetryAfterMs(response.headers.get("Retry-After")),
    }
    await releaseResponseBody(response)
    return outcome
  } catch (cause) {
    if (isRequestTimeout(cause)) {
      return {
        ok: false,
        code: "timeout",
        message: `${request.service} request timed out after ${timeoutMs}ms`,
        retryable: true,
      }
    }
    // The URL can carry a credential, and `fetch` puts the whole URL in its error text.
    return {
      ok: false,
      code: "network_error",
      message: describeTransportError(cause),
      retryable: true,
    }
  }
}
