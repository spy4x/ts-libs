/**
 * ntfy push client — failure-only, retrying, header-safe.
 *
 * Ported from two sources: the `ntfy` half of
 * `rostok/scripts/backup/src/reporting.ts` (retries, priority, tags) and
 * `mig/lib/notify.ts` (gating, fail-soft, and the non-ASCII header fix). The
 * backup domain is gone: nothing here imports or references `BackupResult`, so
 * the notifier works from any caller.
 *
 * Deviations from the sources, each pinned by a test:
 *
 *  - `mig` ran the message **body** through its header sanitiser
 *    (`notify.ts:119`), so `Café ☕` arrived as `Caf? ?`. Only headers are
 *    transliterated here; the body is UTF-8 end to end.
 *  - `mig` returned `void` and logged transport failures
 *    (`notify.ts:121-128`), so a caller could not tell a delivered push from a
 *    dropped one. Every method returns a discriminated result.
 *  - `rostok` gated on `successCount === totalCount` (`reporting.ts:45`), a
 *    backup concept. The gate is now an explicit `NotificationSeverity`.
 *  - Neither source honoured `Retry-After`; `rostok` used a fixed 3s delay
 *    (`reporting.ts:53`). Transient statuses now honour the header.
 *  - `mig` read `NTFY_URL`, `NTFY_TOPIC` and `NTFY_TOKEN` at call time but
 *    `rostok` used a bearer token in `Authorization` directly
 *    (`reporting.ts:193`). The token is a constructor parameter here, never
 *    read at module scope and never logged.
 */

import {
  type BackoffFn,
  type Clock,
  createAsciiHeaders,
  createExponentialBackoff,
  isTransientStatus,
  parseRetryAfterMs,
  type RetryPolicy,
  runWithRetry,
  type Sleeper,
} from "./retry.ts"

/**
 * Severity gate.
 *
 * `Failure` is the default and the only severity a caller has to opt into:
 * a notifier that pushes on every success is noise, and noise is how the real
 * failure gets scrolled past. `Info` exists for callers that want both.
 */
export enum NotificationSeverity {
  /** Pushes. */
  Failure = "failure",
  /** Also pushes. Only useful when the caller explicitly wants success pushes. */
  Info = "info",
}

/** ntfy priority, 1 (min) to 5 (max). `enum` because the set is finite. */
export enum NtfyPriority {
  Min = 1,
  Low = 2,
  Default = 3,
  High = 4,
  Urgent = 5,
}

export interface NtfyClientConfig {
  /** Base ntfy URL, e.g. `https://ntfy.example.invalid`. Trailing slashes are stripped. */
  baseUrl: string
  /** Topic name. Percent-encoded into the path. */
  topic: string
  /** Bearer token. Optional: a self-hosted ntfy without auth needs none. */
  token?: string
}

export interface NtfyPush {
  /** Goes into the `Title` header, so it is transliterated to ASCII. */
  title: string
  /** Goes into the body verbatim, so non-ASCII survives. */
  message: string
  severity: NotificationSeverity
  priority?: NtfyPriority
  tags?: string[]
  click?: string
  /** When set, supersedes the client-level gate. */
  gate?: NotificationSeverity
}

export type NtfyErrorCode = "not_configured" | "http_error" | "network_error" | "invalid_base_url"

export interface NtfyPushed {
  ok: true
  status: "pushed"
  httpStatus: number
  attempts: number
  /** Headers as sent, so a caller can assert the ASCII transliteration. */
  headers: Record<string, string>
}

export interface NtfySkipped {
  ok: true
  status: "skipped"
  reason: "below-gate"
  attempts: 0
}

export interface NtfyFailure {
  ok: false
  code: NtfyErrorCode
  message: string
  status?: number
  attempts: number
}

export type NtfyResult = NtfyPushed | NtfySkipped | NtfyFailure

export interface NtfyRetryOptions {
  maxAttempts?: number
  baseDelayMs?: number
  maxDelayMs?: number
  totalBudgetMs?: number
  jitterRatio?: number
}

export interface NtfyClientOptions {
  fetcher?: typeof fetch
  sleep?: Sleeper
  clock?: Clock
  backoff?: BackoffFn
  retry?: NtfyRetryOptions
  /** Default gate for every push. Defaults to `NotificationSeverity.Failure`. */
  gate?: NotificationSeverity
  /** Receives every requested delay, in order. */
  onDelay?: (delayMs: number, attempt: number) => void
}

/** 5 attempts, 3s between them, mirroring `rostok`'s ntfy loop. */
const DEFAULT_RETRY: RetryPolicy = {
  maxAttempts: 5,
  baseDelayMs: 3000,
  maxDelayMs: 15_000,
  totalBudgetMs: 60_000,
  jitterRatio: 0,
}

/**
 * Reads ntfy settings from an environment reader.
 *
 * All of `NTFY_URL` and `NTFY_TOPIC` are required; `NTFY_TOKEN` is optional
 * because a self-hosted ntfy on a private network may not use auth. `null`
 * when incomplete, so "not configured" stays a caller decision — `mig`
 * collapsed it into a silent no-op, which means a typo'd variable name looks
 * exactly like a deliberate disable.
 */
