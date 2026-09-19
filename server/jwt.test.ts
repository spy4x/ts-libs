import {
  assert,
  assertEquals,
  assertFalse,
  assertInstanceOf,
  assertMatch,
  assertRejects,
  assertThrows,
} from "@std/assert"
import { describe, it } from "@std/testing/bdd"
import {
  assertJwtSecret,
  constantTimeEquals,
  DEFAULT_TTL_SECONDS,
  JWT_ALGORITHM,
  JWT_TYPE,
  JwtError,
  JwtErrorCode,
  JwtSigner,
  MIN_SECRET_LENGTH,
  PLACEHOLDER_SECRET_MARKERS,
  PLACEHOLDER_SECRETS,
} from "./jwt.ts"

/**
 * A long, obviously fake secret. Fixtures are deliberately non-key-shaped: no realistic provider
 * formats, no real-looking entropy — nothing a scanner would flag and nothing that would work.
 */
const TEST_SECRET = "test-secret-not-real-0123456789abcdef"

/** Deterministic clock used by every test, so no assertion depends on wall-clock time. */
const TEST_NOW_MS = Date.UTC(2026, 0, 15, 12, 0, 0) // 2026-01-15T12:00:00Z
const TEST_NOW_SECONDS = TEST_NOW_MS / 1000

/** Signer with an injected clock; options override the defaults. */
function makeSigner(options: Partial<ConstructorParameters<typeof JwtSigner>[0]> = {}): JwtSigner {
  return new JwtSigner({ secret: TEST_SECRET, clock: () => TEST_NOW_MS, ...options })
}

/**
 * Assert a rejection is the expected typed failure, without ever matching on message text.
 */
async function assertJwtError(
  promise: Promise<unknown>,
  code: JwtErrorCode,
): Promise<JwtError> {
  const error = await assertRejects(() => promise, JwtError)
  assertEquals(error.code, code)
  return error
}

const encoder = new TextEncoder()

