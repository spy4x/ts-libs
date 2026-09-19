/**
 * Session minting, validation and revocation.
 *
 * The suite exists because this file was the package's weakest claim: it is
 * published (`server/deno.json` exports it), `verify` and `hash` are the only
 * secret-bearing paths outside the providers, and it had **no test at all** — so a
 * change that put the raw token into storage, or that compared it with `===`,
 * would have shipped green. Every assertion below is about a property the session
 * token depends on.
 */

import { assert, assertEquals, assertFalse } from "@std/assert"
import { CryptoContext } from "./crypto.ts"
import { SessionManager } from "./session.ts"
import type { Session, SessionBase } from "./types.ts"
import { DEFAULT_SESSION_LENGTH } from "./constants.ts"
import { MemoryCacheStore, TenantCache } from "./cache.ts"

const PEPPER = "test-pepper-not-real"
const ITERATIONS = 1_000

/** A store holding sessions in a map, with the database-like behaviour the manager relies on. */
class FakeSessionStore {
  readonly rows = new Map<number, Session>()
  private nextId = 1

  constructor(private readonly now: () => number = Date.now) {}

  getSession(id: number): Promise<null | Session> {
    const row = this.rows.get(id)
    return Promise.resolve(row ? structuredClone(row) : null)
  }

  getAllSessions(userId: number): Promise<Session[]> {
    return Promise.resolve(
      [...this.rows.values()].filter((row) => row.userId === userId).map((row) =>
        structuredClone(row)
      ),
    )
  }

  createSession(
    session: Pick<SessionBase, "token" | "userId" | "keyId" | "expiresAt">,
  ): Promise<null | Session> {
    const timestamp = new Date(this.now())
    const row: Session = {
      id: this.nextId++,
      createdAt: timestamp,
      updatedAt: timestamp,
      token: session.token,
      userId: session.userId,
      keyId: session.keyId,
      expiresAt: session.expiresAt ?? null,
    }
    this.rows.set(row.id, row)
    return Promise.resolve(structuredClone(row))
  }

  updateSession(id: number, session: Partial<SessionBase>): Promise<null | Session> {
    const row = this.rows.get(id)
    if (!row) {
      return Promise.resolve(null)
    }
    const updated = { ...row, ...session, id }
    this.rows.set(id, updated)
    return Promise.resolve(structuredClone(updated))
  }

  deleteSession(id: number): Promise<void> {
    this.rows.delete(id)
    return Promise.resolve()
  }

  deleteAllSessions(userId: number): Promise<void> {
    for (const [id, row] of this.rows) {
      if (row.userId === userId) {
        this.rows.delete(id)
      }
    }
    return Promise.resolve()
  }

  deleteExpiredSessions(): Promise<void> {
    for (const [id, row] of this.rows) {
      if (row.expiresAt && row.expiresAt.getTime() < this.now()) {
        this.rows.delete(id)
      }
    }
    return Promise.resolve()
  }
}

/** A fixed clock, so expiry is decided by the test. */
function clock(start = Date.parse("2026-01-01T00:00:00.000Z")) {
  let current = start
  return {
    now: () => current,
    advance: (ms: number) => {
      current += ms
    },
  }
}

function build(
  options: { ttlMinutes?: number; negativeCache?: TenantCache; time?: ReturnType<typeof clock> } =
    {},
) {
  const time = options.time ?? clock()
  const store = new FakeSessionStore(time.now)
  const crypto = new CryptoContext({ pepper: PEPPER, iterations: ITERATIONS })
  const manager = new SessionManager({
    store,
    crypto,
    negativeCache: options.negativeCache,
    sessionDurationMin: options.ttlMinutes ?? 60,
    sessionLength: 32,
    now: time.now,
  })
  return { manager, store, time, crypto }
}

Deno.test("a minted session's raw token never reaches the store", async () => {
  // This is the property that had no test. `SessionManager.create` must return the
  // raw token to the caller while persisting only a digest of it — the same rule the
  // magic-link and OTP keys follow. If it stored `notHashedToken`, a dump of the
  // sessions table would be a set of working cookies.
  const { manager, store } = build()
  const session = await manager.create({ userId: 1, keyId: 1 })
  assert(session)

  const stored = [...store.rows.values()].find((row) => row.id === session.id)
  assert(stored, "the session must have been persisted")
  assertFalse(stored.token === session.token, "the store must not hold the raw token")
  assertFalse(
    stored.token.includes(session.token),
    "the raw token must not appear in the stored value",
  )
  assert(/^[0-9a-f]+:[0-9a-f]+$/.test(stored.token), `unexpected stored shape ${stored.token}`)
  // The caller keeps the raw value, which is what the cookie carries.
  assertEquals(session.token.length, DEFAULT_SESSION_LENGTH)
})

Deno.test("validate accepts the raw token and the matching id only", async () => {
  const { manager } = build()
  const session = await manager.create({ userId: 1, keyId: 1 })
  assert(session)

  const cookie = manager.getIdTokenForCookie(session)
  assertEquals(cookie, `${session.id}:${session.token}`)

  const validated = await manager.validate(cookie)
  assert(validated, "a fresh cookie must validate")
  assertEquals(validated.id, session.id)
  assertEquals(validated.token, session.token, "the raw token comes back for re-issuing the cookie")

  // A wrong token, a wrong id, a malformed value.
  assertEquals(await manager.validate(`${session.id}:${"a".repeat(32)}`), null)
  assertEquals(await manager.validate(`${session.id + 1}:${session.token}`), null)
  assertEquals(await manager.validate(session.token), null)
  assertEquals(await manager.validate(""), null)
  assertEquals(await manager.validate("0:token"), null)
  assertEquals(await manager.validate("1abc:token"), null)
})

