/**
 * Inbound webhook verification: HMAC-SHA256 over a timestamp and the raw
 * request body, signed with a shared secret.
 *
 * Two header layouts are read: a signature header plus a separate timestamp
 * header (the default), or one combined header carrying both, such as
 * Stripe's `Stripe-Signature: t=<ts>,v1=<hex>` (see
 * {@link WebhookVerifierConfig.combinedHeader}). Either way the signed string is
 * `<timestamp>.<raw body>`, or `<timestamp>:<raw body>` for Paddle through
 * {@link CombinedSignatureHeader.signedSeparator}. This is **not** a drop-in verifier for GitHub or
 * Slack: GitHub sends no timestamp at all, so every real GitHub delivery is
 * rejected as `missing_timestamp`, and Slack signs a different string; see the
 * package README for the full comparison.
 *
 * Nothing in the extraction sweep had a receiver, so this is written fresh
 * rather than ported. It is deliberately the smallest correct thing:
 *
 *  - HMAC-SHA256 over a signed prefix plus the **raw** request body bytes. The
 *    body must be the bytes off the wire, before any JSON parsing or
 *    re-serialisation — re-encoding changes hashes and is the standard way a
 *    webhook check is quietly defeated.
 *  - Comparison is `crypto.subtle.verify`, which is constant-time inside the
 *    platform's HMAC. No `===` and no `Buffer.compare`-style short-circuit.
 *  - A timestamp participates in the signature and is checked against an
 *    injected clock, so a captured request cannot be replayed after the skew
 *    window. A missing or unparseable timestamp is a rejection, not "no
 *    replay protection needed".
 *  - Fail-closed: every rejection path returns a reason and none of them
 *    accept. Nothing here logs, so a secret or a body cannot leak from it.
 *
 * The module verifies; it does not route. It returns the parsed JSON only
 * after the signature has been accepted, because a 200 from an unverified
 * body is how a forged event reaches a handler.
 * @module
 */

/** Why a delivery was rejected. Every value is a rejection. */
export type WebhookRejectReason =
  | "invalid_secret"
  | "missing_signature"
  | "malformed_signature"
  | "missing_timestamp"
  | "malformed_timestamp"
  | "stale_timestamp"
  | "future_timestamp"
  | "malformed_body"
  | "signature_mismatch"

/** Result of {@link verifyWebhookRequest}: the verified body, or why it was rejected. */
export type WebhookVerifyResult =
  | { ok: true; body: Uint8Array; timestampSeconds: number }
  | { ok: false; reason: WebhookRejectReason; message: string }

/**
 * One header that carries the timestamp and the signatures together, as a list of `key=value`
 * pairs: Stripe's `Stripe-Signature: t=1492774577,v1=5257…,v0=6ffb…` is
 * `{ name: "Stripe-Signature", pairSeparator: ",", timestampKey: "t", signatureKey: "v1" }`.
 *
 * Every pair whose key is `signatureKey` is a candidate signature, and the delivery passes when one
 * of them matches: a sender that is rolling its secret signs with the old and the new one at once.
 * Pairs with any other key are ignored, so a sender's test-only scheme (Stripe's `v0`) can never
 * stand in for the real one.
 */
export interface CombinedSignatureHeader {
  /** Header name, matched case-insensitively. */
  name: string
  /** What separates one `key=value` pair from the next: `","` for Stripe. */
  pairSeparator: string
  /** Key of the timestamp pair, in whole seconds: `"t"` for Stripe. Exactly one is required. */
  timestampKey: string
  /** Key of a signature pair, a 64-character hex HMAC: `"v1"` for Stripe. */
  signatureKey: string
  /**
   * What joins the timestamp and the body in the signed string:
   * `<timestamp><signedSeparator><body>`.
   * Default `"."`, as Stripe signs. Paddle signs `<ts>:<body>`, so it needs `":"`.
   */
  signedSeparator?: string
}

