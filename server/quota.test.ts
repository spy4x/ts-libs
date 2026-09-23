import {
  assertEquals,
  assertFalse,
  assertInstanceOf,
  AssertionError,
  assertRejects,
  assertStrictEquals,
  assertThrows,
} from "@std/assert"
import {
  createQuotaMeter,
  QuotaDecision,
  QuotaError,
  QuotaErrorCode,
  type QuotaKey,
  quotaKey,
  type QuotaMeter,
  type QuotaPolicy,
  QuotaPrincipalKind,
  quotaStatusCode,
  type QuotaStore,
  resolveQuotaPrincipal,
  SESSION_POOL_PRINCIPAL,
  sessionPoolKey,
} from "./quota.ts"

// ── Fixtures ───────────────────────────────────────────────────────────────

/**
 * A `Map`-backed quota store — the smallest correct one-operation store.
 *
 * Every method decides and writes without awaiting anything in between, which
 * is what makes it atomic here and what a SQL store buys with a single
 * conditional statement (see the `QuotaStore` JSDoc). A store that awaited
 * between the read and the write would lose increments, exactly like the
 * check-then-record pattern this module replaced.
 */
function inMemoryStore(): QuotaStore {
  const counters = new Map<string, number>()
  const id = (key: QuotaKey): string => `${key.principal}|${key.window}`
  return {
    read: (key) => Promise.resolve(counters.get(id(key)) ?? 0),
    increment: (key, count) => {
      const next = (counters.get(id(key)) ?? 0) + count
      counters.set(id(key), next)
      return Promise.resolve(next)
    },
    reserve: (key, count, limit) => {
      const used = counters.get(id(key)) ?? 0
      if (used + count > limit) return Promise.resolve({ granted: false, used })
      counters.set(id(key), used + count)
      return Promise.resolve({ granted: true, used: used + count })
    },
    release: (key, count) => {
      const next = Math.max(0, (counters.get(id(key)) ?? 0) - count)
      counters.set(id(key), next)
      return Promise.resolve(next)
    },
  }
}

/**
 * Wraps a store and counts calls, so "the store is not touched" is asserted
 * against real invocations rather than against the counter's value — a store
 * that was read and written back to the same value would otherwise look
 * untouched.
 */
function spyStore(store: QuotaStore): {
  store: QuotaStore
  calls: { read: number; increment: number; reserve: number; release: number }
} {
  const calls = { read: 0, increment: 0, reserve: 0, release: 0 }
  return {
    calls,
    store: {
      read: (key) => {
        calls.read += 1
        return store.read(key)
      },
      increment: (key, count) => {
        calls.increment += 1
        return store.increment(key, count)
      },
      reserve: (key, count, limit) => {
        calls.reserve += 1
        return store.reserve(key, count, limit)
      },
      release: (key, count) => {
        calls.release += 1
        return store.release(key, count)
      },
    },
  }
}

const USER = { kind: QuotaPrincipalKind.User, id: "user-1" }

/** A meter with a frozen clock: `windowSeconds` omitted, so one lifetime window. */
function makeMeter(
  overrides: Partial<
    { policy: QuotaPolicy; store: QuotaStore; meteredResourceAvailable: boolean }
  > = {},
): {
  meter: QuotaMeter
  calls: { read: number; increment: number; reserve: number; release: number }
} {
  const spy = spyStore(overrides.store ?? inMemoryStore())
  const created = createQuotaMeter({
    policy: overrides.policy ?? { limit: 3 },
    store: spy.store,
    meteredResourceAvailable: overrides.meteredResourceAvailable ?? true,
    now: () => 0,
  })
  return { meter: created, calls: spy.calls }
}

/** The error a call rejects with, asserted to be an `Error` so its fields are readable. */
async function rejectedError(fn: () => unknown): Promise<Error> {
  try {
    await fn()
  } catch (error) {
    assertInstanceOf(error, Error)
    return error
  }
  throw new AssertionError("expected the call to reject")
}

/**
 * The `QuotaError.code` a call throws or rejects with, or `undefined` when it
 * does neither. `await`ing an already-rejected value from a synchronous throw
 * is what lets one helper serve both `resolveQuotaPrincipal` and the async
 * meter methods.
 */
async function caughtCode(fn: () => unknown): Promise<QuotaErrorCode | undefined> {
  try {
    await fn()
  } catch (error) {
    assertInstanceOf(error, QuotaError)
    return error.code
  }
  return undefined
}

// ── check ──────────────────────────────────────────────────────────────────

Deno.test("check: a fresh principal is Allowed and reports remaining = limit - used", async () => {
  const spy = spyStore(inMemoryStore())
  const store = spy.store
  await store.increment({ principal: "user:user-1", window: "all" }, 2)
  const { meter } = makeMeter({ policy: { limit: 10 }, store })
  const state = await meter.check(USER)
  assertEquals(state.decision, QuotaDecision.Allowed)
  assertEquals(state.used, 2)
  assertEquals(state.limit, 10)
  assertEquals(state.remaining, 8)
  assertEquals(state.windowSeconds, 0)
  assertEquals(state.metered, true)
})

Deno.test("check: a principal with no recorded usage is Allowed with the full limit", async () => {
  const { meter, calls } = makeMeter({ policy: { limit: 50 } })
  const state = await meter.check(USER)
  assertEquals(state.decision, QuotaDecision.Allowed)
  assertEquals(state.used, 0)
  assertEquals(state.remaining, 50)
  assertEquals(calls.read, 1)
  assertEquals(calls.increment, 0)
})

Deno.test("check: usage exactly at the limit is Exhausted with remaining 0", async () => {
  const { meter } = makeMeter({ policy: { limit: 3 } })
  await meter.record(USER, 3)
  const state = await meter.check(USER)
  assertEquals(state.decision, QuotaDecision.Exhausted)
  assertEquals(state.used, 3)
  assertEquals(state.remaining, 0)
})

Deno.test("check: usage past the limit stays Exhausted with remaining clamped at 0", async () => {
  const { meter } = makeMeter({ policy: { limit: 3 } })
  await meter.record(USER, 5)
  const state = await meter.check(USER)
  assertEquals(state.decision, QuotaDecision.Exhausted)
  assertEquals(state.used, 5)
  assertEquals(state.remaining, 0)
})

