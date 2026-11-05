/**
 * ntfy push client — failure-only, retrying, header-safe.
 *
 * Retries, priority, tags, gating, fail-soft delivery and safe non-ASCII
 * headers, with no domain of its own, so the notifier works from any caller.
 *
 * Each pinned by a test:
 *
 *  - Only headers are transliterated; the body is UTF-8 end to end, so
 *    `Café ☕` arrives as written.
 *  - Every method returns a discriminated result, so a caller can tell a
 *    delivered push from a dropped one.
 *  - The gate is an explicit `NotificationSeverity`.
 *  - Transient statuses honour `Retry-After`.
 *  - The token is a constructor parameter, never read at module scope and
 *    never logged.
 *
 * ```ts
 * const client = new NtfyClient({ baseUrl, topic, token })
 * const result = await client.notifyFailure("backup failed", "3 of 5 repositories failed")
 * ```
 *
 * **Failure-only by default.** `NotificationSeverity.Failure` is the gate; an `Info` push is a no-op
 * that still returns `{ ok: true, status: "skipped", reason: "below-gate", attempts: 0 }`, so the gate
 * is assertable. Callers that genuinely want success pushes pass `severity: Info`.
 *
 * **Result.** `{ ok: true, status: "pushed", httpStatus, attempts, title, tags }`,
 * `{ ok: true, status: "skipped", … }`, or `{ ok: false, code, message, status?, attempts }`, `code`
 * being `"http_error"`, `"network_error"`, `"timeout"` or `"redirected"`.
 *
 * **The base URL must be the final address.** Redirects are not followed. Following a 301, 302 or 303
 * re-sends the push as a bodiless GET, which ntfy answers with its web app and a 200, so a lost push
 * would read as delivered; following it with the method kept would send the token to wherever
 * `Location` points. Any 3xx answer is `redirected`, is not retried, and its message names neither
 * the `Location` nor the base URL.
 *
 * **Config.** `NTFY_URL` and `NTFY_TOPIC` are required; `NTFY_TOKEN` is optional because a
 * self-hosted ntfy on a private network may not use auth. Read through `ntfyConfigFromEnv(read?)`,
 * which returns `null` when incomplete.
 *
 * **Retry policy.** 5 attempts, 3s doubling plus +/-20% jitter (2.4-3.6s, 4.8-7.2s, 9.6-14.4s,
 * 12-15s), honouring `Retry-After`, bounded by attempts and total elapsed time. The jitter exists so
 * many callers hitting the same endpoint at once do not retry at the same instant; a test constructs
 * the client with no options at all and confirms two instances get different delays.
 *
 * **The base URL never appears in a result.** It can carry a token in its path, and `fetch` puts the
 * whole URL in its error text. Every transport failure is reported through `describeTransportError`,
 * which returns the error's class name and `transport failure (url withheld)` — never the URL. The
 * same helper covers `HealthchecksClient` (the ping URL carries the check's capability key).
 *
 * ## Header safety
 *
 * `Headers.set` rejects code points the platform will not accept in a header value, and the rejection
 * surfaces from inside `fetch` as an opaque `TypeError: Value is not a valid ByteString`. Two
 * different needs follow:
 *
 * - A **header value** must be transliterated to printable ASCII. `toAsciiHeaderValue` maps the
 *   characters that matter for readability (`—` → `-`, `"` → `"`, `…` → `...`, non-breaking space →
 *   space) and replaces everything else — Latin-1 accents, Cyrillic, CJK, emoji — with `?`. Each run
 *   of HT, LF and CR becomes one space, because `Headers.set` throws on a line break inside a value.
 * - A **message body** must be left alone: through the same sanitiser, `Café ☕` would reach ntfy
 *   as `Caf? ?`. Only headers are transliterated here.
 *
 * `createAsciiHeaders` applies the transliteration to every value, so the failure cannot come back
 * through a new call site. Both halves are pinned by tests, including the body round-trip.
 *
 * @module
 */

