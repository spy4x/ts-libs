import { expect } from "@std/expect"
import { describe, it } from "@std/testing/bdd"
import { decodeHex, encodeHex } from "@std/encoding/hex"
import { OTHER_PEPPER, PEPPER } from "./fake-store.test.ts"
import {
  createPasswordHasher,
  DEFAULT_PASSWORD_ITERATIONS,
  MAX_PASSWORD_BYTES,
  MAX_PASSWORD_ITERATIONS,
  MIN_PASSWORD_ITERATIONS,
} from "./password.ts"

// Most cases run at the lowest accepted count to keep the suite quick; one case pins the default.
const FAST = { pepper: PEPPER, iterations: MIN_PASSWORD_ITERATIONS }
const PASSWORD = "correct horse battery staple"
const NO_MATCH = { valid: false, needsRehash: false }

async function pbkdf2Hex(input: Uint8Array, salt: Uint8Array, iterations: number) {
  const key = await crypto.subtle.importKey("raw", new Uint8Array(input), "PBKDF2", false, [
    "deriveBits",
  ])
  const bits = await crypto.subtle.deriveBits(
    { name: "PBKDF2", salt: new Uint8Array(salt), iterations, hash: "SHA-256" },
    key,
    256,
  )
  return encodeHex(new Uint8Array(bits))
}

/** This module's construction, written out independently: PBKDF2 over HMAC(pepper, password). */
async function manualHash(password: string, salt: Uint8Array, iterations: number) {
  const pepperKey = await crypto.subtle.importKey(
    "raw",
    new TextEncoder().encode(PEPPER),
    { name: "HMAC", hash: "SHA-256" },
    false,
    ["sign"],
  )
  const input = new Uint8Array(
    await crypto.subtle.sign("HMAC", pepperKey, new TextEncoder().encode(password)),
  )
  const key = await pbkdf2Hex(input, salt, iterations)
  return `pbkdf2-sha256$${iterations}$${encodeHex(salt)}$${key}`
}

/** The template's `hash()`, reproduced: PBKDF2 over `password + pepper`, 100 000 rounds. */
async function templateHash(password: string, pepper: string): Promise<string> {
  const salt = crypto.getRandomValues(new Uint8Array(16))
  const key = await pbkdf2Hex(new TextEncoder().encode(password + pepper), salt, 100_000)
  return `${encodeHex(salt)}:${key}`
}