Deno.test("check: a limit of 0 is a disabled budget, not an error", async () => {
  const { meter } = makeMeter({ policy: { limit: 0 } })
  const state = await meter.check(USER)
  assertEquals(state.decision, QuotaDecision.Exhausted)
  assertEquals(state.limit, 0)
  assertEquals(state.remaining, 0)
})

// ── record ─────────────────────────────────────────────────────────────────

Deno.test("record: increments by 1 by default and returns the resulting state", async () => {
  const { meter, calls } = makeMeter({ policy: { limit: 10 } })
  const state = await meter.record(USER)
  assertEquals(state.used, 1)
  assertEquals(state.remaining, 9)
  assertEquals(state.decision, QuotaDecision.Allowed)
  assertEquals(calls.increment, 1)
  assertEquals(calls.read, 0)
})

Deno.test("record: increments by count", async () => {
  const { meter } = makeMeter({ policy: { limit: 10 } })
  await meter.record(USER, 4)
  const state = await meter.record(USER, 2)
  assertEquals(state.used, 6)
  assertEquals(state.remaining, 4)
})

Deno.test("record: past the limit reports used > limit rather than clamping", async () => {
  const { meter } = makeMeter({ policy: { limit: 3 } })
  await meter.record(USER, 3)
  const state = await meter.record(USER, 4)
  assertEquals(state.decision, QuotaDecision.Exhausted)
  assertEquals(state.used, 7)
  assertEquals(state.limit, 3)
  assertEquals(state.remaining, 0)
  const read = await meter.get(USER)
  assertEquals(read.used, 7)
})

Deno.test("record: a count of 0, -1, 1.5 or NaN throws InvalidCount", async () => {
  const { meter } = makeMeter()
  for (const count of [0, -1, 1.5, Number.NaN]) {
    assertEquals(await caughtCode(() => meter.record(USER, count)), QuotaErrorCode.InvalidCount)
  }
})

Deno.test("record: a rejected count never reaches the store", async () => {
  const { meter, calls } = makeMeter()
  await assertRejects(() => meter.record(USER, 0), QuotaError)
  assertEquals(calls.increment, 0)
  assertEquals(calls.read, 0)
})

Deno.test("record: a count above the ceiling is InvalidCount, at the ceiling it succeeds", async () => {
  const { meter, calls } = makeMeter({ policy: { limit: 1_000_000 } })
  const message = "count must be an integer between 1 and 1000000"

  // 1e9 in one call is a caller bug (a swapped argument, an unbounded batch),
  // not a batch: it would drain a whole budget in one request.
  for (const count of [1e9, 1_000_001]) {
    const thrown = await rejectedError(() => meter.record(USER, count))
    assertInstanceOf(thrown, QuotaError)
    assertEquals(thrown.code, QuotaErrorCode.InvalidCount)
    assertEquals(thrown.message, message)
    assertFalse(thrown.message.includes("1000001"))
    assertFalse(thrown.message.includes("1000000000"))
    assertFalse(thrown.message.includes("was "))
  }
  assertEquals(calls.increment, 0)

  // The ceiling itself is legal, and it is spent exactly, never clamped.
  const state = await meter.record(USER, 1_000_000)
  assertEquals(state.used, 1_000_000)
  assertEquals(state.limit, 1_000_000)
  assertEquals(state.remaining, 0)
  assertEquals(state.decision, QuotaDecision.Exhausted)
  assertEquals(calls.increment, 1)
})

Deno.test("record: the ceiling is a limit on one call, not a cap on the counter", async () => {
  const { meter } = makeMeter({ policy: { limit: 100 } })
  await meter.record(USER, 1_000_000)
  const state = await meter.record(USER, 1_000_000)
  assertEquals(state.used, 2_000_000)
  assertEquals(state.limit, 100)
  assertEquals(state.remaining, 0)
})

// ── BYOK / own key ─────────────────────────────────────────────────────────

Deno.test("check: a BYOK request is Allowed, unmetered, and never touches the store", async () => {
  const { meter, calls } = makeMeter({ policy: { limit: 50 } })
  const state = await meter.check(USER, { hasOwnKey: true })
  assertEquals(state.decision, QuotaDecision.Allowed)
  assertEquals(state.used, 0)
  assertEquals(state.remaining, 50)
  assertFalse(state.metered)
  assertEquals(calls.read, 0)
  assertEquals(calls.increment, 0)
})

Deno.test("check: bypassWithOwnKey false keeps a BYOK request metered", async () => {
  const { meter, calls } = makeMeter({ policy: { limit: 50, bypassWithOwnKey: false } })
  await meter.record(USER, 5)
  const state = await meter.check(USER, { hasOwnKey: true })
  assertEquals(state.decision, QuotaDecision.Allowed)
  assertEquals(state.used, 5)
  assertEquals(state.remaining, 45)
  assertEquals(state.metered, true)
  assertEquals(calls.read, 1)
})

// ── metered key unavailable ────────────────────────────────────────────────

Deno.test("check: an unconfigured metered key is Unavailable, not Exhausted", async () => {
  const { meter, calls } = makeMeter({ meteredResourceAvailable: false })
  const state = await meter.check(USER)
  assertEquals(state.decision, QuotaDecision.Unavailable)
  assertEquals(state.used, 0)
  assertEquals(state.limit, 0)
  assertEquals(state.remaining, 0)
  assertFalse(state.metered)
  assertEquals(calls.read, 0)
  assertEquals(calls.increment, 0)
})

Deno.test("record: an unconfigured metered key is Unavailable and spends no budget", async () => {
  const store = inMemoryStore()
  const spy = spyStore(store)
  const created = createQuotaMeter({
    policy: { limit: 3 },
    store: spy.store,
    meteredResourceAvailable: false,
    now: () => 0,
  })
  const state = await created.record(USER, 2)
  assertEquals(state.decision, QuotaDecision.Unavailable)
  assertEquals(state.used, 0)
  assertEquals(spy.calls.increment, 0)
  assertEquals(spy.calls.read, 0)
  assertEquals(await store.read(quotaKey(USER, { limit: 3 }, 0)), 0)
})

Deno.test("get: an unconfigured metered key is Unavailable without reading the store", async () => {
  const { meter, calls } = makeMeter({ meteredResourceAvailable: false })
  const state = await meter.get(USER)
  assertEquals(state.decision, QuotaDecision.Unavailable)
  assertEquals(calls.read, 0)
  assertEquals(quotaStatusCode(state.decision), 503)
})

// ── HTTP contract ──────────────────────────────────────────────────────────

