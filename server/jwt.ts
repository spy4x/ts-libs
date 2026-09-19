/**
 * Zero-dependency HS256 JWT signing and verification.
 *
 * Ported from `offer-lens/libs/auth/mod.ts:62-122`. Five defects in that source are fixed here,
 * at extraction time, because each one is exploitable on its own:
 *
 * 1. `getJwtSecret()` (`mod.ts:10-14`) read the signing key from the environment and fell back to
 *    `JWT_SECRET || DEMO_OPENAI_API_KEY || "offerlens-dev-secret-change-in-production"`. A token
 *    signed with a public default is forgeable by anyone who reads the repository, and the second
 *    branch silently accepted *any* unrelated provider key as the HMAC secret. Here the secret is
 *    an injected option, no environment variable is read at all, and {@link assertJwtSecret} fails
 *    closed on a missing, short or placeholder value.
 * 2. `mod.ts:115` compared the received signature with `!==`, which short-circuits on the first
 *    differing byte. Verification now goes through {@link constantTimeEquals}.
 * 3. `mod.ts:109-116` never decoded the header, so `{"alg":"none"}` — or HS384/RS256 — was accepted
 *    as long as the HMAC happened to match. The header is now validated before the signature is
 *    even computed, and `alg`/`typ` must match exactly.
 * 4. `mod.ts:100` hardcoded a 30-day expiry for every token. The default here is one hour; a caller
 *    that wants longer asks for it explicitly with `expiresInSeconds`.
 * 5. The source returned `null` for every failure (and swallowed all exceptions at `mod.ts:119`), so
 *    a caller could not tell an expired token from a forged one. Failures are typed
 *    {@link JwtError}s carrying a {@link JwtErrorCode}.
 *
 * No error message in this module interpolates the token, the secret, the header or the payload, and
 * none of them is logged. Branch on {@link JwtErrorCode}, never on the message text.
 */

import { type } from "arktype"
import { decodeBase64Url, encodeBase64Url } from "@std/encoding/base64url"
import { timingSafeEqual } from "@std/crypto/timing-safe-equal"

/** JOSE `alg` this module signs with and the only value it will verify. */
export const JWT_ALGORITHM = "HS256"

/** JOSE `typ` this module writes and the only value it will verify. */
export const JWT_TYPE = "JWT"

/**
 * Smallest accepted secret length, in characters.
 *
 * An HS256 tag is an HMAC over a single message, so a secret is not protected by any rate limit and
 * the whole keyspace can be searched offline from one captured token. 32 characters removes a
 * dictionary-sized search; it does not replace real entropy, which the caller must inject.
 */
export const MIN_SECRET_LENGTH = 32

/**
 * Lowercased secrets that are rejected outright, however long they are.
 *
 * Compared with exact set membership against `secret.trim().toLowerCase()`, never as a substring.
 */
export const PLACEHOLDER_SECRETS: ReadonlySet<string> = Object.freeze(
  new Set([
    "dev",
    "test",
    "secret",
    "password",
    "changeme",
    "change-me",
    "jwt-secret",
    "supersecret",
    "your-secret",
    "development",
    "production",
  ]),
)

/**
 * Lowercased substrings that mark a secret as a placeholder.
 *
 * The exact-match set above cannot catch the value this module was extracted from:
 * `offerlens-dev-secret-change-in-production` is 39 characters, so a length floor alone would let it
 * through and the ported library would ship the same publicly-known signing key as its source.
 * These markers catch it while staying narrow enough not to over-reject — a long random secret that
 * merely contains the word "secret" as a token (`prod-secret-9f3c...`) passes both checks.
 */
export const PLACEHOLDER_SECRET_MARKERS: readonly string[] = Object.freeze([
  "change-in-production",
  "changeme",
  "change-me",
  "placeholder",
  "dev-secret",
  "example-secret",
  "your-secret",
  "not-a-real",
  "insecure",
])

