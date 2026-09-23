import { expect } from "@std/expect"
import { describe, it } from "@std/testing/bdd"
import { SecondFactorStatus, SessionManager } from "@spy4x/server/sign-in"
import {
  createClock,
  createFakeStore,
  type ManualClock,
  PEPPER,
} from "../sign-in/fake-store.test.ts"
import {
  createEmailCodeSignIn,
  DEFAULT_CODE_MAX_ATTEMPTS,
  DEFAULT_CODE_TTL_MINUTES,
  EMAIL_CODE_METHOD,
  EmailCodeError,
  type EmailCodeErrorReason,
  type EmailCodeSignIn,
  type EmailCodeSignInDeps,
} from "./email-code.ts"
import { MemoryAuthStore } from "./memory-store.ts"
import type { AuthSessionRecord } from "./model.ts"

const MINUTE = 60_000
const ADDRESS = "ann@example.com"

interface Harness {
  provider: EmailCodeSignIn
  store: MemoryAuthStore
  clock: ManualClock
  /** Every code sent, in order. */
  sent: { email: string; code: string }[]
  /** Asks for a code for `email` and returns the code that was sent. */
  codeFor(email?: string): Promise<string>
}

function setup(overrides: Partial<EmailCodeSignInDeps> = {}): Harness {
  const clock = createClock()
  const store = new MemoryAuthStore({ clock })
  const sessions = new SessionManager<AuthSessionRecord>({
    store: createFakeStore<AuthSessionRecord>().store,
    pepper: PEPPER,
    durationMinutes: 60,
    clock,
  })
  const sent: { email: string; code: string }[] = []
  const provider = createEmailCodeSignIn({
    store,
    sessions,
    clock,
    sendCode: (email, code) => {
      sent.push({ email, code })
      return Promise.resolve()
    },
    ...overrides,
  })
  const codeFor = async (email = ADDRESS) => {
    await provider.requestCode(email)
    return sent[sent.length - 1].code
  }
  return { provider, store, clock, sent, codeFor }
}

async function expectRefusal(
  promise: Promise<unknown>,
  reason: EmailCodeErrorReason,
): Promise<void> {
  const error = await promise.then(() => null, (caught: unknown) => caught)
  expect(error).toBeInstanceOf(EmailCodeError)
  expect((error as EmailCodeError).reason).toBe(reason)
}

describe("createEmailCodeSignIn: requestCode", () => {
  it("sends an 8-character base64url code to the normalised address", async () => {
    const { provider, sent } = setup()
    await provider.requestCode("  Ann@Example.COM ")
    expect(sent.length).toBe(1)
    expect(sent[0].email).toBe(ADDRESS)
    expect(sent[0].code).toMatch(/^[A-Za-z0-9_-]{8}$/)
  })

  it("sends a different code each time", async () => {
    const { codeFor } = setup()
    expect(await codeFor()).not.toBe(await codeFor())
  })

  it("refuses a value that is not an address and sends nothing", async () => {
    const { provider, sent } = setup()
    await expectRefusal(provider.requestCode("not an address"), "invalid-email")
    expect(sent.length).toBe(0)
  })

  it("passes a failure to send to the caller", async () => {
    const { provider } = setup({ sendCode: () => Promise.reject(new Error("smtp down")) })
    await expect(provider.requestCode(ADDRESS)).rejects.toThrow("smtp down")
  })
})

