import { expect } from "@std/expect"
import { describe, it } from "@std/testing/bdd"
import {
  createPasswordHasher,
  type PasswordHasher,
  SecondFactorStatus,
  SessionManager,
  SessionStatus,
} from "@ts-libs/server/sign-in"
import { createClock, createFakeStore, PEPPER } from "../sign-in/fake-store.test.ts"
import { MemoryAuthStore } from "./memory-store.ts"
import type { AuthSessionRecord } from "./model.ts"
import {
  createPasswordSignIn,
  PASSWORD_METHOD,
  type PasswordSignInError,
  type PasswordSignInOptions,
} from "./password.ts"

/** The lowest iteration count the hasher accepts, so the suite stays fast. */
const ITERATIONS = 100_000
const MINUTE = 60_000
const ANN = "ann@example.com"
const MALLORY_PASSWORD = "mallory-secret-1"

interface HasherCall {
  name: "hash" | "verify"
  stored?: string
}

/** A real hasher that records each call. Same own keys as `PasswordHasher`, ordinary functions. */
function recordingHasher(inner: PasswordHasher): { hasher: PasswordHasher; calls: HasherCall[] } {
  const calls: HasherCall[] = []
  const hasher = {
    hash(password: string): Promise<string> {
      calls.push({ name: "hash" })
      return inner.hash(password)
    },
    verify(password: string, stored: string) {
      calls.push({ name: "verify", stored })
      return inner.verify(password, stored)
    },
  } satisfies PasswordHasher
  return { hasher, calls }
}

function setup(overrides: Partial<PasswordSignInOptions> = {}) {
  const clock = createClock()
  const store = new MemoryAuthStore({ clock })
  const sessionStore = createFakeStore<AuthSessionRecord>()
  const sessions = new SessionManager<AuthSessionRecord>({
    store: sessionStore.store,
    pepper: PEPPER,
    durationMinutes: 60,
    clock,
  })
  const recorded = recordingHasher(createPasswordHasher({ pepper: PEPPER, iterations: ITERATIONS }))
  const provider = createPasswordSignIn({
    store,
    sessions,
    clock,
    hasher: recorded.hasher,
    ...overrides,
  })
  return { clock, store, sessions, sessionStore, provider, hasherCalls: recorded.calls }
}

async function refusal(promise: Promise<unknown>): Promise<PasswordSignInError> {
  const error = await promise.then(() => null, (caught: unknown) => caught)
  expect(error).toBeInstanceOf(Error)
  expect((error as Error).name).toBe("PasswordSignInError")
  return error as PasswordSignInError
}

/** Every key in the store, across the given users. */
async function allKeys(store: MemoryAuthStore, userIds: number[]) {
  return (await Promise.all(userIds.map((id) => store.listKeys(id)))).flat()
}

describe("createPasswordSignIn: signUp", () => {
  it("creates an unproven password key whose subject and email are the normalised address", async () => {
    const { provider } = setup()
    const result = await provider.signUp({ email: "  Ann@Example.COM ", password: "correct horse" })
    expect(result.key).toMatchObject({
      userId: result.user.id,
      method: PASSWORD_METHOD,
      subject: ANN,
      email: ANN,
      provenAt: null,
    })
    expect(result.key.secret).toMatch(/^pbkdf2-sha256\$/)
    expect(result.session.session).toMatchObject({
      userId: result.user.id,
      keyId: result.key.id,
      status: SessionStatus.Active,
      secondFactor: SecondFactorStatus.NotRequired,
    })
  })

  it("asks the app for the second-factor status of the session", async () => {
    const { provider } = setup({
      secondFactorFor: () => Promise.resolve(SecondFactorStatus.Pending),
    })
    const result = await provider.signUp({ email: ANN, password: "correct horse" })
    expect(result.session.session.secondFactor).toBe(SecondFactorStatus.Pending)
  })

  it("refuses a malformed address and a too-short password", async () => {
    const { provider } = setup()
    expect(
      (await refusal(provider.signUp({ email: "not-an-address", password: "long enough" })))
        .reason,
    ).toBe("invalid-email")
    expect((await refusal(provider.signUp({ email: ANN, password: "short" }))).reason)
      .toBe("invalid-password")
  })

  it("refuses an address another user owns proven, and creates nothing", async () => {
    const { provider, store } = setup()
    const owner = await store.createUserWithKey({
      method: "email-code",
      subject: ANN,
      email: ANN,
      secret: null,
      provenAt: new Date(0),
    })
    const error = await refusal(
      provider.signUp({ email: "ANN@example.com", password: "x".repeat(8) }),
    )
    expect(error.reason).toBe("email-taken")
    expect(await store.findKey(PASSWORD_METHOD, ANN)).toBeNull()
    expect(await store.findUserIdByProvenEmail(ANN)).toBe(owner.user.id)
  })

  it("answers a second sign-up for the same address with email-taken, not a store conflict", async () => {
    const { provider } = setup()
    await provider.signUp({ email: ANN, password: MALLORY_PASSWORD })
    const error = await refusal(provider.signUp({ email: ANN, password: "another-password" }))
    expect(error.reason).toBe("email-taken")
  })
})

