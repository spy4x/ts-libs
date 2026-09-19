/**
 * Usage quota metering — a countable budget per principal over a long window,
 * decremented by units of business work (one analysis, one export, one
 * document). It is what a UI renders as "37 of 50 free requests used".
 *
 * ## This is not a rate limiter
 *
 * The distinction is the whole point of the module, so it is a contract, not a
 * comment. `server/quota.ts` never contains a token bucket, a sliding window, a
 * requests-per-second rule, a per-IP key, middleware, or an `X-RateLimit-*` /
 * `Retry-After` header. The source repo (`offer-lens`) has no request rate
 * limiter at all — what it calls a "limit" is a quota, and that is verifiable
 * rather than asserted: a case-insensitive grep for `rate-limit`, `token
 * bucket`, `sliding window`, `X-RateLimit` and `Retry-After` over every `.ts`
 * file in `offer-lens/libs/` and `offer-lens/apps/` matches **nothing**, and the
 * only `429`/`503` literals in `apps/api/` are the two quota sites,
 * `apps/api/routes/analyze.ts:114-125` and `apps/api/routes/batch.ts:112-123`.
 * Rate limiting is a separate package (`platform/rate-limit`, issue #4) owned by
 * another agent.
 *
 * - **Measured unit**: a quota counts *business work* (an analysis, a billable
 *   provider call, a document); a rate limiter counts *requests*. One HTTP
 *   request may spend three units, and a request that spends nothing still
 *   arrives.
 * - **Window length**: a quota window is long (a lifetime, a day, a month — 50
 *   free analyses ever); a rate limit window is seconds, and its job is smooth
 *   throughput, not entitlement.
 * - **Who is keyed**: a quota is keyed by a *principal* — an authenticated
 *   user, falling back to a browser session ({@link QuotaPrincipal}). A rate
 *   limiter is keyed by whatever can be counted cheaply and is not
 *   attacker-controlled: an IP, a route, a token. A user can open a new session;
 *   they cannot become a new user.
 * - **Where it is enforced**: a quota is checked at the point of a *costly
 *   business action*, after authentication, and recorded after the work has
 *   happened ({@link QuotaMeter.record}). A rate limiter is middleware, before
 *   routing.
 * - **What it counts**: a quota counts successful units of work, so it can be
 *   incremented late, can overshoot its limit, and is billed to a principal. A
 *   rate limiter counts arrivals, so every request counts whether or not it
 *   succeeded.
 * - **What it emits**: a quota emits a *state* for the UI (`used`, `limit`,
 *   `remaining`) and a decision that maps to `200` / `429` / `503`
 *   ({@link quotaHttpStatus}, from `apps/api/routes/analyze.ts:114-125`). A rate
 *   limiter emits headers and a bodyless rejection.
 *
 * Consequences that follow from the above, and are deliberate: `429` here means
 * "this principal has spent their budget", never "you are going too fast", and
 * the `503` in {@link QuotaDecision.Unavailable} is a service condition, not an
 * exhausted budget.
 *
 * ## Sources
 *
 * Ported from `offer-lens`, with the store and the clock injected so the module
 * carries no driver, no KV client and no `Date.now()`:
 *
 * - `apps/api/services/demo-usage.ts:19-24` — a caller-supplied (BYOK) key
 *   bypasses metering entirely.
 * - `apps/api/services/demo-usage.ts:27-32` — no metered provider key
 *   configured means the request cannot proceed at all; that is a *service*
 *   condition, distinguishable from a limit hit.
 * - `apps/api/services/demo-usage.ts:34-46` and
 *   `apps/api/services/auth.ts:156-165` (`checkUserLimit`) — a logged-in
 *   principal gets the per-user limit.
 * - `apps/api/services/demo-usage.ts:48-57` and `apps/api/routes/usage.ts:9-18`
 *   — a session id is the fallback principal; neither present is a caller
 *   error (`routes/usage.ts:14-16` answered `400`).
 * - `apps/api/services/demo-usage.ts:63-80` — recording happens after the work,
 *   and a record can push usage past the limit.
 * - `apps/api/routes/usage.ts:20-31` — an active own-key marks the metered
 *   budget as inactive.
 * - `apps/api/routes/analyze.ts:114-125` (the same shape at
 *   `apps/api/routes/batch.ts:112-123`) — the HTTP contract {@link quotaHttpStatus}
 *   encodes. It is the *route*, not `routes/usage.ts` (which only reads), that
 *   maps a blocked check to a status: `usage.limit === 0` → `503`
 *   `"Demo key not configured on server. Provide your own API key."`, otherwise
 *   a spent budget → `429` `{ error: "Demo limit reached", used, limit }`. The
 *   `200` case is simply "not blocked" — the route proceeds to the work.
 * - `libs/db/mod.ts:224-248` (`getSessionUsage` / `recordSessionUsage` /
 *   `getUserUsage` / `incrementUsage`) is the shape {@link QuotaStore} was
 *   extracted from; the driver is not ported.
 *
 * ## Deviations from the source (all intentional, all tested)
 *
 * 1. {@link QuotaMeter.record} does **not** spend budget when no metered key is
 *    configured. The source recorded unconditionally
 *    (`apps/api/services/demo-usage.ts:63-80`), which charged a user for a
 *    request that could not be served. A service that cannot serve does not
 *    spend budget.
 * 2. {@link QuotaMeter.record} returns the full state instead of a bare
 *    `DemoUsage`, and reports `Exhausted` rather than merely overshooting.
 * 3. {@link QuotaMeter.get} reports the *metered* budget
 *    (`metered: meteredKeyAvailable`) because a read has no way to know about a
 *    BYOK key; the source patched `hasDemoKey = false` afterwards
 *    (`routes/usage.ts:20-31`). The caller still marks BYOK separately.
 * 4. `bypassWithOwnKey` defaults to `true` but is a policy flag, so an
 *    installation that wants every request metered can say so.
 * 5. The `503` is an explicit {@link QuotaDecision.Unavailable} driven by
 *    `meteredKeyAvailable`, not the source's `usage.limit === 0` sentinel
 *    (`apps/api/routes/analyze.ts:115`, `apps/api/routes/batch.ts:113`). That
 *    sentinel overloaded a legitimate value — `limit: 0` is also a correctly
 *    configured, disabled budget — so the source could not express "no provider
 *    key" and "no free requests allowed" as different things. Here they differ:
 *    `Unavailable` (`503`, a service condition) versus `Exhausted` with
 *    `limit: 0` (`429`, a spent budget).
 * 6. **A source bug, fixed here by construction.** The per-user path metered
 *    against `ANONYMOUS_LIMIT = 3` (`libs/shared/mod.ts:189`, via
 *    `apps/api/services/auth.ts:157-164`) while the session path metered against
 *    `DEMO_LIMIT = 50` (`libs/shared/mod.ts:194`, via
 *    `apps/api/services/demo-usage.ts:52`) — so a logged-in user got *fewer*
 *    free requests than an anonymous session, and the two routes reported
 *    different limits for the same product. This port has no module-level limit
 *    constant at all: the limit is explicit {@link QuotaPolicy} configuration,
 *    so the two principals can only differ when the caller says so, and a
 *    reviewer reads the number at the wiring site rather than in a shared
 *    constants file.
 *
 * ## Validation and dependencies
 *
 * The two *input shapes* this module parses — {@link QuotaPolicy} and `record`'s
 * `count` — go through `arktype`, the repo's only validator:
 * {@link policySchema} and {@link countSchema}. An arktype failure is mapped to
 * one of the constant {@link QuotaError} messages and never re-surfaced: an
 * arktype summary echoes the offending value (`must be non-negative (was -1)`),
 * and a constant message keeps a config value out of a log line.
 *
 * **No new dependency**: `arktype` is already pinned in the root import map at
 * 2.2.3, and `import { type } from "arktype"` is this module's only import. The
 * wiring guards around it stay hand-written on purpose — `typeof
 * options.meteredKeyAvailable !== "boolean"` and the store port's two
 * `typeof … === "function"` checks are not input parsing but a check that a DI
 * container was filled in, and they read as such.
 *
 * Nothing else is imported: no framework, no logging, no headers. `429`/`503`
 * are values a caller maps onto its own response.
 */

