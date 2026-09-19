/**
 * healthchecks.io dead-man's-switch client.
 *
 * Ported from the `healthchecks` half of `rostok/scripts/backup/src/reporting.ts`
 * with the backup domain removed: nothing here imports or mentions `BackupResult`,
 * `BackupContext` or a backup count. A notifier that only works while a backup
 * runs is a notifier nobody can reuse, which is why the two halves are separate
 * modules with their own config.
 *
 * Deviations from the source, each pinned by a test:
 *
 *  - The source's only entry point took a `BackupResult`
 *    (`reporting.ts:79`), so the retrying ping was unreachable from anywhere
 *    else. `ping` takes a `HealthchecksPing` value object instead.
 *  - The source's attempt loop swallowed errors and carried on, always
 *    resolving `void` (`reporting.ts:79-121`). A caller could not tell a
 *    delivered ping from a dead endpoint. `ping` returns a discriminated result
 *    with the attempt count and the last status.
 *  - The source's success/failure decision was derived from
 *    `successCount === totalCount` (`reporting.ts:84`), which is a backup
 *    concept. `outcome` is now the caller's explicit `"success" | "fail"`.
 *  - The source built its message from backup rows (`buildHealthchecksMessage`),
 *    including a padded table. That stays in `#18 ops/`, which owns backup.
 */

import { DEFAULT_RETRY_POLICY } from "./policy.ts"
import {
  type BackoffFn,
  type Clock,
  createExponentialBackoff,
  describeTransportError,
  isTransientStatus,
  parseRetryAfterMs,
  type RetryPolicy,
  runWithRetry,
  type Sleeper,
} from "./retry.ts"

/** Which endpoint a ping targets. */
export enum HealthchecksOutcome {
  /** `POST <url>` — the job finished cleanly. */
  Success = "success",
  /** `POST <url>/fail` — the job failed; the check goes down immediately. */
  Fail = "fail",
  /** `POST <url>/start` — the job began; the grace period restarts. */
  Start = "start",
}

export interface HealthchecksClientConfig {
  /** Check ping URL, e.g. `https://hc-ping.example.com/<uuid>`. */
  pingUrl: string
}

export type HealthchecksErrorCode =
  | "not_configured"
  | "http_error"
  | "network_error"
  | "invalid_ping_url"

export interface HealthchecksSuccess {
  ok: true
  httpStatus: number
  attempts: number
  /** Body sent, so a caller can log what was reported without re-deriving it. */
  body: string
  waitedMs: number
}

export interface HealthchecksFailure {
  ok: false
  code: HealthchecksErrorCode
  message: string
  status?: number
  attempts: number
  waitedMs: number
}

export type HealthchecksResult = HealthchecksSuccess | HealthchecksFailure

export interface HealthchecksPing {
  /** `"success"` or `"fail"`; `"start"` signals the beginning of a job. */
  outcome: HealthchecksOutcome
  /** Free-form body. healthchecks.io records the first 10 kB. */
  body?: string
}

export interface HealthchecksRetryOptions {
  maxAttempts?: number
  baseDelayMs?: number
  maxDelayMs?: number
  totalBudgetMs?: number
  jitterRatio?: number
}

export interface HealthchecksClientOptions {
  fetcher?: typeof fetch
  sleep?: Sleeper
  clock?: Clock
  backoff?: BackoffFn
  retry?: HealthchecksRetryOptions
  /** Receives every requested delay, in order. */
  onDelay?: (delayMs: number, attempt: number) => void
}

/**
 * Reads a ping URL from an environment reader.
 *
 * `null` when absent or blank. Nothing is read at module scope, so importing
 * this module cannot throw on a process with no environment, and no secret
 * value is ever baked into a module-level singleton.
 */
export const healthchecksConfigFromEnv = (
  read: (name: string) => string | undefined = (name) => Deno.env.get(name),
): HealthchecksClientConfig | null => {
  const pingUrl = read("HEALTHCHECKS_PING_URL")?.trim()
  return pingUrl ? { pingUrl } : null
}