Deno.test("quotaStatusCode: pins 200, 429 and 503 to the three decisions", () => {
  assertEquals(quotaStatusCode(QuotaDecision.Allowed), 200)
  assertEquals(quotaStatusCode(QuotaDecision.Exhausted), 429)
  assertEquals(quotaStatusCode(QuotaDecision.Unavailable), 503)
})

Deno.test("quotaStatusCode: a disabled budget is 429, distinct from the 503 service case", async () => {
  // The source could not tell these apart: it used `usage.limit === 0` as the
  // "no demo key" sentinel (`apps/api/routes/analyze.ts:115`,
  // `apps/api/routes/batch.ts:113`), which is also a legitimate disabled budget.
  // Here the two are different decisions with different statuses, so a
  // correctly configured `limit: 0` is not reported as a server misconfiguration.
  const disabled = makeMeter({ policy: { limit: 0 } })
  const spent = await disabled.meter.check(USER)
  assertEquals(spent.decision, QuotaDecision.Exhausted)
  assertEquals(spent.limit, 0)
  assertEquals(quotaStatusCode(spent.decision), 429)

  const unconfigured = makeMeter({ meteredResourceAvailable: false })
  const unavailable = await unconfigured.meter.check(USER)
  assertEquals(unavailable.decision, QuotaDecision.Unavailable)
  assertEquals(quotaStatusCode(unavailable.decision), 503)
})

Deno.test("state to HTTP status: a table over the three reachable states", async () => {
  const allowed = await makeMeter({ policy: { limit: 1 } }).meter.check(USER)
  const exhausted = makeMeter({ policy: { limit: 1 } })
  await exhausted.meter.record(USER, 1)
  const exhaustedState = await exhausted.meter.check(USER)
  const unavailable = await makeMeter({ meteredResourceAvailable: false }).meter.check(USER)

  const table: Array<[typeof allowed, number]> = [
    [allowed, 200],
    [exhaustedState, 429],
    [unavailable, 503],
  ]
  for (const [state, status] of table) {
    assertEquals(quotaStatusCode(state.decision), status)
  }
  assertEquals(allowed.decision, QuotaDecision.Allowed)
  assertEquals(exhaustedState.decision, QuotaDecision.Exhausted)
  assertEquals(unavailable.decision, QuotaDecision.Unavailable)
})

// ── fixed windows ──────────────────────────────────────────────────────────

Deno.test("fixed window: usage at t=0 does not count at t=60_000, and does at t=59_999", async () => {
  const spy = spyStore(inMemoryStore())
  const policy: QuotaPolicy = { limit: 1, windowSeconds: 60 }
  const at0 = createQuotaMeter({
    policy,
    store: spy.store,
    meteredResourceAvailable: true,
    now: () => 0,
  })
  await at0.record(USER, 1)

  const at59999 = createQuotaMeter({
    policy,
    store: spy.store,
    meteredResourceAvailable: true,
    now: () => 59_999,
  })
  assertEquals((await at59999.check(USER)).decision, QuotaDecision.Exhausted)

  const at60000 = createQuotaMeter({
    policy,
    store: spy.store,
    meteredResourceAvailable: true,
    now: () => 60_000,
  })
  const rolled = await at60000.check(USER)
  assertEquals(rolled.decision, QuotaDecision.Allowed)
  assertEquals(rolled.used, 0)
  assertEquals(rolled.limit, 1)
  assertEquals(rolled.remaining, 1)
  assertEquals(rolled.windowSeconds, 60)
  assertEquals(rolled.metered, true)
})

Deno.test("quotaKey: the same principal in different windows gets different keys", () => {
  const policy: QuotaPolicy = { limit: 1, windowSeconds: 60 }
  const first = quotaKey(USER, policy, 0)
  const last = quotaKey(USER, policy, 59_999)
  const next = quotaKey(USER, policy, 60_000)
  assertEquals(first, { principal: "user:user-1", window: "w0" })
  assertEquals(last, { principal: "user:user-1", window: "w0" })
  assertEquals(next, { principal: "user:user-1", window: "w1" })
})

Deno.test("fixed window: a recorded overshoot does not leak into the next window", async () => {
  const spy = spyStore(inMemoryStore())
  const policy: QuotaPolicy = { limit: 2, windowSeconds: 3600 }
  const first = createQuotaMeter({
    policy,
    store: spy.store,
    meteredResourceAvailable: true,
    now: () => 0,
  })
  const overshoot = await first.record(USER, 5)
  assertEquals(overshoot.used, 5)

  const second = createQuotaMeter({
    policy,
    store: spy.store,
    meteredResourceAvailable: true,
    now: () => 3_600_000,
  })
  const state = await second.get(USER)
  assertEquals(state.used, 0)
  assertEquals(state.decision, QuotaDecision.Allowed)
  assertEquals(state.remaining, 2)
})

// ── principal isolation ────────────────────────────────────────────────────

Deno.test("quotaKey: one window is shared by a lifetime policy whatever the clock says", () => {
  const lifetime: QuotaPolicy = { limit: 50 }
  assertEquals(quotaKey(USER, lifetime, 0).window, "all")
  assertEquals(quotaKey(USER, lifetime, 1_700_000_000_000).window, "all")
  assertEquals(quotaKey(USER, { limit: 50, windowSeconds: 0 }, 1).window, "all")
})

Deno.test("counters: two principals do not share one", async () => {
  const { meter } = makeMeter({ policy: { limit: 5 } })
  await meter.record(USER, 3)
  const other = await meter.check({ kind: QuotaPrincipalKind.User, id: "user-2" })
  assertEquals(other.used, 0)
  assertEquals(other.remaining, 5)
})

Deno.test("counters: a user and a session with the same id string do not share one", async () => {
  const { meter } = makeMeter({ policy: { limit: 5, sessions: { poolLimit: 100 } } })
  const shared = "principal-collision"
  await meter.record({ kind: QuotaPrincipalKind.User, id: shared }, 4)
  const session = await meter.check({ kind: QuotaPrincipalKind.Session, id: shared })
  assertEquals(session.used, 0)
  assertEquals(session.remaining, 5)
})

