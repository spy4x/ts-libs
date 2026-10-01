// The `LockoutStore` contract, written once and run against both stores: `memory-store.test.ts` runs
// it in the unit tier, `postgres.integration.test.ts` against a real Postgres. Every case drives the
// stores through `createLockout`, since the flow is what a caller relies on.
//
// Not a test file in itself: it is named `*.test.ts` only so the root `publish.exclude` pattern keeps
// it out of the published package, and it registers no tests until a caller runs
// `describeLockoutStoreContract`.

import { expect } from "@std/expect"
import { describe, it } from "@std/testing/bdd"
import {
  createLockout,
  DEFAULT_LOCKOUT_POLICY,
  type Lockout,
  type LockoutState,
  type LockoutStore,
  type LockoutSubject,
} from "./mod.ts"

/** A fresh, empty store, a way to look inside it, and how to dispose of it. */
export interface LockoutStoreFixture {
  store: LockoutStore
  /** Starts tracking `subject`, as a row the caller inserted would. */
  track(subject: LockoutSubject): Promise<void>
  /** The stored state, or `undefined` when the store holds nothing for `subject`. */
  read(subject: LockoutSubject): Promise<LockoutState | undefined>
  close(): Promise<void>
}

/** Opens a fixture; `createMissing` is passed to the store's option of the same name. */
export type OpenLockoutStore = (options: { createMissing: boolean }) => Promise<LockoutStoreFixture>

/** 2001-01-01T00:00:00Z: far from the host clock, so a store reading the host clock is caught. */
export const NOW = Date.UTC(2001, 0, 1)
const { freeFailures, firstLockMs, maxLockMs, quietResetMs } = DEFAULT_LOCKOUT_POLICY

/** A fixture, a lockout over it on a clock the test moves, and the clock. */
async function open(openStore: OpenLockoutStore, createMissing = true) {
  const fixture = await openStore({ createMissing })
  const clock = { at: NOW, now: () => clock.at }
  const lockout = createLockout({ store: fixture.store, clock })
  return { fixture, clock, lockout }
}

/** `count` checks in a row, each with a wrong secret. Returns what each `begin` returned. */
async function guessWrong(lockout: Lockout, subject: LockoutSubject, count: number) {
  const waits: number[] = []
  for (let index = 0; index < count; index += 1) {
    const wait = await lockout.begin(subject)
    waits.push(wait)
    if (wait === 0) await lockout.fail(subject)
  }
  return waits
}

/** Registers the contract suite for one store. */
export function describeLockoutStoreContract(name: string, openStore: OpenLockoutStore): void {
  describe(`${name} (lockout store contract)`, () => {
    it("runs the free checks and one more, then refuses for the first lock", async () => {
      const { fixture, lockout } = await open(openStore)
      try {
        const waits = await guessWrong(lockout, "ann", freeFailures + 2)
        expect(waits).toEqual([...Array(freeFailures + 1).fill(0), firstLockMs])
        expect(await fixture.read("ann")).toEqual({
          failures: freeFailures + 1,
          lockedUntil: NOW + firstLockMs,
          lastFailureAt: NOW,
        })
      } finally {
        await fixture.close()
      }
    })

    it("reports the time left on a running lock without counting the check", async () => {
      const { fixture, clock, lockout } = await open(openStore)
      try {
        await guessWrong(lockout, "ann", freeFailures + 1)
        clock.at += 60_000
        expect(await lockout.begin("ann")).toBe(firstLockMs - 60_000)
        expect((await fixture.read("ann"))?.failures).toBe(freeFailures + 1)
      } finally {
        await fixture.close()
      }
    })

    it("doubles the lock for each wrong guess past the budget, up to the maximum", async () => {
      const { fixture, clock, lockout } = await open(openStore)
      try {
        await guessWrong(lockout, "ann", freeFailures)
        const locks: number[] = []
        for (let index = 0; index < 9; index += 1) {
          expect(await lockout.begin("ann")).toBe(0)
          await lockout.fail("ann")
          const lock = await lockout.begin("ann")
          locks.push(lock)
          clock.at += lock
        }
        expect(locks).toEqual([1, 2, 4, 8, 16, 32, 64, 96, 96].map((n) => n * firstLockMs))
        expect(locks.at(-1)).toBe(maxLockMs)
      } finally {
        await fixture.close()
      }
    })

    it("gives back one slot and clears the lock when the secret was right", async () => {
      const { fixture, lockout } = await open(openStore)
      try {
        await guessWrong(lockout, "ann", freeFailures)
        expect(await lockout.begin("ann")).toBe(0)
        await lockout.refund("ann")
        expect(await fixture.read("ann")).toEqual({
          failures: freeFailures,
          lockedUntil: null,
          lastFailureAt: NOW,
        })
        expect(await lockout.begin("ann")).toBe(0)
      } finally {
        await fixture.close()
      }
    })

    it("starts the count again after the quiet days with no wrong guess", async () => {
      const { fixture, clock, lockout } = await open(openStore)
      try {
        await guessWrong(lockout, "ann", freeFailures + 1)
        clock.at += quietResetMs - 1
        expect(await lockout.begin("ann")).toBe(0)
        expect((await fixture.read("ann"))?.failures).toBe(freeFailures + 2)
        await lockout.fail("ann")

        clock.at += quietResetMs
        expect(await lockout.begin("ann")).toBe(0)
        expect(await fixture.read("ann")).toEqual({
          failures: 1,
          lockedUntil: null,
          lastFailureAt: clock.at,
        })
      } finally {
        await fixture.close()
      }
    })

    it("runs only the free checks and one more when guesses arrive in parallel", async () => {
      const { fixture, lockout } = await open(openStore)
      try {
        const waits = await Promise.all(
          Array.from({ length: freeFailures * 4 }, () => lockout.begin("ann")),
        )
        expect(waits.filter((wait) => wait === 0).length).toBe(freeFailures + 1)
        expect((await fixture.read("ann"))?.failures).toBe(freeFailures + 1)
      } finally {
        await fixture.close()
      }
    })

    it("keeps one subject's lock away from another", async () => {
      const { fixture, lockout } = await open(openStore)
      try {
        await guessWrong(lockout, "ann", freeFailures + 1)
        expect(await lockout.begin("ann")).toBe(firstLockMs)
        expect(await lockout.begin("bob")).toBe(0)
        expect((await fixture.read("bob"))?.failures).toBe(1)
      } finally {
        await fixture.close()
      }
    })

    it("lets an untracked subject through and writes nothing when not creating rows", async () => {
      const { fixture, lockout } = await open(openStore, false)
      try {
        expect(await guessWrong(lockout, "ann", freeFailures + 2)).toEqual(
          Array(freeFailures + 2).fill(0),
        )
        await lockout.refund("ann")
        expect(await fixture.read("ann")).toBeUndefined()

        await fixture.track("ann")
        expect(await lockout.begin("ann")).toBe(0)
        expect((await fixture.read("ann"))?.failures).toBe(1)
      } finally {
        await fixture.close()
      }
    })
  })
}