import { type } from "arktype"

/**
 * The shape of {@link QuotaPolicy} as accepted from configuration.
 *
 * `windowSeconds` is optional and, *when present*, strictly positive: an
 * explicit `windowSeconds: 0` is refused rather than folded into the lifetime
 * window an omitted field produces, because "a window of zero seconds" is a
 * configuration typo worth failing on, not a lifetime budget. `limit: 0` stays
 * legal — a disabled budget (see deviation 5 in the module doc).
 *
 * Undeclared keys are ignored, matching the hand-written check this replaced: a
 * policy object carrying extra wiring fields is not a shape error.
 */
const policySchema = type({
  limit: "number.integer >= 0",
  "windowSeconds?": "number.integer > 0",
  "bypassWithOwnKey?": "boolean",
})

/**
 * Just the `limit` half of {@link policySchema}.
 *
 * A shape failure inside a whole-object message is only `"limit must be …"` or
 * `"windowSeconds must be …"`, and one arktype check cannot report which field
 * it disliked without its value-echoing text being surfaced. So the field is
 * identified by re-checking the `limit` alone, which is one boolean, and the
 * constant message then names the field the caller must fix. Kept separate and
 * module-level so the schema is parsed once, not per `createQuotaMeter` call.
 */
const limitOnlySchema = type({ limit: "number.integer >= 0" })

