// The `SessionStore` contract, written once and run against both stores: `session-store.test.ts`
// runs it against the fake from `fake-store.test.ts` in the unit tier,
// `postgres-session-store.integration.test.ts` against `createPostgresSessionStore` on a real
// Postgres. It is how the fake, which about ten unit-test files rely on, is shown to behave like the
// real store on every rule `SessionStore` documents.
//
// Not a test file in itself: it is named `*.test.ts` only so the root `publish.exclude` pattern keeps
// it out of the published package, and it registers no tests until a caller runs
// `describeSessionStoreContract`.

import { expect } from "@std/expect"
import { describe, it } from "@std/testing/bdd"
import { STORE_METHODS } from "./fake-store.test.ts"
import {
  SecondFactorStatus,
  type SessionRecord,
  SessionStatus,
  type SessionStore,
} from "./session.ts"

/** A user the store accepts sessions for, and the app's own columns a new session of it needs. */
export interface SessionUser<S extends SessionRecord> {
  userId: number
  columns: Omit<S, keyof SessionRecord>
}

/** A fresh, empty store, how to add a user to it, and how to dispose of it. */
export interface SessionStoreFixture<S extends SessionRecord> {
  store: SessionStore<S>
  addUser(): Promise<SessionUser<S>>
  close(): Promise<void>
}

/** 2001-01-01T00:00:00Z: far from the host clock, so a store reading the host clock is caught. */
const NOW = new Date(Date.UTC(2001, 0, 1))
const MINUTE = 60_000
const HASH = "ab".repeat(32)

interface Overrides {
  status?: SessionStatus
  secondFactor?: SecondFactorStatus
  expiresAt?: Date
}

/**
 * Registers the contract suite for one store.
 *
 * @param label Names the store in every test name.
 * @param open Returns a fresh, empty store for each test.
 */
