// Tests for token auth. The two behaviours that matter: a token is compared in
// constant time, and a token never reaches a log line.

import { assert, assertEquals, assertNotMatch } from "@std/assert"
import { describe, it } from "@std/testing/bdd"
import {
  bearerTokenFromEnv,
  bearerTokenFromHeaders,
  constantTimeEquals,
  createTokenVerifier,
  formatLogLine,
  REDACTED_TOKEN,
  redactor,
} from "./auth.ts"
import { FAKE_TOKEN, FAKE_TOKEN_WRONG } from "./test-helpers.ts"

describe("constantTimeEquals", () => {
  it("accepts two equal tokens", async () => {
    assertEquals(await constantTimeEquals(FAKE_TOKEN, FAKE_TOKEN), true)
  })

  it("rejects an equal-length wrong token", async () => {
    assertEquals(FAKE_TOKEN.length, FAKE_TOKEN_WRONG.length)
    assertEquals(await constantTimeEquals(FAKE_TOKEN_WRONG, FAKE_TOKEN), false)
  })

  it("rejects tokens of different lengths without throwing", async () => {
    assertEquals(await constantTimeEquals("short", FAKE_TOKEN), false)
    assertEquals(await constantTimeEquals(FAKE_TOKEN, "short"), false)
  })

  it("rejects a shared prefix of any length", async () => {
    for (let length = 1; length < FAKE_TOKEN.length; length += 1) {
      assertEquals(await constantTimeEquals(FAKE_TOKEN.slice(0, length), FAKE_TOKEN), false)
    }
  })

  it("rejects an empty presented token and an empty configured token", async () => {
    assertEquals(await constantTimeEquals("", FAKE_TOKEN), false)
    assertEquals(await constantTimeEquals(FAKE_TOKEN, ""), false)
  })
})

describe("createTokenVerifier", () => {
  it("accepts the configured token", async () => {
    const verifier = createTokenVerifier(FAKE_TOKEN)
    assertEquals(await verifier.verify(FAKE_TOKEN), true)
  })

  it("rejects an equal-length wrong token", async () => {
    const verifier = createTokenVerifier(FAKE_TOKEN)
    assertEquals(await verifier.verify(FAKE_TOKEN_WRONG), false)
  })

  it("rejects the empty token", async () => {
    const verifier = createTokenVerifier(FAKE_TOKEN)
    assertEquals(await verifier.verify(""), false)
  })

  it("refuses to be built from an empty secret rather than failing open", () => {
    let thrown: unknown
    try {
      createTokenVerifier("")
    } catch (error) {
      thrown = error
    }
    assert(thrown instanceof Error)
    assert((thrown as Error).message.includes("fail open"))
  })
})

describe("bearerTokenFromHeaders", () => {
  it("reads a Bearer token", () => {
    const headers = new Headers({ Authorization: `Bearer ${FAKE_TOKEN}` })
    assertEquals(bearerTokenFromHeaders(headers), FAKE_TOKEN)
  })

  it("reads a bare token", () => {
    const headers = new Headers({ Authorization: FAKE_TOKEN })
    assertEquals(bearerTokenFromHeaders(headers), FAKE_TOKEN)
  })

  it("reads a lowercase bearer scheme", () => {
    const headers = new Headers({ Authorization: `bearer ${FAKE_TOKEN}` })
    assertEquals(bearerTokenFromHeaders(headers), FAKE_TOKEN)
  })

  it("returns undefined when the header is absent", () => {
    assertEquals(bearerTokenFromHeaders(new Headers()), undefined)
  })

  it("returns undefined for an empty header value", () => {
    assertEquals(bearerTokenFromHeaders(new Headers({ Authorization: "   " })), undefined)
  })
})

describe("bearerTokenFromEnv", () => {
  it("reads the value of the named variable", () => {
    const env = { get: (name: string) => (name === "MCP_BEARER_TOKEN" ? FAKE_TOKEN : undefined) }
    assertEquals(bearerTokenFromEnv("MCP_BEARER_TOKEN", env), FAKE_TOKEN)
  })

  it("throws instead of returning undefined for a missing variable", () => {
    const env = { get: () => undefined }
    let thrown: unknown
    try {
      bearerTokenFromEnv("MCP_BEARER_TOKEN", env)
    } catch (error) {
      thrown = error
    }
    assert(thrown instanceof Error)
    assert((thrown as Error).message.includes("MCP_BEARER_TOKEN is not set"))
  })

  it("throws for an empty variable", () => {
    const env = { get: () => "" }
    let thrown: unknown
    try {
      bearerTokenFromEnv("MCP_BEARER_TOKEN", env)
    } catch (error) {
      thrown = error
    }
    assert(thrown instanceof Error)
  })
})

describe("redactor", () => {
  it("replaces every occurrence of a known secret", () => {
    const redact = redactor([FAKE_TOKEN])
    assertEquals(
      redact(`a ${FAKE_TOKEN} b ${FAKE_TOKEN}`),
      `a ${REDACTED_TOKEN} b ${REDACTED_TOKEN}`,
    )
  })

  it("leaves an unrelated line untouched", () => {
    const redact = redactor([FAKE_TOKEN])
    assertEquals(redact("nothing sensitive here"), "nothing sensitive here")
  })

  it("ignores undefined and empty secrets", () => {
    const redact = redactor([undefined, ""])
    assertEquals(redact("plain text"), "plain text")
  })

  it("redacts several secrets in one line", () => {
    const redact = redactor([FAKE_TOKEN, FAKE_TOKEN_WRONG])
    const line = redact(`${FAKE_TOKEN} and ${FAKE_TOKEN_WRONG}`)
    assertNotMatch(line, new RegExp(FAKE_TOKEN))
    assertNotMatch(line, new RegExp(FAKE_TOKEN_WRONG))
  })
})

describe("formatLogLine", () => {
  it("prefixes the level in upper case and redacts the token", () => {
    const line = formatLogLine("warn", `Auth failed: Authorization="Bearer ${FAKE_TOKEN}"`, [
      FAKE_TOKEN,
    ])
    assertEquals(line, `[WARN] Auth failed: Authorization="Bearer ${REDACTED_TOKEN}"`)
  })

  it("emits no token for a line that interpolates the header, the api key and a query value", () => {
    const line = formatLogLine(
      "debug",
      `Auth failed: Authorization="${FAKE_TOKEN}" X-Api-Key="${FAKE_TOKEN}" query="${FAKE_TOKEN}"`,
      [FAKE_TOKEN],
    )
    assertNotMatch(line, new RegExp(FAKE_TOKEN))
    assertEquals(line.split(REDACTED_TOKEN).length - 1, 3)
  })
})
