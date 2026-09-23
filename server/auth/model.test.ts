import { expect } from "@std/expect"
import { describe, it } from "@std/testing/bdd"
import { AuthConflictError, ChallengeOutcome, MAX_EMAIL_LENGTH, normalizeEmail } from "./model.ts"

describe("normalizeEmail", () => {
  it("normalises case variants of one address to the same value", () => {
    expect(normalizeEmail("A@X.com")).toBe("a@x.com")
    expect(normalizeEmail("a@x.com")).toBe("a@x.com")
  })

  it("trims surrounding whitespace", () => {
    expect(normalizeEmail("  Ann@Example.COM\n")).toBe("ann@example.com")
  })

  it("answers null for a value that is not an address", () => {
    for (const value of ["", "   ", "ann", "ann@", "@example.com", "ann@localhost", "a b@x.com"]) {
      expect(normalizeEmail(value)).toBeNull()
    }
    for (const value of [undefined, null, 42, {}, ["a@x.com"]]) {
      expect(normalizeEmail(value)).toBeNull()
    }
  })

  it("refuses a control character inside the address", () => {
    expect(normalizeEmail("ann@exa\r\nmple.com")).toBeNull()
    expect(normalizeEmail("ann\u0000@example.com")).toBeNull()
  })

  it("accepts an address of the maximum length and refuses a longer one", () => {
    const domain = "@example.com"
    const longest = "a".repeat(MAX_EMAIL_LENGTH - domain.length) + domain
    expect(normalizeEmail(longest)).toBe(longest)
    expect(normalizeEmail("a" + longest)).toBeNull()
  })
})

describe("ChallengeOutcome", () => {
  it("numbers every outcome from 1, so none is falsy", () => {
    expect([
      ChallengeOutcome.Matched,
      ChallengeOutcome.WrongGuess,
      ChallengeOutcome.LockedOut,
      ChallengeOutcome.Missing,
    ]).toEqual([1, 2, 3, 4])
  })
})

describe("AuthConflictError", () => {
  it("carries the reason and is an Error", () => {
    const error = new AuthConflictError("email-owned")
    expect(error).toBeInstanceOf(Error)
    expect(error.name).toBe("AuthConflictError")
    expect(error.reason).toBe("email-owned")
    expect(new AuthConflictError("key-exists").message).toContain("method and subject")
  })
})
