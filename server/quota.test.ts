import {
  assertEquals,
  assertFalse,
  assertInstanceOf,
  assertRejects,
  assertStrictEquals,
  assertThrows,
} from "@std/assert"
import {
  createQuotaMeter,
  QuotaDecision,
  QuotaError,
  QuotaErrorCode,
  quotaHttpStatus,
  type QuotaKey,
  quotaKey,
  type QuotaMeter,
  type QuotaPolicy,
  QuotaPrincipalKind,
  type QuotaStore,
  resolveQuotaPrincipal,
} from "./quota.ts"

// ── Fixtures ───────────────────────────────────────────────────────────────

/** A `Map`-backed quota store — the smallest correct one-increment store. */
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
  calls: { read: number; increment: number }
} {
  const calls = { read: 0, increment: 0 }
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
    },
  }
}

const USER = { kind: QuotaPrincipalKind.User, id: "user-1" }

/** A meter with a frozen clock: `windowSeconds` omitted, so one lifetime window. */
function makeMeter(
  overrides: Partial<{ policy: QuotaPolicy; store: QuotaStore; meteredKeyAvailable: boolean }> = {},
): { meter: QuotaMeter; calls: { read: number; increment: number } } {
  const spy = spyStore(overrides.store ?? inMemoryStore())
  const created = createQuotaMeter({
    policy: overrides.policy ?? { limit: 3 },
    store: spy.store,
    meteredKeyAvailable: overrides.meteredKeyAvailable ?? true,
    now: () => 0,
  })
  return { meter: created, calls: spy.calls }
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
  const { meter, calls } = makeMeter({ meteredKeyAvailable: false })
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
    meteredKeyAvailable: false,
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
  const { meter, calls } = makeMeter({ meteredKeyAvailable: false })
  const state = await meter.get(USER)
  assertEquals(state.decision, QuotaDecision.Unavailable)
  assertEquals(calls.read, 0)
  assertEquals(quotaHttpStatus(state.decision), 503)
})

// ── HTTP contract ──────────────────────────────────────────────────────────

Deno.test("quotaHttpStatus: pins 200, 429 and 503 to the three decisions", () => {
  assertEquals(quotaHttpStatus(QuotaDecision.Allowed), 200)
  assertEquals(quotaHttpStatus(QuotaDecision.Exhausted), 429)
  assertEquals(quotaHttpStatus(QuotaDecision.Unavailable), 503)
})

Deno.test("quotaHttpStatus: a disabled budget is 429, distinct from the 503 service case", async () => {
  // The source could not tell these apart: it used `usage.limit === 0` as the
  // "no demo key" sentinel (`apps/api/routes/analyze.ts:115`,
  // `apps/api/routes/batch.ts:113`), which is also a legitimate disabled budget.
  // Here the two are different decisions with different statuses, so a
  // correctly configured `limit: 0` is not reported as a server misconfiguration.
  const disabled = makeMeter({ policy: { limit: 0 } })
  const spent = await disabled.meter.check(USER)
  assertEquals(spent.decision, QuotaDecision.Exhausted)
  assertEquals(spent.limit, 0)
  assertEquals(quotaHttpStatus(spent.decision), 429)

  const unconfigured = makeMeter({ meteredKeyAvailable: false })
  const unavailable = await unconfigured.meter.check(USER)
  assertEquals(unavailable.decision, QuotaDecision.Unavailable)
  assertEquals(quotaHttpStatus(unavailable.decision), 503)
})