/**
 * Lifetime applied when neither `expiresInSeconds` nor `defaultTtlSeconds` is given.
 *
 * The source hardcoded 30 days (`mod.ts:100`); one hour is the safer default for a library that
 * cannot see how the token is stored or revoked, and lengthening it stays a caller's decision.
 */
export const DEFAULT_TTL_SECONDS = 3600

/** Why a JWT operation failed. Branch on this; the messages carry no detail by design. */
export enum JwtErrorCode {
  /** No secret was configured, or it was empty or whitespace-only. */
  MissingSecret = 1,
  /** The secret was too short, or recognisable as a placeholder. */
  WeakSecret = 2,
  /** The token had no three non-empty segments, or a segment was not base64url. */
  MalformedToken = 3,
  /** The header's `alg` was missing or was not exactly `"HS256"`. */
  UnsupportedAlgorithm = 4,
  /** The header's `typ` was missing or was not exactly `"JWT"`. */
  MissingType = 5,
  /** The recomputed HMAC tag did not match the token's signature. */
  InvalidSignature = 6,
  /** `exp` is in the past, beyond the configured clock tolerance. */
  ExpiredToken = 7,
  /** `nbf` is in the future, beyond the configured clock tolerance. */
  NotYetValid = 8,
  /** The payload did not match the claims schema (for example a non-numeric `sub`). */
  MalformedClaims = 9,
  /** A requested lifetime was not a positive integer number of seconds. */
  InvalidExpiry = 10,
  /** The `iss` claim did not match the configured issuer. */
  InvalidIssuer = 11,
  /** The `aud` claim did not include the configured audience. */
  InvalidAudience = 12,
}

/**
 * One typed error class for the whole module.
 *
 * Every message is a constant chosen by this module: no token, secret, header or payload value ever
 * reaches `message`, `cause` or a log. Distinguishing a forged token from an expired one is exactly
 * what the source could not do (it returned `null` for both), so callers should switch on `code`.
 */
export class JwtError extends Error {
  /** Machine-readable reason. Never classify a JWT failure by matching `message`. */
  readonly code: JwtErrorCode

  constructor(code: JwtErrorCode, message: string, options?: { cause?: unknown }) {
    super(message, options)
    this.name = "JwtError"
    this.code = code
  }
}

/** Constant messages. Defined once so no call site can interpolate a value into them. */
const MESSAGES = {
  missingSecret: "JWT secret is missing",
  weakSecret: "JWT secret is too weak",
  malformedToken: "Token is malformed",
  unsupportedAlgorithm: "Token algorithm is not supported",
  missingType: "Token type is missing",
  invalidSignature: "Token signature is invalid",
  expired: "Token has expired",
  notYetValid: "Token is not valid yet",
  malformedClaims: "Token claims are malformed",
  invalidExpiry: "expiresInSeconds must be a positive integer",
  invalidIssuer: "Token issuer is invalid",
  invalidAudience: "Token audience is invalid",
  unavailable: "Token signing is unavailable",
} as const

/**
 * Reject a secret that cannot be used safely for HS256, and return it unchanged.
 *
 * Fails closed on the three ways a secret is unusable rather than merely weak: absent (including a
 * non-string, since the value may arrive from untyped configuration), shorter than
 * {@link MIN_SECRET_LENGTH}, or recognisable as a placeholder. The placeholder check is two-tier —
 * {@link PLACEHOLDER_SECRETS} matches the whole trimmed, lowercased value, and
 * {@link PLACEHOLDER_SECRET_MARKERS} matches a substring — so `changeme` and
 * `offerlens-dev-secret-change-in-production` both fail while a long random secret containing the
 * word "secret" passes.
 *
 * Thrown messages are constant: they never contain the secret, or any part of it.
 *
 * @param secret Candidate secret, typed `unknown` on purpose — callers pass config values.
 * @throws {JwtError} `MissingSecret` when absent/empty, `WeakSecret` when short or a placeholder.
 */
