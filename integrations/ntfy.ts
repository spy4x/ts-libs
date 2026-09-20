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

import { createAsciiHeaders } from "./header-safety.ts"
import {
  type BackoffFn,
  type Clock,
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

/**
 * Failure reasons `push` can report.
 *
 * There is deliberately no `not_configured` or `invalid_base_url` member: a
 * blank or unparseable base URL is rejected at construction, so neither can
 * reach a result. `ntfyConfigFromEnv` returning `null` is how "not configured"
 * reaches the caller, as an explicit decision. A member no code path produces
 * is one a caller branches on forever and never sees — the same defect as an
 * unreachable validator.
 */
export type NtfyErrorCode = "http_error" | "network_error" | "timeout"

export interface NtfyPushed {
  ok: true
  status: "pushed"
  httpStatus: number
  attempts: number
  /**
   * The header values a caller may need, already transliterated to ASCII.
   *
   * Deliberately *not* the whole header map. Returning it verbatim also
   * returned `authorization: "Bearer <token>"`, so any caller that logged a
   * result — the obvious thing to do with one — logged the credential. These
   * are the only two fields a caller has a reason to read; the token is never
   * part of a result.
   */
  title: string
  tags: string | null
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
  /**
   * Timeout for a single request, via `AbortSignal.timeout()`. Defaults to
   * `DEFAULT_REQUEST_TIMEOUT_MS`. Never larger than the budget an attempt has
   * left under `totalBudgetMs` — see `post`.
   */
  requestTimeoutMs?: number
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
/**
 * Describes why a URL string is unusable, without echoing it.
 *
 * A base URL can carry a token in its path, so the rejection names the shape
 * problem and never the value.
 *
 * The caller passes the value it read, **before** the trailing slash is
 * normalised away: `"https://"` stripped to `"https:"` no longer contains `://`,
 * so the old test on that substring called it scheme-less, which is the one
 * thing it is not. The newline that would otherwise become a path separator is
 * stripped for the same reason.
 */
const describeUrlShape = (value: string): string => {
  if (value === "") {
    return "it is empty"
  }
  if (value.includes("://")) {
    return "it has a scheme but no host"
  }
  return /^[A-Za-z][A-Za-z0-9+.-]*:(\/|$)/.test(value.replace(/[\t\n\r]/g, ""))
    ? "it has a scheme but no absolute URL"
    : "no absolute scheme"
}

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
  private readonly requestTimeoutMs: number

  constructor(config: NtfyClientConfig, options: NtfyClientOptions = {}) {
    // The trailing slash is dropped **after** the guard, not before it: the
    // guard's rejection text describes the value the caller supplied, and
    // stripping first turned `"https://"` into `"https:"` — a shape the message
    // then described wrongly. Nothing about which values are refused changes,
    // because `URL.canParse` is what refuses them.
    const rawBaseUrl = config.baseUrl?.trim() ?? ""
    const baseUrl = rawBaseUrl.replace(/\/+$/, "")
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
    // The base URL is the push endpoint's origin, so a URL the platform cannot
    // parse can never deliver a push. Before this guard all four malformed
    // shapes below constructed happily and every push came back
    // `network_error` after the transport failed on the garbage URL — a
    // misconfiguration that looked like a provider outage.
    if (!URL.canParse(baseUrl)) {
      throw new Error(
        `NtfyClient: baseUrl is not a valid absolute URL: ${describeUrlShape(rawBaseUrl)}`,
      )
    }
    this.config = { ...config, baseUrl, topic }
    this.fetcher = options.fetcher ?? ((input, init) => fetch(input, init))
    this.sleep = options.sleep ?? ((ms) => new Promise((resolve) => setTimeout(resolve, ms)))
    this.clock = options.clock ?? (() => Date.now())
    this.gate = options.gate ?? NotificationSeverity.Failure
    this.policy = { ...DEFAULT_RETRY, ...options.retry, onDelay: options.onDelay }
    this.backoff = options.backoff ?? createExponentialBackoff(this.policy)
    this.requestTimeoutMs = options.requestTimeoutMs ?? DEFAULT_REQUEST_TIMEOUT_MS
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
      attempt: async (attempt, remainingBudgetMs) => {
        const outcome = await this.post(headers, push.message, attempt, remainingBudgetMs)
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
        title: headers.get("Title") ?? "",
        tags: headers.get("Tags"),
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

  private async post(
    headers: Headers,
    body: string,
    attempt: number,
    remainingBudgetMs: number,
  ): Promise<PostOutcome> {
    // Never longer than what `totalBudgetMs` has left: a per-request timeout
    // alone bounds one request, but not the operation `push` promises to bound.
    const timeoutMs = Math.max(Math.min(this.requestTimeoutMs, remainingBudgetMs), 0)
    try {
      // The body is re-encoded from the string by the platform, so UTF-8
      // survives; only the header values were transliterated above.
      const response = await this.fetcher(this.endpoint, {
        method: "POST",
        headers,
        body,
        signal: AbortSignal.timeout(timeoutMs),
      })
      if (response.ok) {
        await releaseResponseBody(response)
        return { ok: true, httpStatus: response.status, attempts: attempt }
      }
      const outcome: PostFailure = {
        ok: false,
        code: "http_error",
        message: `${response.status} ${response.statusText}`.trim(),
        status: response.status,
        attempts: attempt,
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
          message: `ntfy request timed out after ${timeoutMs}ms`,
          attempts: attempt,
          retryable: true,
        }
      }
      return {
        ok: false,
        code: "network_error",
        // The base URL can carry a token in its path, and `fetch` puts the whole
        // URL in its error text. Same defect as Slack's and healthchecks', and
        // the same helper closes it.
        message: describeTransportError(cause),
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
  code: "http_error" | "network_error" | "timeout"
  message: string
  attempts: number
  retryable: boolean
  status?: number
  retryAfterMs?: number
}
