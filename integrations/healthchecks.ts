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
 *    including a padded table. That was backup-specific and was never ported
 *    here; it lived in `ops/`'s backup module, which is not part of ts-libs (#67).
 * @module
 */

import {
  createPostTransport,
  type PostOutcome,
  type PostTransport,
  postWithRetry,
} from "./_post.ts"
import { DEFAULT_RETRY_POLICY } from "./policy.ts"
import type { BackoffFn, Sleeper } from "./retry.ts"
import type { RandomSource } from "@spy4x/platform/universal/async"
import type { NowFn } from "@spy4x/platform/universal/time"

/** Which endpoint a ping targets. */
export enum HealthchecksOutcome {
  /** `POST <url>` — the job finished cleanly. */
  Success = "success",
  /** `POST <url>/fail` — the job failed; the check goes down immediately. */
  Fail = "fail",
  /** `POST <url>/start` — the job began; the grace period restarts. */
  Start = "start",
}

/** Where to ping, for {@link HealthchecksClient}. */
export interface HealthchecksClientConfig {
  /** Check ping URL, e.g. `https://hc-ping.example.com/<uuid>`. */
  pingUrl: string
}

/**
 * Failure reasons `ping` can report.
 *
 * There is deliberately no `not_configured` or `invalid_ping_url` code: an
 * unconfigured or unparseable URL is rejected at construction, so it cannot
 * reach a result. `healthchecksConfigFromEnv` returning `null` is how "not
 * configured" reaches the caller, as an explicit decision. A member that no
 * code path produces is a member a caller will branch on forever and never see.
 */
export type HealthchecksErrorCode =
  | "http_error"
  | "network_error"
  | "timeout"
  | "check_not_found"
  | "rate_limited"
  | "redirected"

/** A ping that reached healthchecks.io and was accepted. */
export interface HealthchecksSuccess {
  /** Always `true` on this variant of {@link HealthchecksResult}. */
  ok: true
  /** HTTP status healthchecks.io responded with. */
  httpStatus: number
  /** Attempts it took to get accepted, including the first. */
  attempts: number
  /** Body sent, so a caller can log what was reported without re-deriving it. */
  body: string
  /** Total time spent waiting between attempts. */
  waitedMs: number
}

/** A ping that could not be delivered after retrying. */
export interface HealthchecksFailure {
  /** Always `false` on this variant of {@link HealthchecksResult}. */
  ok: false
  /** Machine-readable failure kind. */
  code: HealthchecksErrorCode
  /** Human-readable failure detail. */
  message: string
  /** HTTP status of the last attempt, when the failure was an HTTP error. */
  status?: number
  /** Attempts made before giving up. */
  attempts: number
  /** Total time spent waiting between attempts. */
  waitedMs: number
}

/** Outcome of {@link HealthchecksClient.ping}. */
export type HealthchecksResult = HealthchecksSuccess | HealthchecksFailure

/** One ping to send through {@link HealthchecksClient.ping}. */
export interface HealthchecksPing {
  /** `"success"` or `"fail"`; `"start"` signals the beginning of a job. */
  outcome: HealthchecksOutcome
  /** Free-form body. healthchecks.io records the first 10 kB. */
  body?: string
}

/** Overrides for the client's default retry policy. All fields are optional. */
export interface HealthchecksRetryOptions {
  /** Total attempts, including the first. */
  maxAttempts?: number
  /** Delay before the second attempt. */
  baseDelayMs?: number
  /** Ceiling for a single delay. */
  maxDelayMs?: number
  /** Wall-clock ceiling for the whole ping. */
  totalBudgetMs?: number
  /** Symmetric jitter fraction applied to a computed backoff, 0 to 1. */
  jitterRatio?: number
}

/** Construction-time overrides for {@link HealthchecksClient}, all optional and test-injectable. */
export interface HealthchecksClientOptions {
  /** Replaces the platform `fetch`. Defaults to the global `fetch`. */
  fetcher?: typeof fetch
  /** Replaces the waiter used between retries. Defaults to a real sleep. */
  sleep?: Sleeper
  /** Replaces the elapsed-time source. Defaults to `Date.now`. */
  clock?: NowFn
  /** Replaces the delay computation between retries. */
  backoff?: BackoffFn
  /** Overrides for the default retry policy. */
  retry?: HealthchecksRetryOptions
  /** Receives every requested delay, in order. */
  onDelay?: (delayMs: number, attempt: number) => void
  /**
   * Timeout for a single request, via `AbortSignal.timeout()`. Defaults to
   * `DEFAULT_REQUEST_TIMEOUT_MS`. Never larger than the budget an attempt has
   * left under `totalBudgetMs` — see `post`.
   */
  requestTimeoutMs?: number
  /** Random source for `backoff`'s jitter. Defaults to `Math.random`. */
  random?: RandomSource
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
 * The default policy is the source's: 10 attempts with 60s doubling, capped at
 * 5 minutes per wait (see `DEFAULT_RETRY_POLICY`). `Retry-After` is honoured
 * when the provider sends it — healthchecks.io rate-limits with `429` and the
 * source ignored the header, hammering the endpoint on the exact failures it was retrying.
 */
export class HealthchecksClient {
  private readonly pingUrl: string
  private readonly transport: PostTransport