import { createAsciiHeaders } from "./header-safety.ts"
import {
  createPostTransport,
  type PostOutcome,
  type PostTransport,
  postWithRetry,
} from "./_post.ts"
import { type BackoffFn, releaseResponseBody, type RetryPolicy, type Sleeper } from "./retry.ts"
import { processEnv } from "@spy4x/platform/server/process"
import type { RandomSource } from "@spy4x/platform/universal/async"
import type { NowFn } from "@spy4x/platform/universal/time"

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

/** Where to push and how to authenticate, for {@link NtfyClient}. */
export interface NtfyClientConfig {
  /** Base ntfy URL, e.g. `https://ntfy.example.invalid`. Trailing slashes are stripped. */
  baseUrl: string
  /** Topic name. Percent-encoded into the path. */
  topic: string
  /**
   * Bearer token. Optional: a self-hosted ntfy without auth needs none.
   * Whitespace around it is trimmed, and a token that is empty after trimming
   * counts as none. The rest must be visible ASCII only (`!` to `~`): the
   * constructor refuses a token with a space, tab, line break or non-ASCII
   * character inside it rather than send an altered credential.
   */
  token?: string
}

/** One notification to send through {@link NtfyClient.push}. */
export interface NtfyPush {
  /** Goes into the `Title` header, so it is transliterated to ASCII. */
  title: string
  /** Goes into the body verbatim, so non-ASCII survives. */
  message: string
  /** How severe the event is; compared against the client's gate. */
  severity: NotificationSeverity
  /** ntfy priority, 1 (min) to 5 (max). Defaults to ntfy's own default. */
  priority?: NtfyPriority
  /** ntfy tags/emoji shortcodes attached to the notification. */
  tags?: string[]
  /** URL opened when the notification is tapped. */
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
export type NtfyErrorCode = "http_error" | "network_error" | "timeout" | "redirected"

/** A push that reached ntfy and was accepted. */
export interface NtfyPushed {
  /** Always `true` on this variant of {@link NtfyResult}. */
  ok: true
  /** Discriminant for {@link NtfyResult}. */
  status: "pushed"
  /** HTTP status ntfy responded with. */
  httpStatus: number
  /** Attempts it took to get accepted, including the first. */
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
  /** Tags sent in the outgoing request, or `null` when the push carried none. */
  tags: string | null
}

/** A push that was never sent because its severity did not meet the gate. */
export interface NtfySkipped {
  /** Always `true` on this variant of {@link NtfyResult}. */
  ok: true
  /** Discriminant for {@link NtfyResult}. */
  status: "skipped"
  /** Why it was skipped. Only one reason exists today. */
  reason: "below-gate"
  /** Always `0`: no attempt was made. */
  attempts: 0
}

/** A push that could not be delivered after retrying. */
export interface NtfyFailure {
  /** Always `false` on this variant of {@link NtfyResult}. */
  ok: false
  /** Machine-readable failure kind. */
  code: NtfyErrorCode
  /** Human-readable failure detail. */
  message: string
  /** HTTP status of the last attempt, when the failure was an HTTP error. */
  status?: number
  /** Attempts made before giving up. */
  attempts: number
}

/** Outcome of {@link NtfyClient.push}. */
export type NtfyResult = NtfyPushed | NtfySkipped | NtfyFailure

/** Overrides for the client's default retry policy. All fields are optional. */
export interface NtfyRetryOptions {
  /** Total attempts, including the first. */
  maxAttempts?: number
  /** Delay before the second attempt. */
  baseDelayMs?: number
  /** Ceiling for a single delay. */
  maxDelayMs?: number
  /** Wall-clock ceiling for the whole push. */
  totalBudgetMs?: number
  /** Symmetric jitter fraction applied to a computed backoff, 0 to 1. */
  jitterRatio?: number
}

/** Construction-time overrides for {@link NtfyClient}, all optional and test-injectable. */
export interface NtfyClientOptions {
  /** Replaces the platform `fetch`. Defaults to the global `fetch`. */
  fetcher?: typeof fetch
  /** Replaces the waiter used between retries. Defaults to a real sleep. */
  sleep?: Sleeper
  /** Replaces the elapsed-time source. Defaults to `Date.now`. */
  clock?: NowFn
  /** Replaces the delay computation between retries. */
  backoff?: BackoffFn
  /** Overrides for the default retry policy. */
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
  /** Random source for `backoff`'s jitter. Defaults to `Math.random`. */
  random?: RandomSource
}

/**
 * 5 attempts, 3s doubling, plus +/-20% jitter so
 * many callers hitting the same endpoint at once do not retry in lockstep.
 *
 * Delay ranges with jitter applied: 2.4-3.6s, 4.8-7.2s, 9.6-14.4s, 12-15s (the
 * fourth clamps to `maxDelayMs` before jitter can push it past it). Worst case,
 * every draw lands at its span's top: 3.6 + 7.2 + 14.4 + 15 = 40.2s, still well
 * inside the 60s budget, so all 5 attempts always complete.
 */
const DEFAULT_RETRY: RetryPolicy = {
  maxAttempts: 5,
  baseDelayMs: 3000,
  maxDelayMs: 15_000,
  totalBudgetMs: 60_000,
  jitterRatio: 0.2,
}

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

/**
 * Reads ntfy settings from an environment reader.
 *
 * All of `NTFY_URL` and `NTFY_TOPIC` are required; `NTFY_TOKEN` is optional
 * because a self-hosted ntfy on a private network may not use auth. `null`
 * when incomplete, so "not configured" stays a caller decision — a silent
 * no-op would make a typo'd variable name look exactly like a deliberate
 * disable. The default reader is `processEnv` from
 * `@spy4x/platform/server/process`, so it works on Deno, Node and Bun; on Deno
 * it needs `--allow-env`.
 */
export const ntfyConfigFromEnv = (
  read: (name: string) => string | undefined = (name) => processEnv.get(name),
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
  private readonly transport: PostTransport
  private readonly gate: NotificationSeverity

  /**
   * Throws when `config.baseUrl` is empty or unparseable, `config.topic` is
   * empty, or `config.token` holds a character outside visible ASCII.
   */
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
    // Header values are folded and transliterated before sending, which is
    // right for a title but would silently alter a credential: `abc\ndef`
    // would go out as `abc def` and come back as a 401 that looks like a
    // revoked token. Refuse it here instead. The message never echoes the token.
    // Whitespace around the token is trimmed first, as the platform trims a
    // header value, so a token read from a file ending in a newline still works.
    const token = config.token?.trim() ?? ""
    if (token !== "" && !/^[\x21-\x7E]+$/.test(token)) {
      throw new Error(
        "NtfyClient: token contains a character outside visible ASCII " +
          "(a space, tab, line break or non-ASCII character)",
      )
    }
    this.config = { ...config, baseUrl, topic, token: token === "" ? undefined : token }
    this.gate = options.gate ?? NotificationSeverity.Failure
    this.transport = createPostTransport(DEFAULT_RETRY, options)
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

    // The body is re-encoded from the string by the platform, so UTF-8 survives; only the header
    // values were transliterated above.
    const { settled, attempts } = await postWithRetry(this.transport, {
      service: "ntfy",
      urlSetting: "base URL",
      url: this.endpoint,
      headers,
      body: push.message,
      accepted: releaseAccepted,
    })
    if (settled.ok) {
      return {
        ok: true,
        status: "pushed",
        httpStatus: settled.httpStatus,
        attempts,
        title: headers.get("Title") ?? "",
        tags: headers.get("Tags"),
      }
    }
    return {
      ok: false,
      code: settled.code,
      message: settled.message,
      status: settled.status,
      attempts,
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
}

/**
 * A 2xx from ntfy is a delivered push; its body is never read. A failure to release that body is
 * ignored: reporting it as a network error retried a push ntfy had already delivered.
 */
const releaseAccepted = async (response: Response): Promise<PostOutcome<NtfyErrorCode>> => {
  await releaseResponseBody(response).catch(() => undefined)
  return { ok: true, httpStatus: response.status }
}