/**
 * The shape of one unit-of-work count: a positive integer.
 *
 * A fractional or negative count would corrupt a counter that every later read
 * divides into `remaining`, so it is refused at the boundary. `allows` is used
 * rather than a parsed result because the count is consumed as the caller's own
 * value, never as a copy.
 */
const countSchema = type("number.integer > 0")

/** A `limit` that is not a counter at all, refused at construction. */
const POLICY_LIMIT_MESSAGE = "QuotaPolicy.limit must be a non-negative safe integer"
/** A `windowSeconds` that is neither "lifetime" (0/undefined) nor a window. */
const POLICY_WINDOW_MESSAGE = "QuotaPolicy.windowSeconds must be a positive safe integer when set"
/** A principal that cannot be keyed — refused rather than billed to `""`. */
const NO_PRINCIPAL_MESSAGE = "A userId or a sessionId is required"
/** A `count` that is not a quantity of work — refused rather than corrupting a counter. */
const INVALID_COUNT_MESSAGE = "count must be a positive safe integer"
/** The injected persistence port is missing or half-wired. */
const STORE_PORT_MESSAGE = "QuotaStore must provide read and increment functions"

/** What a caller should do with a check: proceed, stop, or turn the feature off. */
export enum QuotaDecision {
  /** The principal is inside the budget; the work may proceed. */
  Allowed = 1,
  /**
   * The budget is spent. Maps to `429` — an exhausted entitlement, not a flood
   * (source `apps/api/routes/analyze.ts:121-124`).
   */
  Exhausted = 2,
  /**
   * The metered provider key is not configured, so there is nothing to meter
   * (source `apps/api/services/demo-usage.ts:27-32`, surfaced as `503` at
   * `apps/api/routes/analyze.ts:115-120`). Retrying later may work, and it is
   * emphatically not {@link Exhausted}.
   */
  Unavailable = 3,
}

/** Who owns a counter. Sessions are the anonymous fallback (source `demo-usage.ts:48-57`). */
export enum QuotaPrincipalKind {
  /** An authenticated principal; has priority over a session id. */
  User = 1,
  /** An anonymous principal identified by a session id. */
  Session = 2,
}

/**
 * Why a quota operation was refused. Typed so callers branch on a code, never on
 * an error message.
 */