export function describeSessionStoreContract<S extends SessionRecord>(
  label: string,
  open: () => Promise<SessionStoreFixture<S>>,
): void {
  async function withStore(
    body: (fixture: SessionStoreFixture<S>, create: Create<S>) => Promise<void>,
  ): Promise<void> {
    const fixture = await open()
    try {
      const create: Create<S> = (user, overrides = {}) =>
        fixture.store.create(
          {
            ...user.columns,
            userId: user.userId,
            tokenHash: HASH,
            status: overrides.status ?? SessionStatus.Active,
            secondFactor: overrides.secondFactor ?? SecondFactorStatus.NotRequired,
            expiresAt: overrides.expiresAt ?? new Date(NOW.getTime() + 60 * MINUTE),
          } as Omit<S, "id">,
        )
      await body(fixture, create)
    } finally {
      await fixture.close()
    }
  }

  /** The stored row, failing the test when there is none. */
  async function stored(store: SessionStore<S>, id: number): Promise<S> {
    const row = await store.findById(id)
    if (row === null) throw new Error(`session ${id} is not stored`)
    return row
  }

  describe(`${label}: shape`, () => {
    it("has exactly the SessionStore methods, clearPendingSecondFactors included", () =>
      withStore(({ store }) => {
        expect(Object.keys(store).sort()).toEqual(STORE_METHODS)
        return Promise.resolve()
      }))
  })

  describe(`${label}: create and findById`, () => {
    it("assigns distinct positive integer ids and returns every field it was given", () =>
      withStore(async ({ addUser }, create) => {
        const user = await addUser()
        const expiresAt = new Date(NOW.getTime() + 5 * MINUTE + 123)
        const first = await create(user, {
          status: SessionStatus.Active,
          secondFactor: SecondFactorStatus.Pending,
          expiresAt,
        })
        const second = await create(user)
        expect(Number.isInteger(first.id) && first.id > 0).toBe(true)
        expect(second.id).not.toBe(first.id)
        expect(first).toEqual({
          ...user.columns,
          id: first.id,
          userId: user.userId,
          tokenHash: HASH,
          status: SessionStatus.Active,
          secondFactor: SecondFactorStatus.Pending,
          expiresAt,
        })
      }))

    it("finds a created session exactly as create returned it", () =>
      withStore(async ({ store, addUser }, create) => {
        const session = await create(await addUser(), { status: SessionStatus.SignedOut })
        expect(await store.findById(session.id)).toEqual(session)
      }))

    it("finds nothing for an id no session has", () =>
      withStore(async ({ store, addUser }, create) => {
        const session = await create(await addUser())
        expect(await store.findById(session.id + 1000)).toBeNull()
      }))

    it("hands out a copy, so changing a returned session leaves the stored one as it was", () =>
      withStore(async ({ store, addUser }, create) => {
        const session = await create(await addUser())
        session.status = SessionStatus.SignedOut
        session.expiresAt.setTime(0)
        const found = await stored(store, session.id)
        found.status = SessionStatus.Expired
        const again = await stored(store, session.id)
        expect(again.status).toBe(SessionStatus.Active)
        expect(again.expiresAt.getTime()).toBe(NOW.getTime() + 60 * MINUTE)
      }))
  })

  describe(`${label}: extend`, () => {
    it("moves expiresAt of an active session and leaves its status", () =>
      withStore(async ({ store, addUser }, create) => {
        const session = await create(await addUser())
        const later = new Date(NOW.getTime() + 120 * MINUTE)
        expect(await store.extend(session.id, later)).toBe(true)
        const row = await stored(store, session.id)
        expect(row.expiresAt.getTime()).toBe(later.getTime())
        expect(row.status).toBe(SessionStatus.Active)
      }))

    it("refuses a signed-out, an expired and an unknown session, changing nothing", () =>
      withStore(async ({ store, addUser }, create) => {
        const user = await addUser()
        const signedOut = await create(user, { status: SessionStatus.SignedOut })
        const expired = await create(user, { status: SessionStatus.Expired })
        const later = new Date(NOW.getTime() + 120 * MINUTE)
        expect(await store.extend(signedOut.id, later)).toBe(false)
        expect(await store.extend(expired.id, later)).toBe(false)
        expect(await store.extend(expired.id + 1000, later)).toBe(false)
        expect(await store.findById(signedOut.id)).toEqual(signedOut)
        expect(await store.findById(expired.id)).toEqual(expired)
      }))
  })

  describe(`${label}: completeSecondFactor`, () => {
    it("completes the second factor of an active session", () =>
      withStore(async ({ store, addUser }, create) => {
        const session = await create(await addUser(), { secondFactor: SecondFactorStatus.Pending })
        expect(await store.completeSecondFactor(session.id)).toBe(true)
        expect((await stored(store, session.id)).secondFactor).toBe(SecondFactorStatus.Completed)
      }))

    it("refuses a signed-out and an unknown session, changing nothing", () =>
      withStore(async ({ store, addUser }, create) => {
        const session = await create(await addUser(), {
          status: SessionStatus.SignedOut,
          secondFactor: SecondFactorStatus.Pending,
        })
        expect(await store.completeSecondFactor(session.id)).toBe(false)
        expect(await store.completeSecondFactor(session.id + 1000)).toBe(false)
        expect(await store.findById(session.id)).toEqual(session)
      }))
  })

  describe(`${label}: clearPendingSecondFactors`, () => {
    it("clears only the user's active pending sessions", () =>
      withStore(async ({ store, addUser }, create) => {
        const ann = await addUser()
        const bob = await addUser()
        const pending = await create(ann, { secondFactor: SecondFactorStatus.Pending })
        const completed = await create(ann, { secondFactor: SecondFactorStatus.Completed })
        const signedOut = await create(ann, {
          status: SessionStatus.SignedOut,
          secondFactor: SecondFactorStatus.Pending,
        })
        const bobs = await create(bob, { secondFactor: SecondFactorStatus.Pending })

        await store.clearPendingSecondFactors!(ann.userId)

        expect((await stored(store, pending.id)).secondFactor).toBe(
          SecondFactorStatus.NotRequired,
        )
        expect(await store.findById(completed.id)).toEqual(completed)
        expect(await store.findById(signedOut.id)).toEqual(signedOut)
        expect(await store.findById(bobs.id)).toEqual(bobs)
      }))
  })

  describe(`${label}: signOut and signOutUser`, () => {
    it("signs out an active session and leaves an expired one expired", () =>
      withStore(async ({ store, addUser }, create) => {
        const user = await addUser()
        const active = await create(user)
        const expired = await create(user, { status: SessionStatus.Expired })
        await store.signOut(active.id)
        await store.signOut(expired.id)
        await store.signOut(expired.id + 1000)
        expect((await stored(store, active.id)).status).toBe(SessionStatus.SignedOut)
        expect(await store.findById(expired.id)).toEqual(expired)
      }))

    it("signs out every active session of the user except the one kept", () =>
      withStore(async ({ store, addUser }, create) => {
        const ann = await addUser()
        const bob = await addUser()
        const kept = await create(ann)
        const other = await create(ann)
        const expired = await create(ann, { status: SessionStatus.Expired })
        const bobs = await create(bob)

        await store.signOutUser(ann.userId, kept.id)

        expect(await store.findById(kept.id)).toEqual(kept)
        expect((await stored(store, other.id)).status).toBe(SessionStatus.SignedOut)
        expect(await store.findById(expired.id)).toEqual(expired)
        expect(await store.findById(bobs.id)).toEqual(bobs)
      }))

    it("signs out every active session of the user when none is kept", () =>
      withStore(async ({ store, addUser }, create) => {
        const ann = await addUser()
        const first = await create(ann)
        const second = await create(ann)
        await store.signOutUser(ann.userId, null)
        expect((await stored(store, first.id)).status).toBe(SessionStatus.SignedOut)
        expect((await stored(store, second.id)).status).toBe(SessionStatus.SignedOut)
      }))
  })

  describe(`${label}: expire`, () => {
    it("expires an active session at or before now and nothing else", () =>
      withStore(async ({ store, addUser }, create) => {
        const user = await addUser()
        const atNow = await create(user, { expiresAt: NOW })
        const before = await create(user, { expiresAt: new Date(NOW.getTime() - MINUTE) })
        const after = await create(user, { expiresAt: new Date(NOW.getTime() + 1) })
        const signedOut = await create(user, {
          status: SessionStatus.SignedOut,
          expiresAt: new Date(NOW.getTime() - MINUTE),
        })

        await store.expire(NOW)

        expect((await stored(store, atNow.id)).status).toBe(SessionStatus.Expired)
        expect((await stored(store, before.id)).status).toBe(SessionStatus.Expired)
        expect(await store.findById(after.id)).toEqual(after)
        expect(await store.findById(signedOut.id)).toEqual(signedOut)
      }))
  })
}

/** Creates a session of `user`: active, no second factor, an hour from NOW, unless overridden. */
interface Create<S extends SessionRecord> {
  (user: SessionUser<S>, overrides?: Overrides): Promise<S>
}