describe("createPasswordHasher", () => {
  it("verifies the password it hashed and refuses any other", async () => {
    const hasher = createPasswordHasher(FAST)
    const stored = await hasher.hash(PASSWORD)
    expect(await hasher.verify(PASSWORD, stored)).toEqual({ valid: true, needsRehash: false })
    expect(await hasher.verify(`${PASSWORD} `, stored)).toEqual(NO_MATCH)
    expect(await hasher.verify("Correct horse battery staple", stored)).toEqual(NO_MATCH)
  })

  it("refuses the right password under a different pepper", async () => {
    const stored = await createPasswordHasher(FAST).hash(PASSWORD)
    const other = createPasswordHasher({ ...FAST, pepper: OTHER_PEPPER })
    expect(await other.verify(PASSWORD, stored)).toEqual(NO_MATCH)
  })

  it("salts every hash, so one password never hashes the same way twice", async () => {
    const hasher = createPasswordHasher(FAST)
    const first = await hasher.hash(PASSWORD)
    const second = await hasher.hash(PASSWORD)
    expect(first).not.toBe(second)
    expect(first.split("$")[2]).not.toBe(second.split("$")[2])
  })

  it("writes 600 000 PBKDF2-SHA-256 iterations and a 16-byte salt by default", async () => {
    const stored = await createPasswordHasher({ pepper: PEPPER }).hash(PASSWORD)
    expect(DEFAULT_PASSWORD_ITERATIONS).toBe(600_000)
    expect(stored).toMatch(/^pbkdf2-sha256\$600000\$[0-9a-f]{32}\$[0-9a-f]{64}$/)
  })

  it("derives the key from HMAC-SHA-256 of the password under the pepper", async () => {
    const stored = await createPasswordHasher(FAST).hash(PASSWORD)
    const [, iterations, saltHex] = stored.split("$")
    expect(await manualHash(PASSWORD, decodeHex(saltHex), Number(iterations))).toBe(stored)
  })

  it("uses the iteration count written in the stored value", async () => {
    const hasher = createPasswordHasher(FAST)
    const stored = await hasher.hash(PASSWORD)
    const edited = stored.replace("$100000$", "$100001$")
    expect(edited).not.toBe(stored)
    expect(await hasher.verify(PASSWORD, edited)).toEqual(NO_MATCH)
  })

  it("asks for a rehash when the stored count is below the configured one", async () => {
    const stored = await createPasswordHasher(FAST).hash(PASSWORD)
    const stronger = createPasswordHasher({ pepper: PEPPER, iterations: 100_001 })
    expect(await stronger.verify(PASSWORD, stored)).toEqual({ valid: true, needsRehash: true })

    const strongerStored = await stronger.hash(PASSWORD)
    const weaker = createPasswordHasher(FAST)
    expect(await weaker.verify(PASSWORD, strongerStored)).toEqual({
      valid: true,
      needsRehash: false,
    })
  })

  it("verifies a hash in the template's format and asks for a rehash", async () => {
    const hasher = createPasswordHasher(FAST)
    const legacy = await templateHash(PASSWORD, PEPPER)
    expect(await hasher.verify(PASSWORD, legacy)).toEqual({ valid: true, needsRehash: true })
    expect(await hasher.verify("wrong password", legacy)).toEqual(NO_MATCH)
    const otherPepper = createPasswordHasher({ ...FAST, pepper: OTHER_PEPPER })
    expect(await otherPepper.verify(PASSWORD, legacy)).toEqual(NO_MATCH)
  })

  it("answers no, without throwing, for every stored value that is not exactly a known format", async () => {
    const hasher = createPasswordHasher(FAST)
    const stored = await hasher.hash(PASSWORD)
    const [, , salt, key] = stored.split("$")
    const legacy = await templateHash(PASSWORD, PEPPER)
    const [legacySalt, legacyKey] = legacy.split(":")

    // Each of these would verify under a parser that trusted Number(), parseInt() or the case of
    // the hex, or that ignored what follows the key.
    const lookalikes = [
      `pbkdf2-sha256$1e5$${salt}$${key}`,
      `pbkdf2-sha256$0x186a0$${salt}$${key}`,
      `pbkdf2-sha256$0100000$${salt}$${key}`,
      `pbkdf2-sha256$+100000$${salt}$${key}`,
      `pbkdf2-sha256$ 100000$${salt}$${key}`,
      `pbkdf2-sha256$100000.0$${salt}$${key}`,
      `pbkdf2-sha256$100000$${salt.toUpperCase()}$${key}`,
      `pbkdf2-sha256$100000$${salt}$${key.toUpperCase()}`,
      `pbkdf2-sha256$100000$${salt}$${key}$extra`,
      `pbkdf2-sha256$100000$${salt}$${key}\n`,
      ` ${stored}`,
      `PBKDF2-SHA256$100000$${salt}$${key}`,
      `${legacySalt.toUpperCase()}:${legacyKey}`,
      `${legacySalt}:${legacyKey}:extra`,
      `${legacySalt}:${legacyKey}\n`,
    ]
    for (const value of lookalikes) {
      expect({ value, result: await hasher.verify(PASSWORD, value) }).toEqual({
        value,
        result: NO_MATCH,
      })
    }

    // Plain garbage, including what made the template's `checkHash` throw.
    const garbage: unknown[] = [
      "",
      "no-colon-at-all",
      "abc:def",
      "0:0",
      `${legacySalt}:`,
      `:${legacyKey}`,
      `${legacySalt.slice(1)}:${legacyKey}`,
      `pbkdf2-sha256$99999$${salt}$${key}`,
      `pbkdf2-sha256$${MAX_PASSWORD_ITERATIONS + 1}$${salt}$${key}`,
      `pbkdf2-sha256$999999999$${salt}$${key}`,
      `pbkdf2-sha256$100000$${salt}`,
      `pbkdf2-sha512$100000$${salt}$${key}`,
      null,
      undefined,
      42,
    ]
    for (const value of garbage) {
      expect({ value, result: await hasher.verify(PASSWORD, value as string) }).toEqual({
        value,
        result: NO_MATCH,
      })
    }
  })

  it("refuses a stored value above the iteration ceiling, even one that would match", async () => {
    const hasher = createPasswordHasher(FAST)
    const rounds = MAX_PASSWORD_ITERATIONS + 1
    const stored = await manualHash(PASSWORD, new Uint8Array(16), rounds)
    expect(stored).toContain(`$${rounds}$`)
    expect(await hasher.verify(PASSWORD, stored)).toEqual(NO_MATCH)
  })

  it("refuses an empty or over-long password when hashing, and answers no when verifying", async () => {
    const hasher = createPasswordHasher(FAST)
    const stored = await hasher.hash(PASSWORD)
    const tooLong = "a".repeat(MAX_PASSWORD_BYTES + 1)
    const tooManyBytes = "é".repeat(MAX_PASSWORD_BYTES / 2 + 1) // two UTF-8 bytes each

    await expect(hasher.hash("")).rejects.toThrow(RangeError)
    await expect(hasher.hash(tooLong)).rejects.toThrow(RangeError)
    await expect(hasher.hash(tooManyBytes)).rejects.toThrow(RangeError)
    await expect(hasher.hash(undefined as unknown as string)).rejects.toThrow(TypeError)
    expect(await hasher.verify("", stored)).toEqual(NO_MATCH)
    // Stored values that really are these passwords' hashes, so only the length check refuses them.
    const salt = new Uint8Array(16)
    const tooLongStored = await manualHash(tooLong, salt, MIN_PASSWORD_ITERATIONS)
    const tooManyBytesStored = await manualHash(tooManyBytes, salt, MIN_PASSWORD_ITERATIONS)
    expect(await hasher.verify(tooLong, tooLongStored)).toEqual(NO_MATCH)
    expect(await hasher.verify(tooManyBytes, tooManyBytesStored)).toEqual(NO_MATCH)
    expect(await hasher.verify(null as unknown as string, stored)).toEqual(NO_MATCH)
  })

  it("accepts a password of exactly the byte limit", async () => {
    const hasher = createPasswordHasher(FAST)
    const longest = "é".repeat(MAX_PASSWORD_BYTES / 2)
    const stored = await hasher.hash(longest)
    expect(await hasher.verify(longest, stored)).toEqual({ valid: true, needsRehash: false })
  })

  it("refuses a missing, short, blank or non-printable pepper", () => {
    for (const pepper of [undefined, "", "short", " ".repeat(40), "\u0007".repeat(40), 7]) {
      expect(() => createPasswordHasher({ pepper: pepper as string })).toThrow(TypeError)
    }
  })

  it("refuses an iteration count outside the accepted range", () => {
    for (const iterations of [0, 99_999, MAX_PASSWORD_ITERATIONS + 1, 100_000.5, Number.NaN]) {
      expect(() => createPasswordHasher({ pepper: PEPPER, iterations })).toThrow(RangeError)
    }
  })
})

describe("password.ts source", () => {
  it("compares derived keys with constantTimeEquals and never with === or !==", async () => {
    const source = await Deno.readTextFile(new URL("./password.ts", import.meta.url))
    const code = source.split("\n").filter((line) => !/^\s*(\/\/|\*|\/\*\*)/.test(line))
    expect(code.filter((line) => line.includes("constantTimeEquals(derived, expected)")))
      .toHaveLength(2)
    expect(
      code.filter((line) => /(derived|expected)\s*[!=]==|[!=]==\s*(derived|expected)/.test(line)),
    )
      .toEqual([])
  })
})