  /** Throws when `config.pingUrl` is empty or unparseable. */
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
    // dead-man's switch. Refused at construction, matching how an empty URL is
    // refused, so no error code has to exist for a state that cannot produce a
    // result.
    if (!URL.canParse(pingUrl)) {
      throw new Error("HealthchecksClient: pingUrl is not a valid absolute URL")
    }
    this.pingUrl = pingUrl.replace(/\/+$/, "")
    this.transport = createPostTransport(DEFAULT_RETRY_POLICY, options)
  }

  /**
   * Sends one ping, retrying transient failures under the policy.
   *
   * Never throws. A non-2xx answer is a failure, not a log line: the source
   * logged `healthchecks ping failed: ...` and returned, so a permanently
   * broken switch looked like a healthy process.
   *
   * A 2xx is not enough either. healthchecks.io answers `200 OK (not found)`
   * for a UUID it does not know and `200 OK (rate limited)` for a ping it
   * ignored (https://healthchecks.io/docs/http_api/), so the first bytes of
   * the body decide: `check_not_found` is final, `rate_limited` is retried.
   * A redirect is refused as `redirected` rather than followed, because
   * following a 301/302/303 turns the POST into a GET and drops the body.
   */
  async ping(ping: HealthchecksPing): Promise<HealthchecksResult> {
    const url = this.urlFor(ping.outcome)
    const body = ping.body ?? ""

    const { settled, attempts, waitedMs } = await postWithRetry(this.transport, {
      service: "healthchecks",
      urlSetting: "ping URL",
      url,
      body,
      accepted: readAnswer,
    })
    if (settled.ok) {
      return {
        ok: true,
        httpStatus: settled.httpStatus,
        attempts,
        body,
        waitedMs,
      }
    }
    return {
      ok: false,
      code: settled.code,
      message: settled.message,
      status: settled.status,
      attempts,
      waitedMs,
    }
  }

  /** The URL a given outcome would call. Useful for diagnostics and tests. */
  urlFor(outcome: HealthchecksOutcome): string {
    if (outcome === HealthchecksOutcome.Success) {
      return this.pingUrl
    }
    return `${this.pingUrl}/${outcome === HealthchecksOutcome.Fail ? "fail" : "start"}`
  }
}

/** Body healthchecks.io sends with a 200 when the check UUID does not exist. */
const NOT_FOUND_BODY = "OK (not found)"
/** Body healthchecks.io sends with a 200 when it ignored a ping over the rate limit. */
const RATE_LIMITED_BODY = "OK (rate limited)"
/** Enough bytes to tell the documented bodies apart; the rest is never buffered. */
const BODY_PREFIX_BYTES = 64

/**
 * Decides a 2xx answer by its first bytes: healthchecks.io answers `200 OK (not found)` for a
 * UUID it does not know and `200 OK (rate limited)` for a ping it ignored.
 */
const readAnswer = async (response: Response): Promise<PostOutcome<HealthchecksErrorCode>> => {
  const answer = (await readBodyPrefix(response, BODY_PREFIX_BYTES)).trim()
  if (answer === NOT_FOUND_BODY) {
    return {
      ok: false,
      code: "check_not_found",
      message: `healthchecks has no check for this ping URL (${NOT_FOUND_BODY})`,
      status: response.status,
      retryable: false,
    }
  }
  if (answer === RATE_LIMITED_BODY) {
    return {
      ok: false,
      code: "rate_limited",
      message: `healthchecks ignored the ping (${RATE_LIMITED_BODY})`,
      status: response.status,
      retryable: true,
    }
  }
  return { ok: true, httpStatus: response.status }
}

/**
 * Reads at most `maxBytes` of a response body as text, then cancels the
 * rest, so a hostile endpoint cannot make the client buffer a large answer.
 * The request's own `AbortSignal.timeout` bounds a body that stalls.
 */
const readBodyPrefix = async (response: Response, maxBytes: number): Promise<string> => {
  if (response.body === null) {
    return ""
  }
  const reader = response.body.getReader()
  const decoder = new TextDecoder()
  let text = ""
  let total = 0
  try {
    while (total < maxBytes) {
      const { done, value } = await reader.read()
      if (done) {
        return text + decoder.decode()
      }
      const kept = value.subarray(0, maxBytes - total)
      total += kept.byteLength
      text += decoder.decode(kept, { stream: true })
    }
    await reader.cancel()
    return text + decoder.decode()
  } finally {
    reader.releaseLock()
  }
}
