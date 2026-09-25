/**
 * Signed payload codec: a small JSON value, bound to a purpose and signed with HMAC-SHA-256,
 * carried as one URL-safe string.
 *
 * Built for two consumers that each hand-rolled the same primitive (#202): the template's
 * group-list pagination cursor and the unsubscribe link on antonshubin.com. A token is
 *
 * ```
 * base64url(JSON envelope) + "." + base64url(HMAC-SHA-256(secret, MAC input))
 * ```
 *
 * The envelope is `{ purpose, version, payload }` plus `expiresAt` (Unix milliseconds) when the
 * token expires. The MAC input is a fixed domain tag, the length-prefixed bound context and the
 * encoded envelope, so the purpose, the version, the expiry and the payload are all signed.
 *
 * The bound context works like associated data in an AEAD cipher: the MAC covers it, the token
 * does not carry it, and the verifier must supply the same value again. A cursor binds the
 * signed-in user id that way, so a cursor copied to another account fails its signature check, and
 * an unsubscribe link binds the subscriber's address, so the address never appears in the URL.
 *
 * @example Pagination cursor bound to the signed-in user
 * ```ts
 * const cursors = createSignedPayloadCodec({
 *   secret: "example-secret-at-least-32-characters",
 *   purpose: "groups.list",
 *   version: 1,
 *   schema: type({ updatedAt: "string.date.iso", id: "string.uuid", "+": "reject" }),
 * })
 * const pageKey = { updatedAt: "2026-09-25T00:00:00.000Z", id: crypto.randomUUID() }
 * const cursor = await cursors.sign(pageKey, { context: String(userId) })
 * const page = await cursors.verify(cursor, { context: String(userId) })
 * if (!page.ok) throw new Error(`invalid cursor: ${page.error}`)
 * ```
 *
 * @example Unsubscribe link that carries no address
 * ```ts
 * const unsubscribe = createSignedPayloadCodec({
 *   secret: "example-secret-at-least-32-characters",
 *   purpose: "unsubscribe",
 *   version: 1,
 *   schema: type({ "+": "reject" }),
 * })
 * // Normalise the address the same way on both sides; the token itself holds no address.
 * const token = await unsubscribe.sign({}, { context: email.trim().toLowerCase() })
 * const result = await unsubscribe.verify(token, { context: email.trim().toLowerCase() })
 * ```
 *
 * @module
 */

import { type Type, type } from "arktype"
import { decodeBase64Url, encodeBase64Url } from "@std/encoding/base64url"
import type { Result } from "./universal/result.ts"
import { assertUsableSecret } from "./token-secret.ts"

/**
 * Why a token was refused. Callers branch on the code, never on a message: a refusal carries no
 * text, so nothing about the token or the secret can leak into a log through it.
 */
export enum SignedPayloadErrorCode {
  /** Not two base64url segments, over {@link MAX_SIGNED_PAYLOAD_LENGTH}, a signature of the wrong
   * width, or a signed envelope that is not the codec's JSON shape. */
  Malformed = 1,
  /** The signature does not match: forged, altered, signed with another secret, or verified with a
   * different bound context than it was signed with. */
  BadSignature = 2,
  /** Signed correctly, but for another purpose. */
  WrongPurpose = 3,
  /** Signed correctly, but its expiry is at or before the codec's clock. */
  Expired = 4,
  /** Signed correctly, but another payload version, or a payload the schema rejects. */
  InvalidPayload = 5,
}

/**
 * Thrown by {@link SignedPayloadCodec.sign} when it would mint a token that `verify` refuses:
 * `InvalidPayload` for a payload that is not JSON or does not survive a JSON round trip through the
 * schema, `Malformed` for a token longer than {@link MAX_SIGNED_PAYLOAD_LENGTH}. Verification never
 * throws it; it returns the code instead.
 */
export class SignedPayloadError extends Error {
  readonly code: SignedPayloadErrorCode

  constructor(code: SignedPayloadErrorCode, message: string, options?: { cause?: unknown }) {
    super(message, options)
    this.name = "SignedPayloadError"
    this.code = code
  }
}

/** Longest token, in characters, that `verify` will decode. Anything longer is `Malformed`. */
export const MAX_SIGNED_PAYLOAD_LENGTH = 4096

/** Settings fixed for the codec's lifetime. */
export interface SignedPayloadCodecOptions<S extends Type> {
  /** HMAC key, at least `MIN_SECRET_LENGTH` printable characters (the rule `tokens.ts` uses). */
  secret: string
  /** What the token is for, e.g. `"groups.list"`. A token verifies only under the same purpose. */
  purpose: string
  /** Payload version, a positive integer. A token of any other version is `InvalidPayload`. */
  version: number
  /**
   * Validates the payload after a JSON round trip, on sign and on verify. arktype objects accept
   * extra keys by default; add `"+": "reject"` to demand an exact key set.
   */
  schema: S
  /**
   * Clock in Unix milliseconds, for expiry. Defaults to `Date.now`; inject one in tests. Read once
   * per call, and only when a lifetime is involved. A value that is not a safe integer makes `sign`
   * throw a `RangeError` and `verify` refuse an expiring token as `Expired`.
   */
  now?: () => number
}