Deno.test("state to HTTP status: a table over the three reachable states", async () => {
  const allowed = await makeMeter({ policy: { limit: 1 } }).meter.check(USER)
  const exhausted = makeMeter({ policy: { limit: 1 } })
  await exhausted.meter.record(USER, 1)
  const exhaustedState = await exhausted.meter.check(USER)
  const unavailable = await makeMeter({ meteredKeyAvailable: false }).meter.check(USER)

  const table: Array<[typeof allowed, number]> = [
    [allowed, 200],
    [exhaustedState, 429],
    [unavailable, 503],
  ]
  for (const [state, status] of table) {
    assertEquals(quotaHttpStatus(state.decision), status)
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
    meteredKeyAvailable: true,
    now: () => 0,
  })
  await at0.record(USER, 1)

  const at59999 = createQuotaMeter({
    policy,
    store: spy.store,
    meteredKeyAvailable: true,
    now: () => 59_999,
  })
  assertEquals((await at59999.check(USER)).decision, QuotaDecision.Exhausted)

  const at60000 = createQuotaMeter({
    policy,
    store: spy.store,
    meteredKeyAvailable: true,
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
    meteredKeyAvailable: true,
    now: () => 0,
  })
  const overshoot = await first.record(USER, 5)
  assertEquals(overshoot.used, 5)

  const second = createQuotaMeter({
    policy,
    store: spy.store,
    meteredKeyAvailable: true,
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
  const { meter } = makeMeter({ policy: { limit: 5 } })
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
    meteredKeyAvailable: true,
    now: () => 0,
  })
  await meter.record(USER, 2)
  const later = createQuotaMeter({
    policy: { limit: 2 },
    store: spy.store,
    meteredKeyAvailable: true,
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

// ── construction validation ────────────────────────────────────────────────

Deno.test("createQuotaMeter: rejects a limit that is not a non-negative safe integer", async () => {
  const store = inMemoryStore()
  for (const limit of [-1, 1.5, Number.NaN, Number.POSITIVE_INFINITY]) {
    assertEquals(
      await caughtCode(() =>
        createQuotaMeter({ policy: { limit }, store, meteredKeyAvailable: true })
      ),
      QuotaErrorCode.InvalidPolicyLimit,
    )
  }
})

Deno.test("createQuotaMeter: rejects windowSeconds 0 once it is set", async () => {
  const store = inMemoryStore()
  assertEquals(
    await caughtCode(() =>
      createQuotaMeter({ policy: { limit: 1, windowSeconds: 0 }, store, meteredKeyAvailable: true })
    ),
    QuotaErrorCode.InvalidPolicyLimit,
  )
  assertEquals(
    await caughtCode(() =>
      createQuotaMeter({
        policy: { limit: 1, windowSeconds: -60 },
        store,
        meteredKeyAvailable: true,
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
  ]
  for (const store of cases) {
    assertEquals(
      await caughtCode(() =>
        createQuotaMeter({ policy, store: store as QuotaStore, meteredKeyAvailable: true })
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
        meteredKeyAvailable: true,
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
      () => createQuotaMeter({ policy, store, meteredKeyAvailable: true }),
      QuotaError,
    )
    assertInstanceOf(thrown, QuotaError)
    assertEquals(thrown.code, QuotaErrorCode.InvalidPolicyLimit)
    assertEquals(thrown.message, message)
    assertFalse(thrown.message.includes("was "))
  }

  const countThrown = await assertRejects(
    () => makeMeter().meter.record(USER, 1.5),
    QuotaError,
  )
  assertInstanceOf(countThrown, QuotaError)
  assertEquals(countThrown.code, QuotaErrorCode.InvalidCount)
  assertEquals(countThrown.message, "count must be a positive safe integer")
  assertFalse(countThrown.message.includes("1.5"))
})

// ── get ────────────────────────────────────────────────────────────────────

Deno.test("get: never mutates usage, and reports the metered budget", async () => {
  const store = inMemoryStore()
  const spy = spyStore(store)
  const meter = createQuotaMeter({
    policy: { limit: 4 },
    store: spy.store,
    meteredKeyAvailable: true,
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
  const { meter, calls } = makeMeter({ meteredKeyAvailable: false })
  await meter.get(USER)
  assertEquals(calls.read, 0)
})
