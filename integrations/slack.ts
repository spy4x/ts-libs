/**
 * Slack incoming-webhook client.
 *
 * One POST, zero dependencies, zero SDK. The payload is passed through
 * untouched: Block Kit blocks are domain-bound and stay in the application.
 * This module also does not register handlers — `initX()` plus
 * `eventBus.register(DomainEvent, Handler)` is the application's CQRS wiring.
 *
 * Deviation from the `roley` source this was ported from: `send` returned a
 * bare `boolean` and logged the failure body on the way out
 * (`slack.service.ts:22-25`), and callers ignored the result, so a revoked
 * webhook went unnoticed. `send` now returns a discriminated result carrying
 * the HTTP status, and writes nothing to the console.
 */

import {
  type BackoffFn,
  type Clock,
  createExponentialBackoff,
  describeErrorKind,
  describeTransportError,
  isTransientStatus,
  parseRetryAfterMs,
  type RetryPolicy,
  runWithRetry,
  type Sleeper,
} from "./retry.ts"

export interface SlackClientConfig {
  /** Slack incoming-webhook URL, e.g. `https://hooks.slack.example.com/services/T/B/X`. */
  webhookUrl: string
}

/**
 * Failure reasons `send` can report.
 *
 * There is deliberately no `not_configured` code: an unconfigured client is
 * rejected at construction rather than represented as a runtime failure a
 * caller can forget to branch on. `slackConfigFromEnv` returning `null` is how
 * "not configured" reaches the caller, as an explicit decision.
 */
export type SlackErrorCode = "http_error" | "network_error" | "invalid_payload"

export interface SlackSuccess {
  ok: true
  /** Slack answers an accepted webhook with `200 OK` and the body `ok`. */
  httpStatus: number
  attempts: number
}

export interface SlackFailure {
  ok: false
  code: SlackErrorCode
  message: string
  /** Absent only when no request was made. */
  status?: number
  /** Slack's verbatim response body, truncated. Never contains a secret. */
  responseBody?: string
  attempts: number
}

export type SlackResult = SlackSuccess | SlackFailure

export interface SlackRetryOptions {
  maxAttempts?: number
  baseDelayMs?: number
  maxDelayMs?: number
  totalBudgetMs?: number
  jitterRatio?: number
}

export interface SlackClientOptions {
  fetcher?: typeof fetch
  sleep?: Sleeper
  clock?: Clock
  backoff?: BackoffFn
  retry?: SlackRetryOptions
  /** Receives every requested delay, in order. */
  onDelay?: (delayMs: number, attempt: number) => void
}

const DEFAULT_RETRY: RetryPolicy = {
  maxAttempts: 3,
  baseDelayMs: 500,
  maxDelayMs: 8000,
  totalBudgetMs: 30_000,
  jitterRatio: 0.2,
}

/** Longest Slack error body kept in a result. */
const MAX_RESPONSE_BODY = 500

type PostOutcome = PostSuccess | PostFailure

interface PostSuccess {
  ok: true
  httpStatus: number
  attempts: number
}

interface PostFailure {
  ok: false
  code: "http_error" | "network_error"
  message: string
  attempts: number
  retryable: boolean
  status?: number
  responseBody?: string
  retryAfterMs?: number
}

/**
 * Reads the webhook URL from an environment reader.
 *
 * Returns `null` when it is absent or blank. Nothing is read at module scope,
 * so importing this module never throws on a process with no environment.
 */
export const slackConfigFromEnv = (
  read: (name: string) => string | undefined = (name) => Deno.env.get(name),
): SlackClientConfig | null => {
  const webhookUrl = read("SLACK_WEBHOOK_URL")?.trim()
  return webhookUrl ? { webhookUrl } : null
}

/**
 * Slack incoming-webhook client.
 *
 * A client with a blank URL is rejected at construction: a webhook this
 * optional would otherwise fail silently at the first send, which is the
 * behaviour being removed. Callers that tolerate an unconfigured integration
 * decide that themselves and record it — see `slackConfigFromEnv`.
 */
export class SlackClient {
  private readonly webhookUrl: string
  private readonly fetcher: typeof fetch
  private readonly sleep: Sleeper
  private readonly clock: Clock
  private readonly policy: RetryPolicy
  private readonly backoff: BackoffFn

