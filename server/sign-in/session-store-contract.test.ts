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
  type NewSessionDevice,
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
  /** Creates the session with this device and time; without it `create` gets one argument. */
  device?: NewSessionDevice
}

/** A device whose session was created, and so last used, `minutes` after NOW. */
function deviceAt(minutes: number, deviceName = "Firefox on Linux"): NewSessionDevice {
  return { deviceName, ipHint: "203.0.113.*", at: new Date(NOW.getTime() + minutes * MINUTE) }
}

/** A time `minutes` after NOW. */
function after(minutes: number): Date {
  return new Date(NOW.getTime() + minutes * MINUTE)
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
      const create: Create<S> = (user, overrides = {}) => {
        const session = {
          ...user.columns,
          userId: user.userId,
          tokenHash: HASH,
          status: overrides.status ?? SessionStatus.Active,
          secondFactor: overrides.secondFactor ?? SecondFactorStatus.NotRequired,
          expiresAt: overrides.expiresAt ?? new Date(NOW.getTime() + 60 * MINUTE),
        } as Omit<S, "id">
        // One argument unless the test names a device, as the manager calls it.
        return overrides.device
          ? fixture.store.create(session, overrides.device)
          : fixture.store.create(session)
      }
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
    it("has exactly the SessionStore methods, the optional ones included", () =>
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

  describe(`${label}: create with a device, and listForUser`, () => {
    it("lists a session with the device and the time it was created with", () =>
      withStore(async ({ store, addUser }, create) => {
        const user = await addUser()
        const session = await create(user, { device: deviceAt(3, "Safari on iPhone") })
        expect(await store.listForUser!(user.userId, after(4))).toEqual([{
          id: session.id,
          deviceName: "Safari on iPhone",
          ipHint: "203.0.113.*",
          createdAt: after(3),
          lastUsedAt: after(3),
        }])
      }))

    it("returns the same record from create with a device as without one", () =>
      withStore(async ({ store, addUser }, create) => {
        const user = await addUser()
        const session = await create(user, { device: deviceAt(0) })
        expect(Object.keys(session).sort()).toEqual(Object.keys(await create(user)).sort())
        expect(await store.findById(session.id)).toEqual(session)
      }))

    it("stores a device with no address, and a name with control characters removed", () =>
      withStore(async ({ store, addUser }, create) => {
        const user = await addUser()
        await create(user, {
          device: { deviceName: "Fire\u0000fox\n on Linux", ipHint: null, at: NOW },
        })
        const [entry] = await store.listForUser!(user.userId, NOW)
        expect(entry.deviceName).toBe("Firefox on Linux")
        expect(entry.ipHint).toBeNull()
      }))

    it("lists a session created without a device with an empty name and no address", () =>
      withStore(async ({ store, addUser }, create) => {
        const user = await addUser()
        const session = await create(user)
        const entries = await store.listForUser!(user.userId, NOW)
        expect(entries.map(({ id, deviceName, ipHint }) => ({ id, deviceName, ipHint }))).toEqual([
          { id: session.id, deviceName: "", ipHint: null },
        ])
        expect(entries[0].createdAt).toBeInstanceOf(Date)
        expect(entries[0].lastUsedAt.getTime()).toBe(entries[0].createdAt.getTime())
      }))

    it("lists only live sessions: active, and not at or past expiresAt", () =>
      withStore(async ({ store, addUser }, create) => {
        const user = await addUser()
        const live = await create(user, { device: deviceAt(0), expiresAt: after(10) })
        await create(user, { device: deviceAt(0), status: SessionStatus.SignedOut })
        await create(user, { device: deviceAt(0), status: SessionStatus.Expired })
        // Still marked active: the periodic `expire` has not run yet.
        await create(user, { device: deviceAt(0), expiresAt: after(5) })
        const listed = await store.listForUser!(user.userId, after(5))
        expect(listed.map((entry) => entry.id)).toEqual([live.id])
      }))

    it("lists the last used session first, and the newer of two used at the same time first", () =>
      withStore(async ({ store, addUser }, create) => {
        const user = await addUser()
        const oldest = await create(user, { device: deviceAt(1) })
        const newest = await create(user, { device: deviceAt(3) })
        const middle = await create(user, { device: deviceAt(2) })
        const twin = await create(user, { device: deviceAt(2) })
        const listed = await store.listForUser!(user.userId, after(4))
        expect(listed.map((entry) => entry.id)).toEqual([newest.id, twin.id, middle.id, oldest.id])
      }))

    it("lists none of another user's sessions", () =>
      withStore(async ({ store, addUser }, create) => {
        const ann = await addUser()
        const bob = await addUser()
        const anns = await create(ann, { device: deviceAt(0) })
        await create(bob, { device: deviceAt(0) })
        const listed = await store.listForUser!(ann.userId, after(1))
        expect(listed.map((entry) => entry.id)).toEqual([anns.id])
        expect(await store.listForUser!(ann.userId + bob.userId + 1000, after(1))).toEqual([])
      }))
  })

  describe(`${label}: deleteForUser`, () => {
    it("deletes the user's own session, whatever its status, and says so", () =>
      withStore(async ({ store, addUser }, create) => {
        const user = await addUser()
        const active = await create(user)
        const signedOut = await create(user, { status: SessionStatus.SignedOut })
        const kept = await create(user)
        expect(await store.deleteForUser!(user.userId, active.id)).toBe(true)
        expect(await store.deleteForUser!(user.userId, signedOut.id)).toBe(true)
        expect(await store.findById(active.id)).toBeNull()
        expect(await store.findById(signedOut.id)).toBeNull()
        expect(await store.findById(kept.id)).toEqual(kept)
      }))

    it("leaves another user's session untouched and answers false, as for a missing one", () =>
      withStore(async ({ store, addUser }, create) => {
        const ann = await addUser()
        const bob = await addUser()
        const bobs = await create(bob, { device: deviceAt(0) })
        expect(await store.deleteForUser!(ann.userId, bobs.id)).toBe(false)
        expect(await store.deleteForUser!(ann.userId, bobs.id + 1000)).toBe(false)
        expect(await store.findById(bobs.id)).toEqual(bobs)
        expect((await store.listForUser!(bob.userId, after(1))).map((e) => e.id)).toEqual([bobs.id])
      }))
  })

  describe(`${label}: deleteOthers`, () => {
    it("deletes every other live session of the user, keeps the named one, and counts", () =>
      withStore(async ({ store, addUser }, create) => {
        const user = await addUser()
        const kept = await create(user)
        const first = await create(user)
        const second = await create(user)
        expect(await store.deleteOthers!(user.userId, kept.id, NOW)).toBe(2)
        expect(await store.findById(kept.id)).toEqual(kept)
        expect(await store.findById(first.id)).toBeNull()
        expect(await store.findById(second.id)).toBeNull()
      }))

    it("leaves the user's signed-out and expired sessions in place and does not count them", () =>
      withStore(async ({ store, addUser }, create) => {
        const user = await addUser()
        const kept = await create(user)
        const signedOut = await create(user, { status: SessionStatus.SignedOut })
        const expired = await create(user, { status: SessionStatus.Expired })
        const pastExpiry = await create(user, { expiresAt: after(5) })
        expect(await store.deleteOthers!(user.userId, kept.id, after(5))).toBe(0)
        expect(await store.findById(signedOut.id)).toEqual(signedOut)
        expect(await store.findById(expired.id)).toEqual(expired)
        expect(await store.findById(pastExpiry.id)).toEqual(pastExpiry)
      }))

    it("leaves another user's sessions untouched", () =>
      withStore(async ({ store, addUser }, create) => {
        const ann = await addUser()
        const bob = await addUser()
        const kept = await create(ann)
        await create(ann)
        const bobs = await create(bob)
        expect(await store.deleteOthers!(ann.userId, kept.id, NOW)).toBe(1)
        expect(await store.findById(bobs.id)).toEqual(bobs)
      }))

    it("deletes nothing when the session to keep is another user's, or no session", () =>
      withStore(async ({ store, addUser }, create) => {
        const ann = await addUser()
        const bob = await addUser()
        const anns = await create(ann)
        const bobs = await create(bob)
        expect(await store.deleteOthers!(ann.userId, bobs.id, NOW)).toBe(0)
        expect(await store.deleteOthers!(ann.userId, anns.id + bobs.id + 1000, NOW)).toBe(0)
        expect(await store.findById(anns.id)).toEqual(anns)
        expect(await store.findById(bobs.id)).toEqual(bobs)
      }))

    it("deletes nothing when the session to keep is signed out, or at its expiry", () =>
      withStore(async ({ store, addUser }, create) => {
        const user = await addUser()
        const live = await create(user)
        const signedOut = await create(user, { status: SessionStatus.SignedOut })
        const ending = await create(user, { expiresAt: after(5) })
        expect(await store.deleteOthers!(user.userId, signedOut.id, NOW)).toBe(0)
        expect(await store.deleteOthers!(user.userId, ending.id, after(5))).toBe(0)
        expect(await store.findById(live.id)).toEqual(live)
        // One millisecond earlier the kept session is live, and the other one goes.
        const early = new Date(after(5).getTime() - 1)
        expect(await store.deleteOthers!(user.userId, ending.id, early)).toBe(1)
        expect(await store.findById(live.id)).toBeNull()
      }))

    it("deletes nothing when the session to keep is not an id", () =>
      withStore(async ({ store, addUser }, create) => {
        const user = await addUser()
        const session = await create(user)
        for (const keep of [0, -1, 1.5, Number.NaN]) {
          expect(await store.deleteOthers!(user.userId, keep, NOW)).toBe(0)
        }
        expect(await store.findById(session.id)).toEqual(session)
      }))
  })

  describe(`${label}: touch`, () => {
    /** The last-used time of the user's only listed session. */
    async function lastUsed(store: SessionStore<S>, userId: number, now: Date): Promise<number> {
      const [entry] = await store.listForUser!(userId, now)
      return entry.lastUsedAt.getTime()
    }

    it("records the time once the interval has passed", () =>
      withStore(async ({ store, addUser }, create) => {
        const user = await addUser()
        const session = await create(user, { device: deviceAt(0) })
        expect(await store.touch!(user.userId, session.id, after(5), 5 * MINUTE)).toBe(true)
        expect(await lastUsed(store, user.userId, after(5))).toBe(after(5).getTime())
      }))

    it("writes nothing inside the interval", () =>
      withStore(async ({ store, addUser }, create) => {
        const user = await addUser()
        const session = await create(user, { device: deviceAt(0) })
        const early = new Date(after(5).getTime() - 1)
        expect(await store.touch!(user.userId, session.id, early, 5 * MINUTE)).toBe(false)
        expect(await lastUsed(store, user.userId, early)).toBe(NOW.getTime())
      }))

    it("does not touch a session that is signed out, or at its expiry", () =>
      withStore(async ({ store, addUser }, create) => {
        const user = await addUser()
        const signedOut = await create(user, {
          device: deviceAt(0),
          status: SessionStatus.SignedOut,
        })
        const ending = await create(user, { device: deviceAt(0), expiresAt: after(30) })
        expect(await store.touch!(user.userId, signedOut.id, after(10), MINUTE)).toBe(false)
        expect(await store.touch!(user.userId, ending.id, after(30), MINUTE)).toBe(false)
        expect(await lastUsed(store, user.userId, after(29))).toBe(NOW.getTime())
      }))

    it("leaves another user's session untouched and answers false", () =>
      withStore(async ({ store, addUser }, create) => {
        const ann = await addUser()
        const bob = await addUser()
        const bobs = await create(bob, { device: deviceAt(0) })
        expect(await store.touch!(ann.userId, bobs.id, after(10), MINUTE)).toBe(false)
        expect(await lastUsed(store, bob.userId, after(10))).toBe(NOW.getTime())
      }))
  })
}

/** Creates a session of `user`: active, no second factor, an hour from NOW, unless overridden. */
interface Create<S extends SessionRecord> {
  (user: SessionUser<S>, overrides?: Overrides): Promise<S>
}
