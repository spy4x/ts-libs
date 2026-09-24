// In-memory `SessionStore` for the unit tier. Not a test file in itself: it is named `*.test.ts`
// only so the root `publish.exclude` pattern keeps it out of the published package, and it registers
// no tests, because every test file that imports it would run them again.
//
// Its shape is the interface's and nothing more: the literal below is checked with `satisfies
// SessionStore<S>`, which rejects a missing and an extra key alike, and `session.test.ts` asserts
// the runtime keys. Test-only access (the rows and a call log) sits beside the store, never on it.

import type { SessionRecord, SessionStore } from "./session.ts"
import { SecondFactorStatus, SessionStatus } from "./session.ts"

/** A fake store plus the handles a test inspects it through. */
export interface FakeStore<S extends SessionRecord> {
  store: SessionStore<S>
  /** The stored rows by id. Tests may read and edit them directly. */
  rows: Map<number, S>
  /** Every store method called, in order, by name. */
  calls: string[]
}

/** The method names of `SessionStore`, sorted. */
export const STORE_METHODS = [
  "clearPendingSecondFactors",
  "completeSecondFactor",
  "create",
  "expire",
  "extend",
  "findById",
  "signOut",
  "signOutUser",
]

/**
 * Creates an empty fake store. Every conditional write only touches an `Active` row, as the
 * interface requires, and every row goes in and comes out as a copy, as it would through a driver.
 */
export function createFakeStore<S extends SessionRecord = SessionRecord>(): FakeStore<S> {
  const rows = new Map<number, S>()
  const calls: string[] = []
  let nextId = 1

  const store = {
    create(session: Omit<S, "id">): Promise<S> {
      calls.push("create")
      const row = { ...structuredClone(session), id: nextId } as S
      nextId += 1
      rows.set(row.id, row)
      return Promise.resolve(structuredClone(row))
    },
    findById(id: number): Promise<S | null> {
      calls.push("findById")
      const row = rows.get(id)
      return Promise.resolve(row ? structuredClone(row) : null)
    },
    extend(id: number, expiresAt: Date): Promise<boolean> {
      calls.push("extend")
      const row = rows.get(id)
      if (!row || row.status !== SessionStatus.Active) return Promise.resolve(false)
      row.expiresAt = new Date(expiresAt.getTime())
      return Promise.resolve(true)
    },
    completeSecondFactor(id: number): Promise<boolean> {
      calls.push("completeSecondFactor")
      const row = rows.get(id)
      if (!row || row.status !== SessionStatus.Active) return Promise.resolve(false)
      row.secondFactor = SecondFactorStatus.Completed
      return Promise.resolve(true)
    },
    clearPendingSecondFactors(userId: number): Promise<void> {
      calls.push("clearPendingSecondFactors")
      for (const row of rows.values()) {
        if (
          row.userId === userId && row.status === SessionStatus.Active &&
          row.secondFactor === SecondFactorStatus.Pending
        ) {
          row.secondFactor = SecondFactorStatus.NotRequired
        }
      }
      return Promise.resolve()
    },
    signOut(id: number): Promise<void> {
      calls.push("signOut")
      const row = rows.get(id)
      if (row && row.status === SessionStatus.Active) row.status = SessionStatus.SignedOut
      return Promise.resolve()
    },
    signOutUser(userId: number, exceptId: number | null): Promise<void> {
      calls.push("signOutUser")
      for (const row of rows.values()) {
        if (row.userId === userId && row.id !== exceptId && row.status === SessionStatus.Active) {
          row.status = SessionStatus.SignedOut
        }
      }
      return Promise.resolve()
    },
    expire(now: Date): Promise<void> {
      calls.push("expire")
      for (const row of rows.values()) {
        if (row.status === SessionStatus.Active && row.expiresAt.getTime() <= now.getTime()) {
          row.status = SessionStatus.Expired
        }
      }
      return Promise.resolve()
    },
  } satisfies SessionStore<S>

  return { store, rows, calls }
}

/** A clock the test moves by hand. Starts in 2001, far from the host's clock. */
export interface ManualClock {
  now(): number
  set(ms: number): void
  advance(ms: number): void
}

/**
 * 2001-01-01T00:00:00Z. Far enough from the host clock that code reading `Date.now()` instead of
 * the injected clock fails the tests, and in the past, so Hono's check that `Expires` is at most 400
 * days ahead of the host clock never fires.
 */
export const T0 = Date.UTC(2001, 0, 1)

/** Creates a {@link ManualClock} at {@link T0}. */
export function createClock(start: number = T0): ManualClock {
  let current = start
  return {
    now: () => current,
    set: (ms: number) => {
      current = ms
    },
    advance: (ms: number) => {
      current += ms
    },
  }
}

/** Obviously fake secrets, long enough for the 32-character floor. */
export const PEPPER = "test-pepper-not-a-real-secret-0123456789"
export const OTHER_PEPPER = "other-test-pepper-not-real-0123456789ab"
export const COOKIE_SECRET = "test-cookie-secret-not-real-0123456789"