export enum QuotaErrorCode {
  /** Neither a user nor a session id was supplied — a caller error (`400`). */
  NoPrincipal = 1,
  /** `count` was not a positive safe integer — refusing beats writing a corrupt total. */
  InvalidCount = 2,
  /** The policy is unusable (bad `limit`, bad `windowSeconds`, or a broken store port). */
  InvalidPolicyLimit = 3,
}

/**
 * The only error a caller has to catch to answer a misconfigured or
 * ill-formed metering call.
 *
 * Messages are constants and never echo the offending value: a `count`, a
 * `limit` and a principal id are not secret, but an error string is the last
 * place an id should travel, and a constant message keeps
 * {@link QuotaErrorCode} the only classification surface.
 */
export class QuotaError extends Error {
  /** Machine-readable reason; branch on this, never on `message`. */
  readonly code: QuotaErrorCode

  constructor(code: QuotaErrorCode, message: string, options?: { cause?: unknown }) {
    super(message, options)
    this.name = "QuotaError"
    this.code = code
  }
}

/** The identity a counter is billed to. */
export interface QuotaPrincipal {
  kind: QuotaPrincipalKind
  /** The user id or the session id, already trimmed and non-empty. */
  id: string
}

/** The metered budget as the UI needs to render it. */
export interface QuotaState {
  decision: QuotaDecision
  used: number
  limit: number
  /** Always `max(0, limit - used)`; `0` once the budget is spent, never negative. */
  remaining: number
  /** 0 means one single lifetime window. */
  windowSeconds: number
  /** false when a caller-supplied (BYOK) key bypassed the metered budget, or when no metered key exists. */
  metered: boolean
}

/** The budget a principal is entitled to. */
export interface QuotaPolicy {
  /**
   * Units of business work allowed inside one window. `0` is legitimate and
   * means the budget is disabled — deliberately *not* the source's "no key
   * configured" sentinel (see deviation 5 in the module doc).
   *
   * The value is configuration with no module-level constant behind it: the
   * source had two (`ANONYMOUS_LIMIT = 3` at `libs/shared/mod.ts:189`,
   * `DEMO_LIMIT = 50` at `libs/shared/mod.ts:194`) and they disagreed, which is
   * the bug deviation 6 records.
   */
  limit: number
  /**
   * Omitted → one lifetime window. > 0 → a fixed window of that many seconds,
   * keyed by wall-clock bucket (see {@link quotaKey}). Long by definition: a
   * period-shaped entitlement, not a throughput control.
   *
   * An *explicit* `0` is refused by the policy schema rather than read as
   * "lifetime" — omit the field instead. Note that {@link quotaKey} still
   * treats a `0` it is handed (a hand-built policy, never one this factory
   * validated) as the lifetime window, because that is the only sane reading of
   * "no window length".
   */
  windowSeconds?: number
  /** Default true: a BYOK request bypasses metering entirely (source demo-usage.ts:19-24). */
  bypassWithOwnKey?: boolean
}

/**
 * The identity of a counter: one principal inside one window. `window` is
 * `"all"` or `w<index>`.
 *
 * Both halves are opaque to {@link QuotaStore} — it stores an opaque composite
 * key, which is what lets one SQL table or one KV namespace hold every quota in
 * an installation.
 */
export interface QuotaKey {
  principal: string
  window: string
}

/**
 * The injected persistence port — no DB driver, no KV client, no clock.
 *
 * `increment` must be atomic (a single `UPDATE ... SET used = used + n` or a KV
 * increment). This module never reads-then-writes, precisely so a store can
 * satisfy the port with one atomic operation; a read-modify-write store would
 * lose an increment under concurrency and is not a correct implementation.
 */
export interface QuotaStore {
  read(key: QuotaKey): Promise<number>
  /** Adds `count` and returns the new total. */
  increment(key: QuotaKey, count: number): Promise<number>
}

