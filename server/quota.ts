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
 *   attacker-controlled: an IP, a route, a token. A session id is chosen by the
 *   caller, so anonymous principals are bounded together by one shared pool
 *   ({@link QuotaPolicy.sessions}) as well as one counter each.
 * - **Where it is enforced**: a quota is spent at the point of a *costly
 *   business action*, after authentication — taken before the work with
 *   {@link QuotaMeter.reserve} and given back with {@link QuotaMeter.release}
 *   when the work did not happen. A rate limiter is middleware, before routing.
 * - **What it counts**: a quota counts successful units of work, so it can be
 *   incremented late, can overshoot its limit, and is billed to a principal. A
 *   rate limiter counts arrivals, so every request counts whether or not it
 *   succeeded.
 * - **What it emits**: a quota emits a *state* for the UI (`used`, `limit`,
 *   `remaining`) and a decision that maps to `200` / `429` / `503`
 *   ({@link quotaStatusCode}, from `apps/api/routes/analyze.ts:114-125`). A rate
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
 *   `apps/api/routes/batch.ts:112-123`) — the two-branch contract
 *   {@link quotaStatusCode} encodes. It is the *route*, not `routes/usage.ts`
 *   (which only reads), that maps a blocked check to a status: no configured
 *   provider key → `503`, otherwise a spent budget → `429`. The `200` case is
 *   simply "not blocked" — the route proceeds to the work. The source's two
 *   response strings are its product's, not this module's, and are not ported.
 * - `libs/db/mod.ts:224-248` (`getSessionUsage` / `recordSessionUsage` /
 *   `getUserUsage` / `incrementUsage`) is the shape {@link QuotaStore} was
 *   extracted from; the driver is not ported.
 *
 * ## Deviations from the source (all intentional, all tested)
 *
 * 1. {@link QuotaMeter.record} does **not** spend budget when the metered
 *    resource is not configured. The source recorded unconditionally
 *    (`apps/api/services/demo-usage.ts:63-80`), which charged a user for a
 *    request that could not be served. A service that cannot serve does not
 *    spend budget.
 * 2. {@link QuotaMeter.record} returns the full state instead of a bare
 *    usage record, and reports `Exhausted` rather than merely overshooting.
 * 3. {@link QuotaMeter.get} reports the *metered* budget
 *    (`metered: meteredResourceAvailable`) because a read has no way to know
 *    about a BYOK key; the source patched its own-key flag afterwards
 *    (`routes/usage.ts:20-31`). The caller still marks BYOK separately.
 * 4. `bypassWithOwnKey` defaults to `true` but is a policy flag, so an
 *    installation that wants every request metered can say so.
 * 5. The `503` is an explicit {@link QuotaDecision.Unavailable} driven by
 *    `meteredResourceAvailable`, not the source's `usage.limit === 0` sentinel
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
 * 7. **The gate is one atomic step.** The source read a counter, ran the work
 *    and incremented afterwards (`apps/api/services/demo-usage.ts:34-80`), so
 *    parallel requests all read the same "one left" and all proceeded — with a
 *    limit of 1 and ten parallel callers, ten of them ran.
 *    {@link QuotaMeter.reserve} takes the units before the work in a single
 *    store operation, and {@link QuotaMeter.release} gives them back when the
 *    work failed. {@link QuotaMeter.check} stays, as a display-only read.
 * 8. **Anonymous principals share one pool.** A session id is caller-chosen, so
 *    a per-session counter bounds nothing on its own: rotating the id gave a
 *    fresh budget every request. {@link QuotaPolicy.sessions} is now the one
 *    place that allows session principals at all, and it carries the budget all
 *    of them share.
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
 * options.meteredResourceAvailable !== "boolean"` and the store port's four
 * `typeof … === "function"` checks are not input parsing but a check that a DI
 * container was filled in, and they read as such.
 *
 * Nothing else is imported: no framework, no logging, no headers. `429`/`503`
 * are values a caller maps onto its own response.
 */

import { type } from "arktype"

/**
 * `sessions`, as configuration writes it.
 *
 * `undefined` is one of the accepted values, not only an absent key: a caller
 * building a policy from its own config writes `sessions: config.anonymous ?
 * { poolLimit: n } : undefined`, which TypeScript accepts for an optional field,
 * and failing that at construction would be a trap rather than a guard. Both
 * spellings mean the same thing — session principals are not metered here.
 */
const SESSIONS_SHAPE = ["undefined", "|", { poolLimit: "number.integer >= 0" }] as const

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
  "sessions?": SESSIONS_SHAPE,
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
 * Just the `sessions` half of {@link policySchema}, re-checked for the same
 * reason {@link limitOnlySchema} exists: so the constant message names the field
 * the caller has to fix without any arktype text — and its value — being
 * surfaced.
 */
const sessionsOnlySchema = type({ "sessions?": SESSIONS_SHAPE })

/**
 * The shape of one unit-of-work count: an integer inside a bounded range.
 *
 * A fractional or negative count would corrupt a counter that every later read
 * divides into `remaining`, so it is refused at the boundary. So is an absurd
 * *large* one: one recorded unit of work is one billable action or one batch of
 * them, and a call spending a million units at once is a caller bug — a swapped
 * argument, or an unbounded batch size — that would otherwise silently drain a
 * principal's whole budget in a single request. The ceiling is set far above any
 * real batch on purpose, so it rejects bugs and never rejects real work;
 * `1e9` is not a batch, it is a budget.
 *
 * `allows` is used rather than a parsed result because the count is consumed as
 * the caller's own value, never as a copy.
 */
const countSchema = type("1 <= number.integer <= 1000000")

/** A `limit` that is not a counter at all, refused at construction. */
const POLICY_LIMIT_MESSAGE = "QuotaPolicy.limit must be a non-negative safe integer"
/** A `windowSeconds` that is neither "lifetime" (0/undefined) nor a window. */
const POLICY_WINDOW_MESSAGE = "QuotaPolicy.windowSeconds must be a positive safe integer when set"
/** A `sessions.poolLimit` that is not a counter, refused at construction. */
const POLICY_SESSION_POOL_MESSAGE =
  "QuotaPolicy.sessions.poolLimit must be a non-negative safe integer"
/** A principal that cannot be keyed — refused rather than billed to `""`. */
const NO_PRINCIPAL_MESSAGE = "A userId or a sessionId is required"
/**
 * A `count` that is not a quantity of work — refused rather than corrupting a
 * counter or draining a budget in one call. The ceiling is named so a caller
 * knows what to split; the offending value is deliberately not echoed.
 */
const INVALID_COUNT_MESSAGE = "count must be an integer between 1 and 1000000"
/** The injected persistence port is missing or half-wired. */
const STORE_PORT_MESSAGE = "QuotaStore must provide read, increment, reserve and release functions"
/** A session principal arrived at a meter whose policy does not allow one. */
const SESSION_PRINCIPAL_MESSAGE = "QuotaPolicy.sessions must be set to meter a session principal"

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
  /** `count` was not a bounded positive integer — refusing beats a corrupt or drained counter. */
  InvalidCount = 2,
  /** The policy is unusable (bad `limit`, bad `windowSeconds`, or a broken store port). */
  InvalidPolicyLimit = 3,
  /**
   * A session principal was metered under a policy with no `sessions` budget — a
   * wiring error (`400` for the caller, or a refusal to serve anonymously).
   */
  SessionPrincipalNotAllowed = 4,
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
  /**
   * The clock reading {@link QuotaMeter.reserve} used to key the units it took,
   * present only on the state `reserve` itself returns. Pass it straight through
   * to the matching {@link QuotaMeter.release} so a refund lands in the window
   * the reservation was taken from rather than whatever window the clock is in
   * when the refund runs.
   */
  reservedAt?: number
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
  /**
   * Anonymous (session) principals, and the budget they all share.
   *
   * Omitted, every session principal is refused with
   * {@link QuotaErrorCode.SessionPrincipalNotAllowed}: only an authenticated
   * user can be metered. Present, `poolLimit` is one counter that *every*
   * session principal spends from, on top of that principal's own `limit`.
   *
   * The pool exists because a session id is chosen by the caller. A per-session
   * counter alone bounds nothing — a client that mints a new id per request
   * starts every request with a fresh budget — so the pool is what actually caps
   * what anonymous traffic can spend. Size it as "what this installation is
   * willing to give away in one window", not as a per-visitor number.
   *
   * The nesting is the contract: allowing session principals and naming their
   * shared budget is one decision, so the type makes it impossible to do the
   * first without the second.
   *
   * A session id must still be **issued and verified by the server** (a signed
   * cookie, a server-side session record). An unverified id from a header is an
   * identity the caller wrote for itself: the pool bounds the damage, it does
   * not make the id trustworthy.
   */
  sessions?: { poolLimit: number }
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

/** What {@link QuotaStore.reserve} answers: whether the units were taken, and the counter after. */
export interface QuotaReservation {
  /** True when the store took `count` units; false when the limit would have been passed. */
  granted: boolean
  /** The counter after the attempt — unchanged when `granted` is false. */
  used: number
}

/**
 * The injected persistence port — no DB driver, no KV client, no clock.
 *
 * Every method must be **one atomic operation** on the counter. This module
 * never reads a counter and writes it back, precisely so a store can satisfy the
 * port with a single statement; a read-modify-write store loses an increment
 * under concurrency and is not a correct implementation.
 *
 * `reserve` is the only method that may gate work, because deciding and
 * spending have to be the same step. In SQL that is one conditional update:
 *
 * ```sql
 * UPDATE quota SET used = used + $count
 *  WHERE principal = $principal AND window = $window AND used + $count <= $limit
 *  RETURNING used
 * ```
 *
 * A returned row is `{ granted: true, used }`; no row means the limit would have
 * been passed, and the store answers `{ granted: false, used }` with a plain
 * read (`0` when the row does not exist yet). An upsert-shaped store does the
 * same with `INSERT … ON CONFLICT DO UPDATE SET used = quota.used + $count
 * WHERE quota.used + $count <= $limit`.
 */
export interface QuotaStore {
  read(key: QuotaKey): Promise<number>
  /**
   * Adds `count` and returns the new total, whatever the limit says. This is the
   * after-the-fact path used by {@link QuotaMeter.record}; it cannot gate work.
   */
  increment(key: QuotaKey, count: number): Promise<number>
  /**
   * Adds `count` **only if** the result stays within `limit`, in one atomic
   * step, and reports whether it did.
   */
  reserve(key: QuotaKey, count: number, limit: number): Promise<QuotaReservation>
  /**
   * Gives `count` units back and returns the new total. Never goes below zero:
   * a store subtracts with `GREATEST(used - $count, 0)`, because a refund that
   * drove a counter negative would hand out free budget.
   */
  release(key: QuotaKey, count: number): Promise<number>
}

/** Construction options for {@link createQuotaMeter}. */
export interface QuotaMeterOptions {
  policy: QuotaPolicy
  store: QuotaStore
  /**
   * False when the shared resource the budget meters — a provider key, a licence
   * seat, a pool of workers — is not configured. Every call then answers
   * `Unavailable` (503), not `Exhausted` (429), and no counter is touched.
   */
  meteredResourceAvailable: boolean
  /** Milliseconds since the epoch, injected for determinism. Defaults to `Date.now`. */
  now?: () => number
}

/**
 * The metering surface. Every method is `async` even where an implementation
 * happens to be synchronous, so a store can be remote.
 */
export interface QuotaMeter {
  /**
   * Inspect the budget without spending any of it — **for display only** (source
   * `apps/api/services/demo-usage.ts:13-58`).
   *
   * This is what renders "37 of 50 used". It must not gate work: between the
   * answer and the work, any number of other requests can spend the same
   * budget, so ten parallel callers all read "one left" and all proceed.
   * {@link QuotaMeter.reserve} is the gate, and it is the only method that
   * decides and spends in one step.
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
   * Take `count` (default 1) units of the budget **before** the work, and report
   * whether they were taken. This is the only safe gate: the decision and the
   * spend are one atomic store operation, so parallel callers cannot all be told
   * they have the last unit.
   *
   * `Allowed` means the units are now charged to the principal and the work may
   * proceed. `Exhausted` means nothing was charged and the work must not run.
   * When the work then fails for a reason the principal should not pay for, give
   * the units back with {@link QuotaMeter.release}.
   *
   * A session principal spends twice: first from the pool every session shares
   * ({@link QuotaPolicy.sessions}), then from its own counter. Reserving two
   * counters is not one atomic step, so the order matters and is fixed — pool
   * first, own counter second, and the pool unit is given back both when the own
   * counter refuses and when the store throws instead of answering. In the window
   * between the two calls the pool counts a unit that was never spent, which can
   * refuse another session that would just have fit; the refund closes that
   * window, and no over-*spend* is possible in either order.
   *
   * One case the refund cannot close: a process that dies between the two calls
   * leaves a pool unit taken until the window rolls, and a lifetime window never
   * rolls. A budget that must survive that needs reservations stored with an
   * expiry, which this port deliberately does not have.
   *
   * The returned {@link QuotaState} carries `reservedAt`, the clock reading this
   * call used to key the units it took. Pass it to the matching
   * {@link QuotaMeter.release} so the refund lands in the same window.
   *
   * @throws {QuotaError} `InvalidCount` when `count` is not an integer between 1
   * and 1_000_000, `SessionPrincipalNotAllowed` when the policy has no
   * `sessions` budget and the principal is a session.
   */
  reserve(
    principal: QuotaPrincipal,
    count?: number,
    options?: { hasOwnKey?: boolean },
  ): Promise<QuotaState>
  /**
   * Give `count` (default 1) reserved units back after work that did not happen
   * — the provider call failed, the upload was rejected, the job was cancelled.
   * Returns the state after the refund.
   *
   * Only for units {@link QuotaMeter.reserve} took.
   *
   * **A refund is not idempotent, and a `release` that threw must not be
   * retried for a session principal.** Releasing the same reservation twice
   * gives the units back twice; only a counter already at zero absorbs the
   * second one, because a store never goes below zero. For a session principal
   * a release is two store calls — the principal's own counter first, then the
   * shared pool — so after one of them has failed the other has already been
   * refunded, and a retry gives that refund a second time. The caller cannot
   * tell which of the two calls failed, so it cannot tell which counter a retry
   * would double-refund: if the own-counter call failed nothing was refunded
   * and a retry is exact; if the pool call failed the own counter was already
   * refunded and a retry refunds it again, over-crediting the caller's own
   * counter (absorbed at zero once it gets there). The pool itself is never
   * over-credited by a retry — it is refunded once, on the call that succeeds.
   * The own counter is refunded first so that a failure part-way through leaves
   * the pool holding a unit that nothing holds any more: short rather than
   * over-credited, and cleared when the window rolls.
   *
   * `options` mirrors {@link QuotaMeter.reserve}'s, and a caller passes the same
   * value to both: a request that brought its own key reserved nothing, so its
   * release must spend nothing either. Passing `hasOwnKey` on the reserve and
   * not on the release refunds a metered unit that was never taken.
   *
   * `options.reservedAt`, when passed, is the clock reading `reserve` used
   * (`QuotaState.reservedAt` on the state `reserve` returned) — pass it straight
   * through and the refund keys both the principal's own counter and the shared
   * pool by that reading instead of the current clock. Omitted, `release` keys
   * by the window the clock is in **now**, exactly as before: a reservation that
   * outlives a window boundary is then refunded against the new window, and the
   * old one keeps the unit until it rolls. The unit moves between windows and
   * the total across the two is unchanged either way; keep a unit of work
   * shorter than the window, use a lifetime window, or pass `reservedAt` to make
   * this impossible.
   *
   * @throws {QuotaError} `InvalidCount`, `SessionPrincipalNotAllowed` — as
   * {@link QuotaMeter.reserve}.
   */
  release(
    principal: QuotaPrincipal,
    count?: number,
    options?: { hasOwnKey?: boolean; reservedAt?: number },
  ): Promise<QuotaState>
  /**
   * Add `count` (default 1) units of completed business work and return the
   * resulting state (source `apps/api/services/demo-usage.ts:63-80`). Call it
   * *after* the work: the result may be `Exhausted` with `used > limit`, and
   * that overshoot is reported, never clamped away.
   *
   * This is accounting, not a gate: it records work that already happened and it
   * cannot refuse anything. Use it where overshoot is acceptable and the
   * `check`-then-`record` pair is *not* how concurrent work is bounded — that is
   * {@link QuotaMeter.reserve}.
   *
   * There is deliberately no BYOK parameter here. A BYOK request never reaches
   * this method: the caller records only on the path where {@link check}
   * returned `Allowed`, and `check` is where the own-key bypass lives — the
   * source returned from its check before any recording was reached
   * (`apps/api/services/demo-usage.ts:19-24`), so the same call site skipped the
   * recording step entirely. This meter cannot tell on its own whether the
   * work it is being told about was paid for by the caller's key or by the
   * metered one, so a call site that records unconditionally charges the
   * metered budget for BYOK work. That is the caller's invariant to keep, and
   * this contract is stated rather than silently assumed.
   *
   * @throws {QuotaError} `InvalidCount` when `count` is not an integer between 1
   * and 1_000_000.
   */
  record(principal: QuotaPrincipal, count?: number): Promise<QuotaState>
  /**
   * Read the current budget without incrementing (source
   * `apps/api/services/demo-usage.ts:85-94`).
   *
   * `hasOwnKey` is unknown on a read, so this reports the metered budget
   * (`metered: meteredResourceAvailable`); the caller marks BYOK separately, as the
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
 * 200 for Allowed, 429 for Exhausted, 503 for Unavailable — the status a caller
 * answers with, as a value. Nothing here writes a response, a header or a body.
 *
 * Renamed from `quotaHttpStatus`: the mapping is this module's own decision
 * table, not a port of one product's route handler, and the caller decides what
 * a status code means in its transport. The two branches were read from
 * `apps/api/routes/analyze.ts:114-125` and the identical pair at
 * `apps/api/routes/batch.ts:112-123`; the response strings around them were that
 * product's wording and stayed there. `apps/api/routes/usage.ts` was never the
 * mapping site — it only reads state for the UI.
 */
export function quotaStatusCode(decision: QuotaDecision): 200 | 429 | 503 {
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
 * Both fields are typed `unknown` on purpose. This function's whole job is to
 * read identity out of *untrusted* request input — an `X-Session-Id` header, a
 * decoded JWT claim — where a number, an object or an array can arrive despite
 * any static type. A value that is not a string is therefore treated as absent
 * rather than trimmed, so the outcome is always either a real principal or the
 * typed `NoPrincipal`; a raw `TypeError` from `.trim()` would be an untyped
 * failure escaping a function whose entire contract is typed errors. In
 * particular `{ userId: 12345, sessionId: "s-1" }` resolves to the *session*:
 * a non-string user id does not shadow a usable session id, and it does not
 * become a counter key of `"12345"` either.
 *
 * @throws {QuotaError} `NoPrincipal` when neither input is a non-blank string.
 */
export function resolveQuotaPrincipal(
  input: { userId?: unknown; sessionId?: unknown },
): QuotaPrincipal {
  // `typeof` before `trim`, then a truthiness test on the trimmed value: a
  // non-string and an empty/whitespace string are both "absent", so a header
  // that is present but empty (or wrong-typed) never becomes a principal whose
  // counter every anonymous request shares.
  const userId = typeof input.userId === "string" ? input.userId.trim() : ""
  if (userId) return { kind: QuotaPrincipalKind.User, id: userId }
  const sessionId = typeof input.sessionId === "string" ? input.sessionId.trim() : ""
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

/**
 * The principal half of the counter every session principal shares.
 *
 * It cannot collide with a real principal: {@link quotaKey} always writes
 * `<kind>:<id>` with a non-empty id, and this value has no colon.
 */
export const SESSION_POOL_PRINCIPAL = "session-pool"

/**
 * The key of the shared session pool inside the window containing `nowMs`.
 *
 * Exported so a store's own tests, a dashboard or a migration can address the
 * same counter the meter spends from. The window is derived exactly as
 * {@link quotaKey} derives it, so the pool resets on the same boundary as the
 * per-session counters it bounds.
 */
export function sessionPoolKey(policy: QuotaPolicy, nowMs: number): QuotaKey {
  const windowSeconds = policy.windowSeconds ?? 0
  const window = windowSeconds > 0 ? `w${Math.floor(nowMs / (windowSeconds * 1000))}` : "all"
  return { principal: SESSION_POOL_PRINCIPAL, window }
}

/** Narrow an `unknown` to the injected store port, so a wiring mistake fails at construction. */
function isStorePort(value: unknown): value is QuotaStore {
  if (typeof value !== "object" || value === null) return false
  const port = value as {
    read?: unknown
    increment?: unknown
    reserve?: unknown
    release?: unknown
  }
  return typeof port.read === "function" && typeof port.increment === "function" &&
    typeof port.reserve === "function" && typeof port.release === "function"
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
 * A `sessions` block, when present, must carry a non-negative integer
 * `poolLimit`, re-checked through {@link sessionsOnlySchema} so its own constant
 * message names it.
 *
 * @throws {QuotaError} `InvalidPolicyLimit` for a `limit` that is not a
 * non-negative safe integer, a `windowSeconds` that is set (present and not
 * `undefined`) but not a positive safe integer, a malformed `sessions` block, or
 * a store port missing `read`, `increment`, `reserve` or `release`.
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
    if (!sessionsOnlySchema.allows(policy)) {
      throw new QuotaError(QuotaErrorCode.InvalidPolicyLimit, POLICY_SESSION_POOL_MESSAGE)
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

  const { policy, store, meteredResourceAvailable } = options
  const bypassWithOwnKey = policy.bypassWithOwnKey !== false
  const windowSeconds = policy.windowSeconds ?? 0
  const limit = policy.limit
  const clock = options.now ?? Date.now
  // `!== undefined`, not a truthiness test: `sessions` is the whole decision to
  // meter anonymous callers, and an absent one can only mean "refuse".
  const sessions = policy.sessions
  const sessionPoolLimit = sessions?.poolLimit ?? 0

  // Every method reads the clock once, into `nowMs`, and derives both keys from
  // that one reading. Two readings inside one call can fall on either side of a
  // window boundary, and a session reservation would then take the pool unit in
  // one window and its own unit in the next — leaving a pool unit behind that
  // the matching release, keyed by the later window, could not give back.
  const keyFor = (principal: QuotaPrincipal, nowMs: number): QuotaKey =>
    quotaKey(principal, policy, nowMs)

  const poolKeyAt = (nowMs: number): QuotaKey => sessionPoolKey(policy, nowMs)

  const isSession = (principal: QuotaPrincipal): boolean =>
    principal.kind === QuotaPrincipalKind.Session

  /**
   * A session principal is only meterable when the policy said so. Checked
   * before anything else on every method, so a meter wired for authenticated
   * users cannot silently start counting caller-chosen identities.
   */
  const assertPrincipalAllowed = (principal: QuotaPrincipal): void => {
    if (isSession(principal) && sessions === undefined) {
      throw new QuotaError(QuotaErrorCode.SessionPrincipalNotAllowed, SESSION_PRINCIPAL_MESSAGE)
    }
  }

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

  /**
   * The caller's own key is not our spend: nothing is read, nothing is written,
   * and the UI reports the metered budget as inactive rather than as "50
   * remaining" (source demo-usage.ts:19-24).
   *
   * `limit`, not the counter: a BYOK request spends nothing, so the budget is
   * reported whole. With `limit: 0` (a disabled budget) the result is `Allowed`
   * with `remaining: 0` — the caller's own key is still usable, and
   * `metered: false` is what tells the UI not to render a counter.
   */
  const ownKeyState = (): QuotaState => ({
    decision: QuotaDecision.Allowed,
    used: 0,
    limit,
    remaining: limit,
    windowSeconds,
    metered: false,
  })

  const assertCount = (count: number): void => {
    if (!countSchema.allows(count)) {
      throw new QuotaError(QuotaErrorCode.InvalidCount, INVALID_COUNT_MESSAGE)
    }
  }

  const decisionFor = (used: number): QuotaDecision =>
    used < limit ? QuotaDecision.Allowed : QuotaDecision.Exhausted

  /**
   * The state a read reports. A session principal is inside its budget only
   * while the shared pool is too, so the pool is read as well and the stricter
   * of the two answers wins. `used`/`remaining` stay the principal's own
   * numbers — the pool is a ceiling on the whole anonymous population and is
   * not a counter any single visitor can be shown as theirs.
   */
  const readState = async (principal: QuotaPrincipal, nowMs: number): Promise<QuotaState> => {
    const used = await store.read(keyFor(principal, nowMs))
    let decision = decisionFor(used)
    if (decision === QuotaDecision.Allowed && isSession(principal)) {
      const pooled = await store.read(poolKeyAt(nowMs))
      if (pooled >= sessionPoolLimit) decision = QuotaDecision.Exhausted
    }
    return stateOf(decision, used, true)
  }

  /**
   * Give a pool unit back after the reservation it belonged to could not be
   * completed, without replacing the failure the caller has to see.
   *
   * A refund that throws is swallowed on purpose: the store that just rejected
   * the metered reservation is quite likely to reject this too, and the caller
   * needs the original failure, not a second one about the cleanup. What is
   * left behind in that case is one pool unit until the window rolls, which is
   * the same cost as a process that dies between the two calls.
   */
  const releasePoolQuietly = async (nowMs: number, count: number): Promise<void> => {
    try {
      await store.release(poolKeyAt(nowMs), count)
    } catch {
      return
    }
  }

  return {
    async check(principal, checkOptions) {
      assertPrincipalAllowed(principal)
      if (!meteredResourceAvailable) return unavailable()
      if (checkOptions?.hasOwnKey && bypassWithOwnKey) return ownKeyState()
      return await readState(principal, clock())
    },

    async reserve(principal, count = 1, reserveOptions) {
      assertPrincipalAllowed(principal)
      // Count first, then the service condition: a caller bug is not masked by
      // an outage, and no reason to touch the store has existed yet.
      assertCount(count)
      if (!meteredResourceAvailable) return unavailable()
      if (reserveOptions?.hasOwnKey && bypassWithOwnKey) return ownKeyState()

      const nowMs = clock()
      const pooled = isSession(principal)
      if (pooled) {
        // Pool first. Taking the shared budget before the private one means the
        // worst case is a unit held in the pool for the length of one store
        // round trip and then refunded; the reverse order would let a rotating
        // session id spend its own fresh counter before the pool ever saw it.
        const pool = await store.reserve(poolKeyAt(nowMs), count, sessionPoolLimit)
        if (!pool.granted) {
          return stateOf(QuotaDecision.Exhausted, await store.read(keyFor(principal, nowMs)), true)
        }
      }

      let own: QuotaReservation
      try {
        own = await store.reserve(keyFor(principal, nowMs), count, limit)
      } catch (error) {
        // The pool unit is already taken at this point, and nothing else will
        // ever give it back: the caller sees a failure, so it has nothing to
        // release. A store that goes down would otherwise close the anonymous
        // tier one unit at a time.
        if (pooled) await releasePoolQuietly(nowMs, count)
        throw error
      }

      if (!own.granted && pooled) await releasePoolQuietly(nowMs, count)
      return {
        ...stateOf(
          own.granted ? QuotaDecision.Allowed : QuotaDecision.Exhausted,
          own.used,
          true,
        ),
        reservedAt: nowMs,
      }
    },

    async release(principal, count = 1, releaseOptions) {
      assertPrincipalAllowed(principal)
      assertCount(count)
      if (!meteredResourceAvailable) return unavailable()
      // The mirror of `reserve`: a bypassed request took nothing, so there is
      // nothing to give back. Without this, the documented reserve-work-release
      // pattern refunds a metered unit for a request that never spent one.
      if (releaseOptions?.hasOwnKey && bypassWithOwnKey) return ownKeyState()

      // `reservedAt`, when the caller passes the reading `reserve` used, keys
      // the refund by the window the reservation was taken from instead of
      // whatever window the clock is in when the refund runs.
      const nowMs = releaseOptions?.reservedAt ?? clock()
      // The reverse of `reserve`, and the order is the whole point: the private
      // counter is refunded first, so a store that fails between the two calls
      // leaves the shared pool holding a unit nothing holds any more. That is
      // the failing-closed direction — the pool refuses a caller it could have
      // served — where refunding the pool first would hand a unit to whoever
      // asks next.
      const used = await store.release(keyFor(principal, nowMs), count)
      if (isSession(principal)) await store.release(poolKeyAt(nowMs), count)
      return stateOf(decisionFor(used), used, true)
    },

    async record(principal, count = 1) {
      assertPrincipalAllowed(principal)
      assertCount(count)
      // Deviation from the source, which recorded unconditionally: a service
      // that cannot serve does not spend the principal's budget.
      if (!meteredResourceAvailable) return unavailable()
      const nowMs = clock()
      if (isSession(principal)) await store.increment(poolKeyAt(nowMs), count)
      const used = await store.increment(keyFor(principal, nowMs), count)
      // Above the limit on purpose: the work already happened, so it is
      // recorded and reported, never clamped (source demo-usage.ts:63-80).
      return stateOf(decisionFor(used), used, true)
    },

    async get(principal) {
      assertPrincipalAllowed(principal)
      if (!meteredResourceAvailable) return unavailable()
      return await readState(principal, clock())
    },
  }
}
