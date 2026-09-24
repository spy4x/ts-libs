// Tests for token auth. The two behaviours that matter: a token is compared in
// constant time, and a token never reaches a log line.

import { assert, assertEquals, assertNotMatch, assertThrows } from "@std/assert"
import { describe, it } from "@std/testing/bdd"
import {
  bearerTokenFromEnv,
  bearerTokenFromHeaders,
  constantTimeEquals,
  createTokenVerifier,
  formatLogLine,
  REDACTED_TOKEN,
  redactor,
} from "./bearer-auth.ts"

/** An obviously-fake bearer token used across this suite. */
const FAKE_TOKEN = "not-a-real-token"

/** A different token of the same length as {@link FAKE_TOKEN}, for the auth tests. */
const FAKE_TOKEN_WRONG = "not-a-fake-token"

/**
 * Run `action` with `crypto.subtle.digest` instrumented, and report which algorithms and
 * input lengths went through it. Restores the real implementation afterwards.
 */
async function recordDigests(
  action: () => Array<Promise<unknown>>,
): Promise<{ algorithms: string[]; inputs: number[] }> {
  const realDigest = crypto.subtle.digest.bind(crypto.subtle)
  const algorithms: string[] = []
  const inputs: number[] = []
  crypto.subtle.digest = ((algorithm: AlgorithmIdentifier, data: BufferSource) => {
    algorithms.push(String(algorithm))
    inputs.push(new Uint8Array(data as ArrayBuffer).byteLength)
    return realDigest(algorithm, data)
  }) as typeof crypto.subtle.digest

  try {
    await Promise.all(action())
  } finally {
    crypto.subtle.digest = realDigest as typeof crypto.subtle.digest
  }
  return { algorithms, inputs }
}

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

  it("digests both sides on every call, whatever the input length", async () => {
    const { algorithms, inputs } = await recordDigests(() => [
      constantTimeEquals("short", FAKE_TOKEN),
      constantTimeEquals(FAKE_TOKEN, "x".repeat(200)),
    ])

    assertEquals(algorithms, Array(4).fill("SHA-256"))
    assertEquals(inputs, [5, FAKE_TOKEN.length, FAKE_TOKEN.length, 200])
  })

  it("rejects an empty presented token and an empty configured token", async () => {
    assertEquals(await constantTimeEquals("", FAKE_TOKEN), false)
    assertEquals(await constantTimeEquals(FAKE_TOKEN, ""), false)
  })

  it("is a thin, deprecated alias of platform/tokens' constantTimeEqualsText (#71)", async () => {
    // Source-reading rather than behaviour: the tests above already pin every
    // observable behaviour of this function, and they would stay green whether
    // it delegates or reimplements. This test is the one thing that catches a
    // reviewer "helpfully" inlining logic back into the deprecated alias.
    const source = await Deno.readTextFile(new URL("./bearer-auth.ts", import.meta.url))
    assert(
      source.includes('import { constantTimeEqualsText } from "@spy4x/platform/tokens"'),
      "bearer-auth.ts must import constantTimeEqualsText from its home",
    )
    const start = source.indexOf("export async function constantTimeEquals(")
    assert(start >= 0, "constantTimeEquals is no longer declared")
    const bodyStart = source.indexOf("{", start)
    const bodyEnd = source.indexOf("}", bodyStart)
    const body = source.slice(bodyStart, bodyEnd + 1).replace(/\s+/g, " ").trim()
    assertEquals(
      body,
      "{ return await constantTimeEqualsText(presented, expected) }",
      "constantTimeEquals must delegate to constantTimeEqualsText and add no logic of its own",
    )
    assert(
      source.includes("@deprecated Use `constantTimeEqualsText`"),
      "constantTimeEquals must carry a @deprecated JSDoc tag naming its replacement",
    )
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

  it("never compares the plaintext on the production path", async () => {
    // The verifier used to pre-digest the configured token once and digest only the
    // presented one, which made the number of digest calls depend on the secret rather
    // than on the request. Both sides are now hashed per call, so this counts 2 per
    // verification and a short presented token cannot skip the digest.
    //
    // What this establishes, exactly: **which** values reach `crypto.subtle.digest` and how
    // many times — the presented value and the configured token, always both, whatever the
    // presented length. It does **not** establish comparison safety. A comparison of the
    // two digests that is behaviourally equivalent on a digested 32-byte input passes it,
    // and one such comparison is not constant time:
    //
    //   const [p, e] = [await digest(presented), await digest(expected)]
    //   return new TextDecoder().decode(p) === new TextDecoder().decode(e)   // green here
    //
    // Measured: that mutant leaves this file green, 6 passed (26 steps) / 0 failed. Equal
    // bytes decode to equal strings, so no input can separate it from a byte-wise
    // comparison — the two are observationally identical from outside
    // `constantTimeEquals`, and timing is not measurable on a shared runner. So the
    // constant-time property rests on `@std/crypto`'s `timingSafeEqual`, named in
    // `platform/tokens.ts`'s `constantTimeEqualsText` (this file's `constantTimeEquals` is
    // now a deprecated alias of it), and two things carry the safety this test cannot: that call, and
    // digesting both sides first — a leak from a non-constant-time comparison is then a
    // leak of SHA-256 output, not of token bytes. The counting assertions below pin the
    // second half of that; nothing in this suite pins the first.
    const { algorithms, inputs } = await recordDigests(() => [
      createTokenVerifier(FAKE_TOKEN).verify("ab"),
    ])

    assertEquals(algorithms, ["SHA-256", "SHA-256"])
    assertEquals(inputs, [2, FAKE_TOKEN.length])
  })

  it("digests the configured token per call rather than once at construction", async () => {
    // The same production-path property on the axis that a pre-digested secret would show
    // up on: three verifications must be three digest pairs, in order, not one pair and
    // then presented-only digests.
    const { inputs } = await recordDigests(() => [
      createTokenVerifier(FAKE_TOKEN).verify("ab"),
      createTokenVerifier(FAKE_TOKEN).verify("abc"),
      createTokenVerifier(FAKE_TOKEN).verify(FAKE_TOKEN_WRONG),
    ])

    assertEquals(inputs, [
      2,
      FAKE_TOKEN.length,
      3,
      FAKE_TOKEN.length,
      FAKE_TOKEN_WRONG.length,
      FAKE_TOKEN.length,
    ])
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
  it("takes the environment as a required argument, so no import reads it", () => {
    // The one assertion that keeps a credential read out of module scope: calling it
    // without an environment is a type error and a runtime failure, never a silent read of
    // the ambient process environment. The single-argument call is made through a
    // deliberately wrong, locally declared signature — no `any`, and nothing in `src`
    // loses its types for it.
    const wrongArity = bearerTokenFromEnv as unknown as (name: string) => string
    assertThrows(() => wrongArity("MCP_BEARER_TOKEN"), TypeError)
  })

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