describe("createPasswordSignIn: signIn", () => {
  it("signs in with the password, whatever the address's case", async () => {
    const { provider } = setup()
    const signedUp = await provider.signUp({ email: ANN, password: "correct horse" })
    const result = await provider.signIn({ email: "ANN@EXAMPLE.com", password: "correct horse" })
    expect(result.user.id).toBe(signedUp.user.id)
    expect(result.key.id).toBe(signedUp.key.id)
    expect(result.session.session.keyId).toBe(signedUp.key.id)
  })

  it("refuses a wrong password and a missing account with the same error", async () => {
    const { provider } = setup()
    await provider.signUp({ email: ANN, password: "correct horse" })
    const wrong = await refusal(provider.signIn({ email: ANN, password: "wrong horse" }))
    const missing = await refusal(
      provider.signIn({ email: "nobody@example.com", password: "wrong horse" }),
    )
    expect(missing.reason).toBe("invalid-credentials")
    expect(wrong.reason).toBe(missing.reason)
    expect(wrong.message).toBe(missing.message)
  })

  it("runs one verification against the dummy hash made once, when the account is missing", async () => {
    const { provider, hasherCalls } = setup()
    // The dummy hash is made when the provider is created.
    expect(hasherCalls).toEqual([{ name: "hash" }])
    for (const email of ["nobody@example.com", "else@example.com", "not-an-address"]) {
      hasherCalls.length = 0
      await refusal(provider.signIn({ email, password: "wrong horse" }))
      expect(hasherCalls.map((call) => call.name)).toEqual(["verify"])
      expect(hasherCalls[0].stored).toMatch(/^pbkdf2-sha256\$100000\$/)
    }
  })

  it("verifies the same dummy hash for every missing account", async () => {
    const { provider, hasherCalls } = setup()
    await refusal(provider.signIn({ email: "one@example.com", password: "wrong horse" }))
    await refusal(provider.signIn({ email: "two@example.com", password: "wrong horse" }))
    const stored = hasherCalls.filter((call) => call.name === "verify").map((call) => call.stored)
    expect(stored).toHaveLength(2)
    expect(stored[0]).toBe(stored[1])
  })

  it("runs one verification against the stored hash for an existing account", async () => {
    const { provider, hasherCalls } = setup()
    const signedUp = await provider.signUp({ email: ANN, password: "correct horse" })
    hasherCalls.length = 0
    await refusal(provider.signIn({ email: ANN, password: "wrong horse" }))
    expect(hasherCalls).toEqual([{ name: "verify", stored: signedUp.key.secret! }])
  })

  it("refuses a deleted user", async () => {
    const { provider, store } = setup()
    const signedUp = await provider.signUp({ email: ANN, password: "correct horse" })
    const findUser = store.findUser.bind(store)
    store.findUser = async (id) => {
      const user = await findUser(id)
      return user && { ...user, deletedAt: new Date(0) }
    }
    expect(signedUp.user.deletedAt).toBeNull()
    const error = await refusal(provider.signIn({ email: ANN, password: "correct horse" }))
    expect(error.reason).toBe("invalid-credentials")
  })

  it("replaces an outdated hash on a successful sign-in", async () => {
    const { provider, store } = setup({
      hasher: createPasswordHasher({ pepper: PEPPER, iterations: ITERATIONS + 1 }),
    })
    const oldHash = await createPasswordHasher({ pepper: PEPPER, iterations: ITERATIONS })
      .hash("correct horse")
    const created = await store.createUserWithKey({
      method: PASSWORD_METHOD,
      subject: ANN,
      email: ANN,
      secret: oldHash,
      provenAt: null,
    })
    const result = await provider.signIn({ email: ANN, password: "correct horse" })
    expect(result.key.secret).toMatch(/^pbkdf2-sha256\$100001\$/)
    expect((await store.findKeyById(created.key.id))?.secret).toBe(result.key.secret)
    await provider.signIn({ email: ANN, password: "correct horse" })
  })
})