Deno.test("counters: a lifetime policy never resets", async () => {
  const spy = spyStore(inMemoryStore())
  const meter = createQuotaMeter({
    policy: { limit: 2 },
    store: spy.store,
    meteredResourceAvailable: true,
    now: () => 0,
  })
  await meter.record(USER, 2)
  const later = createQuotaMeter({
    policy: { limit: 2 },
    store: spy.store,
    meteredResourceAvailable: true,
    now: () => 1_700_000_000_000,
  })
  const state = await later.check(USER)
  assertEquals(state.decision, QuotaDecision.Exhausted)
  assertEquals(state.used, 2)
  assertEquals(state.remaining, 0)
  assertEquals(state.windowSeconds, 0)
})

// ── resolveQuotaPrincipal ──────────────────────────────────────────────────

Deno.test("resolveQuotaPrincipal: a user wins over a session", () => {
  const principal = resolveQuotaPrincipal({ userId: "user-1", sessionId: "session-1" })
  assertEquals(principal, { kind: QuotaPrincipalKind.User, id: "user-1" })
})

Deno.test("resolveQuotaPrincipal: the session is the fallback when there is no user", () => {
  assertEquals(resolveQuotaPrincipal({ sessionId: "session-1" }), {
    kind: QuotaPrincipalKind.Session,
    id: "session-1",
  })
  assertEquals(resolveQuotaPrincipal({ userId: null, sessionId: "session-1" }), {
    kind: QuotaPrincipalKind.Session,
    id: "session-1",
  })
})

Deno.test("resolveQuotaPrincipal: blank ids count as absent and surviving ids are trimmed", async () => {
  // A blank user does not shadow a real session, and the session is normalised
  // before it is baked into a counter key.
  assertEquals(resolveQuotaPrincipal({ userId: "  ", sessionId: " session-1 " }), {
    kind: QuotaPrincipalKind.Session,
    id: "session-1",
  })
  assertEquals(resolveQuotaPrincipal({ userId: "", sessionId: "session-1" }), {
    kind: QuotaPrincipalKind.Session,
    id: "session-1",
  })
  assertEquals(resolveQuotaPrincipal({ userId: " user-1 " }), {
    kind: QuotaPrincipalKind.User,
    id: "user-1",
  })
  // Blank is absent even when the other input is present but unusable.
  assertEquals(
    await caughtCode(() => resolveQuotaPrincipal({ userId: "", sessionId: "   " })),
    QuotaErrorCode.NoPrincipal,
  )
})

Deno.test("resolveQuotaPrincipal: neither principal is a NoPrincipal error", async () => {
  for (const input of [{}, { userId: null, sessionId: null }, { userId: " ", sessionId: "\t" }]) {
    assertEquals(await caughtCode(() => resolveQuotaPrincipal(input)), QuotaErrorCode.NoPrincipal)
  }
})

Deno.test("resolveQuotaPrincipal: a non-string id is absent, never a raw TypeError", () => {
  // Request input is untrusted: a header or a decoded claim can carry a number,
  // an object or an array. Each must resolve to a typed failure, not a crash.
  const inputs: unknown[] = [
    { userId: 12345 },
    { userId: {} },
    { userId: [] },
    { sessionId: 42 },
    { userId: 12345, sessionId: 42 },
    { userId: true, sessionId: false },
    { userId: ["user-1"], sessionId: { id: "session-1" } },
  ]
  for (const input of inputs) {
    let thrown: unknown
    try {
      resolveQuotaPrincipal(input as { userId?: unknown; sessionId?: unknown })
    } catch (error) {
      thrown = error
    }
    assertInstanceOf(thrown, QuotaError)
    assertFalse(thrown instanceof TypeError)
    assertEquals(thrown.code, QuotaErrorCode.NoPrincipal)
  }
})

Deno.test("resolveQuotaPrincipal: a non-string user id does not shadow a usable session", () => {
  assertEquals(resolveQuotaPrincipal({ userId: 12345, sessionId: "s-1" }), {
    kind: QuotaPrincipalKind.Session,
    id: "s-1",
  })
  assertEquals(resolveQuotaPrincipal({ userId: {}, sessionId: " s-1 " }), {
    kind: QuotaPrincipalKind.Session,
    id: "s-1",
  })
})

Deno.test("resolveQuotaPrincipal: a valid string id still resolves through the unknown-typed input", () => {
  assertEquals(resolveQuotaPrincipal({ userId: "user-1", sessionId: "session-1" }), {
    kind: QuotaPrincipalKind.User,
    id: "user-1",
  })
  assertEquals(resolveQuotaPrincipal({ userId: null, sessionId: "session-1" }), {
    kind: QuotaPrincipalKind.Session,
    id: "session-1",
  })
})

// ── construction validation ────────────────────────────────────────────────

Deno.test("createQuotaMeter: rejects a limit that is not a non-negative safe integer", async () => {
  const store = inMemoryStore()
  for (const limit of [-1, 1.5, Number.NaN, Number.POSITIVE_INFINITY]) {
    assertEquals(
      await caughtCode(() =>
        createQuotaMeter({ policy: { limit }, store, meteredResourceAvailable: true })
      ),
      QuotaErrorCode.InvalidPolicyLimit,
    )
  }
})

Deno.test("createQuotaMeter: rejects windowSeconds 0 once it is set", async () => {
  const store = inMemoryStore()
  assertEquals(
    await caughtCode(() =>
      createQuotaMeter({
        policy: { limit: 1, windowSeconds: 0 },
        store,
        meteredResourceAvailable: true,
      })
    ),
    QuotaErrorCode.InvalidPolicyLimit,
  )
  assertEquals(
    await caughtCode(() =>
      createQuotaMeter({
        policy: { limit: 1, windowSeconds: -60 },
        store,
        meteredResourceAvailable: true,
      })
    ),
    QuotaErrorCode.InvalidPolicyLimit,
  )
})

Deno.test("createQuotaMeter: rejects a missing or half-wired store port", async () => {
  const policy: QuotaPolicy = { limit: 1 }
  const cases: unknown[] = [
    undefined,
    null,
    {},
    { read: () => Promise.resolve(0) },
    { increment: () => Promise.resolve(0) },
    // The two gates are as required as the two counters: a store that cannot
    // reserve cannot bound concurrent work, and one that cannot release turns
    // every failed call into spent budget.
    {
      read: () => Promise.resolve(0),
      increment: () => Promise.resolve(0),
      release: () => Promise.resolve(0),
    },
    {
      read: () => Promise.resolve(0),
      increment: () => Promise.resolve(0),
      reserve: () => Promise.resolve({ granted: true, used: 1 }),
    },
  ]
  for (const store of cases) {
    assertEquals(
      await caughtCode(() =>
        createQuotaMeter({ policy, store: store as QuotaStore, meteredResourceAvailable: true })
      ),
      QuotaErrorCode.InvalidPolicyLimit,
    )
  }
})