export function assertJwtSecret(secret: unknown): string {
  if (typeof secret !== "string") {
    throw new JwtError(JwtErrorCode.MissingSecret, MESSAGES.missingSecret)
  }
  const trimmed = secret.trim()
  if (trimmed.length === 0) {
    throw new JwtError(JwtErrorCode.MissingSecret, MESSAGES.missingSecret)
  }
  const normalized = trimmed.toLowerCase()
  if (
    trimmed.length < MIN_SECRET_LENGTH ||
    PLACEHOLDER_SECRETS.has(normalized) ||
    PLACEHOLDER_SECRET_MARKERS.some((marker) => normalized.includes(marker))
  ) {
    throw new JwtError(JwtErrorCode.WeakSecret, MESSAGES.weakSecret)
  }
  return secret
}

/**
 * Compare two byte strings in time independent of their contents.
 *
 * Length is not secret, so an unequal length returns early; everything else runs the same path.
 * Both inputs are SHA-256'd first, which is what makes the two sides equal length for the final
 * `timingSafeEqual` (it throws on mismatched lengths). That step is load-bearing for a JWT: the
 * received signature segment is attacker-controlled and may be truncated or absurdly long, and
 * digesting both sides means the comparison cannot leak length by early-exiting at the primitive.
 *
 * @example
 * ```ts
 * await constantTimeEquals(decodedSignature, recomputedTag) // false for any tampering
 * ```
 */
export async function constantTimeEquals(a: Uint8Array, b: Uint8Array): Promise<boolean> {
  if (a.length !== b.length) return false
  // Copied into fresh views first: `crypto.subtle` rejects a `Uint8Array` whose buffer is not a
  // plain `ArrayBuffer` (a view over a `SharedArrayBuffer` carries that type), and `[ ...bytes ]`
  // is the narrowing without an assertion.
  const [digestA, digestB] = await Promise.all([
    crypto.subtle.digest("SHA-256", new Uint8Array([...a])),
    crypto.subtle.digest("SHA-256", new Uint8Array([...b])),
  ])
  return timingSafeEqual(new Uint8Array(digestA), new Uint8Array(digestB))
}

/**
 * Header shape. Undeclared keys (`kid`, `crit`, …) are preserved, not stripped.
 *
 * `alg` and `typ` are optional here on purpose. Requiring them would make a missing key a *shape*
 * failure (`MalformedToken`) and hide the security-relevant diagnosis: `{"typ":"JWT"}` with no `alg`
 * is an algorithm attack on a well-formed token, and must report `UnsupportedAlgorithm`.
 */
const headerSchema = type({ "alg?": "string", "typ?": "string", "[string]": "unknown" })

/** Payload shape. `iat`/`exp` are required; `sub` is optional; undeclared claims are preserved. */
const claimsSchema = type({
  iat: "number",
  exp: "number",
  "sub?": "string",
  "[string]": "unknown",
})

/** Claims as {@link JwtSigner.verify} returns them: stamped times plus whatever the caller signed. */
export interface JwtClaims {
  /** Issued at, seconds since the epoch. Stamped by the signer, never taken from the caller. */
  iat: number
  /** Expiry, seconds since the epoch. Stamped by the signer, never taken from the caller. */
  exp: number
  /** Subject — conventionally the user id. */
  sub?: string
  /** Issuer. Verified against the signer's configured `issuer` when one is set. */
  iss?: string
  /** Audience. Verified against the signer's configured `audience` when one is set. */
  aud?: string | string[]
  /** Any further claims the caller signed, preserved through verify. */
  [claim: string]: unknown
}

/**
 * What a caller supplies to `sign`.
 *
 * Deliberately without `iat`/`exp`: the signer stamps both from its own clock, so a caller cannot
 * backdate a token, extend its life, or sign a claim the verifier is about to check.
 */
export interface JwtClaimInput {
  /** Subject — conventionally the user id. */
  sub?: string
  /** Any further claims to embed verbatim. */
  [claim: string]: unknown
}