describe("createPasswordSignIn: changePassword", () => {
  it("refuses a wrong current password and keeps the old one", async () => {
    const { provider } = setup()
    const { user } = await provider.signUp({ email: ANN, password: "correct horse" })
    const error = await refusal(provider.changePassword({
      userId: user.id,
      currentPassword: "wrong horse",
      newPassword: "battery staple",
    }))
    expect(error.reason).toBe("invalid-credentials")
    await provider.signIn({ email: ANN, password: "correct horse" })
  })

  it("replaces the password, then signs out every other session", async () => {
    const { provider, sessions } = setup()
    const first = await provider.signUp({ email: ANN, password: "correct horse" })
    const second = await provider.signIn({ email: ANN, password: "correct horse" })
    const changed = await provider.changePassword({
      userId: first.user.id,
      currentPassword: "correct horse",
      newPassword: "battery staple",
    })
    expect(await sessions.validate(first.session.cookieValue)).toBeNull()
    expect(await sessions.validate(second.session.cookieValue)).toBeNull()
    expect((await sessions.validate(changed.session.cookieValue))?.session.id)
      .toBe(changed.session.session.id)
    expect((await refusal(provider.signIn({ email: ANN, password: "correct horse" }))).reason)
      .toBe("invalid-credentials")
    await provider.signIn({ email: ANN, password: "battery staple" })
  })

  it("creates the new session before it revokes the others", async () => {
    const { provider, sessionStore } = setup()
    const { user } = await provider.signUp({ email: ANN, password: "correct horse" })
    sessionStore.calls.length = 0
    await provider.changePassword({
      userId: user.id,
      currentPassword: "correct horse",
      newPassword: "battery staple",
    })
    expect(sessionStore.calls).toEqual(["create", "signOutUser"])
  })
})

describe("createPasswordSignIn: requestReset and completeReset", () => {
  it("issues a 43-character code that expires after the configured minutes", async () => {
    const { provider, clock } = setup({ resetTtlMinutes: 15 })
    const issued = await provider.requestReset({ email: " Ann@Example.com" })
    expect(issued.email).toBe(ANN)
    expect(issued.code).toMatch(/^[A-Za-z0-9_-]{43}$/)
    expect(issued.expiresAt.getTime()).toBe(clock.now() + 15 * MINUTE)
  })

  it("issues a code whether or not an account uses the address", async () => {
    const { provider } = setup()
    const issued = await provider.requestReset({ email: "nobody@example.com" })
    expect(issued.code).toHaveLength(43)
    const error = await refusal(
      provider.completeReset({ email: issued.email, code: issued.code, newPassword: "new-pass-1" }),
    )
    expect(error.reason).toBe("no-account")
  })

  it("sets the new password on a proven key and signs out every other session", async () => {
    const { provider, sessions, sessionStore, store } = setup()
    const signedUp = await provider.signUp({ email: ANN, password: "correct horse" })
    await store.proveKey(signedUp.key.id, new Date(0))
    const { code } = await provider.requestReset({ email: ANN })
    sessionStore.calls.length = 0
    const reset = await provider.completeReset({ email: ANN, code, newPassword: "battery staple" })
    expect(sessionStore.calls).toEqual(["create", "signOutUser"])
    expect(reset.user.id).toBe(signedUp.user.id)
    expect(reset.key.id).toBe(signedUp.key.id)
    expect(reset.key.provenAt?.getTime()).toBe(0)
    expect(await sessions.validate(signedUp.session.cookieValue)).toBeNull()
    expect(await sessions.validate(reset.session.cookieValue)).not.toBeNull()
    await provider.signIn({ email: ANN, password: "battery staple" })
  })

  it("accepts a code once", async () => {
    const { provider } = setup()
    await provider.signUp({ email: ANN, password: "correct horse" })
    const { code } = await provider.requestReset({ email: ANN })
    await provider.completeReset({ email: ANN, code, newPassword: "battery staple" })
    const error = await refusal(
      provider.completeReset({ email: ANN, code, newPassword: "again-123" }),
    )
    expect(error.reason).toBe("invalid-code")
  })

  it("refuses the right code after the configured number of wrong guesses", async () => {
    const { provider } = setup({ maxResetAttempts: 3 })
    await provider.signUp({ email: ANN, password: "correct horse" })
    const { code } = await provider.requestReset({ email: ANN })
    for (let i = 0; i < 3; i++) {
      const wrong = await refusal(
        provider.completeReset({ email: ANN, code: "guess", newPassword: "battery staple" }),
      )
      expect(wrong.reason).toBe("invalid-code")
    }
    const locked = await refusal(
      provider.completeReset({ email: ANN, code, newPassword: "battery staple" }),
    )
    expect(locked.reason).toBe("locked-out")
    await provider.signIn({ email: ANN, password: "correct horse" })
  })

  it("refuses an expired code", async () => {
    const { provider, clock } = setup()
    await provider.signUp({ email: ANN, password: "correct horse" })
    const { code } = await provider.requestReset({ email: ANN })
    clock.advance(30 * MINUTE)
    const error = await refusal(
      provider.completeReset({ email: ANN, code, newPassword: "battery staple" }),
    )
    expect(error.reason).toBe("invalid-code")
  })

  it("does not spend a matching code on a refused new password", async () => {
    const { provider } = setup()
    await provider.signUp({ email: ANN, password: "correct horse" })
    const { code } = await provider.requestReset({ email: ANN })
    const error = await refusal(provider.completeReset({ email: ANN, code, newPassword: "short" }))
    expect(error.reason).toBe("invalid-password")
    await provider.completeReset({ email: ANN, code, newPassword: "battery staple" })
  })
})