/**
 * healthchecks.io client.
 *
 * The default policy is the source's: 10 attempts with 60s doubling capped at
 * 10 minutes per wait. `Retry-After` is honoured when the provider sends it —
 * healthchecks.io rate-limits with `429` and the source ignored the header,
 * hammering the endpoint on the exact failures it was retrying.
 */
export class HealthchecksClient {
  private readonly pingUrl: string
  private readonly fetcher: typeof fetch
  private readonly sleep: Sleeper
  private readonly clock: Clock
  private readonly policy: RetryPolicy
  private readonly backoff: BackoffFn

  constructor(config: HealthchecksClientConfig, options: HealthchecksClientOptions = {}) {
    const pingUrl = config.pingUrl?.trim() ?? ""
    if (pingUrl === "") {
      throw new Error(
        "HealthchecksClient: pingUrl is empty — use healthchecksConfigFromEnv() and treat " +
          "an unconfigured switch as an explicit caller decision",
      )
    }
    // A URL the platform cannot parse can never be pinged, and the failure it
    // used to produce was `{ ok: true, httpStatus: 200 }` from a stubbed
    // transport. Refused at construction so a typo cannot look like a healthy
    // dead-man's switch. `invalid_ping_url` stays an error code because a
    // caller-supplied URL is the only thing that reaches this point.
    if (!URL.canParse(pingUrl)) {
      throw new Error("HealthchecksClient: pingUrl is not a valid absolute URL")
    }
    this.pingUrl = pingUrl.replace(/\/+$/, "")
    this.fetcher = options.fetcher ?? ((input, init) => fetch(input, init))
    this.sleep = options.sleep ?? ((ms) => new Promise((resolve) => setTimeout(resolve, ms)))
    this.clock = options.clock ?? (() => Date.now())
    this.policy = {
      ...DEFAULT_RETRY_POLICY,
      ...options.retry,
      onDelay: options.onDelay,
    }
    this.backoff = options.backoff ?? createExponentialBackoff(this.policy)
  }

  /**
   * Sends one ping, retrying transient failures under the policy.
   *
   * Never throws. A non-2xx answer is a failure, not a log line: the source
   * logged `healthchecks ping failed: ...` and returned, so a permanently
   * broken switch looked like a healthy process.
   */
  async ping(ping: HealthchecksPing): Promise<HealthchecksResult> {
    const url = this.urlFor(ping.outcome)
    const body = ping.body ?? ""

    let last: PostOutcome | undefined
    const run = await runWithRetry<PostOutcome>({
      policy: this.policy,
      sleep: this.sleep,
      clock: this.clock,
      backoff: this.backoff,
      attempt: async (attempt) => {
        const attemptOutcome = await this.post(url, body, attempt)
        last = attemptOutcome
        return {
          failed: !attemptOutcome.ok && attemptOutcome.retryable,
          retryAfterMs: attemptOutcome.ok ? undefined : attemptOutcome.retryAfterMs,
          value: attemptOutcome,
        }
      },
    })
    const settled = last ?? run.result
    if (settled.ok) {
      return {
        ok: true,
        httpStatus: settled.httpStatus,
        attempts: run.attempts,
        body,
        waitedMs: run.waitedMs,
      }
    }
    return {
      ok: false,
      code: settled.code,
      message: settled.message,
      status: settled.status,
      attempts: run.attempts,
      waitedMs: run.waitedMs,
    }
  }

  /** The URL a given outcome would call. Useful for diagnostics and tests. */
  urlFor(outcome: HealthchecksOutcome): string {
    if (outcome === HealthchecksOutcome.Success) {
      return this.pingUrl
    }
    return `${this.pingUrl}/${outcome === HealthchecksOutcome.Fail ? "fail" : "start"}`
  }

  private async post(url: string, body: string, attempt: number): Promise<PostOutcome> {
    try {
      const response = await this.fetcher(url, { method: "POST", body })
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
  code: "http_error" | "network_error"
  message: string
  attempts: number
  retryable: boolean
  status?: number
  retryAfterMs?: number
}