Deno.test("QuotaError: carries a typed code and a constant message", async () => {
  const thrown = assertThrows(
    () =>
      createQuotaMeter({
        policy: { limit: -1 },
        store: inMemoryStore(),
        meteredResourceAvailable: true,
      }),
    QuotaError,
  )
  assertInstanceOf(thrown, QuotaError)
  assertStrictEquals(thrown.name, "QuotaError")
  assertEquals(thrown.code, QuotaErrorCode.InvalidPolicyLimit)
  // The message is a constant that names the field — and never the offending
  // value, which matters more now that arktype (whose summary echoes
  // `must be non-negative (was -1)`) produces the underlying verdict.
  assertEquals(thrown.message, "QuotaPolicy.limit must be a non-negative safe integer")
  assertFalse(thrown.message.includes("-1"))
  assertFalse(thrown.message.includes("was "))
  assertEquals(await caughtCode(() => resolveQuotaPrincipal({})), QuotaErrorCode.NoPrincipal)
})

Deno.test("QuotaError: an arktype-shaped policy failure never echoes the value", async () => {
  const store = inMemoryStore()
  // Each case fails the arktype schema; none may leak its value into the error.
  const cases: Array<[QuotaPolicy, string]> = [
    [{ limit: -1 }, "QuotaPolicy.limit must be a non-negative safe integer"],
    [{ limit: 1.5 }, "QuotaPolicy.limit must be a non-negative safe integer"],
    [
      { limit: 1, windowSeconds: 0 },
      "QuotaPolicy.windowSeconds must be a positive safe integer when set",
    ],
    [
      { limit: 1, windowSeconds: -60 },
      "QuotaPolicy.windowSeconds must be a positive safe integer when set",
    ],
  ]
  for (const [policy, message] of cases) {
    const thrown = assertThrows(
      () => createQuotaMeter({ policy, store, meteredResourceAvailable: true }),
      QuotaError,
    )
    assertInstanceOf(thrown, QuotaError)
    assertEquals(thrown.code, QuotaErrorCode.InvalidPolicyLimit)
    assertEquals(thrown.message, message)
    assertFalse(thrown.message.includes("was "))
  }

  const countError = await rejectedError(() => makeMeter().meter.record(USER, 1.5))
  assertInstanceOf(countError, QuotaError)
  assertEquals(countError.code, QuotaErrorCode.InvalidCount)
  assertEquals(countError.message, "count must be an integer between 1 and 1000000")
  assertFalse(countError.message.includes("1.5"))
})

// ── get ────────────────────────────────────────────────────────────────────

Deno.test("get: never mutates usage, and reports the metered budget", async () => {
  const store = inMemoryStore()
  const spy = spyStore(store)
  const meter = createQuotaMeter({
    policy: { limit: 4 },
    store: spy.store,
    meteredResourceAvailable: true,
    now: () => 0,
  })
  await meter.record(USER, 2)
  const key = quotaKey(USER, { limit: 4 }, 0)
  assertEquals(await store.read(key), 2)

  const first = await meter.get(USER)
  const second = await meter.get(USER)
  assertEquals(first.used, 2)
  assertEquals(second.used, 2)
  assertEquals(first.remaining, 2)
  assertEquals(first.metered, true)
  assertEquals(spy.calls.read, 2)
  assertEquals(spy.calls.increment, 1)
  assertEquals(await store.read(key), 2)
})

Deno.test("get: does not read the store when no metered key is configured", async () => {
  const { meter, calls } = makeMeter({ meteredResourceAvailable: false })
  await meter.get(USER)
  assertEquals(calls.read, 0)
})

// ── reserve: the gate ──────────────────────────────────────────────────────

/** A session principal; only meterable under a policy that allows sessions. */
const SESSION = { kind: QuotaPrincipalKind.Session, id: "session-1" }

/** Resolves on a later macrotask, standing in for the paid work of a request. */
function paidWork(): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, 5))
}

Deno.test("reserve: ten parallel callers of a budget of three run the work three times", async () => {
  // The race only shows when something is awaited between the decision and the
  // work — which is every real request. With `check` in place of `reserve` all
  // ten callers read "allowed" before any of them spent anything.
  const store = inMemoryStore()
  const meter = createQuotaMeter({
    policy: { limit: 3 },
    store,
    meteredResourceAvailable: true,
    now: () => 0,
  })

  let workRan = 0
  let refused = 0
  await Promise.all(Array.from({ length: 10 }, async () => {
    const state = await meter.reserve(USER)
    if (state.decision !== QuotaDecision.Allowed) {
      refused += 1
      return
    }
    await paidWork()
    workRan += 1
  }))

  assertEquals(workRan, 3)
  assertEquals(refused, 7)
  assertEquals(await store.read(quotaKey(USER, { limit: 3 }, 0)), 3)
})

Deno.test("reserve: a refused call charges nothing and reports Exhausted", async () => {
  const store = inMemoryStore()
  const meter = createQuotaMeter({
    policy: { limit: 2 },
    store,
    meteredResourceAvailable: true,
    now: () => 0,
  })
  const key = quotaKey(USER, { limit: 2 }, 0)

  assertEquals((await meter.reserve(USER, 2)).decision, QuotaDecision.Allowed)
  const refused = await meter.reserve(USER)
  assertEquals(refused.decision, QuotaDecision.Exhausted)
  assertEquals(refused.used, 2)
  assertEquals(refused.remaining, 0)
  assertEquals(await store.read(key), 2)

  // A count that does not fit is refused whole: no partial spend.
  const store2 = inMemoryStore()
  const meter2 = createQuotaMeter({
    policy: { limit: 5 },
    store: store2,
    meteredResourceAvailable: true,
    now: () => 0,
  })
  assertEquals((await meter2.reserve(USER, 6)).decision, QuotaDecision.Exhausted)
  assertEquals(await store2.read(quotaKey(USER, { limit: 5 }, 0)), 0)
})

Deno.test("reserve: exactly the limit is Allowed, one more is not", async () => {
  const { meter } = makeMeter({ policy: { limit: 3 } })
  const filled = await meter.reserve(USER, 3)
  assertEquals(filled.decision, QuotaDecision.Allowed)
  assertEquals(filled.used, 3)
  assertEquals(filled.remaining, 0)
  assertEquals((await meter.reserve(USER)).decision, QuotaDecision.Exhausted)
})