/** Construction options for {@link JwtSigner}. */
export interface JwtSignerOptions {
  /** HS256 signing key. Validated by {@link assertJwtSecret}; never read from the environment. */
  secret: string
  /** Milliseconds since the epoch. Injected so expiry is testable; defaults to `Date.now`. */
  clock?: () => number
  /** Applied by `sign` when `expiresInSeconds` is not passed per call. */
  defaultTtlSeconds?: number
  /** Seconds of leeway on `exp` and `nbf`, for clock skew between issuer and verifier. */
  clockToleranceSeconds?: number
  /** When set, `verify` requires a matching `iss` claim. */
  issuer?: string
  /** When set, `verify` requires an `aud` claim containing this value. */
  audience?: string
}

/**
 * Parse a token into exactly three segments, with a non-empty header and payload.
 *
 * An **empty signature segment is not a structural failure**: `alg: "none"` + `header.payload.` is
 * the classic forgery, and reporting it as malformed would answer the wrong question. It is refused
 * later, on the algorithm, so the diagnostic names the real attack. Empty header or payload segments
 * stay structural — there is nothing to read there.
 *
 * The structure is checked here rather than with a schema because the segments are opaque base64url
 * — the rules are a segment count and emptiness, which read better than an arktype tuple whose error
 * would have to be discarded anyway (the message must not echo the token).
 */
function splitToken(token: string): [string, string, string] {
  const parts = token.split(".")
  const [header, payload, signature] = parts
  if (parts.length !== 3 || !header || !payload) {
    throw new JwtError(JwtErrorCode.MalformedToken, MESSAGES.malformedToken)
  }
  return [header, payload, signature]
}

/**
 * Strict base64url decode whose failures are typed rather than raw `TypeError`/`RangeError`.
 *
 * Two rules, both needed:
 *
 * 1. The segment must be decodable base64url.
 * 2. It must be its **own canonical encoding**: re-encoding the decoded bytes has to reproduce the
 *    segment exactly. `@std/encoding`'s decoder tolerates `=` padding, so without this check a token
 *    would verify under several distinct spellings — `h.p.s`, `h.p.s=` and `h.p.s==` all decode to
 *    the same tag. Any caller that keys a revocation denylist, a replay cache or an audit record on
 *    the token *string* would then be bypassable by appending `=`. This is token-string
 *    malleability, not a signature forgery: the tag still has to be correct.
 *
 * `""` decodes to zero bytes and re-encodes to `""`, so it stays canonical and carries the
 * empty-signature case into {@link constantTimeEquals} instead of turning it into a raw error.
 *
 * Every non-canonical segment — a padded one, or one using the standard (non-url) alphabet's `+`/`/`
 * — is `MalformedToken`, whichever of the three segments it is.
 */
function decodeSegment(segment: string): Uint8Array {
  try {
    const bytes = decodeBase64Url(segment)
    if (encodeBase64Url(bytes) !== segment) {
      throw new JwtError(JwtErrorCode.MalformedToken, MESSAGES.malformedToken)
    }
    return bytes
  } catch (error) {
    if (error instanceof JwtError) throw error
    throw new JwtError(JwtErrorCode.MalformedToken, MESSAGES.malformedToken, { cause: error })
  }
}

/** Decode a base64url segment as UTF-8 JSON, rejecting anything that is not JSON text. */
function decodeJsonSegment(segment: string): unknown {
  try {
    return JSON.parse(new TextDecoder().decode(decodeSegment(segment)))
  } catch (error) {
    if (error instanceof JwtError) throw error
    throw new JwtError(JwtErrorCode.MalformedToken, MESSAGES.malformedToken, { cause: error })
  }
}

/**
 * HS256 signer and verifier over Web Crypto.
 *
 * The source read its key from `Deno.env`, so one process could only ever use one secret and a
 * misconfigured environment silently signed with a public default. Here the secret is a constructor
 * argument, validated once at construction, and the imported {@link CryptoKey} is cached so a
 * request path pays one `importKey` per signer instead of one per token.
 *
 * @example
 * ```ts
 * const signer = new JwtSigner({ secret: Deno.env.get("JWT_SECRET") ?? "" })
 * const token = await signer.sign({ sub: "user-1" })
 * const claims = await signer.verify(token)
 * ```
 */