/** Shared secret and header names {@link verifyWebhookRequest} needs to check a delivery. */
export interface WebhookVerifierConfig {
  /**
   * Shared secret. Caller-supplied, never read from the environment here, and
   * never logged or echoed into a result.
   *
   * Typed `string`, and re-checked at runtime: a caller can still pass `null`
   * or `undefined` through a cast or an untyped boundary, and an unusable
   * secret must refuse every delivery rather than sign with the falsy value.
   */
  secret: string
  /**
   * Accepted age and future skew of a signature, in seconds. Default 300. Must be a finite number
   * above zero: `NaN` or `Infinity` would accept a replay from any time, so either one throws.
   */
  toleranceSeconds?: number
  /**
   * Signature header name. Configurable because senders disagree on it —
   * GitHub's is `X-Hub-Signature-256`, a generic sender's is
   * `X-Signature-256` — not because naming the header makes this module able
   * to verify that sender's full scheme: GitHub, for one, sends no timestamp,
   * which this module always requires.
   */
  signatureHeader?: string
  /** Timestamp header name. */
  timestampHeader?: string
  /**
   * Read the timestamp and the signatures from one combined header instead. When set,
   * `signatureHeader`, `timestampHeader` and `algorithm` are ignored.
   */
  combinedHeader?: CombinedSignatureHeader
  /** Name of the HMAC algorithm prefix in the header. Default `sha256`. */
  algorithm?: string
  /** Millisecond clock. Injected so the skew tests never touch wall time. */
  clock?: () => number
}

/** A hex SHA-256 HMAC: 64 characters, nothing else. */
const HEX_SHA256 = /^[0-9a-f]{64}$/

/** Longest header kept before parsing; anything longer is a malformed attempt. */
const MAX_SIGNATURE_LENGTH = 200
const MAX_TIMESTAMP_LENGTH = 24
/** Longest combined header kept: a timestamp and a handful of signatures fit with room to spare. */
const MAX_COMBINED_LENGTH = 1024
/** Most signatures one combined header may carry; each costs one HMAC verification. */
const MAX_SIGNATURES = 8
const DEFAULT_TOLERANCE_SECONDS = 300
const DEFAULT_SIGNATURE_HEADER = "x-signature-256"
const DEFAULT_TIMESTAMP_HEADER = "x-signature-timestamp"
const DEFAULT_ALGORITHM = "sha256"

const textEncoder = new TextEncoder()

/** Copies bytes into a freshly allocated `ArrayBuffer` for WebCrypto. */
const toArrayBuffer = (bytes: Uint8Array): Uint8Array<ArrayBuffer> => {
  const copy = new Uint8Array(new ArrayBuffer(bytes.length))
  copy.set(bytes)
  return copy
}

const hexToBytes = (hex: string): Uint8Array<ArrayBuffer> => {
  const bytes = new Uint8Array(new ArrayBuffer(hex.length / 2))
  for (let index = 0; index < bytes.length; index++) {
    bytes[index] = Number.parseInt(hex.substring(index * 2, index * 2 + 2), 16)
  }
  return bytes
}

/** Reads a header case-insensitively from a `Headers` instance or a plain record. */
const readHeader = (headers: Headers | Record<string, string>, name: string): string | null => {
  if (headers instanceof Headers) {
    return headers.get(name)
  }
  const wanted = name.toLowerCase()
  for (const [key, value] of Object.entries(headers)) {
    if (key.toLowerCase() === wanted) {
      return value
    }
  }
  return null
}

/** Header values that passed the shape checks, or the rejection that stopped them. */
type ParsedHeaders =
  | { ok: true; digests: string[]; timestampValue: string }
  | { ok: false; reason: WebhookRejectReason; message: string }

/** Reads the signature and the timestamp from two separate headers (the default layout). */
const readSeparateHeaders = (
  headers: Headers | Record<string, string>,
  config: WebhookVerifierConfig,
): ParsedHeaders => {
  const algorithm = config.algorithm ?? DEFAULT_ALGORITHM
  const signatureHeader = readHeader(headers, config.signatureHeader ?? DEFAULT_SIGNATURE_HEADER)
  if (signatureHeader === null || signatureHeader.trim() === "") {
    return { ok: false, reason: "missing_signature", message: "signature header is absent" }
  }
  const signatureValue = signatureHeader.trim()
  if (signatureValue.length > MAX_SIGNATURE_LENGTH) {
    return { ok: false, reason: "malformed_signature", message: "signature header is too long" }
  }
  const separatorIndex = signatureValue.indexOf("=")
  const scheme = separatorIndex === -1 ? "" : signatureValue.slice(0, separatorIndex).toLowerCase()
  const digest = (separatorIndex === -1 ? signatureValue : signatureValue.slice(separatorIndex + 1))
    .trim()
    .toLowerCase()
  if (scheme !== "" && scheme !== algorithm) {
    return {
      ok: false,
      reason: "malformed_signature",
      message: `signature scheme ${scheme} is not ${algorithm}`,
    }
  }
  if (!HEX_SHA256.test(digest)) {
    return {
      ok: false,
      reason: "malformed_signature",
      message: "signature is not 64 hex characters",
    }
  }

  const timestampHeader = readHeader(headers, config.timestampHeader ?? DEFAULT_TIMESTAMP_HEADER)
  if (timestampHeader === null || timestampHeader.trim() === "") {
    return { ok: false, reason: "missing_timestamp", message: "timestamp header is absent" }
  }
  return { ok: true, digests: [digest], timestampValue: timestampHeader.trim() }
}

