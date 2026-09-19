/**
 * Inbound webhook verification (Slack / GitHub / Stripe / generic HMAC-SHA256).
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

export type WebhookVerifyResult =
  | { ok: true; body: Uint8Array; timestampSeconds: number }
  | { ok: false; reason: WebhookRejectReason; message: string }

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
  /** Accepted age and future skew of a signature, in seconds. Default 300. */
  toleranceSeconds?: number
  /**
   * Signature header name. GitHub sends `X-Hub-Signature-256`; a generic
   * sender uses `X-Signature-256`.
   */
  signatureHeader?: string
  /** Timestamp header name. */
  timestampHeader?: string
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

  if (!(rawBody instanceof Uint8Array) && !(rawBody instanceof ArrayBuffer)) {
    return { ok: false, reason: "malformed_body", message: "raw body must be bytes" }
  }
  const bytes = rawBody instanceof Uint8Array ? rawBody : new Uint8Array(rawBody)
  const clock = config.clock ?? (() => Date.now())
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
  const timestampValue = timestampHeader.trim()
  if (timestampValue.length > MAX_TIMESTAMP_LENGTH || !/^\d+$/.test(timestampValue)) {
    return {
      ok: false,
      reason: "malformed_timestamp",
      message: "timestamp is not an integer of seconds",
    }
  }
  const timestampSeconds = Number.parseInt(timestampValue, 10)
  const tolerance = config.toleranceSeconds ?? DEFAULT_TOLERANCE_SECONDS
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
  // in this module: `<timestamp seconds>.<raw body>`, both as bytes.
  const prefixBytes = textEncoder.encode(`${timestampSeconds}.`)
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
  const valid = await crypto.subtle.verify(
    "HMAC",
    key,
    toArrayBuffer(hexToBytes(digest)),
    toArrayBuffer(signed),
  )
  if (!valid) {
    return { ok: false, reason: "signature_mismatch", message: "signature does not match the body" }
  }
  return { ok: true, body: bytes, timestampSeconds }
}