Deno.test("reserve: a BYOK request is Allowed, unmetered, and never touches the store", async () => {
  const { meter, calls } = makeMeter({ policy: { limit: 1 } })
  const state = await meter.reserve(USER, 1, { hasOwnKey: true })
  assertEquals(state.decision, QuotaDecision.Allowed)
  assertFalse(state.metered)
  assertEquals(calls.reserve, 0)
  assertEquals(calls.read, 0)
})

Deno.test("reserve: an unconfigured metered resource is Unavailable and spends nothing", async () => {
  const { meter, calls } = makeMeter({ meteredResourceAvailable: false })
  const state = await meter.reserve(USER)
  assertEquals(state.decision, QuotaDecision.Unavailable)
  assertEquals(quotaStatusCode(state.decision), 503)
  assertEquals(calls.reserve, 0)
})

Deno.test("reserve: a count of 0, -1, 1.5 or NaN throws InvalidCount before the store", async () => {
  const { meter, calls } = makeMeter()
  for (const count of [0, -1, 1.5, Number.NaN]) {
    assertEquals(await caughtCode(() => meter.reserve(USER, count)), QuotaErrorCode.InvalidCount)
  }
  assertEquals(calls.reserve, 0)
})

// ── release: the refund ────────────────────────────────────────────────────

Deno.test("release: work that failed gives its units back", async () => {
  const store = inMemoryStore()
  const meter = createQuotaMeter({
    policy: { limit: 2 },
    store,
    meteredResourceAvailable: true,
    now: () => 0,
  })

  await meter.reserve(USER, 2)
  assertEquals((await meter.reserve(USER)).decision, QuotaDecision.Exhausted)

  const refunded = await meter.release(USER)
  assertEquals(refunded.used, 1)
  assertEquals(refunded.remaining, 1)
  assertEquals(refunded.decision, QuotaDecision.Allowed)
  // The freed unit is spendable again.
  assertEquals((await meter.reserve(USER)).decision, QuotaDecision.Allowed)
  assertEquals(await store.read(quotaKey(USER, { limit: 2 }, 0)), 2)
})

Deno.test("release: a refund never drives a counter below zero", async () => {
  const store = inMemoryStore()
  const meter = createQuotaMeter({
    policy: { limit: 2 },
    store,
    meteredResourceAvailable: true,
    now: () => 0,
  })
  await meter.reserve(USER)
  await meter.release(USER)
  const state = await meter.release(USER)
  assertEquals(state.used, 0)
  assertEquals(state.remaining, 2)
  assertEquals(await store.read(quotaKey(USER, { limit: 2 }, 0)), 0)
})

// ── the shared session pool ────────────────────────────────────────────────

Deno.test("sessions: a rotating session id stops at the shared pool limit", async () => {
  // A session id is whatever the caller sends. Twenty different ids, each with
  // its own untouched per-session counter, still spend one pool.
  const store = inMemoryStore()
  const meter = createQuotaMeter({
    policy: { limit: 5, sessions: { poolLimit: 3 } },
    store,
    meteredResourceAvailable: true,
    now: () => 0,
  })

  let allowed = 0
  for (let attempt = 0; attempt < 20; attempt++) {
    const state = await meter.reserve({
      kind: QuotaPrincipalKind.Session,
      id: `rotated-session-${attempt}`,
    })
    if (state.decision === QuotaDecision.Allowed) allowed += 1
  }

  assertEquals(allowed, 3)
  assertEquals(await store.read(sessionPoolKey({ limit: 5 }, 0)), 3)
})

Deno.test("sessions: a user principal never spends the session pool", async () => {
  const store = inMemoryStore()
  const meter = createQuotaMeter({
    policy: { limit: 5, sessions: { poolLimit: 1 } },
    store,
    meteredResourceAvailable: true,
    now: () => 0,
  })
  await meter.reserve(USER, 5)
  assertEquals(await store.read(sessionPoolKey({ limit: 5 }, 0)), 0)
  // The pool is untouched, so an anonymous caller still gets its one unit.
  assertEquals((await meter.reserve(SESSION)).decision, QuotaDecision.Allowed)
})

Deno.test("sessions: a session refused by its own counter gives the pool unit back", async () => {
  const store = inMemoryStore()
  const policy: QuotaPolicy = { limit: 1, sessions: { poolLimit: 10 } }
  const meter = createQuotaMeter({ policy, store, meteredResourceAvailable: true, now: () => 0 })

  assertEquals((await meter.reserve(SESSION)).decision, QuotaDecision.Allowed)
  // This one passes the pool and is then refused by the session's own limit of
  // 1; the pool must not keep the unit it briefly held.
  assertEquals((await meter.reserve(SESSION)).decision, QuotaDecision.Exhausted)
  assertEquals(await store.read(sessionPoolKey(policy, 0)), 1)
})

Deno.test("sessions: a spent pool makes check and get report Exhausted", async () => {
  const store = inMemoryStore()
  const policy: QuotaPolicy = { limit: 50, sessions: { poolLimit: 1 } }
  const meter = createQuotaMeter({ policy, store, meteredResourceAvailable: true, now: () => 0 })

  const fresh = { kind: QuotaPrincipalKind.Session, id: "unused-session" }
  assertEquals((await meter.check(fresh)).decision, QuotaDecision.Allowed)

  await meter.reserve(SESSION)
  // A different session, with an empty counter of its own, is still refused.
  assertEquals((await meter.check(fresh)).decision, QuotaDecision.Exhausted)
  assertEquals((await meter.get(fresh)).decision, QuotaDecision.Exhausted)
  assertEquals((await meter.get(fresh)).used, 0)
})

Deno.test("sessions: releasing a session gives back both the pool and its own unit", async () => {
  const store = inMemoryStore()
  const policy: QuotaPolicy = { limit: 2, sessions: { poolLimit: 1 } }
  const meter = createQuotaMeter({ policy, store, meteredResourceAvailable: true, now: () => 0 })

  await meter.reserve(SESSION)
  await meter.release(SESSION)
  assertEquals(await store.read(sessionPoolKey(policy, 0)), 0)
  assertEquals(await store.read(quotaKey(SESSION, policy, 0)), 0)
  assertEquals((await meter.reserve(SESSION)).decision, QuotaDecision.Allowed)
})