/**
 * Reads the timestamp and every signature from one combined header. Strict: a pair without `=`,
 * a second timestamp, a signature that is not 64 hex characters or more than
 * {@link MAX_SIGNATURES} signatures rejects the whole delivery rather than picking the parts that
 * look usable.
 */
const readCombinedHeader = (
  headers: Headers | Record<string, string>,
  layout: CombinedSignatureHeader,
): ParsedHeaders => {
  const header = readHeader(headers, layout.name)
  if (header === null || header.trim() === "") {
    return { ok: false, reason: "missing_signature", message: "signature header is absent" }
  }
  if (header.length > MAX_COMBINED_LENGTH) {
    return { ok: false, reason: "malformed_signature", message: "signature header is too long" }
  }
  const digests: string[] = []
  const timestamps: string[] = []
  for (const pair of header.split(layout.pairSeparator)) {
    const separatorIndex = pair.indexOf("=")
    if (separatorIndex === -1) {
      return {
        ok: false,
        reason: "malformed_signature",
        message: "signature header has a part that is not key=value",
      }
    }
    const key = pair.slice(0, separatorIndex).trim()
    const value = pair.slice(separatorIndex + 1).trim()
    if (key === layout.timestampKey) {
      timestamps.push(value)
    } else if (key === layout.signatureKey) {
      digests.push(value.toLowerCase())
    }
  }
  if (digests.length === 0) {
    return {
      ok: false,
      reason: "missing_signature",
      message: `signature header has no ${layout.signatureKey} signature`,
    }
  }
  if (digests.length > MAX_SIGNATURES) {
    return {
      ok: false,
      reason: "malformed_signature",
      message: `signature header has more than ${MAX_SIGNATURES} signatures`,
    }
  }
  if (!digests.every((digest) => HEX_SHA256.test(digest))) {
    return {
      ok: false,
      reason: "malformed_signature",
      message: "signature is not 64 hex characters",
    }
  }
  if (timestamps.length === 0) {
    return {
      ok: false,
      reason: "missing_timestamp",
      message: `signature header has no ${layout.timestampKey} timestamp`,
    }
  }
  if (timestamps.length > 1) {
    return {
      ok: false,
      reason: "malformed_timestamp",
      message: "signature header has more than one timestamp",
    }
  }
  return { ok: true, digests, timestampValue: timestamps[0] }
}

/**
 * Verifies one inbound delivery.
 *
 * Accepts the raw body as `Uint8Array` (or the `ArrayBuffer` a runtime hands
 * you) and returns the same bytes on success, so the caller parses JSON after
 * verification rather than before. Timestamp and signature header values are
 * taken from the request, never from the payload — a sender-controlled body
 * claiming its own timestamp proves nothing.
 *
 * @param rawBody Body bytes exactly as received. A `string` is rejected so a
 *   decoded body cannot be passed to a byte-level comparison by accident.
 * @throws {RangeError} When `toleranceSeconds` is not a finite number above 0.
 */