function encodeSegment(value: unknown): string {
  return btoa(JSON.stringify(value)).replace(/=/g, "").replace(/\+/g, "-").replace(/\//g, "_")
}

function decodeSegment(segment: string): string {
  const base64 = segment.replace(/-/g, "+").replace(/_/g, "/").padEnd(
    segment.length + (4 - segment.length % 4) % 4,
    "=",
  )
  return atob(base64)
}

/**
 * Mint a well-signed token with an arbitrary header, using the same HMAC primitive the signer uses.
 *
 * Shared by the `alg`/`typ` cases on purpose: those tests assert on a token this helper produced, so
 * they cannot pass because a helper was defined and never called. The payload is returned so a test
 * can show the forged token's claims were intact — rejected for the header, not for the payload.
 */
async function mintWithHeader(
  header: Record<string, unknown>,
  payload: Record<string, unknown>,
): Promise<{ token: string; payload: Record<string, unknown> }> {
  const key = await crypto.subtle.importKey(
    "raw",
    encoder.encode(TEST_SECRET),
    { name: "HMAC", hash: "SHA-256" },
    false,
    ["sign"],
  )
  const signingInput = `${encodeSegment(header)}.${encodeSegment(payload)}`
  const tag = await crypto.subtle.sign("HMAC", key, encoder.encode(signingInput))
  const signature = btoa(String.fromCharCode(...new Uint8Array(tag)))
    .replace(/=/g, "")
    .replace(/\+/g, "-")
    .replace(/\//g, "_")
  return { token: `${signingInput}.${signature}`, payload }
}

/**
 * A signed token over a fixed clock, for the header table.
 *
 * Built with `sign` and a rewritten header rather than by hand, so the HMAC the verifier is about to
 * recompute is genuine and the table can only pass or fail on the header rules.
 */
async function tokenWithHeader(
  header: Record<string, unknown>,
  claims: Record<string, unknown>,
): Promise<string> {
  const token = await makeSigner().sign(claims)
  const [, payload] = segments(token)
  return `${encodeSegment(header)}.${payload}.${segments(token)[2]}`
}

/** Split a token into its three raw segments; throws on a malformed token. */
function segments(token: string): [string, string, string] {
  const parts = token.split(".")
  if (parts.length !== 3) throw new Error("test helper expected a three-segment token")
  return [parts[0], parts[1], parts[2]]
}

/**
 * Slice the body of a function or method out of the module's own source, by brace matching.
 *
 * Used by the source-inspection tests below, which exist because a *behavioural* test cannot tell
 * `timingSafeEqual` from a byte loop that returns the same answers — every one of those assertions
 * passes either way. Anchoring on the source is the only thing that distinguishes them.
 *
 * The body is opened by the first `{` **after** the name, not the last one before it: JSDoc contains
 * braces of its own (`{@link constantTimeEquals}`), and those precede the declaration.
 */
async function sliceBody(name: string): Promise<string> {
  const source = await Deno.readTextFile(new URL("./jwt.ts", import.meta.url))
  const at = source.indexOf(name)
  assert(at >= 0, `${name} not found in jwt.ts`)
  const bodyStart = source.indexOf("{", at)
  assert(bodyStart >= 0, `could not find the body of ${name}`)
  let depth = 0
  for (let i = bodyStart; i < source.length; i++) {
    if (source[i] === "{") depth++
    else if (source[i] === "}") {
      depth--
      if (depth === 0) {
        const body = source.slice(bodyStart + 1, i)
        assert(body.trim().length > 0, `sliced an empty body for ${name}`)
        return body
      }
    }
  }
  throw new Error(`could not slice the body of ${name}`)
}

/** Strip block and line comments, so a source-inspection test reads code and not prose. */
function stripComments(source: string): string {
  return source.replace(/\/\*[\s\S]*?\*\//g, "").replace(/^\s*\/\/.*$/gm, "")
}

describe("assertJwtSecret", () => {
  it("rejects a non-string or blank secret as missing", () => {
    for (const candidate of [undefined, null, "", "   ", "\t\n", 42, {}]) {
      const error = assertThrows(() => assertJwtSecret(candidate), JwtError)
      assertEquals(error.code, JwtErrorCode.MissingSecret, JSON.stringify(candidate))
    }
  })

  it("accepts a secret of at least the minimum length", () => {
    const shortest = "a".repeat(MIN_SECRET_LENGTH)
    assertEquals(MIN_SECRET_LENGTH, 32)
    assertEquals(assertJwtSecret(shortest), shortest)
    assertEquals(assertJwtSecret(TEST_SECRET), TEST_SECRET)
  })

  it("rejects a secret one character under the minimum length", () => {
    const error = assertThrows(() => assertJwtSecret("a".repeat(31)), JwtError)
    assertEquals(error.code, JwtErrorCode.WeakSecret)
  })

  it("rejects placeholder secrets that are long enough by length alone", () => {
    for (const placeholder of ["dev", "test", "secret", "changeme", "change-me", "password"]) {
      const error = assertThrows(() => assertJwtSecret(placeholder), JwtError)
      assertEquals(error.code, JwtErrorCode.WeakSecret, placeholder)
    }
  })

  it("rejects the source's own hardcoded default even though it is 39 characters", () => {
    const sourceDefault = "offerlens-dev-secret-change-in-production"
    assert(
      sourceDefault.length >= MIN_SECRET_LENGTH,
      "fixture is not long enough to isolate the rule",
    )
    const error = assertThrows(() => assertJwtSecret(sourceDefault), JwtError)
    assertEquals(error.code, JwtErrorCode.WeakSecret)
  })

  it("rejects marker-bearing secrets regardless of surrounding entropy", () => {
    const marked = [
      "prod-placeholder-0123456789abcdef",
      "example-secret-0123456789abcdef",
      "not-a-real-secret-0123456789abcdef",
      "insecure-0123456789abcdefghijkl",
      "your-secret-value-0123456789ab",
    ]
    for (const candidate of marked) {
      const error = assertThrows(() => assertJwtSecret(candidate), JwtError)
      assertEquals(error.code, JwtErrorCode.WeakSecret, candidate)
    }
  })

  it("accepts a long random secret that merely contains the word secret", () => {
    const tokens = [
      "K7fQ2mZp9xVt4LrB8sNc3Wdy6Hjo0EuQ",
      "prod-secret-9f3c1a4b7d2e8c5f0b6a3d9e",
      "s3cr3t-material-9f3c1a4b7d2e8c5f0b6a",
    ]
    for (const candidate of tokens) {
      assertEquals(assertJwtSecret(candidate), candidate, candidate)
    }
  })

  it("keeps its rule sets frozen, lowercase and inspectable", () => {
    assert(PLACEHOLDER_SECRETS.has("changeme"))
    assert(PLACEHOLDER_SECRET_MARKERS.includes("change-in-production"))
    assert(Object.isFrozen(PLACEHOLDER_SECRET_MARKERS))
    for (const value of PLACEHOLDER_SECRETS) assertEquals(value, value.toLowerCase())
    for (const marker of PLACEHOLDER_SECRET_MARKERS) assertEquals(marker, marker.toLowerCase())
  })

  it("never echoes the rejected secret in its message", () => {
    const weak = "0123456789abcdef0123456789abc" // 31 characters, so too short
    const error = assertThrows(() => assertJwtSecret(weak), JwtError)
    assertEquals(error.code, JwtErrorCode.WeakSecret)
    assertFalse(error.message.includes(weak))
    assertFalse(error.message.includes(weak.slice(0, 8)))
  })
})

describe("JwtSigner construction", () => {
  it("throws MissingSecret when constructed with an empty secret", () => {
    const error = assertThrows(() => new JwtSigner({ secret: "" }), JwtError)
    assertEquals(error.code, JwtErrorCode.MissingSecret)
  })

  it("does not accept the source's environment fallback default", () => {
    const error = assertThrows(
      () => new JwtSigner({ secret: "offerlens-dev-secret-change-in-production" }),
      JwtError,
    )
    assertEquals(error.code, JwtErrorCode.WeakSecret)
  })

  it("never reads a signing secret from the environment", async () => {
    const source = await Deno.readTextFile(new URL("./jwt.ts", import.meta.url))
    // Only executable source is inspected: the JSDoc *tells a caller* to pass an env value in, which
    // is the point of the fix, and a comment cannot read anything.
    const code = stripComments(source)
    // Split so this assertion does not match its own literal.
    const globalObject = "Deno"
    for (const member of [".env", "env.get"]) {
      assertFalse(
        code.includes(`${globalObject}${member}`),
        `jwt.ts reads ${globalObject}${member}`,
      )
    }
  })
})

describe("JwtSigner.sign and verify", () => {
  it("signs and verifies a round trip with an injected clock", async () => {
    const signer = makeSigner()
    const claims = { sub: "user-1", email: "user@example.com" }
    const token = await signer.sign(claims)
    const verified = await signer.verify(token)
    assertEquals(verified.sub, "user-1")
    assertEquals(verified.email, "user@example.com")
    assertEquals(verified.iat, TEST_NOW_SECONDS)
    assertEquals(verified.exp, TEST_NOW_SECONDS + DEFAULT_TTL_SECONDS)
  })

  it("writes an HS256 JWT header", async () => {
    const token = await makeSigner().sign({ sub: "user-1" })
    const [headerSegment] = segments(token)
    assertEquals(JSON.parse(decodeSegment(headerSegment)), { alg: JWT_ALGORITHM, typ: JWT_TYPE })
  })

  it("stamps its own iat and exp, ignoring what the caller passed", async () => {
    const signer = makeSigner()
    const token = await signer.sign({ sub: "user-1", iat: 1, exp: 2 })
    const verified = await signer.verify(token)
    assertEquals(verified.iat, TEST_NOW_SECONDS)
    assertEquals(verified.exp, TEST_NOW_SECONDS + DEFAULT_TTL_SECONDS)
  })

  it("applies expiresInSeconds over defaultTtlSeconds and the module default", async () => {
    const withDefault = makeSigner({ defaultTtlSeconds: 120 })
    assertEquals(
      (await withDefault.verify(await withDefault.sign({ sub: "u" }))).exp,
      TEST_NOW_SECONDS + 120,
    )
    assertEquals(
      (await withDefault.verify(await withDefault.sign({ sub: "u" }, { expiresInSeconds: 5 }))).exp,
      TEST_NOW_SECONDS + 5,
    )
    const withoutDefault = makeSigner()
    assertEquals(
      (await withoutDefault.verify(await withoutDefault.sign({ sub: "u" }))).exp,
      TEST_NOW_SECONDS + DEFAULT_TTL_SECONDS,
    )
  })

  it("rejects a lifetime that is not a positive integer", async () => {
    const signer = makeSigner()
    for (const expiresInSeconds of [0, -1, 1.5]) {
      const error = await assertJwtError(
        signer.sign({ sub: "u" }, { expiresInSeconds }),
        JwtErrorCode.InvalidExpiry,
      )
      assertEquals(error.code, JwtErrorCode.InvalidExpiry, String(expiresInSeconds))
    }
  })

  it("signs the same claims to different tokens when the clock moves", async () => {
    const first = new JwtSigner({ secret: TEST_SECRET, clock: () => TEST_NOW_MS })
    const second = new JwtSigner({ secret: TEST_SECRET, clock: () => TEST_NOW_MS + 1000 })
    assertFalse(await first.sign({ sub: "u" }) === await second.sign({ sub: "u" }))
  })
})

describe("JwtSigner.verify token structure", () => {
  it("rejects a token that is not three segments", async () => {
    const signer = makeSigner()
    const token = await signer.sign({ sub: "u" })
    const [header, payload, signature] = segments(token)
    const malformed = [
      "",
      "not-a-token",
      `${header}.${payload}`,
      `${header}.${payload}.${signature}.`,
      `${header}.${payload}.${signature}.extra`,
      `${header}..${signature}`,
      `.${payload}.${signature}`,
    ]
    for (const candidate of malformed) {
      const error = await assertJwtError(signer.verify(candidate), JwtErrorCode.MalformedToken)
      assertEquals(error.code, JwtErrorCode.MalformedToken, candidate)
    }
  })

  it("rejects a signature segment that is not base64url", async () => {
    const signer = makeSigner()
    const [header, payload] = segments(await signer.sign({ sub: "u" }))
    const error = await assertJwtError(
      signer.verify(`${header}.${payload}.not base64url!`),
      JwtErrorCode.MalformedToken,
    )
    assertFalse(error instanceof TypeError)
  })

  it("rejects a non-canonical base64url segment, so one token has one spelling", async () => {
    const signer = makeSigner()
    const token = await signer.sign({ sub: "u" })
    const [header, payload, signature] = segments(token)

    // The decoder tolerates `=` padding, so `h.p.s`, `h.p.s=` and `h.p.s==` used to be three
    // accepted spellings of one token — which defeats any denylist, replay cache or audit record
    // keyed on the token string. Padding must be structural, not a second valid encoding.
    for (const padded of [`${signature}=`, `${signature}==`, `${signature}===`]) {
      const error = await assertJwtError(
        signer.verify(`${header}.${payload}.${padded}`),
        JwtErrorCode.MalformedToken,
      )
      assertEquals(error.code, JwtErrorCode.MalformedToken, padded)
    }

    // A padded *header* is refused structurally, because the header is decoded before the tag is
    // computed. A padded *payload* cannot be: it changes the signing input, so the recomputed tag
    // already differs and the payload is never parsed — rejected either way, one code earlier than
    // the structural rule.
    await assertJwtError(
      signer.verify(`${header}=.${payload}.${signature}`),
      JwtErrorCode.MalformedToken,
    )
    await assertJwtError(
      signer.verify(`${header}.${payload}=.${signature}`),
      JwtErrorCode.InvalidSignature,
    )

    // The canonical spelling still verifies: the rule rejects other encodings, not this one.
    assertEquals((await signer.verify(`${header}.${payload}.${signature}`)).sub, "u")
  })

  it("rejects a header that is not JSON", async () => {
    const signer = makeSigner()
    const [, payload, signature] = segments(await signer.sign({ sub: "u" }))
    const brokenHeader = encodeSegment({ alg: 1, typ: 2 })
    const error = await assertJwtError(
      signer.verify(`${brokenHeader}.${payload}.${signature}`),
      JwtErrorCode.MalformedToken,
    )
    assertEquals(error.code, JwtErrorCode.MalformedToken)
  })
})

describe("JwtSigner.verify header validation", () => {
  it("refuses an alg none forgery on the algorithm, with or without a signature segment", async () => {
    const { payload, token } = await mintWithHeader(
      { alg: "none", typ: "JWT" },
      { sub: "user-1", iat: TEST_NOW_SECONDS, exp: TEST_NOW_SECONDS + 60 },
    )
    const [header, body, intactSignature] = segments(token)
    assertEquals(payload.sub, "user-1")
    // The classic forgery: real signature removed. The diagnostic must name the attack, not the
    // token's shape — an empty segment is not what makes this token dangerous, `alg: none` is.
    await assertJwtError(
      makeSigner().verify(`${header}.${body}.`),
      JwtErrorCode.UnsupportedAlgorithm,
    )
    // Stripped to a single character, and with the original HS256 signature intact: rewriting `alg`
    // must not make a token the verifier would otherwise accept any easier to forge.
    for (const signature of ["x", intactSignature]) {
      const error = await assertJwtError(
        makeSigner().verify(`${header}.${body}.${signature}`),
        JwtErrorCode.UnsupportedAlgorithm,
      )
      assertEquals(error.code, JwtErrorCode.UnsupportedAlgorithm, signature.slice(0, 8))
    }
  })

  it("refuses every algorithm but HS256", async () => {
    const table: { alg: string; payload: Record<string, unknown> }[] = [
      { alg: "HS384", payload: { sub: "u" } },
      { alg: "RS256", payload: { sub: "u" } },
      { alg: "none", payload: { sub: "u" } },
      { alg: "", payload: { sub: "u" } },
    ]
    for (const { alg, payload } of table) {
      const token = await tokenWithHeader({ alg, typ: "JWT" }, payload)
      // Intact payload, real HMAC over the received segments — only the header was rewritten.
      await assertJwtError(makeSigner().verify(token), JwtErrorCode.UnsupportedAlgorithm)
    }
  })

  it("refuses a header with no alg key on the algorithm, not on the shape", async () => {
    const token = await tokenWithHeader(
      { typ: "JWT" },
      { sub: "user-1", iat: TEST_NOW_SECONDS, exp: TEST_NOW_SECONDS + 60 },
    )
    const error = await assertJwtError(
      makeSigner().verify(token),
      JwtErrorCode.UnsupportedAlgorithm,
    )
    assertEquals(error.code, JwtErrorCode.UnsupportedAlgorithm)
  })

  it("refuses a missing or wrong typ with MissingType", async () => {
    // `typ` was never checked at all in the source (`mod.ts:109-116`), so a `typ: "JWS"` token was
    // accepted. `jwt` is lowercase on purpose: the comparison is exact, not case-insensitive.
    for (const typ of [undefined, "JWS", "jwt"]) {
      const header = typ === undefined ? { alg: "HS256" } : { alg: "HS256", typ }
      const token = await tokenWithHeader(
        header,
        { sub: "user-1", iat: TEST_NOW_SECONDS, exp: TEST_NOW_SECONDS + 60 },
      )
      const error = await assertJwtError(makeSigner().verify(token), JwtErrorCode.MissingType)
      assertEquals(error.code, JwtErrorCode.MissingType, String(typ))
    }
  })

  it("returns the claims of a valid token", async () => {
    const signer = makeSigner()
    const token = await signer.sign({ sub: "user-1" })
    assertEquals((await signer.verify(token)).sub, "user-1")
  })

  it("rejects an empty signature on an otherwise valid header as an invalid signature", async () => {
    const signer = makeSigner()
    const [header, payload] = segments(await signer.sign({ sub: "user-1" }))
    // Not MalformedToken: the header is well formed and claims HS256, so this reached the comparison
    // (zero bytes vs the 32-byte tag) and failed it.
    await assertJwtError(signer.verify(`${header}.${payload}.`), JwtErrorCode.InvalidSignature)
  })

  it("keeps verifying a token with extra header keys such as kid", async () => {
    const signer = makeSigner()
    const { token } = await mintWithHeader(
      { alg: "HS256", typ: "JWT", kid: "key-1" },
      { sub: "user-1", iat: TEST_NOW_SECONDS, exp: TEST_NOW_SECONDS + 60 },
    )
    assertEquals((await signer.verify(token)).sub, "user-1")
  })
})

describe("JwtSigner.verify signature and claims", () => {
  it("rejects a tampered payload", async () => {
    const signer = makeSigner()
    const token = await signer.sign({ sub: "user-1" })
    const [header, , signature] = segments(token)
    const forged = encodeSegment({
      sub: "admin",
      iat: TEST_NOW_SECONDS,
      exp: TEST_NOW_SECONDS + 60,
    })
    const error = await assertJwtError(
      signer.verify(`${header}.${forged}.${signature}`),
      JwtErrorCode.InvalidSignature,
    )
    assertFalse(error instanceof TypeError)
  })

  it("rejects a truncated signature segment as InvalidSignature, not MalformedToken", async () => {
    const signer = makeSigner()
    const [header, payload, signature] = segments(await signer.sign({ sub: "user-1" }))
    const error = await assertJwtError(
      signer.verify(`${header}.${payload}.${signature.slice(0, 16)}`),
      JwtErrorCode.InvalidSignature,
    )
    assertEquals(error.code, JwtErrorCode.InvalidSignature)
  })

  it("rejects a signature from another secret", async () => {
    const signer = makeSigner()
    const foreignSigner = new JwtSigner({
      secret: "another-test-secret-0123456789abcdef",
      clock: () => TEST_NOW_MS,
    })
    // Same claims, a key the verifier does not hold: only the tag differs.
    const [header, payload] = segments(await signer.sign({ sub: "user-1" }))
    const foreign = segments(await foreignSigner.sign({ sub: "user-1" }))[2]
    await assertJwtError(
      signer.verify(`${header}.${payload}.${foreign}`),
      JwtErrorCode.InvalidSignature,
    )
  })

  it("rejects a payload whose declared claims have the wrong type", async () => {
    const signer = makeSigner()
    const { token } = await mintWithHeader(
      { alg: "HS256", typ: "JWT" },
      { sub: 42, iat: TEST_NOW_SECONDS, exp: TEST_NOW_SECONDS + 60 },
    )
    const error = await assertJwtError(signer.verify(token), JwtErrorCode.MalformedClaims)
    assertFalse(error.message.includes("42"))
  })

  it("rejects a payload without iat or exp", async () => {
    const signer = makeSigner()
    for (
      const payload of [{ sub: "user-1" }, { iat: TEST_NOW_SECONDS }, {
        exp: TEST_NOW_SECONDS + 60,
      }]
    ) {
      const { token } = await mintWithHeader({ alg: "HS256", typ: "JWT" }, payload)
      await assertJwtError(signer.verify(token), JwtErrorCode.MalformedClaims)
    }
  })

  it("preserves extra claims on the returned object", async () => {
    const signer = makeSigner()
    const token = await signer.sign({ sub: "user-1", anon: false, roles: ["admin"] })
    const verified = await signer.verify(token)
    assertEquals(verified.anon, false)
    assertEquals(verified.roles, ["admin"])
    assertEquals(verified.sub, "user-1")
  })
})

describe("JwtSigner.verify time claims", () => {
  it("rejects an expired token", async () => {
    const signer = makeSigner()
    const token = await signer.sign({ sub: "u" }, { expiresInSeconds: 60 })
    const later = makeSigner({ clock: () => TEST_NOW_MS + 61_000 })
    await assertJwtError(later.verify(token), JwtErrorCode.ExpiredToken)
  })

  it("accepts a token at exp exactly when the clock tolerance covers it", async () => {
    const tolerant = makeSigner({ clockToleranceSeconds: 60 })
    const token = await tolerant.sign({ sub: "u" }, { expiresInSeconds: 60 })
    const strictLater = makeSigner({ clock: () => TEST_NOW_MS + 120_000 })
    await assertJwtError(strictLater.verify(token), JwtErrorCode.ExpiredToken)
    const tolerantLater = makeSigner({
      clock: () => TEST_NOW_MS + 120_000,
      clockToleranceSeconds: 60,
    })
    assertEquals((await tolerantLater.verify(token)).sub, "u")
  })

  it("accepts a token at exp exactly when no tolerance is configured", async () => {
    const atExp = makeSigner({ clock: () => TEST_NOW_MS + 60_000 })
    const token = await makeSigner().sign({ sub: "u" }, { expiresInSeconds: 60 })
    assertEquals((await atExp.verify(token)).sub, "u")
    // One second later it is expired, so the boundary is exact rather than generous.
    await assertJwtError(
      makeSigner({ clock: () => TEST_NOW_MS + 61_000 }).verify(token),
      JwtErrorCode.ExpiredToken,
    )
  })

  it("rejects a token whose nbf is in the future", async () => {
    const signer = makeSigner()
    const { token } = await mintWithHeader(
      { alg: "HS256", typ: "JWT" },
      { sub: "u", iat: TEST_NOW_SECONDS, exp: TEST_NOW_SECONDS + 60, nbf: TEST_NOW_SECONDS + 30 },
    )
    await assertJwtError(signer.verify(token), JwtErrorCode.NotYetValid)
  })

  it("accepts a past nbf", async () => {
    const signer = makeSigner()
    const { token } = await mintWithHeader(
      { alg: "HS256", typ: "JWT" },
      { sub: "u", iat: TEST_NOW_SECONDS, exp: TEST_NOW_SECONDS + 60, nbf: TEST_NOW_SECONDS - 30 },
    )
    assertEquals((await signer.verify(token)).sub, "u")
  })
})

describe("JwtSigner.verify issuer and audience", () => {
  it("rejects a mismatched issuer and accepts a matching one", async () => {
    const signer = makeSigner({ issuer: "https://issuer.example.com" })
    const good = await signer.sign({ sub: "u", iss: "https://issuer.example.com" })
    assertEquals((await signer.verify(good)).iss, "https://issuer.example.com")
    const wrong = await signer.sign({ sub: "u", iss: "https://attacker.example.com" })
    await assertJwtError(signer.verify(wrong), JwtErrorCode.InvalidIssuer)
    const absent = await signer.sign({ sub: "u" })
    await assertJwtError(signer.verify(absent), JwtErrorCode.InvalidIssuer)
  })

  it("rejects a mismatched audience and accepts a string or array match", async () => {
    const signer = makeSigner({ audience: "https://app.example.com" })
    const asString = await signer.sign({ sub: "u", aud: "https://app.example.com" })
    assertEquals((await signer.verify(asString)).aud, "https://app.example.com")
    const asArray = await signer.sign({
      sub: "u",
      aud: ["https://other.example.com", "https://app.example.com"],
    })
    assertEquals(Array.isArray((await signer.verify(asArray)).aud), true)
    const wrong = await signer.sign({ sub: "u", aud: ["https://other.example.com"] })
    await assertJwtError(signer.verify(wrong), JwtErrorCode.InvalidAudience)
    const absent = await signer.sign({ sub: "u" })
    await assertJwtError(signer.verify(absent), JwtErrorCode.InvalidAudience)
  })

  it("skips issuer and audience checks when none are configured", async () => {
    const signer = makeSigner()
    const token = await signer.sign({ sub: "u", iss: "https://anywhere.example.com" })
    assertEquals((await signer.verify(token)).sub, "u")
  })
})

describe("JwtError", () => {
  it("is an Error carrying a code", () => {
    const error = new JwtError(JwtErrorCode.InvalidSignature, "Token signature is invalid")
    assertInstanceOf(error, Error)
    assertEquals(error.name, "JwtError")
    assertEquals(error.code, JwtErrorCode.InvalidSignature)
  })

  it("keeps signature failures free of the token, the secret and the payload", async () => {
    const signer = makeSigner()
    const [header, payload, signature] = segments(await signer.sign({ sub: "subject-1" }))
    const error = await assertJwtError(
      signer.verify(`${header}.${payload}.${signature.slice(0, 16)}`),
      JwtErrorCode.InvalidSignature,
    )
    for (
      const leak of [header, payload, signature, TEST_SECRET, TEST_SECRET.slice(0, 8), "subject-1"]
    ) {
      assertFalse(error.message.includes(leak), `message leaked ${leak}`)
      assertFalse(String(error.cause ?? "").includes(leak), `cause leaked ${leak}`)
    }
    assertEquals(error.message, "Token signature is invalid")
  })

  it("keeps malformed-token failures free of the token", async () => {
    const signer = makeSigner()
    const error = await assertJwtError(
      signer.verify("not-base64url!.@@@.###"),
      JwtErrorCode.MalformedToken,
    )
    for (const leak of ["not-base64url!", "@@@", "###", TEST_SECRET]) {
      assertFalse(error.message.includes(leak), `message leaked ${leak}`)
    }
    assertEquals(error.message, "Token is malformed")
  })
})

describe("constantTimeEquals", () => {
  it("returns true for equal bytes", async () => {
    assertEquals(
      await constantTimeEquals(new Uint8Array([1, 2, 3]), new Uint8Array([1, 2, 3])),
      true,
    )
    assertEquals(await constantTimeEquals(new Uint8Array(0), new Uint8Array(0)), true)
    const tag = new Uint8Array(await crypto.subtle.digest("SHA-256", encoder.encode("tag")))
    assertEquals(await constantTimeEquals(tag, tag.slice()), true)
  })

  it("returns false for a single flipped bit", async () => {
    const left = new Uint8Array([0, 0, 0, 0])
    for (const index of [0, 3]) {
      const right = left.slice()
      right[index] = 1
      assertEquals(await constantTimeEquals(left, right), false, `bit flip at ${index}`)
    }
    const tag = new Uint8Array(await crypto.subtle.digest("SHA-256", encoder.encode("tag")))
    const tampered = tag.slice()
    tampered[31] += 1
    assertEquals(await constantTimeEquals(tag, tampered), false)
  })

  it("returns false for different lengths instead of throwing", async () => {
    assertEquals(await constantTimeEquals(new Uint8Array(0), new Uint8Array(32)), false)
    assertEquals(await constantTimeEquals(new Uint8Array(32), new Uint8Array(0)), false)
    assertEquals(await constantTimeEquals(new Uint8Array(16), new Uint8Array(32)), false)
    assertEquals(await constantTimeEquals(new Uint8Array(4096), new Uint8Array(1)), false)
  })

  it("is the only comparison the primitive performs", async () => {
    // The behavioural tests above cannot pin this: a plain byte loop answers every one of those
    // assertions identically, so the constant-time property would rest on nothing but the import.
    // The body is read with comments stripped, so quoting `timingSafeEqual(` in a comment while
    // looping over the bytes does not satisfy it either.
    const body = stripComments(await sliceBody("export async function constantTimeEquals("))

    assertMatch(body, /return timingSafeEqual\(/)

    // The primitive must be the imported one, not something shadowed locally.
    const module = await Deno.readTextFile(new URL("./jwt.ts", import.meta.url))
    assertMatch(
      stripComments(module),
      /import \{[^}]*\btimingSafeEqual\b[^}]*\} from "@std\/crypto\/timing-safe-equal"/,
    )

    // No manual byte work: no per-byte read, no accumulation with XOR/OR.
    assertFalse(body.includes("charCodeAt"), "the primitive reads bytes by hand")
    assertFalse(body.includes("^="), "the primitive accumulates differences with ^=")
    assertFalse(body.includes("|="), "the primitive accumulates differences with |=")

    // Exactly one comparison operator per line is expected — the length guard — so anything beyond
    // it is a second, hand-rolled comparison of the digest bytes. Asserted precisely rather than as
    // a blanket ban, because the early return on unequal length is allowed and required.
    const comparisons = body.match(/(?<![=!])(?:===|!==)(?!=)/g) ?? []
    assertEquals(comparisons.length, 1, `unexpected comparison operators: ${comparisons.join(" ")}`)
    assertMatch(body, /if \(a\.length !== b\.length\) return false/)
  })
})

describe("verify call site", () => {
  it("goes through the constant-time comparison", async () => {
    // Comments are stripped first, on purpose: a mutation that replaces the compare with a string
    // equality *and adds a comment mentioning* `constantTimeEquals(` satisfied the previous version
    // of this test (11/11 green with production no longer using the primitive).
    const body = stripComments(await sliceBody("async verify("))
    assertMatch(
      body,
      /!await constantTimeEquals\(\s*receivedSignature\s*,\s*expectedTag\s*\)/,
    )
    // Belt and braces: the tag must not be compared by value with either operator.
    for (const operator of ["===", "!=="]) {
      assertFalse(
        new RegExp(`(receivedSignature|expectedTag)[^\\n]*${operator}`).test(body),
        `verify compares the tag with ${operator}`,
      )
    }
  })
})