/** Construction options for {@link createQuotaMeter}. */
export interface QuotaMeterOptions {
  policy: QuotaPolicy
  store: QuotaStore
  /** False when no metered provider key is configured → every check is `Unavailable` (503), not `Exhausted` (429). */
  meteredKeyAvailable: boolean
  /** Milliseconds since the epoch, injected for determinism. Defaults to `Date.now`. */
  now?: () => number
}

/**
 * The metering surface. Every method is `async` even where an implementation
 * happens to be synchronous, so a store can be remote.
 */
export interface QuotaMeter {
  /**
   * Inspect the budget without spending any of it (source
   * `apps/api/services/demo-usage.ts:13-58`).
   *
   * `hasOwnKey` mirrors the caller having supplied their own provider key: with
   * the default policy the budget is bypassed, `used: 0`, `remaining: limit`,
   * `metered: false`, and the store is not touched. In the source the flag
   * travelled as the truthy string literal `"byok"` in the key's position
   * (`apps/api/routes/analyze.ts:111`, tested at `demo-usage.ts:19`) — the value
   * was never a key, only a marker that a key existed, which is exactly why this
   * port makes it a `boolean`.
   */
  check(principal: QuotaPrincipal, options?: { hasOwnKey?: boolean }): Promise<QuotaState>
  /**
   * Add `count` (default 1) units of completed business work and return the
   * resulting state (source `apps/api/services/demo-usage.ts:63-80`). Call it
   * *after* the work: the result may be `Exhausted` with `used > limit`, and
   * that overshoot is reported, never clamped away.
   *
   * @throws {QuotaError} `InvalidCount` when `count` is not a positive safe integer.
   */
  record(principal: QuotaPrincipal, count?: number): Promise<QuotaState>
  /**
   * Read the current budget without incrementing (source
   * `apps/api/services/demo-usage.ts:85-94`).
   *
   * `hasOwnKey` is unknown on a read, so this reports the metered budget
   * (`metered: meteredKeyAvailable`); the caller marks BYOK separately, as the
   * source route did (`apps/api/routes/usage.ts:20-31`).
   */
  get(principal: QuotaPrincipal): Promise<QuotaState>
}

/** A `HashMap`-like lookup never returns `undefined` for an enum member. */
const HTTP_STATUS_BY_DECISION: Record<QuotaDecision, 200 | 429 | 503> = {
  [QuotaDecision.Allowed]: 200,
  [QuotaDecision.Exhausted]: 429,
  [QuotaDecision.Unavailable]: 503,
}

/**
 * 200 for Allowed, 429 for Exhausted, 503 for Unavailable — the HTTP contract,
 * framework-free.
 *
 * The mapping is ported from the source *route*, not from its usage endpoint:
 * `apps/api/routes/analyze.ts:114-125` answers `503` when the demo key is not
 * configured and `429` `{ error: "Demo limit reached", used, limit }` when the
 * budget is spent, else it proceeds (which is this `200`). The same two branches
 * appear at `apps/api/routes/batch.ts:112-123`. `apps/api/routes/usage.ts` was
 * never the mapping site — it only reads state for the UI.
 */
export function quotaHttpStatus(decision: QuotaDecision): 200 | 429 | 503 {
  return HTTP_STATUS_BY_DECISION[decision]
}

/**
 * Resolve the principal a counter is billed to.
 *
 * User wins over session (source `apps/api/services/demo-usage.ts:34-48`): an
 * authenticated request is metered against the user even when it also carries a
 * session id, so signing in cannot reset a budget by rotating a session.
 * Blank/whitespace ids count as absent; neither present throws
 * `QuotaError(NoPrincipal)` (source `apps/api/routes/usage.ts:14-16` → 400).
 *
 * @throws {QuotaError} `NoPrincipal` when both inputs are absent or whitespace.
 */