describe("createEmailCodeSignIn: verifyCode", () => {
  it("signs up with a new user and one proven email-code key whose email is the address", async () => {
    const { provider, store, clock, codeFor } = setup()
    const result = await provider.verifyCode(ADDRESS, await codeFor())

    expect(result.key.method).toBe(EMAIL_CODE_METHOD)
    expect(result.key.subject).toBe(ADDRESS)
    expect(result.key.email).toBe(ADDRESS)
    expect(result.key.secret).toBeNull()
    expect(result.key.provenAt?.getTime()).toBe(clock.now())
    expect(result.key.userId).toBe(result.user.id)
    expect(await store.findUserIdByProvenEmail(ADDRESS)).toBe(result.user.id)
    expect(result.session.session.userId).toBe(result.user.id)
    expect(result.session.session.keyId).toBe(result.key.id)
    expect(result.session.session.secondFactor).toBe(SecondFactorStatus.NotRequired)
  })

  it("signs the same user in again with a fresh code and keeps exactly one key", async () => {
    const { provider, store, codeFor } = setup()
    const first = await provider.verifyCode(ADDRESS, await codeFor())
    const second = await provider.verifyCode(ADDRESS, await codeFor())

    expect(second.user.id).toBe(first.user.id)
    expect(second.key.id).toBe(first.key.id)
    expect(second.key.email).toBe(ADDRESS)
    const keys = await store.listKeys(first.user.id)
    expect(keys.map((key) => [key.method, key.subject])).toEqual([[EMAIL_CODE_METHOD, ADDRESS]])
    expect((await store.findKey(EMAIL_CODE_METHOD, ADDRESS))?.id).toBe(first.key.id)
  })

  it("never creates a second account across repeated code logins", async () => {
    const { provider, store, codeFor } = setup()
    const users = new Set<number>()
    for (let login = 0; login < 3; login++) {
      users.add((await provider.verifyCode(ADDRESS, await codeFor())).user.id)
    }
    expect(users.size).toBe(1)
    const [userId] = users
    expect(await store.findUser(userId + 1)).toBeNull()
  })

  it("treats differently cased addresses as one account", async () => {
    const { provider, codeFor } = setup()
    const first = await provider.verifyCode(ADDRESS, await codeFor("ANN@example.com"))
    const second = await provider.verifyCode(" Ann@Example.com", await codeFor(ADDRESS))
    expect(second.user.id).toBe(first.user.id)
  })

  it("ignores whitespace around the typed code", async () => {
    const { provider, codeFor } = setup()
    const code = await codeFor()
    const result = await provider.verifyCode(ADDRESS, ` ${code}\n`)
    expect(result.key.subject).toBe(ADDRESS)
  })

  it("accepts a code only once", async () => {
    const { provider, codeFor } = setup()
    const code = await codeFor()
    await provider.verifyCode(ADDRESS, code)
    await expectRefusal(provider.verifyCode(ADDRESS, code), "no-code")
  })

  it("accepts only the latest code once a new one is asked for", async () => {
    const { provider, codeFor } = setup()
    const earlier = await codeFor()
    const latest = await codeFor()
    await expectRefusal(provider.verifyCode(ADDRESS, earlier), "wrong-code")
    const result = await provider.verifyCode(ADDRESS, latest)
    expect(result.key.subject).toBe(ADDRESS)
  })

  it("refuses a wrong code", async () => {
    const { provider, codeFor } = setup()
    await codeFor()
    await expectRefusal(provider.verifyCode(ADDRESS, "wrong-00"), "wrong-code")
  })

  it("refuses a code for another address", async () => {
    const { provider, codeFor } = setup()
    const code = await codeFor("bob@example.com")
    await codeFor(ADDRESS)
    await expectRefusal(provider.verifyCode(ADDRESS, code), "wrong-code")
  })

  it("refuses when no code was asked for", async () => {
    const { provider } = setup()
    await expectRefusal(provider.verifyCode(ADDRESS, "anything"), "no-code")
  })

  it("refuses an expired code", async () => {
    const { provider, clock, codeFor } = setup()
    const code = await codeFor()
    clock.advance(DEFAULT_CODE_TTL_MINUTES * MINUTE)
    await expectRefusal(provider.verifyCode(ADDRESS, code), "no-code")
  })

  it("refuses an address that is not one", async () => {
    const { provider } = setup()
    await expectRefusal(provider.verifyCode("nobody", "anything"), "invalid-email")
  })

  it("locks the code out after maxAttempts wrong guesses, even for the right code", async () => {
    const { provider, codeFor } = setup({ maxAttempts: 3 })
    const code = await codeFor()
    for (let guess = 0; guess < 3; guess++) {
      await expectRefusal(provider.verifyCode(ADDRESS, "wrong-00"), "wrong-code")
    }
    await expectRefusal(provider.verifyCode(ADDRESS, code), "locked-out")
  })

  it("keeps the guess counter when a new code is asked for", async () => {
    const { provider, codeFor } = setup()
    await codeFor()
    for (let guess = 0; guess < DEFAULT_CODE_MAX_ATTEMPTS - 1; guess++) {
      await expectRefusal(provider.verifyCode(ADDRESS, "wrong-00"), "wrong-code")
    }
    const fresh = await codeFor()
    await expectRefusal(provider.verifyCode(ADDRESS, "wrong-00"), "wrong-code")
    await expectRefusal(provider.verifyCode(ADDRESS, fresh), "locked-out")
  })

  it("uses the app's secondFactorFor for the session", async () => {
    const { provider, codeFor } = setup({
      secondFactorFor: () => Promise.resolve(SecondFactorStatus.Pending),
    })
    const result = await provider.verifyCode(ADDRESS, await codeFor())
    expect(result.session.session.secondFactor).toBe(SecondFactorStatus.Pending)
  })
})

