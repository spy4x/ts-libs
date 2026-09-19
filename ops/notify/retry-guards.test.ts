import { expect } from "@std/expect"
import { describe, it } from "@std/testing/bdd"
import { describeErrorKind, describeTransportError } from "./retry.ts"

/**
 * The `ops/notify` copy of `retry.ts` is exercised here as well as the
 * `integrations` one, because `retry-drift.test.ts` only proves the two copies
 * are byte-identical — it does not prove either of them behaves. Every guard
 * below is therefore asserted against *this* copy, so a change applied to one
 * copy alone goes red even before the byte comparison notices it.
 */

/** An `Error` whose `name` getter throws, as a caller's hostile payload can supply. */
const errorWithThrowingName = (message: string): unknown =>
  new (class extends Error {
    override get name(): string {
      throw new TypeError(message)
    }
  })("boom")

/** An `Error` wearing whatever name the caller set, which `Error.name` allows. */
const errorNamed = (name: string): unknown => {
  const error = new TypeError("boom")
  Object.defineProperty(error, "name", { value: name })
  return error
}

describe("describeTransportError (ops copy)", () => {
  it("names a platform error class and withholds the URL", () => {
    expect(
      describeTransportError(
        new TypeError(`Invalid URL: 'https://hc-ping.invalid/REALTOKENISH/fail'`),
      ),
    ).toBe("TypeError: transport failure (url withheld)")
  })

  it("returns instead of throwing when the name getter itself throws", () => {
    // An unguarded `cause.name` read propagated this throw, so a notifier whose
    // signature promises a result would have rejected instead.
    const described = describeTransportError(
      errorWithThrowingName(`Invalid URL: 'https://hc-ping.invalid/REALTOKENISH/fail'`),
    )
    expect(described).toBe("transport failure (url withheld)")
    expect(described).not.toContain("REALTOKENISH")
  })
})

describe("describeErrorKind (ops copy)", () => {
  it("names a real platform class, so the allowlist is not empty", () => {
    expect(describeErrorKind(new TypeError("boom"))).toBe("TypeError")
    expect(describeErrorKind(new SyntaxError("boom"))).toBe("SyntaxError")
  })

  it("reports Error for a caller-set name", () => {
    // `Error.name` is writable, so it is caller text: `REALTOKENISH` is 12
    // alphabetic characters, which the previous `/^[A-Za-z]{1,32}$/` admitted.
    expect(describeErrorKind(errorNamed("REALTOKENISH"))).toBe("Error")
    expect(describeErrorKind(errorNamed("A".repeat(32)))).toBe("Error")
  })

  it("returns instead of throwing when the name getter itself throws", () => {
    expect(describeErrorKind(errorWithThrowingName("Invalid URL: 'https://x.invalid/TOKEN'"))).toBe(
      "Error",
    )
  })
})