/** Per-token settings for {@link SignedPayloadCodec.sign}. */
export interface SignOptions {
  /**
   * Value the MAC covers but the token does not carry. Absent and `""` are the same context. A
   * string with a lone surrogate is refused: it has no exact UTF-8 form, so it would share a
   * signature with other strings.
   */
  context?: string
  /** Lifetime in milliseconds from the codec's clock, a positive safe integer. Absent: never. */
  ttlMs?: number
}

/** Per-token settings for {@link SignedPayloadCodec.verify}. */
export interface VerifyOptions {
  /**
   * The context the token was signed with. A different one, or one with a lone surrogate, fails as
   * `BadSignature`.
   */
  context?: string
}

/** Signs and verifies one purpose's payloads. Made by {@link createSignedPayloadCodec}. */
export interface SignedPayloadCodec<S extends Type> {
  /**
   * Signs `payload` into a token.
   *
   * @throws {SignedPayloadError} `InvalidPayload` when the payload is not JSON-serialisable (a
   *     `BigInt`, a cycle, `undefined`) or, after a JSON round trip, does not satisfy the schema;
   *     `Malformed` when the token would exceed {@link MAX_SIGNED_PAYLOAD_LENGTH}. Either token
   *     would never verify.
   * @throws {RangeError} When `ttlMs` is not a positive safe integer, the clock does not return a
   *     safe integer, or the clock plus `ttlMs` passes `Number.MAX_SAFE_INTEGER`.
   * @throws {TypeError} When `context` is not a string or holds a lone surrogate.
   */
  sign(payload: S["inferIn"], options?: SignOptions): Promise<string>
  /**
   * Verifies `token` and returns the schema's output. Never throws for any token string: every
   * refusal is a {@link SignedPayloadErrorCode}. The signature is checked before the envelope is
   * parsed, so a forged token is `BadSignature` and its content is never read. After the signature,
   * the purpose is checked, then the expiry, then the version and the schema.
   */
  verify(
    token: string,
    options?: VerifyOptions,
  ): Promise<Result<S["infer"], SignedPayloadErrorCode>>
}

/** Domain tag at the front of every MAC input, so this MAC never equals another scheme's. */
const MAC_DOMAIN = "spy4x.signed-payload.v1"
const SIGNATURE_BYTES = 32
/** Unpadded base64url length of a {@link SIGNATURE_BYTES}-byte signature. */
const SIGNATURE_LENGTH = 43
const BASE64URL_SEGMENT = /^[A-Za-z0-9_-]+$/
const LONE_SURROGATE = /\p{Cs}/u
const encoder = new TextEncoder()
const decoder = new TextDecoder("utf-8", { fatal: true })

const envelopeSchema = type({
  purpose: "string",
  version: "number.integer",
  "expiresAt?": "number.integer",
  payload: "unknown",
  "+": "reject",
})

/**
 * Creates a codec for one purpose, version and schema.
 *
 * @throws {TokenError} `InvalidSecret` when the secret is missing, not printable or shorter than
 *     `MIN_SECRET_LENGTH`.
 * @throws {TypeError} When `purpose` is empty or `version` is not a positive safe integer.
 */
