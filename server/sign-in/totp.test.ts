import { expect } from "@std/expect"
import { describe, it } from "@std/testing/bdd"
import * as OTPAuth from "otpauth"
import { createClock } from "./fake-store.test.ts"
import { generateTotpSecret, totpEnrolment, verifyTotp } from "./totp.ts"

// RFC 6238 appendix B: the SHA-1 secret is the ASCII string "12345678901234567890". The RFC lists
// eight-digit codes; a six-digit code is the last six of them.
const RFC_SECRET = "GEZDGNBVGY3TQOJQGEZDGNBVGY3TQOJQ"
const RFC_VECTORS = [
  { seconds: 59, code: "287082", step: 1 },
  { seconds: 1111111109, code: "081804", step: 37037036 },
  { seconds: 1234567890, code: "005924", step: 41152263 },
  { seconds: 2000000000, code: "279037", step: 66666666 },
]

const NOW = 1234567890 * 1000
const STEP = 41152263

/** The code for a given step, from the library itself: used only for neighbouring steps. */
function codeAt(step: number, secret = RFC_SECRET): string {
  return OTPAuth.TOTP.generate({
    secret: OTPAuth.Secret.fromBase32(secret),
    algorithm: "SHA1",
    digits: 6,
    period: 30,
    timestamp: step * 30_000,
  })
}

describe("verifyTotp", () => {
  it("accepts the RFC 6238 test vectors and returns their time step", () => {
    for (const { seconds, code, step } of RFC_VECTORS) {
      const clock = createClock(seconds * 1000)
      expect(verifyTotp(RFC_SECRET, code, { lastAcceptedStep: null, clock })).toBe(step)
    }
  })

  it("refuses a code from ten minutes before the injected clock", () => {
    const clock = createClock(NOW + 10 * 60_000)
    expect(verifyTotp(RFC_SECRET, "005924", { lastAcceptedStep: null, clock })).toBeNull()
  })

  it("accepts one step either side and nothing further", () => {
    const clock = createClock(NOW)
    const verify = (step: number) =>
      verifyTotp(RFC_SECRET, codeAt(step), { lastAcceptedStep: null, clock })
    expect(verify(STEP - 1)).toBe(STEP - 1)
    expect(verify(STEP)).toBe(STEP)
    expect(verify(STEP + 1)).toBe(STEP + 1)
    expect(verify(STEP - 2)).toBeNull()
    expect(verify(STEP + 2)).toBeNull()
  })

  it("refuses the same code a second time", () => {
    const clock = createClock(NOW)
    const accepted = verifyTotp(RFC_SECRET, "005924", { lastAcceptedStep: null, clock })
    expect(accepted).toBe(STEP)
    expect(verifyTotp(RFC_SECRET, "005924", { lastAcceptedStep: accepted, clock })).toBeNull()
    clock.advance(30_000) // still inside the window, one step later
    expect(verifyTotp(RFC_SECRET, "005924", { lastAcceptedStep: accepted, clock })).toBeNull()
  })

  it("refuses an earlier step's code once a later step was accepted", () => {
    const clock = createClock(NOW)
    const accepted = verifyTotp(RFC_SECRET, codeAt(STEP + 1), { lastAcceptedStep: null, clock })
    expect(accepted).toBe(STEP + 1)
    expect(verifyTotp(RFC_SECRET, codeAt(STEP), { lastAcceptedStep: accepted, clock })).toBeNull()
    expect(verifyTotp(RFC_SECRET, codeAt(STEP - 1), { lastAcceptedStep: accepted, clock }))
      .toBeNull()
  })

  it("accepts a later step's code after an earlier one was accepted", () => {
    const clock = createClock(NOW)
    expect(verifyTotp(RFC_SECRET, codeAt(STEP), { lastAcceptedStep: STEP - 1, clock })).toBe(STEP)
  })

  it("answers no, without throwing, to anything but six ASCII digits", () => {
    const clock = createClock(NOW)
    const refused: unknown[] = [
      "05924",
      "0059240",
      " 005924",
      "005924 ",
      "00592a",
      "００５９２４",
      "",
      "5924",
      null,
      undefined,
      5924,
    ]
    for (const code of refused) {
      expect({
        code,
        step: verifyTotp(RFC_SECRET, code as string, { lastAcceptedStep: null, clock }),
      })
        .toEqual({ code, step: null })
    }
  })

  it("refuses a secret that is not upper-case base32 of at least 16 bytes", () => {
    const clock = createClock(NOW)
    for (
      const secret of [RFC_SECRET.toLowerCase(), "!!!!", "", "GEZDGNBVGY3TQOJQ", "GEZD GNBV", null]
    ) {
      expect(() => verifyTotp(secret as string, "005924", { lastAcceptedStep: null, clock }))
        .toThrow(TypeError)
    }
  })

  it("refuses a last accepted step that is not null or a non-negative integer", () => {
    const clock = createClock(NOW)
    for (const lastAcceptedStep of [-1, 1.5, Number.NaN, "3", undefined]) {
      expect(() =>
        verifyTotp(RFC_SECRET, "005924", { lastAcceptedStep: lastAcceptedStep as number, clock })
      ).toThrow(TypeError)
    }
  })

  it("refuses a clock that returns something that is not a finite number", () => {
    const clock = createClock(Number.NaN)
    expect(() => verifyTotp(RFC_SECRET, "005924", { lastAcceptedStep: null, clock })).toThrow(
      TypeError,
    )
  })
})

describe("generateTotpSecret", () => {
  it("returns 20 random bytes as 32 base32 characters, different every time", () => {
    const first = generateTotpSecret()
    const second = generateTotpSecret()
    expect(first).toMatch(/^[A-Z2-7]{32}$/)
    expect(OTPAuth.Secret.fromBase32(first).bytes.byteLength).toBe(20)
    expect(first).not.toBe(second)
  })

  it("produces a secret verifyTotp accepts", () => {
    const secret = generateTotpSecret()
    const clock = createClock(NOW)
    expect(verifyTotp(secret, codeAt(STEP, secret), { lastAcceptedStep: null, clock })).toBe(STEP)
  })
})

describe("totpEnrolment", () => {
  it("builds the key URI and its QR code from the issuer and label it is given", () => {
    const { uri, qrCodeSvg } = totpEnrolment(RFC_SECRET, {
      issuer: "Example App",
      label: "user@example.com",
    })
    expect(uri).toBe(
      "otpauth://totp/Example%20App:user%40example.com?issuer=Example%20App" +
        `&secret=${RFC_SECRET}&algorithm=SHA1&digits=6&period=30`,
    )
    expect(qrCodeSvg).toContain("<svg")
  })

  it("refuses an empty issuer or label, or one containing a colon", () => {
    for (
      const account of [
        { issuer: "", label: "user@example.com" },
        { issuer: "Example", label: " " },
        { issuer: "Example:App", label: "user@example.com" },
        { issuer: "Example", label: "user:example" },
        { issuer: undefined, label: "user@example.com" },
      ]
    ) {
      expect(() => totpEnrolment(RFC_SECRET, account as { issuer: string; label: string }))
        .toThrow(TypeError)
    }
  })

  it("refuses a secret that is not upper-case base32 of at least 16 bytes", () => {
    const account = { issuer: "Example", label: "user@example.com" }
    expect(() => totpEnrolment("GEZDGNBV", account)).toThrow(TypeError)
    expect(() => totpEnrolment(RFC_SECRET.toLowerCase(), account)).toThrow(TypeError)
  })
})
