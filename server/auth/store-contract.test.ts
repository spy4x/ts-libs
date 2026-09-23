// The `AuthStore` contract, written once and run against both stores: `memory-store.test.ts` runs
// it in the unit tier, `postgres.integration.test.ts` against a real Postgres. It is how the memory
// store is shown to behave like Postgres on every rule a provider's tests rely on.
//
// Not a test file in itself: it is named `*.test.ts` only so the root `publish.exclude` pattern keeps
// it out of the published package, and it registers no tests until a caller runs
// `describeAuthStoreContract`.

import { expect } from "@std/expect"
import { describe, it } from "@std/testing/bdd"
import { AuthConflictError, ChallengeOutcome, type NewAuthKey } from "./model.ts"
import { AUTH_STORE_METHODS, type AuthStore } from "./store.ts"

/** A fresh, empty store and how to dispose of it. */
export interface StoreFixture {
  store: AuthStore
  close(): Promise<void>
}

/** 2001-01-01T00:00:00Z: far from the host clock, so a store reading the host clock is caught. */
export const NOW = new Date(Date.UTC(2001, 0, 1))
const MINUTE = 60_000
const LATER = new Date(NOW.getTime() + 10 * MINUTE)

/** A key for `email`, unproven unless `provenAt` is given. */
export function emailKey(
  method: string,
  email: string,
  provenAt: Date | null = null,
): NewAuthKey {
  return { method, subject: email, email, secret: null, provenAt }
}

async function expectConflict(promise: Promise<unknown>, reason: string): Promise<void> {
  const error = await promise.then(() => null, (caught: unknown) => caught)
  expect(error).toBeInstanceOf(AuthConflictError)
  expect((error as AuthConflictError).reason).toBe(reason)
}

async function expectRejects(promise: Promise<unknown>, type: ErrorConstructor): Promise<void> {
  const error = await promise.then(() => null, (caught: unknown) => caught)
  expect(error).toBeInstanceOf(type)
}

function tally(outcomes: ChallengeOutcome[]): Record<string, number> {
  const counts: Record<string, number> = { Matched: 0, WrongGuess: 0, LockedOut: 0, Missing: 0 }
  for (const outcome of outcomes) counts[ChallengeOutcome[outcome]] += 1
  return counts
}

/**
 * Registers the contract suite for one store.
 *
 * @param label Names the store in every test name.
 * @param open Returns a fresh, empty store for each test.
 */