describe("createEmailCodeSignIn: who owns the address", () => {
  it("evicts a squatter's unproven claims and signs the mailbox owner in to a new account", async () => {
    const { provider, store, codeFor } = setup()
    const squatter = await store.createUserWithKey({
      method: "password",
      subject: ADDRESS,
      email: ADDRESS,
      secret: "squatter-hash",
      provenAt: null,
    })
    await store.addKey(squatter.user.id, {
      method: EMAIL_CODE_METHOD,
      subject: ADDRESS,
      email: ADDRESS,
      secret: null,
      provenAt: null,
    })

    const victim = await provider.verifyCode(ADDRESS, await codeFor())

    expect(victim.user.id).not.toBe(squatter.user.id)
    expect(await store.listKeys(squatter.user.id)).toEqual([])
    expect(await store.findKey("password", ADDRESS)).toBeNull()
    expect((await store.findKey(EMAIL_CODE_METHOD, ADDRESS))?.userId).toBe(victim.user.id)
    expect(await store.findUserIdByProvenEmail(ADDRESS)).toBe(victim.user.id)
  })

  it("links a new email-code key to the user who already owns the address", async () => {
    const { provider, store, clock, codeFor } = setup()
    const owner = await store.createUserWithKey({
      method: "password",
      subject: ADDRESS,
      email: ADDRESS,
      secret: "owner-hash",
      provenAt: new Date(clock.now()),
    })

    const result = await provider.verifyCode(ADDRESS, await codeFor())

    expect(result.user.id).toBe(owner.user.id)
    expect(result.key.method).toBe(EMAIL_CODE_METHOD)
    expect(result.key.email).toBe(ADDRESS)
    expect(result.key.provenAt).not.toBeNull()
    expect((await store.listKeys(owner.user.id)).map((key) => key.method)).toEqual([
      "password",
      EMAIL_CODE_METHOD,
    ])
  })

  it("proves the owner's own unproven email-code key instead of adding another", async () => {
    const { provider, store, clock, codeFor } = setup()
    const owner = await store.createUserWithKey({
      method: "password",
      subject: ADDRESS,
      email: ADDRESS,
      secret: "owner-hash",
      provenAt: new Date(clock.now()),
    })
    const unproven = await store.addKey(owner.user.id, {
      method: EMAIL_CODE_METHOD,
      subject: ADDRESS,
      email: ADDRESS,
      secret: null,
      provenAt: null,
    })

    const result = await provider.verifyCode(ADDRESS, await codeFor())

    expect(result.key.id).toBe(unproven.id)
    expect(result.key.provenAt?.getTime()).toBe(clock.now())
    expect((await store.listKeys(owner.user.id)).length).toBe(2)
  })
})

describe("createEmailCodeSignIn: options", () => {
  it("refuses a ttl or guess limit that is not a positive integer", () => {
    expect(() => setup({ codeTtlMinutes: 0 })).toThrow(RangeError)
    expect(() => setup({ codeTtlMinutes: 1.5 })).toThrow(RangeError)
    expect(() => setup({ maxAttempts: 0 })).toThrow(RangeError)
    expect(() => setup({ maxAttempts: Number.NaN })).toThrow(RangeError)
  })

  it("keeps a code valid for codeTtlMinutes", async () => {
    const { provider, clock, codeFor } = setup({ codeTtlMinutes: 2 })
    const code = await codeFor()
    clock.advance(2 * MINUTE - 1)
    const result = await provider.verifyCode(ADDRESS, code)
    expect(result.key.subject).toBe(ADDRESS)
    const late = await codeFor()
    clock.advance(2 * MINUTE)
    await expectRefusal(provider.verifyCode(ADDRESS, late), "no-code")
  })
})