Deno.test("sessions: record spends the pool too, so late accounting cannot dodge it", async () => {
  const store = inMemoryStore()
  const policy: QuotaPolicy = { limit: 5, sessions: { poolLimit: 2 } }
  const meter = createQuotaMeter({ policy, store, meteredResourceAvailable: true, now: () => 0 })

  await meter.record(SESSION, 2)
  assertEquals(await store.read(sessionPoolKey(policy, 0)), 2)
  assertEquals(
    (await meter.reserve({ kind: QuotaPrincipalKind.Session, id: "other" })).decision,
    QuotaDecision.Exhausted,
  )
})

Deno.test("sessions: the pool key cannot collide with a principal's own counter", () => {
  const policy: QuotaPolicy = { limit: 1, sessions: { poolLimit: 1 } }
  assertEquals(sessionPoolKey(policy, 0), { principal: SESSION_POOL_PRINCIPAL, window: "all" })
  assertFalse(SESSION_POOL_PRINCIPAL.includes(":"))
  // Every principal key carries `<kind>:<id>`, which the pool principal cannot be.
  for (const principal of [USER, SESSION, { kind: QuotaPrincipalKind.Session, id: "" }]) {
    assertFalse(quotaKey(principal, policy, 0).principal === SESSION_POOL_PRINCIPAL)
  }
})

Deno.test("sessions: the pool follows the same window as the counters it bounds", () => {
  const windowed: QuotaPolicy = { limit: 1, windowSeconds: 60, sessions: { poolLimit: 1 } }
  assertEquals(sessionPoolKey(windowed, 0).window, quotaKey(SESSION, windowed, 0).window)
  assertEquals(sessionPoolKey(windowed, 59_999).window, "w0")
  assertEquals(sessionPoolKey(windowed, 60_000).window, "w1")
})

Deno.test("sessions: a policy with no sessions block refuses every session principal", async () => {
  const { meter, calls } = makeMeter({ policy: { limit: 5 } })
  const code = QuotaErrorCode.SessionPrincipalNotAllowed

  assertEquals(await caughtCode(() => meter.check(SESSION)), code)
  assertEquals(await caughtCode(() => meter.get(SESSION)), code)
  assertEquals(await caughtCode(() => meter.reserve(SESSION)), code)
  assertEquals(await caughtCode(() => meter.release(SESSION)), code)
  assertEquals(await caughtCode(() => meter.record(SESSION)), code)
  // Refused before anything is read, written or even validated as a count.
  assertEquals(calls.read + calls.increment + calls.reserve + calls.release, 0)
  assertEquals(await caughtCode(() => meter.reserve(SESSION, -1)), code)
  // The same meter still meters an authenticated user.
  assertEquals((await meter.check(USER)).decision, QuotaDecision.Allowed)
})

Deno.test("sessions: an undefined sessions block cannot pass for an allowed one", async () => {
  // A wiring mistake that reads a missing config value must not flip the
  // default: `{ sessions: undefined }` is "not allowed", like an absent key.
  const { meter } = makeMeter({ policy: { limit: 5, sessions: undefined } })
  assertEquals(
    await caughtCode(() => meter.reserve(SESSION)),
    QuotaErrorCode.SessionPrincipalNotAllowed,
  )
})

Deno.test("sessions: a poolLimit of 0 allows sessions and gives them nothing", async () => {
  const { meter } = makeMeter({ policy: { limit: 5, sessions: { poolLimit: 0 } } })
  const state = await meter.reserve(SESSION)
  assertEquals(state.decision, QuotaDecision.Exhausted)
  assertEquals(state.used, 0)
})

Deno.test("createQuotaMeter: rejects a sessions block whose poolLimit is not a counter", () => {
  const store = inMemoryStore()
  for (const poolLimit of [-1, 1.5, Number.NaN, Number.POSITIVE_INFINITY]) {
    const thrown = assertThrows(
      () =>
        createQuotaMeter({
          policy: { limit: 5, sessions: { poolLimit } },
          store,
          meteredResourceAvailable: true,
        }),
      QuotaError,
    )
    assertInstanceOf(thrown, QuotaError)
    assertEquals(thrown.code, QuotaErrorCode.InvalidPolicyLimit)
    assertEquals(
      thrown.message,
      "QuotaPolicy.sessions.poolLimit must be a non-negative safe integer",
    )
    assertFalse(thrown.message.includes("was "))
    assertFalse(thrown.message.includes("1.5"))
  }
})

// ── reserve and release on the failure paths ───────────────────────────────

/** Wraps a store and makes `reserve` reject for one principal, as a store outage would. */
function storeFailingReserveFor(store: QuotaStore, principal: string): QuotaStore {
  return {
    ...store,
    reserve: (key, count, limit) =>
      key.principal === principal
        ? Promise.reject(new Error("store unavailable"))
        : store.reserve(key, count, limit),
  }
}

Deno.test("reserve: a store that throws does not strand the session's pool unit", async () => {
  // The pool unit is taken before the metered one. When the second call throws, the caller sees a
  // failure and has nothing to release, so the meter has to give the pool unit back itself —
  // otherwise every store hiccup closes the anonymous tier a little further.
  const store = inMemoryStore()
  const policy: QuotaPolicy = { limit: 5, sessions: { poolLimit: 1 } }
  const meter = createQuotaMeter({
    policy,
    store: storeFailingReserveFor(store, "session:session-1"),
    meteredResourceAvailable: true,
    now: () => 0,
  })

  const thrown = await rejectedError(() => meter.reserve(SESSION))
  assertEquals(thrown.message, "store unavailable")
  assertEquals(await store.read(sessionPoolKey(policy, 0)), 0)
  // The pool is intact, so the next anonymous caller still gets its unit.
  const survivor = createQuotaMeter({ policy, store, meteredResourceAvailable: true, now: () => 0 })
  assertEquals((await survivor.reserve(SESSION)).decision, QuotaDecision.Allowed)
})

Deno.test("reserve: a failing refund does not replace the failure the caller must see", async () => {
  const store = inMemoryStore()
  const policy: QuotaPolicy = { limit: 5, sessions: { poolLimit: 1 } }
  const meter = createQuotaMeter({
    policy,
    store: {
      ...storeFailingReserveFor(store, "session:session-1"),
      release: () => Promise.reject(new Error("release also unavailable")),
    },
    meteredResourceAvailable: true,
    now: () => 0,
  })

  const thrown = await rejectedError(() => meter.reserve(SESSION))
  assertEquals(thrown.message, "store unavailable")
})