export function describeAuthStoreContract(
  label: string,
  open: () => Promise<StoreFixture>,
): void {
  async function withStore(body: (store: AuthStore) => Promise<void>): Promise<void> {
    const fixture = await open()
    try {
      await body(fixture.store)
    } finally {
      await fixture.close()
    }
  }

  describe(`${label}: shape`, () => {
    it("has exactly the AuthStore methods, on its prototype, and no own keys", () =>
      withStore((store) => {
        const prototype = Object.getPrototypeOf(store)
        const methods = Object.getOwnPropertyNames(prototype)
          .filter((name) => name !== "constructor")
          .sort()
        expect(methods).toEqual([...AUTH_STORE_METHODS])
        for (const name of methods) expect(typeof prototype[name]).toBe("function")
        expect(Object.keys(store)).toEqual([])
        return Promise.resolve()
      }))
  })

  describe(`${label}: users and keys`, () => {
    it("creates a user with its first key and finds both", () =>
      withStore(async (store) => {
        const { user, key } = await store.createUserWithKey({
          method: "password",
          subject: "ann@example.com",
          email: "ann@example.com",
          secret: "hash-1",
          provenAt: null,
        })
        expect(Number.isSafeInteger(user.id) && user.id > 0).toBe(true)
        expect(user.createdAt).toBeInstanceOf(Date)
        expect(user.deletedAt).toBeNull()
        expect(key).toMatchObject({
          userId: user.id,
          method: "password",
          subject: "ann@example.com",
          email: "ann@example.com",
          secret: "hash-1",
          provenAt: null,
        })
        expect(await store.findUser(user.id)).toEqual(user)
        expect(await store.findKey("password", "ann@example.com")).toEqual(key)
        expect(await store.findKeyById(key.id)).toEqual(key)
        expect(await store.listKeys(user.id)).toEqual([key])
      }))

    it("refuses a second key with the same method and subject, and creates no user", () =>
      withStore(async (store) => {
        const { user } = await store.createUserWithKey(emailKey("password", "ann@example.com"))
        await expectConflict(
          store.createUserWithKey(emailKey("password", "ann@example.com")),
          "key-exists",
        )
        expect(await store.findUser(user.id + 1)).toBeNull()
        await expectConflict(
          store.addKey(user.id, emailKey("password", "ann@example.com")),
          "key-exists",
        )
        expect(await store.listKeys(user.id)).toHaveLength(1)
      }))

    it("allows the same subject under a different method", () =>
      withStore(async (store) => {
        const { user } = await store.createUserWithKey(emailKey("password", "ann@example.com"))
        const other = await store.createUserWithKey(emailKey("email-code", "ann@example.com"))
        expect(other.user.id).not.toBe(user.id)
        const own = await store.addKey(user.id, {
          method: "oauth:google",
          subject: "ann@example.com",
          email: null,
          secret: null,
          provenAt: null,
        })
        expect(own.userId).toBe(user.id)
      }))

    it("refuses a key whose email is not normalised or whose proof has no email", () =>
      withStore(async (store) => {
        await expectRejects(
          store.createUserWithKey(emailKey("password", "Ann@Example.com")),
          TypeError,
        )
        await expectRejects(
          store.createUserWithKey({
            method: "oauth:google",
            subject: "sub-1",
            email: null,
            secret: null,
            provenAt: NOW,
          }),
          TypeError,
        )
        await expectRejects(store.createUserWithKey(emailKey("", "ann@example.com")), TypeError)
        expect(await store.findUser(1)).toBeNull()
      }))

    it("adds keys to an existing user and lists them in id order", () =>
      withStore(async (store) => {
        const { user, key } = await store.createUserWithKey(
          emailKey("password", "ann@example.com"),
        )
        const second = await store.addKey(user.id, emailKey("email-code", "ann@example.com"))
        const third = await store.addKey(user.id, {
          method: "oauth:github",
          subject: "12345",
          email: null,
          secret: null,
          provenAt: null,
        })
        expect((await store.listKeys(user.id)).map((each) => each.id)).toEqual([
          key.id,
          second.id,
          third.id,
        ])
      }))

    it("refuses to add a key to a user that does not exist", () =>
      withStore(async (store) => {
        const { user } = await store.createUserWithKey(emailKey("password", "ann@example.com"))
        await expectRejects(
          store.addKey(user.id + 100, emailKey("email-code", "bob@example.com")),
          RangeError,
        )
        expect(await store.findKey("email-code", "bob@example.com")).toBeNull()
      }))

    it("answers nothing for an id no store could have assigned", () =>
      withStore(async (store) => {
        await store.createUserWithKey(emailKey("password", "ann@example.com"))
        for (const id of [0, -1, 1.5, Number.NaN, 2 ** 31]) {
          expect(await store.findUser(id)).toBeNull()
          expect(await store.findKeyById(id)).toBeNull()
          expect(await store.listKeys(id)).toEqual([])
          expect(await store.updateKeySecret(id, "hash")).toBe(false)
          expect(await store.deleteKey(id, 1)).toBe(false)
        }
      }))

    it("answers null for a lookup by a value that is not a string", () =>
      withStore(async (store) => {
        await store.createUserWithKey(emailKey("password", "ann@example.com", NOW))
        for (const value of [42, null, undefined, {}] as unknown as string[]) {
          expect(await store.findKey(value, "ann@example.com")).toBeNull()
          expect(await store.findKey("password", value)).toBeNull()
          expect(await store.findUserIdByProvenEmail(value)).toBeNull()
        }
      }))

    it("replaces a key's secret, and answers false for a key that does not exist", () =>
      withStore(async (store) => {
        const { key } = await store.createUserWithKey({
          ...emailKey("password", "ann@example.com"),
          secret: "hash-1",
        })
        expect(await store.updateKeySecret(key.id, "hash-2")).toBe(true)
        expect((await store.findKeyById(key.id))?.secret).toBe("hash-2")
        expect(await store.updateKeySecret(key.id + 100, "hash-3")).toBe(false)
        await expectRejects(store.updateKeySecret(key.id, ""), TypeError)
      }))
  })

  describe(`${label}: proven addresses`, () => {
    it("an unproven key does not own its address", () =>
      withStore(async (store) => {
        await store.createUserWithKey(emailKey("password", "ann@example.com"))
        expect(await store.findUserIdByProvenEmail("ann@example.com")).toBeNull()
      }))

    it("proving a key marks it proven and makes its user the owner of the address", () =>
      withStore(async (store) => {
        const { user, key } = await store.createUserWithKey(
          emailKey("password", "ann@example.com"),
        )
        const proven = await store.proveKey(key.id, NOW)
        expect(proven.provenAt?.getTime()).toBe(NOW.getTime())
        expect(proven.id).toBe(key.id)
        expect(await store.findKeyById(key.id)).toEqual(proven)
        expect(await store.findUserIdByProvenEmail("ann@example.com")).toBe(user.id)
      }))

    it("proving again keeps the time the key was first proven", () =>
      withStore(async (store) => {
        const { key } = await store.createUserWithKey(emailKey("password", "ann@example.com"))
        await store.proveKey(key.id, NOW)
        const again = await store.proveKey(key.id, LATER)
        expect(again.provenAt?.getTime()).toBe(NOW.getTime())
      }))

    it("proving deletes other users' unproven keys for the address and nothing else", () =>
      withStore(async (store) => {
        // Someone registers the address first and never proves it.
        const squatter = await store.createUserWithKey(emailKey("password", "ann@example.com"))
        const squatterOther = await store.addKey(
          squatter.user.id,
          emailKey("email-code", "sam@example.com"),
        )
        const ann = await store.createUserWithKey(emailKey("email-code", "ann@example.com"))
        const annUnproven = await store.addKey(
          ann.user.id,
          {
            method: "password-alt",
            subject: "ann@example.com",
            email: "ann@example.com",
            secret: null,
            provenAt: null,
          },
        )

        await store.proveKey(ann.key.id, NOW)

        expect(await store.findKeyById(squatter.key.id)).toBeNull()
        expect(await store.findKeyById(squatterOther.id)).not.toBeNull()
        expect(await store.findKeyById(annUnproven.id)).not.toBeNull()
        expect(await store.findUser(squatter.user.id)).not.toBeNull()
      }))

    it("refuses to prove an address another user owns, and changes nothing", () =>
      withStore(async (store) => {
        const ann = await store.createUserWithKey(emailKey("email-code", "ann@example.com"))
        await store.proveKey(ann.key.id, NOW)
        const other = await store.createUserWithKey(emailKey("password", "ann@example.com"))

        await expectConflict(store.proveKey(other.key.id, NOW), "email-owned")

        expect((await store.findKeyById(other.key.id))?.provenAt).toBeNull()
        expect(await store.findUserIdByProvenEmail("ann@example.com")).toBe(ann.user.id)
        expect(await store.listKeys(ann.user.id)).toHaveLength(1)
      }))

    it("refuses to prove a key with no email or a key that does not exist", () =>
      withStore(async (store) => {
        const { key } = await store.createUserWithKey({
          method: "oauth:github",
          subject: "12345",
          email: null,
          secret: null,
          provenAt: null,
        })
        await expectRejects(store.proveKey(key.id, NOW), TypeError)
        await expectRejects(store.proveKey(key.id + 100, NOW), RangeError)
        await expectRejects(store.proveKey(key.id, new Date(Number.NaN)), TypeError)
      }))

    it("a key proven at creation claims the address and deletes unproven claims", () =>
      withStore(async (store) => {
        const squatter = await store.createUserWithKey(emailKey("password", "ann@example.com"))
        const ann = await store.createUserWithKey({
          method: "oauth:google",
          subject: "google-sub-1",
          email: "ann@example.com",
          secret: null,
          provenAt: NOW,
        })
        expect(await store.findUserIdByProvenEmail("ann@example.com")).toBe(ann.user.id)
        expect(await store.findKeyById(squatter.key.id)).toBeNull()
      }))

    it("refuses a new user with a proven key for an owned address, and creates no user", () =>
      withStore(async (store) => {
        const ann = await store.createUserWithKey(emailKey("email-code", "ann@example.com", NOW))
        await expectConflict(
          store.createUserWithKey({
            method: "oauth:google",
            subject: "google-sub-2",
            email: "ann@example.com",
            secret: null,
            provenAt: NOW,
          }),
          "email-owned",
        )
        expect(await store.findUser(ann.user.id + 1)).toBeNull()
        expect(await store.findKey("oauth:google", "google-sub-2")).toBeNull()
      }))

    it("refuses to add a proven key for an address another user owns", () =>
      withStore(async (store) => {
        await store.createUserWithKey(emailKey("email-code", "ann@example.com", NOW))
        const bob = await store.createUserWithKey(emailKey("password", "bob@example.com"))
        await expectConflict(
          store.addKey(bob.user.id, {
            method: "oauth:google",
            subject: "google-sub-3",
            email: "ann@example.com",
            secret: null,
            provenAt: NOW,
          }),
          "email-owned",
        )
        expect(await store.listKeys(bob.user.id)).toHaveLength(1)
      }))

    it("of two users proving one address at the same time, exactly one owns it", () =>
      withStore(async (store) => {
        const ann = await store.createUserWithKey(emailKey("email-code", "ann@example.com"))
        const other = await store.createUserWithKey(emailKey("password", "ann@example.com"))

        const results = await Promise.allSettled([
          store.proveKey(ann.key.id, NOW),
          store.proveKey(other.key.id, NOW),
        ])

        const fulfilled = results.filter((result) => result.status === "fulfilled")
        const rejected = results.filter((result) => result.status === "rejected")
        expect(fulfilled).toHaveLength(1)
        expect(rejected).toHaveLength(1)
        // The loser sees the owner ("email-owned") or, when the winner finished first, finds its own
        // unproven key already deleted by the winner's claim.
        const reason = (rejected[0] as PromiseRejectedResult).reason
        expect(reason instanceof AuthConflictError || reason instanceof RangeError).toBe(true)
        const winner = (fulfilled[0] as PromiseFulfilledResult<{ userId: number }>).value.userId
        expect(await store.findUserIdByProvenEmail("ann@example.com")).toBe(winner)
        const loser = winner === ann.user.id ? other : ann
        expect(await store.findKeyById(loser.key.id)).toBeNull()
      }))

    it("a key proven at creation displaces another user's unproven key with the same method and subject", () =>
      withStore(async (store) => {
        const squatter = await store.createUserWithKey(emailKey("password", "ann@example.com"))
        const ann = await store.createUserWithKey(emailKey("password", "ann@example.com", NOW))

        expect(ann.key.provenAt?.getTime()).toBe(NOW.getTime())
        expect(await store.findKey("password", "ann@example.com")).toEqual(ann.key)
        expect(await store.findKeyById(squatter.key.id)).toBeNull()
        expect(await store.findUserIdByProvenEmail("ann@example.com")).toBe(ann.user.id)
      }))

    it("the owner adds a proven key under a method another user holds an unproven claim for", () =>
      withStore(async (store) => {
        const ann = await store.createUserWithKey(emailKey("email-code", "ann@example.com", NOW))
        const squatter = await store.createUserWithKey(emailKey("password", "ann@example.com"))

        const password = await store.addKey(
          ann.user.id,
          emailKey("password", "ann@example.com", NOW),
        )

        expect(password.userId).toBe(ann.user.id)
        expect(await store.findKey("password", "ann@example.com")).toEqual(password)
        expect(await store.findKeyById(squatter.key.id)).toBeNull()
      }))

    it("never displaces a proven key of another user with the same method and subject", () =>
      withStore(async (store) => {
        const bob = await store.createUserWithKey({
          method: "oauth:google",
          subject: "google-sub-1",
          email: "bob@example.com",
          secret: null,
          provenAt: NOW,
        })
        await expectConflict(
          store.createUserWithKey({
            method: "oauth:google",
            subject: "google-sub-1",
            email: "ann@example.com",
            secret: null,
            provenAt: NOW,
          }),
          "key-exists",
        )
        expect(await store.findKeyById(bob.key.id)).toEqual(bob.key)
        expect(await store.findUserIdByProvenEmail("ann@example.com")).toBeNull()
        expect(await store.findUser(bob.user.id + 1)).toBeNull()
      }))

    it("a proven insert does not displace another user's key that carries a different address or none", () =>
      withStore(async (store) => {
        const otherAddress = await store.createUserWithKey({
          method: "password",
          subject: "ann@example.com",
          email: "sam@example.com",
          secret: null,
          provenAt: null,
        })
        const noAddress = await store.createUserWithKey({
          method: "email-code",
          subject: "ann@example.com",
          email: null,
          secret: null,
          provenAt: null,
        })

        await expectConflict(
          store.createUserWithKey(emailKey("password", "ann@example.com", NOW)),
          "key-exists",
        )
        await expectConflict(
          store.createUserWithKey(emailKey("email-code", "ann@example.com", NOW)),
          "key-exists",
        )

        expect(await store.findKeyById(otherAddress.key.id)).toEqual(otherAddress.key)
        expect(await store.findKeyById(noAddress.key.id)).toEqual(noAddress.key)
        expect(await store.findUser(noAddress.user.id + 1)).toBeNull()
        expect(await store.findUserIdByProvenEmail("ann@example.com")).toBeNull()
      }))

    it("never displaces the same user's own unproven key with the same method and subject", () =>
      withStore(async (store) => {
        const ann = await store.createUserWithKey(emailKey("password", "ann@example.com"))
        await expectConflict(
          store.addKey(ann.user.id, emailKey("password", "ann@example.com", NOW)),
          "key-exists",
        )
        expect(await store.findKeyById(ann.key.id)).toEqual(ann.key)
        expect(await store.findUserIdByProvenEmail("ann@example.com")).toBeNull()
      }))

    it("adds a second proven key for an address the same user owns", () =>
      withStore(async (store) => {
        const ann = await store.createUserWithKey(emailKey("email-code", "ann@example.com", NOW))
        const google = await store.addKey(ann.user.id, {
          method: "oauth:google",
          subject: "google-sub-1",
          email: "ann@example.com",
          secret: null,
          provenAt: NOW,
        })
        expect(google.provenAt?.getTime()).toBe(NOW.getTime())
        expect(await store.findUserIdByProvenEmail("ann@example.com")).toBe(ann.user.id)
      }))
  })

  describe(`${label}: deleting keys`, () => {
    it("deletes exactly the named key of the named user", () =>
      withStore(async (store) => {
        const ann = await store.createUserWithKey(emailKey("password", "ann@example.com"))
        const annOther = await store.addKey(ann.user.id, emailKey("email-code", "ann@example.com"))
        const bob = await store.createUserWithKey(emailKey("password", "bob@example.com"))

        expect(await store.deleteKey(bob.user.id, ann.key.id)).toBe(false)
        expect(await store.findKeyById(ann.key.id)).not.toBeNull()

        expect(await store.deleteKey(ann.user.id, ann.key.id)).toBe(true)
        expect(await store.findKeyById(ann.key.id)).toBeNull()
        expect(await store.findKeyById(annOther.id)).not.toBeNull()
        expect(await store.findKeyById(bob.key.id)).not.toBeNull()
        expect(await store.findUser(ann.user.id)).not.toBeNull()

        expect(await store.deleteKey(ann.user.id, ann.key.id)).toBe(false)
      }))

    it("releases the address once the user's last proven key for it is deleted", () =>
      withStore(async (store) => {
        const ann = await store.createUserWithKey(emailKey("email-code", "ann@example.com", NOW))
        const password = await store.addKey(
          ann.user.id,
          emailKey("password", "ann@example.com", NOW),
        )

        expect(await store.deleteKey(ann.user.id, ann.key.id)).toBe(true)
        expect(await store.findUserIdByProvenEmail("ann@example.com")).toBe(ann.user.id)

        expect(await store.deleteKey(ann.user.id, password.id)).toBe(true)
        expect(await store.findUserIdByProvenEmail("ann@example.com")).toBeNull()

        const bob = await store.createUserWithKey(emailKey("email-code", "ann@example.com", NOW))
        expect(await store.findUserIdByProvenEmail("ann@example.com")).toBe(bob.user.id)
      }))
  })

  describe(`${label}: challenges`, () => {
    const challenge = { purpose: "email-code", subject: "ann@example.com" }
    const issue = (secretHash: string, now = NOW, expiresAt = LATER) => ({
      ...challenge,
      secretHash,
      now,
      expiresAt,
    })
    const guess = (secretHash: string, maxAttempts = 5, now = NOW) => ({
      ...challenge,
      secretHash,
      maxAttempts,
      now,
    })

    it("a matching guess consumes the challenge; the same code again is Missing", () =>
      withStore(async (store) => {
        await store.issueChallenge(issue("right"))
        expect(await store.attemptChallenge(guess("right"))).toBe(ChallengeOutcome.Matched)
        expect(await store.attemptChallenge(guess("right"))).toBe(ChallengeOutcome.Missing)
      }))

    it("counts wrong guesses and locks out at maxAttempts, even for the right code", () =>
      withStore(async (store) => {
        await store.issueChallenge(issue("right"))
        for (let i = 0; i < 3; i++) {
          expect(await store.attemptChallenge(guess("wrong", 3))).toBe(ChallengeOutcome.WrongGuess)
        }
        expect(await store.attemptChallenge(guess("right", 3))).toBe(ChallengeOutcome.LockedOut)
        expect(await store.attemptChallenge(guess("wrong", 3))).toBe(ChallengeOutcome.LockedOut)
      }))

    it("keeps the counter when a new code is issued before the old one expires", () =>
      withStore(async (store) => {
        await store.issueChallenge(issue("first"))
        expect(await store.attemptChallenge(guess("wrong", 3))).toBe(ChallengeOutcome.WrongGuess)
        expect(await store.attemptChallenge(guess("wrong", 3))).toBe(ChallengeOutcome.WrongGuess)

        await store.issueChallenge(issue("second", new Date(NOW.getTime() + MINUTE)))

        expect(await store.attemptChallenge(guess("first", 3))).toBe(ChallengeOutcome.WrongGuess)
        expect(await store.attemptChallenge(guess("second", 3))).toBe(ChallengeOutcome.LockedOut)
      }))

    it("starts the counter at zero when the previous challenge had expired", () =>
      withStore(async (store) => {
        await store.issueChallenge(issue("first"))
        for (let i = 0; i < 3; i++) await store.attemptChallenge(guess("wrong", 3))

        const afterExpiry = new Date(LATER.getTime() + MINUTE)
        await store.issueChallenge(
          issue("second", afterExpiry, new Date(afterExpiry.getTime() + 10 * MINUTE)),
        )

        expect(await store.attemptChallenge(guess("wrong", 3, afterExpiry))).toBe(
          ChallengeOutcome.WrongGuess,
        )
        expect(await store.attemptChallenge(guess("second", 3, afterExpiry))).toBe(
          ChallengeOutcome.Matched,
        )
      }))

    it("an expired challenge is Missing and its guesses are not counted", () =>
      withStore(async (store) => {
        await store.issueChallenge(issue("right"))
        expect(await store.attemptChallenge(guess("right", 5, LATER))).toBe(
          ChallengeOutcome.Missing,
        )
        for (let i = 0; i < 5; i++) {
          expect(await store.attemptChallenge(guess("wrong", 5, LATER))).toBe(
            ChallengeOutcome.Missing,
          )
        }
        // Still unused before its expiry: the late guesses did not count and did not consume it.
        expect(await store.attemptChallenge(guess("right", 1))).toBe(ChallengeOutcome.Matched)
      }))

    it("a challenge that was never issued is Missing", () =>
      withStore(async (store) => {
        expect(await store.attemptChallenge(guess("anything"))).toBe(ChallengeOutcome.Missing)
      }))

    it("keeps challenges apart by purpose and by subject", () =>
      withStore(async (store) => {
        await store.issueChallenge(issue("right"))
        await store.issueChallenge({ ...issue("reset"), purpose: "password-reset" })
        await store.issueChallenge({ ...issue("bob"), subject: "bob@example.com" })

        expect(await store.attemptChallenge({ ...guess("right"), purpose: "password-reset" }))
          .toBe(ChallengeOutcome.WrongGuess)
        expect(await store.attemptChallenge({ ...guess("right"), subject: "bob@example.com" }))
          .toBe(ChallengeOutcome.WrongGuess)
        expect(await store.attemptChallenge(guess("right", 1))).toBe(ChallengeOutcome.Matched)
      }))

    it("refuses a challenge or a guess with invalid input", () =>
      withStore(async (store) => {
        await expectRejects(store.issueChallenge(issue("")), TypeError)
        await expectRejects(store.attemptChallenge(guess("right", 0)), TypeError)
        await expectRejects(store.attemptChallenge(guess("right", 1.5)), TypeError)
        await expectRejects(
          store.attemptChallenge(guess("right", 5, new Date(Number.NaN))),
          TypeError,
        )
      }))

    it("50 parallel wrong guesses against maxAttempts 5 compare exactly 5", () =>
      withStore(async (store) => {
        await store.issueChallenge(issue("right"))
        const outcomes = await Promise.all(
          Array.from({ length: 50 }, () => store.attemptChallenge(guess("wrong", 5))),
        )
        expect(tally(outcomes)).toEqual({ Matched: 0, WrongGuess: 5, LockedOut: 45, Missing: 0 })
        expect(await store.attemptChallenge(guess("right", 5))).toBe(ChallengeOutcome.LockedOut)
      }))

    it("50 parallel guesses with the right code among them match at most once", () =>
      withStore(async (store) => {
        await store.issueChallenge(issue("right"))
        const outcomes = await Promise.all(
          Array.from(
            { length: 50 },
            (_, i) => store.attemptChallenge(guess(i % 10 === 3 ? "right" : "wrong", 5)),
          ),
        )
        const counts = tally(outcomes)
        expect(counts.Matched).toBeLessThanOrEqual(1)
        expect(counts.Matched + counts.WrongGuess).toBeLessThanOrEqual(5)
        expect(counts.Matched + counts.WrongGuess + counts.LockedOut + counts.Missing).toBe(50)
      }))
  })
}