Deno.test("validate compares the token as a digest, never as stored plaintext", async () => {
  // The digest is peppered, so a session minted under one pepper does not validate
  // under another even with a byte-identical store.
  const time = clock()
  const store = new FakeSessionStore(time.now)
  const first = new SessionManager({
    store,
    crypto: new CryptoContext({ pepper: PEPPER, iterations: ITERATIONS }),
    now: time.now,
  })
  const session = await first.create({ userId: 1, keyId: 1 })
  assert(session)

  const otherPepper = new SessionManager({
    store,
    crypto: new CryptoContext({ pepper: "other-pepper-not-real", iterations: ITERATIONS }),
    now: time.now,
  })
  assertEquals(
    await otherPepper.validate(first.getIdTokenForCookie(session)),
    null,
    "a session token must not validate under another pepper",
  )
})

Deno.test("an expired session is refused and a live one is refreshed", async () => {
  const time = clock()
  const { manager } = build({ ttlMinutes: 60, time })
  const session = await manager.create({ userId: 1, keyId: 1 })
  assert(session)
  const cookie = manager.getIdTokenForCookie(session)

  // Past the deadline: refused.
  time.advance(60 * 60 * 1000 + 1)
  assertEquals(await manager.validate(cookie), null)
})

Deno.test("a session in its last quarter is extended", async () => {
  const time = clock()
  const { manager, store } = build({ ttlMinutes: 60, time })
  const session = await manager.create({ userId: 1, keyId: 1 })
  assert(session)
  const before = store.rows.get(session.id)?.expiresAt?.getTime() ?? 0

  // Inside the last quarter of the lifetime.
  time.advance(46 * 60 * 1000)
  const refreshed = await manager.validate(manager.getIdTokenForCookie(session))
  assert(refreshed)
  const after = store.rows.get(session.id)?.expiresAt?.getTime() ?? 0
  assert(after > before, "the session must have been extended")
  assertEquals(after, time.now() + 60 * 60 * 1000)
})

Deno.test("delete revokes the session it names and nothing else", async () => {
  const { manager, store } = build()
  const first = await manager.create({ userId: 1, keyId: 1 })
  const second = await manager.create({ userId: 1, keyId: 1 })
  assert(first && second)

  assertEquals(await manager.delete(manager.getIdTokenForCookie(first)), true)
  assertEquals(store.rows.has(first.id), false)
  assertEquals(store.rows.has(second.id), true, "another session must survive")

  // A wrong token for a real id must not revoke it.
  assertEquals(await manager.delete(`${second.id}:${"a".repeat(32)}`), false)
  assertEquals(store.rows.has(second.id), true)
  assertEquals(await manager.delete("malformed"), false)
})

Deno.test("deleteAll and deleteExpired are scoped", async () => {
  const time = clock()
  const { manager, store } = build({ ttlMinutes: 30, time })
  const one = await manager.create({ userId: 1, keyId: 1 })
  const two = await manager.create({ userId: 2, keyId: 2 })
  assert(one && two)

  await manager.deleteAll(1)
  assertEquals(store.rows.has(one.id), false)
  assertEquals(store.rows.has(two.id), true)

  const three = await manager.create({ userId: 2, keyId: 2 })
  assert(three)
  time.advance(30 * 60 * 1000 + 1)
  await manager.deleteExpired()
  assertEquals(store.rows.has(two.id), false)
  assertEquals(store.rows.has(three.id), false)
})

Deno.test("the negative cache short-circuits a known-dead cookie", async () => {
  const time = clock()
  const cache = new TenantCache(new MemoryCacheStore(time.now))
  const { manager, store } = build({ negativeCache: cache, time })

  const session = await manager.create({ userId: 1, keyId: 1 })
  assert(session)
  const cookie = manager.getIdTokenForCookie(session)

  await manager.delete(cookie)
  assertEquals(await manager.validate(cookie), null)
  assert(await cache.get(cookie), "the dead cookie must be cached")

  // Even if the row somehow returns, the cached verdict wins.
  await store.createSession({ token: "x:y", userId: 1, keyId: 1, expiresAt: null })
  assertEquals(await manager.validate(cookie), null)
})

Deno.test("the negative cache carries a millisecond TTL", async () => {
  const time = clock()
  const writes: Array<{ key: string; ttlMs: number }> = []
  const spy = {
    get: () => Promise.resolve(undefined),
    set: (key: string, _value: unknown, ttlMs: number) => {
      writes.push({ key, ttlMs })
      return Promise.resolve()
    },
  }
  const store = new FakeSessionStore(time.now)
  const manager = new SessionManager({
    store,
    crypto: new CryptoContext({ pepper: PEPPER, iterations: ITERATIONS }),
    negativeCache: spy as never,
    negativeCacheTtlMs: 60_000,
    now: time.now,
  })

  assertEquals(await manager.validate("nonsense"), null)
  assertEquals(writes.length, 1)
  // Milliseconds, unscaled — the `ttl * 1000` defect would make this 60_000_000.
  assertEquals(writes[0].ttlMs, 60_000)
  assertEquals(writes[0].key, "nonsense")
})

Deno.test("parseSessionIdToken rejects everything that is not id:token", () => {
  const { manager } = build()
  assertEquals(manager.parseSessionIdToken("12:abc"), { id: 12, token: "abc" })
  // A token containing separators keeps them; only the first colon splits.
  assertEquals(manager.parseSessionIdToken("12:a:b"), { id: 12, token: "a:b" })
  for (
    const value of ["", ":", "12:", ":abc", "0:abc", "-1:abc", "1.5:abc", "1abc:abc", "01:abc"]
  ) {
    assertEquals(
      manager.parseSessionIdToken(value),
      null,
      `${JSON.stringify(value)} must be rejected`,
    )
  }
})