export function createSignedPayloadCodec<S extends Type>(
  options: SignedPayloadCodecOptions<S>,
): SignedPayloadCodec<S> {
  assertUsableSecret(options.secret)
  const { purpose, version, schema } = options
  if (typeof purpose !== "string" || purpose === "") {
    throw new TypeError("purpose must be a non-empty string")
  }
  if (!Number.isSafeInteger(version) || version < 1) {
    throw new TypeError("version must be a positive integer")
  }
  const now = options.now ?? Date.now
  const key = crypto.subtle.importKey(
    "raw",
    encoder.encode(options.secret),
    { name: "HMAC", hash: "SHA-256" },
    false,
    ["sign", "verify"],
  )

  return {
    async sign(payload, signOptions = {}) {
      const { ttlMs, context } = signOptions
      if (ttlMs !== undefined && (!Number.isSafeInteger(ttlMs) || ttlMs < 1)) {
        throw new RangeError("ttlMs must be a positive integer")
      }
      if (!isUsableContext(context)) {
        throw new TypeError("context must be a string without lone surrogates")
      }
      let json: string | undefined
      try {
        json = JSON.stringify(payload)
      } catch (cause) {
        throw new SignedPayloadError(
          SignedPayloadErrorCode.InvalidPayload,
          "payload is not JSON-serialisable",
          { cause },
        )
      }
      if (json === undefined || schema(JSON.parse(json)) instanceof type.errors) {
        throw new SignedPayloadError(
          SignedPayloadErrorCode.InvalidPayload,
          "payload does not satisfy the schema after a JSON round trip",
        )
      }
      let envelope: typeof envelopeSchema.infer = { purpose, version, payload: JSON.parse(json) }
      if (ttlMs !== undefined) {
        const clock = now()
        const expiresAt = clock + ttlMs
        if (!Number.isSafeInteger(clock)) {
          throw new RangeError("the clock must return an integer number of milliseconds")
        }
        if (!Number.isSafeInteger(expiresAt)) {
          throw new RangeError("ttlMs is too long: the expiry would pass Number.MAX_SAFE_INTEGER")
        }
        envelope = { purpose, version, expiresAt, payload: envelope.payload }
      }
      const encoded = encodeBase64Url(encoder.encode(JSON.stringify(envelope)))
      if (encoded.length + 1 + SIGNATURE_LENGTH > MAX_SIGNED_PAYLOAD_LENGTH) {
        throw new SignedPayloadError(
          SignedPayloadErrorCode.Malformed,
          "token would exceed MAX_SIGNED_PAYLOAD_LENGTH",
        )
      }
      const signature = await crypto.subtle.sign(
        "HMAC",
        await key,
        macInput(context, encoded),
      )
      return `${encoded}.${encodeBase64Url(new Uint8Array(signature))}`
    },

    async verify(token, verifyOptions = {}) {
      const refuse = (code: SignedPayloadErrorCode) => ({ ok: false as const, error: code })
      if (typeof token !== "string" || token.length > MAX_SIGNED_PAYLOAD_LENGTH) {
        return refuse(SignedPayloadErrorCode.Malformed)
      }
      const segments = token.split(".")
      if (segments.length !== 2) return refuse(SignedPayloadErrorCode.Malformed)
      const [encoded, encodedSignature] = segments
      const signature = decodeCanonical(encodedSignature)
      if (decodeCanonical(encoded) === null || signature?.length !== SIGNATURE_BYTES) {
        return refuse(SignedPayloadErrorCode.Malformed)
      }
      if (!isUsableContext(verifyOptions.context)) {
        return refuse(SignedPayloadErrorCode.BadSignature)
      }
      const valid = await crypto.subtle.verify(
        "HMAC",
        await key,
        signature,
        macInput(verifyOptions.context, encoded),
      )
      if (!valid) return refuse(SignedPayloadErrorCode.BadSignature)

      const envelope = parseEnvelope(encoded)
      if (envelope === null) return refuse(SignedPayloadErrorCode.Malformed)
      if (envelope.purpose !== purpose) return refuse(SignedPayloadErrorCode.WrongPurpose)
      if (envelope.expiresAt !== undefined) {
        const clock = now()
        if (!Number.isSafeInteger(clock) || envelope.expiresAt <= clock) {
          return refuse(SignedPayloadErrorCode.Expired)
        }
      }
      if (envelope.version !== version) return refuse(SignedPayloadErrorCode.InvalidPayload)
      const output = schema(envelope.payload)
      if (output instanceof type.errors) return refuse(SignedPayloadErrorCode.InvalidPayload)
      return { ok: true as const, value: output as S["infer"] }
    },
  }
}

/**
 * True for an absent context or a string with an exact UTF-8 form. A lone surrogate encodes as
 * U+FFFD, so `"a\uD800"` and `"a\uFFFD"` would otherwise share one signature.
 */
function isUsableContext(context: unknown): boolean {
  return context === undefined || (typeof context === "string" && !LONE_SURROGATE.test(context))
}

/**
 * Decodes one base64url segment, or `null` when it is empty, carries a character outside the
 * unpadded base64url alphabet, or is not the canonical spelling of its bytes. Canonical only: two
 * spellings of one signature would make a token malleable.
 */
function decodeCanonical(segment: string): Uint8Array<ArrayBuffer> | null {
  if (!BASE64URL_SEGMENT.test(segment)) return null
  try {
    const bytes = decodeBase64Url(segment)
    return encodeBase64Url(bytes) === segment ? bytes : null
  } catch {
    return null
  }
}

/** Parses a verified envelope segment, or `null` unless it is UTF-8 JSON of the envelope shape. */
function parseEnvelope(encoded: string): typeof envelopeSchema.infer | null {
  try {
    const envelope = envelopeSchema(JSON.parse(decoder.decode(decodeBase64Url(encoded))))
    return envelope instanceof type.errors ? null : envelope
  } catch {
    return null
  }
}

/**
 * The bytes the MAC covers: the domain tag, a NUL, the context's UTF-8 length as four big-endian
 * bytes, the context, then the encoded envelope. The length prefix keeps the context and the
 * envelope from running into each other, so no two (context, envelope) pairs share an input.
 */
function macInput(context: string | undefined, encoded: string): Uint8Array<ArrayBuffer> {
  const domain = encoder.encode(MAC_DOMAIN)
  const contextBytes = encoder.encode(context ?? "")
  const body = encoder.encode(encoded)
  const input = new Uint8Array(domain.length + 1 + 4 + contextBytes.length + body.length)
  input.set(domain, 0)
  let offset = domain.length + 1
  new DataView(input.buffer).setUint32(offset, contextBytes.length)
  offset += 4
  input.set(contextBytes, offset)
  input.set(body, offset + contextBytes.length)
  return input
}
