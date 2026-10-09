import { expect } from "@std/expect"
import { describe, it } from "@std/testing/bdd"
import { createPasswordHasher } from "./password.ts"
import { eraseLastCharacter, passwordFromInput, runPasswordHash } from "./password-hash.ts"

const PEPPER = "an-invented-test-pepper-0123456789abcdef"
const PASSWORD = "an invented test password"

describe("runPasswordHash", () => {
  it("prints a hash that verifies against the password under the same pepper", async () => {
    const result = await runPasswordHash({
      pepper: PEPPER,
      readPassword: () => Promise.resolve(PASSWORD),
    })
    expect(result.success).toBe(true)
    const hasher = createPasswordHasher({ pepper: PEPPER })
    expect((await hasher.verify(PASSWORD, result.output!)).valid).toBe(true)
  })

  it("refuses a missing or short pepper before asking for the password", async () => {
    for (const pepper of [undefined, "short"]) {
      let asked = false
      const result = await runPasswordHash({
        pepper,
        readPassword: () => {
          asked = true
          return Promise.resolve(PASSWORD)
        },
      })
      expect(result).toEqual({
        success: false,
        error: "Set AUTH_PEPPER (at least 32 characters) first.",
      })
      expect(asked).toBe(false)
    }
  })

  it("refuses an empty or cancelled password", async () => {
    for (const password of ["", null]) {
      const result = await runPasswordHash({
        pepper: PEPPER,
        readPassword: () => Promise.resolve(password),
      })
      expect(result).toEqual({ success: false, error: "No password given." })
    }
  })

  it("never puts the password in its error", async () => {
    const long = "p".repeat(2_000)
    const result = await runPasswordHash({
      pepper: PEPPER,
      readPassword: () => Promise.resolve(long),
    })
    expect(result.success).toBe(false)
    expect(result.error).not.toContain("ppp")
  })
})

describe("passwordFromInput", () => {
  it("drops one trailing line break and keeps every other character", () => {
    expect(passwordFromInput("secret\n")).toBe("secret")
    expect(passwordFromInput("secret\r\n")).toBe("secret")
    expect(passwordFromInput("secret\n\n")).toBe("secret\n")
    expect(passwordFromInput(" secret ")).toBe(" secret ")
  })
})

describe("eraseLastCharacter", () => {
  it("removes a whole multi-byte character", () => {
    const bytes = [...new TextEncoder().encode("aé€")]
    eraseLastCharacter(bytes)
    expect(new TextDecoder().decode(new Uint8Array(bytes))).toBe("aé")
    eraseLastCharacter(bytes)
    expect(new TextDecoder().decode(new Uint8Array(bytes))).toBe("a")
    eraseLastCharacter(bytes)
    eraseLastCharacter(bytes)
    expect(bytes).toEqual([])
  })
})