Deno.test("release: a request that brought its own key refunds nothing", async () => {
  // The documented pattern passes the same options to `reserve` and `release`. A bypassed reserve
  // spends nothing, so its release must spend nothing either — a refund here is free budget.
  const store = inMemoryStore()
  const meter = createQuotaMeter({
    policy: { limit: 3 },
    store,
    meteredResourceAvailable: true,
    now: () => 0,
  })
  const key = quotaKey(USER, { limit: 3 }, 0)

  await meter.reserve(USER, 2)
  const bypassed = await meter.reserve(USER, 1, { hasOwnKey: true })
  assertEquals(bypassed.metered, false)

  const state = await meter.release(USER, 1, { hasOwnKey: true })
  assertEquals(state.metered, false)
  assertEquals(await store.read(key), 2)
})

Deno.test("release: bypassWithOwnKey false keeps an own-key release metered", async () => {
  const store = inMemoryStore()
  const policy: QuotaPolicy = { limit: 3, bypassWithOwnKey: false }
  const meter = createQuotaMeter({ policy, store, meteredResourceAvailable: true, now: () => 0 })

  await meter.reserve(USER, 2, { hasOwnKey: true })
  const state = await meter.release(USER, 1, { hasOwnKey: true })
  assertEquals(state.used, 1)
  assertEquals(await store.read(quotaKey(USER, policy, 0)), 1)
})

Deno.test("reserve: one call reads the clock once, even across a window boundary", async () => {
  // A clock that moves between the two store calls of one reservation would take the pool unit in
  // one window and the metered unit in the next, and the refund could never reach the first.
  const store = inMemoryStore()
  const policy: QuotaPolicy = { limit: 5, windowSeconds: 60, sessions: { poolLimit: 5 } }
  let reads = 0
  const meter = createQuotaMeter({
    policy,
    store,
    meteredResourceAvailable: true,
    now: () => (reads++ === 0 ? 59_999 : 60_000),
  })

  await meter.reserve(SESSION)

  assertEquals(await store.read(sessionPoolKey(policy, 59_999)), 1)
  assertEquals(await store.read(quotaKey(SESSION, policy, 59_999)), 1)
  assertEquals(await store.read(sessionPoolKey(policy, 60_000)), 0)
  assertEquals(await store.read(quotaKey(SESSION, policy, 60_000)), 0)
  assertEquals(reads, 1)
})

Deno.test("release: a store that fails part-way leaves the pool short, never over-credited", async () => {
  // The private counter is refunded first on purpose. When the second call
  // fails, the pool keeps a unit nothing holds any more — it refuses a caller
  // it could have served, which is the safe direction. Refunding the pool first
  // would instead hand that unit to whoever asks next, and the caller cannot
  // repair it: retrying a release that threw refunds the half that succeeded a
  // second time.
  const store = inMemoryStore()
  const policy: QuotaPolicy = { limit: 5, sessions: { poolLimit: 1 } }
  const meter = createQuotaMeter({
    policy,
    store: {
      ...store,
      release: (key, count) =>
        key.principal === SESSION_POOL_PRINCIPAL
          ? Promise.reject(new Error("pool release unavailable"))
          : store.release(key, count),
    },
    meteredResourceAvailable: true,
    now: () => 0,
  })

  await meter.reserve(SESSION)
  const thrown = await rejectedError(() => meter.release(SESSION))

  assertEquals(thrown.message, "pool release unavailable")
  // The private counter came back before the failure; the pool did not.
  assertEquals(await store.read(quotaKey(SESSION, policy, 0)), 0)
  assertEquals(await store.read(sessionPoolKey(policy, 0)), 1)
})

Deno.test("release: reservedAt refunds the window the reservation was taken from, across a boundary", async () => {
  // Reserve while the clock reads 59_999 (window w0), release while it reads 60_000 (window w1),
  // passing the `reservedAt` the reservation carried. Both w0 counters — the session's own and the
  // shared pool — must read 0 afterwards: the refund followed the reservation, not the clock.
  const store = inMemoryStore()
  const policy: QuotaPolicy = { limit: 5, windowSeconds: 60, sessions: { poolLimit: 5 } }
  const meterAtReserve = createQuotaMeter({
    policy,
    store,
    meteredResourceAvailable: true,
    now: () => 59_999,
  })
  const meterAtRelease = createQuotaMeter({
    policy,
    store,
    meteredResourceAvailable: true,
    now: () => 60_000,
  })

  const reserved = await meterAtReserve.reserve(SESSION)
  assertEquals(reserved.reservedAt, 59_999)

  await meterAtRelease.release(SESSION, 1, { reservedAt: reserved.reservedAt })

  assertEquals(await store.read(quotaKey(SESSION, policy, 59_999)), 0)
  assertEquals(await store.read(sessionPoolKey(policy, 59_999)), 0)
  // w1 was never touched: nothing was reserved there, and nothing was refunded there either.
  assertEquals(await store.read(quotaKey(SESSION, policy, 60_000)), 0)
  assertEquals(await store.read(sessionPoolKey(policy, 60_000)), 0)
})

Deno.test("release: without reservedAt, a refund across a boundary still moves the unit to the new window", async () => {
  // Same reserve/release timing as above, but the release omits `reservedAt` — today's behaviour,
  // which the `reservedAt` argument is additive to. w0 keeps the unit until it rolls, and w1 is
  // refunded a unit it never gave out, clamped at 0 by the store's own floor.
  const store = inMemoryStore()
  const policy: QuotaPolicy = { limit: 5, windowSeconds: 60, sessions: { poolLimit: 5 } }
  const meterAtReserve = createQuotaMeter({
    policy,
    store,
    meteredResourceAvailable: true,
    now: () => 59_999,
  })
  const meterAtRelease = createQuotaMeter({
    policy,
    store,
    meteredResourceAvailable: true,
    now: () => 60_000,
  })

  await meterAtReserve.reserve(SESSION)
  await meterAtRelease.release(SESSION)

  assertEquals(await store.read(quotaKey(SESSION, policy, 59_999)), 1)
  assertEquals(await store.read(sessionPoolKey(policy, 59_999)), 1)
  assertEquals(await store.read(quotaKey(SESSION, policy, 60_000)), 0)
  assertEquals(await store.read(sessionPoolKey(policy, 60_000)), 0)
})