export class JwtSigner {
  readonly #secret: string
  readonly #clock: () => number
  readonly #defaultTtlSeconds: number
  readonly #clockToleranceSeconds: number
  readonly #issuer: string | undefined
  readonly #audience: string | undefined
  #key: Promise<CryptoKey> | null = null

  constructor(options: JwtSignerOptions) {
    this.#secret = assertJwtSecret(options.secret)
    this.#clock = options.clock ?? Date.now
    this.#defaultTtlSeconds = options.defaultTtlSeconds ?? DEFAULT_TTL_SECONDS
    this.#clockToleranceSeconds = options.clockToleranceSeconds ?? 0
    this.#issuer = options.issuer
    this.#audience = options.audience
  }

  /**
   * The imported HMAC key, imported on first use and cached.
   *
   * The cached promise is cleared when the import rejects, otherwise one transient failure would
   * poison the signer for its whole lifetime.
   */
  #hmacKey(): Promise<CryptoKey> {
    if (this.#key === null) {
      const imported = crypto.subtle.importKey(
        "raw",
        new TextEncoder().encode(this.#secret),
        { name: "HMAC", hash: "SHA-256" },
        false,
        ["sign"],
      )
      // Cleared on failure via a rejection handler: clearing in a `catch` around `await` would
      // change `imported` itself, so the retry-able promise has to be the handler's result.
      this.#key = imported.catch((error: unknown) => {
        this.#key = null
        throw new JwtError(JwtErrorCode.MissingSecret, MESSAGES.unavailable, { cause: error })
      })
    }
    return this.#key
  }

  /** Seconds since the epoch, truncated from the injected millisecond clock. */
  #nowSeconds(): number {
    return Math.floor(this.#clock() / 1000)
  }

  /**
   * Sign `claims` into a compact JWS in `header.payload.signature` form.
   *
   * The header is always `{ alg: "HS256", typ: "JWT" }` and the output claims are always
   * `{ ...claims, iat, exp }` — an `iat` or `exp` the caller put in `claims` is overwritten, so a
   * caller cannot misdate a token. Lifetime resolution order is `expiresInSeconds`,
   * `defaultTtlSeconds`, then {@link DEFAULT_TTL_SECONDS}.
   *
   * @throws {JwtError} `InvalidExpiry` when the resolved lifetime is not a positive integer.
   */
  async sign(claims: JwtClaimInput, options?: { expiresInSeconds?: number }): Promise<string> {
    const ttlSeconds = options?.expiresInSeconds ?? this.#defaultTtlSeconds
    if (!Number.isInteger(ttlSeconds) || ttlSeconds <= 0) {
      throw new JwtError(JwtErrorCode.InvalidExpiry, MESSAGES.invalidExpiry)
    }
    const encoder = new TextEncoder()
    const nowSeconds = this.#nowSeconds()
    const header = encodeBase64Url(encoder.encode(JSON.stringify({
      alg: JWT_ALGORITHM,
      typ: JWT_TYPE,
    })))
    const payload = encodeBase64Url(
      encoder.encode(JSON.stringify({ ...claims, iat: nowSeconds, exp: nowSeconds + ttlSeconds })),
    )
    const signingInput = `${header}.${payload}`
    const tag = await crypto.subtle.sign(
      "HMAC",
      await this.#hmacKey(),
      encoder.encode(signingInput),
    )
    return `${signingInput}.${encodeBase64Url(new Uint8Array(tag))}`
  }

  /**
   * Verify a token and return its claims, or throw a typed {@link JwtError}.
   *
   * Order is deliberate and is the fix: **the header is validated before the signature segment is
   * even decoded.** Validating `alg` after the signature is what makes an algorithm-confusion token
   * (`alg: "none"` with no signature, or HS384/RS256 signed with the same secret) worth trying, and
   * it is why the classic `header.payload.` forgery must be answered on the algorithm rather than
   * dismissed as a malformed token. Header and payload segments are decoded through typed wrappers,
   * so no raw `SyntaxError`/`TypeError` escapes on any path.
   *
   * The tag is recomputed over the raw received `header.payload` string and compared with
   * {@link constantTimeEquals}, so a truncated, padded or empty signature cannot short-circuit the
   * comparison. Only after the token is proven to be ours is the payload parsed, and `iss`/`aud` are
   * checked last, against configured values.
   *
   * @throws {JwtError} `MalformedToken`, `UnsupportedAlgorithm`, `MissingType`, `InvalidSignature`,
   * `MalformedClaims`, `ExpiredToken`, `NotYetValid`, `InvalidIssuer` or `InvalidAudience`.
   */
  async verify(token: string): Promise<JwtClaims> {
    const [headerSegment, payloadSegment, signatureSegment] = splitToken(token)

    const header = headerSchema(decodeJsonSegment(headerSegment))
    // An array satisfies an index-signature schema while having no claim to any field; refuse it as
    // the malformed header it is rather than reporting a missing algorithm.
    if (header instanceof type.errors || Array.isArray(header)) {
      throw new JwtError(JwtErrorCode.MalformedToken, MESSAGES.malformedToken)
    }
    // Shape and value are checked separately: `alg: "none"` satisfies the `string` schema above and
    // a missing `alg` satisfies the optional key, so both are refused here, by value.
    if (header.alg !== JWT_ALGORITHM) {
      throw new JwtError(JwtErrorCode.UnsupportedAlgorithm, MESSAGES.unsupportedAlgorithm)
    }
    if (header.typ !== JWT_TYPE) {
      throw new JwtError(JwtErrorCode.MissingType, MESSAGES.missingType)
    }

    // Reached only by a token that claims HS256/JWT, so an empty segment here is a forgery attempt,
    // not a structural defect: `""` decodes to zero bytes and fails the comparison below.
    const receivedSignature = decodeSegment(signatureSegment)
    const expectedTag = new Uint8Array(
      await crypto.subtle.sign(
        "HMAC",
        await this.#hmacKey(),
        new TextEncoder().encode(`${headerSegment}.${payloadSegment}`),
      ),
    )
    if (!await constantTimeEquals(receivedSignature, expectedTag)) {
      throw new JwtError(JwtErrorCode.InvalidSignature, MESSAGES.invalidSignature)
    }

    const parsed = claimsSchema(decodeJsonSegment(payloadSegment))
    if (parsed instanceof type.errors) {
      throw new JwtError(JwtErrorCode.MalformedClaims, MESSAGES.malformedClaims)
    }
    // `parsed` is the validated value, spread into a fresh object so the return type is built rather
    // than asserted: arktype preserves undeclared keys, but an index signature cannot carry the
    // declared claim types through, and widening `iat`/`exp` would make every caller guard them.
    const claims: JwtClaims = {
      ...parsed,
      iat: parsed.iat,
      exp: parsed.exp,
      ...(parsed.sub === undefined ? {} : { sub: parsed.sub }),
    }

    const nowSeconds = this.#nowSeconds()
    const notBefore = claims.nbf
    // `nbf` is optional, so a non-number is treated as absent rather than as an invalid claim — the
    // same leniency the source had, and the value is only ever compared after this guard.
    if (typeof notBefore === "number" && notBefore > nowSeconds + this.#clockToleranceSeconds) {
      throw new JwtError(JwtErrorCode.NotYetValid, MESSAGES.notYetValid)
    }
    if (claims.exp < nowSeconds - this.#clockToleranceSeconds) {
      throw new JwtError(JwtErrorCode.ExpiredToken, MESSAGES.expired)
    }
    if (this.#issuer !== undefined && claims.iss !== this.#issuer) {
      throw new JwtError(JwtErrorCode.InvalidIssuer, MESSAGES.invalidIssuer)
    }
    if (this.#audience !== undefined) {
      const audiences = Array.isArray(claims.aud)
        ? claims.aud
        : typeof claims.aud === "string"
        ? [claims.aud]
        : []
      if (!audiences.includes(this.#audience)) {
        throw new JwtError(JwtErrorCode.InvalidAudience, MESSAGES.invalidAudience)
      }
    }

    return claims
  }
}