describe("createPasswordSignIn: an address registered by someone else", () => {
  it("gives the address to the person who resets it, not to whoever signed up first", async () => {
    const { provider, store, sessions } = setup()
    const mallory = await provider.signUp({ email: ANN, password: MALLORY_PASSWORD })

    expect((await refusal(provider.signUp({ email: ANN, password: "ann-password" }))).reason)
      .toBe("email-taken")

    const { code } = await provider.requestReset({ email: ANN })
    const ann = await provider.completeReset({ email: ANN, code, newPassword: "ann-password" })

    expect(ann.user.id).not.toBe(mallory.user.id)
    expect(ann.key).toMatchObject({ subject: ANN, email: ANN, userId: ann.user.id })
    expect(ann.key.provenAt).not.toBeNull()
    expect(await store.findUserIdByProvenEmail(ANN)).toBe(ann.user.id)
    expect(await store.listKeys(mallory.user.id)).toEqual([])
    expect((await refusal(provider.signIn({ email: ANN, password: MALLORY_PASSWORD }))).reason)
      .toBe("invalid-credentials")
    expect((await provider.signIn({ email: ANN, password: "ann-password" })).user.id)
      .toBe(ann.user.id)
    expect((await sessions.validate(ann.session.cookieValue))?.session.userId).toBe(ann.user.id)
  })

  it("puts the password on the owner's account when a stale claim holds the address", async () => {
    const { provider, store } = setup()
    const owner = await store.createUserWithKey({
      method: "email-code",
      subject: ANN,
      email: ANN,
      secret: null,
      provenAt: new Date(0),
    })
    // The store allows an unproven key for an owned address; only a proof or proven insert evicts it.
    const mallory = await store.createUserWithKey({
      method: PASSWORD_METHOD,
      subject: ANN,
      email: ANN,
      secret: await createPasswordHasher({ pepper: PEPPER, iterations: ITERATIONS })
        .hash(MALLORY_PASSWORD),
      provenAt: null,
    })
    const { code } = await provider.requestReset({ email: ANN })
    const reset = await provider.completeReset({ email: ANN, code, newPassword: "ann-password" })
    expect(reset.user.id).toBe(owner.user.id)
    expect(reset.key).toMatchObject({ userId: owner.user.id, subject: ANN, email: ANN })
    expect(await store.listKeys(mallory.user.id)).toEqual([])
    expect((await refusal(provider.signIn({ email: ANN, password: MALLORY_PASSWORD }))).reason)
      .toBe("invalid-credentials")
  })

  it("proves the owner's own unproven password key in place", async () => {
    const { provider, store } = setup()
    const signedUp = await provider.signUp({ email: ANN, password: "correct horse" })
    await store.addKey(signedUp.user.id, {
      method: "email-code",
      subject: ANN,
      email: ANN,
      secret: null,
      provenAt: new Date(0),
    })
    const { code } = await provider.requestReset({ email: ANN })
    const reset = await provider.completeReset({ email: ANN, code, newPassword: "battery staple" })
    expect(reset.key.id).toBe(signedUp.key.id)
    expect(reset.key.provenAt).not.toBeNull()
  })

  it("writes every key with its address as both subject and email", async () => {
    const { provider, store } = setup()
    const mallory = await provider.signUp({ email: "Ann@Example.com", password: MALLORY_PASSWORD })
    const bob = await provider.signUp({ email: "BOB@example.com ", password: "bob-password" })
    const { code } = await provider.requestReset({ email: ANN })
    const ann = await provider.completeReset({ email: ANN, code, newPassword: "ann-password" })
    const keys = await allKeys(store, [mallory.user.id, bob.user.id, ann.user.id])
    expect(keys).toHaveLength(2)
    for (const key of keys) {
      expect(key.method).toBe(PASSWORD_METHOD)
      expect(key.email).toBe(key.subject)
    }
  })
})

describe("createPasswordSignIn: options", () => {
  it("refuses limits that are not positive integers", () => {
    for (
      const bad of [
        { minPasswordLength: 0 },
        { resetTtlMinutes: 1.5 },
        { resetTtlMinutes: 24 * 60 + 1 },
        { maxResetAttempts: -1 },
      ]
    ) {
      expect(() => setup(bad)).toThrow(RangeError)
    }
  })
})