export const ntfyConfigFromEnv = (
  read: (name: string) => string | undefined = (name) => Deno.env.get(name),
): NtfyClientConfig | null => {
  const baseUrl = read("NTFY_URL")?.trim()
  const topic = read("NTFY_TOPIC")?.trim()
  const token = read("NTFY_TOKEN")?.trim()
  if (!baseUrl || !topic) {
    return null
  }
  return token ? { baseUrl, topic, token } : { baseUrl, topic }
}

/**
 * ntfy client.
 *
 * Pushes are gated: with the default `Failure` gate, `Info` is a no-op that
 * still returns a result, so a caller can assert the gate without inspecting
 * internal state. Every push is retried on 429/5xx and on transport throws,
 * honouring `Retry-After`.
 */
export class NtfyClient {
  private readonly config: NtfyClientConfig
  private readonly fetcher: typeof fetch
  private readonly sleep: Sleeper
  private readonly clock: Clock
  private readonly policy: RetryPolicy
  private readonly backoff: BackoffFn
  private readonly gate: NotificationSeverity

  constructor(config: NtfyClientConfig, options: NtfyClientOptions = {}) {
    const baseUrl = config.baseUrl?.trim().replace(/\/+$/, "") ?? ""
    const topic = config.topic?.trim() ?? ""
    if (baseUrl === "") {
      throw new Error(
        "NtfyClient: baseUrl is empty — use ntfyConfigFromEnv() and handle the " +
          "unconfigured case explicitly",
      )
    }
    if (topic === "") {
      throw new Error("NtfyClient: topic is empty — a push without a topic has nowhere to go")
    }
    this.config = { ...config, baseUrl, topic }
    this.fetcher = options.fetcher ?? ((input, init) => fetch(input, init))
    this.sleep = options.sleep ?? ((ms) => new Promise((resolve) => setTimeout(resolve, ms)))
    this.clock = options.clock ?? (() => Date.now())
    this.gate = options.gate ?? NotificationSeverity.Failure
    this.policy = { ...DEFAULT_RETRY, ...options.retry, onDelay: options.onDelay }
    this.backoff = options.backoff ?? createExponentialBackoff(this.policy)
  }

  /** The topic endpoint, without the token. */
  get endpoint(): string {
    return `${this.config.baseUrl}/${encodeURIComponent(this.config.topic)}`
  }

  /**
   * Sends a push, or records that the gate suppressed it.
   *
   * The title, priority, tags and click URL become headers and are therefore
   * transliterated to ASCII; the message becomes the body and is sent as UTF-8
   * bytes untouched.
   */
  async push(push: NtfyPush): Promise<NtfyResult> {
    const gate = push.gate ?? this.gate
    if (gate === NotificationSeverity.Failure && push.severity !== NotificationSeverity.Failure) {
      return { ok: true, status: "skipped", reason: "below-gate", attempts: 0 }
    }

    const headerValues: Record<string, string> = { "Title": push.title }
    if (this.config.token) {
      headerValues["Authorization"] = `Bearer ${this.config.token}`
    }
    if (push.priority !== undefined) {
      headerValues["Priority"] = String(push.priority)
    }
    if (push.tags && push.tags.length > 0) {
      headerValues["Tags"] = push.tags.join(",")
    }
    if (push.click) {
      headerValues["Click"] = push.click
    }
    const headers = createAsciiHeaders(headerValues)

    let last: PostOutcome | undefined
    const run = await runWithRetry<PostOutcome>({
      policy: this.policy,
      sleep: this.sleep,
      clock: this.clock,
      backoff: this.backoff,
      attempt: async (attempt) => {
        const outcome = await this.post(headers, push.message, attempt)
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
      return {
        ok: true,
        status: "pushed",
        httpStatus: settled.httpStatus,
        attempts: run.attempts,
        headers: Object.fromEntries(headers.entries()),
      }
    }
    return {
      ok: false,
      code: settled.code,
      message: settled.message,
      status: settled.status,
      attempts: run.attempts,
    }
  }

  /**
   * Failure-only convenience wrapper.
   *
   * Named for the gate rather than the transport so a caller cannot reach for
   * it expecting the message to be conditional, and it is the method to use
   * when "only tell me when something broke" is the requirement.
   */
  async notifyFailure(
    title: string,
    message: string,
    options: Omit<NtfyPush, "title" | "message" | "severity"> = {},
  ): Promise<NtfyResult> {
    return await this.push({
      ...options,
      title,
      message,
      severity: NotificationSeverity.Failure,
    })
  }

  private async post(headers: Headers, body: string, attempt: number): Promise<PostOutcome> {
    try {
      // The body is re-encoded from the string by the platform, so UTF-8
      // survives; only the header values were transliterated above.
      const response = await this.fetcher(this.endpoint, { method: "POST", headers, body })
      if (response.ok) {
        return { ok: true, httpStatus: response.status, attempts: attempt }
      }
      return {
        ok: false,
        code: "http_error",
        message: `${response.status} ${response.statusText}`.trim(),
        status: response.status,
        attempts: attempt,
        retryable: isTransientStatus(response.status),
        retryAfterMs: parseRetryAfterMs(response.headers.get("Retry-After")),
      }
    } catch (cause) {
      return {
        ok: false,
        code: "network_error",
        message: cause instanceof Error ? cause.message : String(cause),
        attempts: attempt,
        retryable: true,
      }
    }
  }
}

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
  retryAfterMs?: number
}