export function resolveQuotaPrincipal(
  input: { userId?: string | null; sessionId?: string | null },
): QuotaPrincipal {
  // `??` first, then a truthiness test on the trimmed value: `""` is treated
  // exactly like `undefined`, so a header that is present but empty does not
  // become a principal whose counter every anonymous request shares.
  const userId = input.userId?.trim() ?? ""
  if (userId) return { kind: QuotaPrincipalKind.User, id: userId }
  const sessionId = input.sessionId?.trim() ?? ""
  if (sessionId) return { kind: QuotaPrincipalKind.Session, id: sessionId }
  throw new QuotaError(QuotaErrorCode.NoPrincipal, NO_PRINCIPAL_MESSAGE)
}

/**
 * Derive the counter identity for a principal inside the window containing
 * `nowMs`.
 *
 * The window is `"all"` for a lifetime policy (a fixed bucket index would reset
 * the budget on a calendar boundary, which is not what "50 free requests ever"
 * means), or `w<index>` where `index = floor(nowMs / (windowSeconds * 1000))`.
 *
 * A fixed window is deliberately the crudest scheme: it is the only one a
 * KV/SQL store can implement with **one atomic increment on one key**, and it
 * needs no stored per-request timestamp, so it stays cheap and auditable at any
 * scale. It is also coarse — a principal can spend `2 * limit` across a
 * boundary, and a burst straddling it is not smoothed. Smoothing is explicitly
 * out of scope: a *sliding* window is a rate limiter concern (`platform/rate-limit`,
 * issue #4), and buying it here would trade a quota's auditability for it.
 */
export function quotaKey(principal: QuotaPrincipal, policy: QuotaPolicy, nowMs: number): QuotaKey {
  const kind = principal.kind === QuotaPrincipalKind.User ? "user" : "session"
  const windowSeconds = policy.windowSeconds ?? 0
  const window = windowSeconds > 0 ? `w${Math.floor(nowMs / (windowSeconds * 1000))}` : "all"
  return { principal: `${kind}:${principal.id}`, window }
}

/** Narrow an `unknown` to the injected store port, so a wiring mistake fails at construction. */
function isStorePort(value: unknown): value is QuotaStore {
  if (typeof value !== "object" || value === null) return false
  const port = value as { read?: unknown; increment?: unknown }
  return typeof port.read === "function" && typeof port.increment === "function"
}

/**
 * Validate the policy and the store port once, at construction, rather than on
 * every request: a bad `limit` would otherwise surface as a wrong number in the
 * UI rather than a failed boot.
 *
 * `limit: 0` is accepted on purpose — a disabled budget is a valid
 * configuration, and it keeps a feature flag writable as `limit: 0` instead of
 * a second code path.
 *
 * `windowSeconds: 0` is rejected when it is *written out*, even though an
 * omitted `windowSeconds` means the lifetime window (which behaves identically
 * at runtime, via `policy.windowSeconds ?? 0`). The two are not
 * interchangeable on the page: `windowSeconds: 0` reads as "a window of zero
 * seconds", which is the shape of a rate limiter's mistake, and a config that
 * says it should be corrected to either "omit it" or a real period rather than
 * silently accepted as a lifetime budget.
 *
 * A policy that does not satisfy `arktype`'s {@link policySchema} is refused,
 * with the `limit` field checked separately (via {@link limitOnlySchema}) so the
 * constant message names the field to fix. A policy whose `windowSeconds` is bad
 * *only* reports the window string; when both fields are bad the window message
 * wins, which is acceptable because both constants name a real defect and
 * neither echoes a value.
 *
 * @throws {QuotaError} `InvalidPolicyLimit` for a `limit` that is not a
 * non-negative safe integer, a `windowSeconds` that is set (present and not
 * `undefined`) but not a positive safe integer, or a store port missing
 * `read`/`increment`.
 */
