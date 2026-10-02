import { expect } from "@std/expect"
import { describe, it } from "@std/testing/bdd"
import { redactAddress, REDACTED_EMAIL } from "./redact.ts"

describe("redactAddress", () => {
  it("replaces the address in any letter case", () => {
    expect(redactAddress("550 JANE@Example.COM and jane@example.com", "jane@example.com"))
      .toBe(`550 ${REDACTED_EMAIL} and ${REDACTED_EMAIL}`)
  })

  it("replaces the URL-encoded address, keeping other text", () => {
    expect(redactAddress("GET /v1/send?to=jane%40example.com failed", "jane@example.com"))
      .toBe(`GET /v1/send?to=${REDACTED_EMAIL} failed`)
  })
})