  constructor(config: SlackClientConfig, options: SlackClientOptions = {}) {
    const webhookUrl = config.webhookUrl?.trim() ?? ""
    if (webhookUrl === "") {
      throw new Error(
        "SlackClient: webhookUrl is empty — pass slackConfigFromEnv(Deno.env.get) ?? undefined " +
          "and handle the unconfigured case explicitly",
      )
    }
    this.webhookUrl = webhookUrl
    this.fetcher = options.fetcher ?? ((input, init) => fetch(input, init))
    this.sleep = options.sleep ?? ((ms) => new Promise((resolve) => setTimeout(resolve, ms)))
    this.clock = options.clock ?? (() => Date.now())
    this.policy = { ...DEFAULT_RETRY, ...options.retry, onDelay: options.onDelay }
    this.backoff = options.backoff ?? createExponentialBackoff(this.policy)
  }

  /**
   * Posts one payload to the webhook.
   *
   * Never throws and never logs. 429 and 5xx retry under the policy, honouring
   * `Retry-After`; every other non-2xx fails immediately, since a malformed
   * Block Kit payload cannot become valid by being sent again.
   */
  async send(payload: unknown): Promise<SlackResult> {
    if (payload === undefined) {
      return {
        ok: false,
        code: "invalid_payload",
        message: "payload is undefined",
        attempts: 0,
      }
    }
    let body: string
    try {
      body = JSON.stringify(payload)
    } catch (cause) {
      // A serialisation failure is a caller bug, not a provider problem, so it
      // reports as `invalid_payload` with a fixed description. The raw message
      // is not returned: what `JSON.stringify` throws on a payload with a
      // hostile `toJSON` or getter is caller-controlled text, and a result is
      // the kind of value that gets logged. The error's class still tells the
      // caller whether it was a cycle (`TypeError`) or a BigInt (`TypeError`) —
      // both `TypeError` here, which is why the description carries the weight.
      return {
        ok: false,
        code: "invalid_payload",
        message: `payload is not JSON-serialisable (${describeErrorKind(cause)})`,
        attempts: 0,
      }
    }

    let last: PostOutcome | undefined
    const run = await runWithRetry<PostOutcome>({
      policy: this.policy,
      sleep: this.sleep,
      clock: this.clock,
      backoff: this.backoff,
      attempt: async (attempt) => {
        const outcome = await this.post(body, attempt)
        last = outcome
        return {
          failed: !outcome.ok && outcome.retryable,
          retryAfterMs: outcome.ok ? undefined : outcome.retryAfterMs,
          value: outcome,
        }
      },
    })
    const settled = last ?? run.result
    if (settled.ok) {
      return { ok: true, httpStatus: settled.httpStatus, attempts: run.attempts }
    }
    return {
      ok: false,
      code: settled.code,
      message: settled.message,
      status: settled.status,
      responseBody: settled.responseBody,
      attempts: run.attempts,
    }
  }

  private async post(body: string, attempt: number): Promise<PostOutcome> {
    try {
      const response = await this.fetcher(this.webhookUrl, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body,
      })
      if (response.ok) {
        return { ok: true, httpStatus: response.status, attempts: attempt }
      }
      return {
        ok: false,
        code: "http_error",
        message: `${response.status} ${response.statusText}`.trim(),
        status: response.status,
        responseBody: await readErrorBody(response),
        attempts: attempt,
        retryable: isTransientStatus(response.status),
        retryAfterMs: parseRetryAfterMs(response.headers.get("Retry-After")),
      }
    } catch (cause) {
      return {
        ok: false,
        code: "network_error",
        message: describeTransportError(cause),
        attempts: attempt,
        retryable: true,
      }
    }
  }
}

/**
 * Slack answers a failed webhook with a plain-text reason (`invalid_payload`,
 * `channel_not_found`), not JSON. Reading it as text keeps the reason. Slack
 * posts to this URL as a query token, so only the path-less URL is ever at
 * risk; nothing here is logged, so no token can leak.
 */
const readErrorBody = async (response: Response): Promise<string | undefined> => {
  try {
    const text = (await response.text()).trim()
    return text === "" ? undefined : text.slice(0, MAX_RESPONSE_BODY)
  } catch {
    return undefined
  }
}