function assertQuotaConfig(policy: QuotaPolicy, store: unknown): void {
  // arktype, not a hand-rolled walk. The failure's own text is discarded on
  // purpose — it echoes the offending value — so the constant messages survive
  // while an undeclared extra key stays tolerated (a policy object carrying
  // wiring fields is not a shape error).
  if (!policySchema.allows(policy)) {
    if (!limitOnlySchema.allows(policy)) {
      throw new QuotaError(QuotaErrorCode.InvalidPolicyLimit, POLICY_LIMIT_MESSAGE)
    }
    throw new QuotaError(QuotaErrorCode.InvalidPolicyLimit, POLICY_WINDOW_MESSAGE)
  }
  if (!isStorePort(store)) {
    throw new QuotaError(QuotaErrorCode.InvalidPolicyLimit, STORE_PORT_MESSAGE)
  }
}

/**
 * Build a {@link QuotaMeter} over an injected policy, store and clock.
 *
 * The returned meter holds no mutable state: every number lives in the store,
 * so two processes share one budget, and a restart cannot reset usage.
 *
 * @throws {QuotaError} `InvalidPolicyLimit` when the policy or the store port is
 * unusable — fail at wiring time, not mid-request.
 */
export function createQuotaMeter(options: QuotaMeterOptions): QuotaMeter {
  assertQuotaConfig(options?.policy, options?.store)

  const { policy, store, meteredKeyAvailable } = options
  const bypassWithOwnKey = policy.bypassWithOwnKey !== false
  const windowSeconds = policy.windowSeconds ?? 0
  const limit = policy.limit
  const clock = options.now ?? Date.now

  const keyFor = (principal: QuotaPrincipal): QuotaKey => quotaKey(principal, policy, clock())

  const stateOf = (decision: QuotaDecision, used: number, metered: boolean): QuotaState => ({
    decision,
    used,
    limit,
    remaining: Math.max(0, limit - used),
    windowSeconds,
    metered,
  })

  /** The service cannot serve at all — a 503, and no counter is read or written. */
  const unavailable = (): QuotaState => ({
    decision: QuotaDecision.Unavailable,
    used: 0,
    limit: 0,
    remaining: 0,
    windowSeconds,
    metered: false,
  })

  return {
    async check(principal, checkOptions) {
      if (!meteredKeyAvailable) return unavailable()
      // The caller's own key is not our spend: nothing is read, nothing is
      // written, and the UI reports the metered budget as inactive rather than
      // as "50 remaining" (source demo-usage.ts:19-24).
      if (checkOptions?.hasOwnKey && bypassWithOwnKey) {
        // `limit`, not the counter: a BYOK request spends nothing, so the
        // budget is reported whole. With `limit: 0` (a disabled budget) the
        // result is `Allowed` with `remaining: 0` — the caller's own key is
        // still usable, and `metered: false` is what tells the UI not to render
        // a counter.
        return {
          decision: QuotaDecision.Allowed,
          used: 0,
          limit,
          remaining: limit,
          windowSeconds,
          metered: false,
        }
      }
      const used = await store.read(keyFor(principal))
      const decision = used < limit ? QuotaDecision.Allowed : QuotaDecision.Exhausted
      return stateOf(decision, used, true)
    },

    async record(principal, count = 1) {
      // Count first, then the service condition: a caller bug is not masked by
      // an outage, and no reason to touch the store has existed yet.
      if (!countSchema.allows(count)) {
        throw new QuotaError(QuotaErrorCode.InvalidCount, INVALID_COUNT_MESSAGE)
      }
      // Deviation from the source, which recorded unconditionally: a service
      // that cannot serve does not spend the principal's budget.
      if (!meteredKeyAvailable) return unavailable()
      const used = await store.increment(keyFor(principal), count)
      // Above the limit on purpose: the work already happened, so it is
      // recorded and reported, never clamped (source demo-usage.ts:63-80).
      const decision = used < limit ? QuotaDecision.Allowed : QuotaDecision.Exhausted
      return stateOf(decision, used, true)
    },

    async get(principal) {
      if (!meteredKeyAvailable) return unavailable()
      const used = await store.read(keyFor(principal))
      const decision = used < limit ? QuotaDecision.Allowed : QuotaDecision.Exhausted
      return stateOf(decision, used, true)
    },
  }
}