export const verifyWebhookRequest = async (
  rawBody: Uint8Array | ArrayBuffer,
  headers: Headers | Record<string, string>,
  config: WebhookVerifierConfig,
): Promise<WebhookVerifyResult> => {
  // Fail closed on *every* unusable secret, not just the empty string. A blank
  // or non-string secret previously fell through to `crypto.subtle.importKey`
  // with a key built from the falsy value: a zero-length key throws
  // `DataError: Key length is zero`, while `null`, `undefined`, a number or
  // whitespace produced a *usable* key, so a forged body signed with the same
  // falsy value was accepted. Both behaviours are wrong; neither may accept.
  if (config === null || config === undefined || typeof config.secret !== "string") {
    return {
      ok: false,
      reason: "invalid_secret",
      message: "verifier has no usable secret configured",
    }
  }
  if (config.secret.trim() === "") {
    return {
      ok: false,
      reason: "invalid_secret",
      message: "verifier has no usable secret configured",
    }
  }

  const tolerance = config.toleranceSeconds ?? DEFAULT_TOLERANCE_SECONDS
  if (!Number.isFinite(tolerance) || tolerance <= 0) {
    // A configuration error, not a bad delivery: thrown so it surfaces at the first request
    // instead of turning replay protection off.
    throw new RangeError(`toleranceSeconds must be a finite number above 0, got ${tolerance}`)
  }

  if (!(rawBody instanceof Uint8Array) && !(rawBody instanceof ArrayBuffer)) {
    return { ok: false, reason: "malformed_body", message: "raw body must be bytes" }
  }
  const bytes = rawBody instanceof Uint8Array ? rawBody : new Uint8Array(rawBody)
  const clock = config.clock ?? (() => Date.now())

  const parsed = config.combinedHeader === undefined
    ? readSeparateHeaders(headers, config)
    : readCombinedHeader(headers, config.combinedHeader)
  if (!parsed.ok) {
    return parsed
  }
  const { digests, timestampValue } = parsed
  if (timestampValue.length > MAX_TIMESTAMP_LENGTH || !/^\d+$/.test(timestampValue)) {
    return {
      ok: false,
      reason: "malformed_timestamp",
      message: "timestamp is not an integer of seconds",
    }
  }
  const timestampSeconds = Number.parseInt(timestampValue, 10)
  const ageSeconds = Math.floor(clock() / 1000) - timestampSeconds
  if (ageSeconds > tolerance) {
    return { ok: false, reason: "stale_timestamp", message: `timestamp is ${ageSeconds}s old` }
  }
  if (ageSeconds < -tolerance) {
    return {
      ok: false,
      reason: "future_timestamp",
      message: `timestamp is ${-ageSeconds}s in the future`,
    }
  }

  // One construction of the signed string, used by the only verification path
  // in this module: `<timestamp seconds><separator><raw body>`, both as bytes. The separator is
  // "." unless a combined header names another.
  const separator = config.combinedHeader?.signedSeparator ?? "."
  const prefixBytes = textEncoder.encode(`${timestampSeconds}${separator}`)
  const signed = new Uint8Array(new ArrayBuffer(prefixBytes.length + bytes.length))
  signed.set(prefixBytes, 0)
  signed.set(bytes, prefixBytes.length)
  const key = await crypto.subtle.importKey(
    "raw",
    textEncoder.encode(config.secret),
    { name: "HMAC", hash: "SHA-256" },
    false,
    ["verify"],
  )
  // `verify` is constant-time in the platform's HMAC. No string or byte-level
  // `===` touches the digest, which would leak position-by-position progress.
  //
  // This line must keep using `crypto.subtle.verify` and never a hand-rolled
  // comparison (`===`, `Buffer.compare`, a byte-by-byte loop that returns
  // early): none of those run in constant time, and every one of them would
  // let a network attacker recover a valid signature one byte at a time by
  // timing rejections. No test in this suite can catch that regression —
  // constant-time-ness is a property of how long the comparison takes, not of
  // what it returns, and asserting on timing here would be exactly the kind
  // of wall-clock-based unit test this repo's house rules rule out. Treat
  // this comment as the guard a test cannot be.
  //
  // Every candidate is verified, with no early exit, so the time taken does not
  // depend on which of several signatures matched.
  const signedBuffer = toArrayBuffer(signed)
  let valid = false
  for (const digest of digests) {
    const matches = await crypto.subtle.verify(
      "HMAC",
      key,
      toArrayBuffer(hexToBytes(digest)),
      signedBuffer,
    )
    valid = valid || matches
  }
  if (!valid) {
    return { ok: false, reason: "signature_mismatch", message: "signature does not match the body" }
  }
  return { ok: true, body: bytes, timestampSeconds }
}
