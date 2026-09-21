/**
 * AES-256-GCM at-rest encryption for secrets (OAuth tokens, provider API keys).
 *
 * The scheme is `template/libs/server/crypto`'s scheme, folded in unchanged: the
 * IV is 12 random bytes generated per call and prepended to the
 * ciphertext-plus-16-byte-tag, and the wire format is standard base64 (with `+`,
 * `/` and padding — **not** base64url) of `[IV (12 bytes)][ciphertext + tag]`.
 * A ciphertext produced by that module stays readable here and vice versa.
 * Nothing in this file is a second scheme, so no format negotiation, version
 * byte or algorithm tag is needed.
 *
 * `encrypt` and `decrypt` take an optional `context` that is passed to AES-GCM
 * as additional authenticated data. It binds a blob to where it is stored — a
 * ciphertext sealed for one row cannot be opened as another — and it changes no
 * bytes of the wire format, because additional data is authenticated rather than
 * stored. A call that passes no context produces exactly the bytes the template's
 * module produces, so values written before this existed stay readable.
 *
 * The key material has two entry points, and they are not interchangeable:
 * `new CryptoService(secret)` hashes the passphrase with SHA-256 (template's
 * derivation), while `CryptoService.fromHexKey(hex)` decodes 64 hex characters
 * to the 32 raw AES-256 key bytes and imports them as they are
 * (`offer-lens/libs/encrypt/mod.ts:13-19`'s key path). Same wire format, two
 * keys — see the {@link CryptoService} JSDoc.
 *
 * Two documented defects of the sources are fixed here rather than ported:
 *
 * - `offer-lens/libs/encrypt/mod.ts:13-18` accepted a 32-hex-character
 *   (16-byte, AES-128) `ENCRYPTION_KEY` next to a 64-hex-character AES-256 one,
 *   so the same deployment could silently run one of two key sizes.
 *   `CryptoService.fromHexKey` now demands exactly 32 key bytes
 *   (`HEX_KEY_LENGTH` = 64 hex characters) and rejects AES-128 matter.
 * - `offer-lens/libs/scraper/mod.ts:132` classified failures with
 *   `msg.includes("abort") || msg.includes("timeout")`. Nothing here inspects
 *   message text: every failure leaves as a {@link CryptoError} with a
 *   {@link CryptoErrorCode}, and caught values are narrowed with `instanceof`.
 *
 * The secret is injected rather than read from the environment: reading
 * `ENCRYPTION_KEY` is `server/user-secrets`' job (`CryptoService.fromHexKey` is
 * the constructor it calls). A single SHA-256 pass is a derivation, not a KDF —
 * reusing the same secret as, say, a password pepper is the weak point, not this
 * module. Prefer a dedicated secret and migrate to HKDF with a distinct info
 * label when that reuse cannot be avoided.
 */

import { decodeBase64, encodeBase64 } from "@std/encoding/base64"

/** WebCrypto algorithm name. */
export const AES_ALGORITHM = "AES-GCM"

/** Key size in bytes. AES-128 (16) is deliberately not supported. */
export const AES_KEY_BYTES = 32

/** Key size in bits, passed to `crypto.subtle.importKey`. */
export const KEY_BITS = 256

/** IV size in bytes: 96 bits, the size recommended for GCM. */
export const IV_LENGTH = 12

/** Length of a hex-encoded {@link AES_KEY_BYTES}-byte key. */
export const HEX_KEY_LENGTH = 64

/** Default number of trailing code points {@link maskKey} is asked to leave visible. */
export const DEFAULT_MASK_VISIBLE = 4

/**
 * Trailing code points {@link maskKey} may ever show, whatever a caller asks for.
 * A caller that passes a larger `visible` gets this instead of its own number.
 */
export const MAX_MASK_VISIBLE = 4

/**
 * A hint shows at most one trailing code point per this many code points of the
 * key, so a short key reveals proportionally less than a long one.
 */
export const MASK_VISIBLE_DIVISOR = 4

/**
 * Code points in every non-empty hint {@link maskKey} returns, whatever the key
 * is. Fixed rather than derived from the key's length: a hint as long as its key
 * tells a reader how long the key is, which narrows a guess before a single
 * character is tried.
 */
export const MASK_LENGTH = 12

/** Hex without padding or separators, matched after lower-casing the input. */
const HEX_PATTERN = /^[0-9a-f]+$/

const encoder = new TextEncoder()
const decoder = new TextDecoder()

/**
 * Failure classes of this module. Branch on `code`; never on a message, because
 * no message may carry key, plaintext or ciphertext material and so no message
 * is allowed to distinguish cases by wording.
 *
 * Values start at 1 (`enum` house rule) and are part of the public contract.
 */
export enum CryptoErrorCode {
  /** The secret passed to `new CryptoService` was empty, blank or not a string. */
  InvalidSecret = 1,
  /** The value passed to `fromHexKey` was not exactly 64 hex characters. */
  InvalidHexKey = 2,
  /** The ciphertext was not decodable base64, or shorter than one IV. */
  MalformedCiphertext = 3,
  /** WebCrypto failed to derive, import or use the key while encrypting. */
  EncryptionFailed = 4,
  /** GCM authentication failed, or WebCrypto failed while decrypting. */
  DecryptionFailed = 5,
}

/**
 * The one error this module throws. `code` is the machine-readable branch
 * point; `message` is a constant chosen to leak nothing about the key, the
 * plaintext or the ciphertext, and `cause` keeps the originating
 * `DOMException`/`OperationError` for debugging without ever being stringified
 * into a message here.
 */
export class CryptoError extends Error {
  readonly code: CryptoErrorCode

  constructor(code: CryptoErrorCode, message: string, options?: { cause?: unknown }) {
    super(message, options)
    this.name = "CryptoError"
    this.code = code
  }
}

/**
 * The port `server/user-secrets.ts` depends on: any cipher (this AES-GCM one, a
 * KV-backed one, a KMS or HSM client) satisfies the shape, so the caller never
 * names a concrete implementation.
 */
export interface SecretCipher {
  /**
   * `context` binds the ciphertext to where it is stored: a blob sealed with one
   * context cannot be opened with another or with none. An implementation that
   * cannot bind a context must reject a call that passes one rather than ignore
   * it, because a silently unbound ciphertext is one a row copy can still open.
   */
  encrypt(plaintext: string, context?: string): Promise<string>
  decrypt(ciphertext: string, context?: string): Promise<string>
}

/**
 * AES-256-GCM cipher with two entry points that produce **different** keys from
 * the same characters:
 *
 * - `new CryptoService(secret)` treats the argument as a passphrase and derives
 *   the key as `crypto.subtle.digest("SHA-256", utf8(secret))`, then
 *   `importKey("raw", digest, { name: "AES-GCM", length: 256 })` — the scheme
 *   from `template/libs/server/crypto`.
 * - {@link CryptoService.fromHexKey} treats the argument as 32 hex-encoded raw
 *   key bytes and imports those bytes unchanged, with no hashing — the key path
 *   from `offer-lens/libs/encrypt/mod.ts:13-19`.
 *
 * The two are not interchangeable: `fromHexKey(h)` does not read a ciphertext
 * produced by `new CryptoService(h)`. Whichever entry point a deployment picks
 * is a wire-format decision and cannot be switched without re-encrypting.
 *
 * The `CryptoKey` promise is cached per instance; a failed import resets the
 * cache to `null` so the next call retries instead of pinning the instance to a
 * permanent failure.
 */
export class CryptoService implements SecretCipher {
  #key: Promise<CryptoKey> | null = null
  /**
   * Key material source for {@link CryptoService.#getKey}: the SHA-256 digest of
   * the passphrase (set here) or the decoded raw bytes (set by
   * {@link CryptoService.fromHexKey}).
   */
  #keyBytes: () => Promise<Uint8Array<ArrayBuffer>>

  /**
   * The secret is **not** kept as a property. It is read once here, closed over
   * by `#keyBytes`, and never reachable again: `JSON.stringify`, `Deno.inspect`,
   * `Object.keys` and `structuredClone` of an instance therefore show no key
   * material. A `private readonly` parameter property would have been an
   * ordinary enumerable field that every one of those four prints.
   */
  constructor(secret: string) {
    if (typeof secret !== "string" || secret.trim() === "") {
      throw new CryptoError(
        CryptoErrorCode.InvalidSecret,
        "CryptoService requires a non-empty secret",
      )
    }
    this.#keyBytes = () => digestOf(secret)
  }

  /**
   * Wraps 32 raw key bytes given as hex. The bytes **are** the AES-256 key: the
   * hex is decoded to bytes and imported raw, never hashed, so
   * `fromHexKey(h)` and `new CryptoService(h)` — the same 64 characters —
   * produce different keys and neither can decrypt the other's ciphertext.
   * This matches the source's key path (`offer-lens/libs/encrypt/mod.ts:13-19`)
   * while dropping its acceptance of a 16-byte/AES-128 key.
   *
   * Accepts exactly {@link HEX_KEY_LENGTH} hex characters — no 16-byte/AES-128
   * key, no `0x` prefix, no separators, no padding. Upper-case and lower-case
   * hex are the same key (input is lower-cased, which is not a secret-affecting
   * normalisation: hex digits are case-insensitive). Nothing is trimmed — a
   * value with surrounding whitespace is a different key and is therefore
   * rejected, not silently repaired.
   */
  static fromHexKey(hex: string): CryptoService {
    // One shape rule, stated once: {@link isHexKey} is the same check a caller
    // uses to decide whether a configured value is a raw key or a passphrase,
    // and a second inline copy of it here could drift away from that answer.
    if (!isHexKey(hex)) {
      throw new CryptoError(
        CryptoErrorCode.InvalidHexKey,
        `encryption key must be exactly ${HEX_KEY_LENGTH} hex characters (${AES_KEY_BYTES} bytes)`,
      )
    }
    // `isHexKey` makes a decode failure impossible, so the decoder needs no
    // error path of its own. The `#keyBytes` assignment replaces the
    // constructor's SHA-256 source before the instance is handed out.
    const bytes = decodeHex(hex.toLowerCase())
    const service = new CryptoService(hex)
    service.#keyBytes = () => Promise.resolve(bytes)
    return service
  }

  /**
   * Encrypts `plaintext` and returns standard base64 of
   * `[IV (12 bytes)][ciphertext + tag]`. A fresh IV per call means two calls
   * with the same plaintext produce different output.
   *
   * `context` is passed to AES-GCM as additional authenticated data: it is not
   * stored, not recoverable from the blob, and the same string must be supplied
   * again to open it. Omitting it produces the byte-identical format the
   * template's module reads, so a stored value written without a context stays
   * readable and one written with a context does not.
   */
  async encrypt(plaintext: string, context?: string): Promise<string> {
    try {
      const key = await this.#getKey()
      const iv = crypto.getRandomValues(new Uint8Array(IV_LENGTH))
      const sealed = await crypto.subtle.encrypt(
        gcmParameters(iv, context),
        key,
        encoder.encode(plaintext),
      )

      const result = new Uint8Array(iv.length + sealed.byteLength)
      result.set(iv, 0)
      result.set(new Uint8Array(sealed), iv.length)
      return encodeBase64(result)
    } catch (error) {
      if (error instanceof CryptoError) throw error
      throw new CryptoError(CryptoErrorCode.EncryptionFailed, "encryption failed", {
        cause: error instanceof Error ? error : undefined,
      })
    }
  }

  /**
   * Decrypts standard base64 of `[IV (12 bytes)][ciphertext + tag]` produced by
   * {@link CryptoService.encrypt} or by `template`'s module. A blob that is not
   * decodable base64, or is shorter than `IV_LENGTH`, is
   * {@link CryptoErrorCode.MalformedCiphertext}; a GCM tag mismatch (a wrong key
   * included) is {@link CryptoErrorCode.DecryptionFailed}. The raw `TypeError`,
   * `RangeError`, `DOMException` or `OperationError` never escapes.
   *
   * `context` must be exactly what {@link CryptoService.encrypt} was given. A
   * different context, or none where one was used, is a tag mismatch and so is
   * {@link CryptoErrorCode.DecryptionFailed} — the same answer as a wrong key,
   * on purpose: which of the two failed is not something a caller may learn.
   */
  async decrypt(ciphertext: string, context?: string): Promise<string> {
    let sealed: Uint8Array<ArrayBuffer>
    try {
      sealed = decodeBase64(ciphertext)
    } catch (error) {
      throw new CryptoError(CryptoErrorCode.MalformedCiphertext, "ciphertext is not valid base64", {
        cause: error instanceof Error ? error : undefined,
      })
    }

    if (sealed.length < IV_LENGTH) {
      throw new CryptoError(
        CryptoErrorCode.MalformedCiphertext,
        "ciphertext is shorter than one IV",
      )
    }

    try {
      const key = await this.#getKey()
      const opened = await crypto.subtle.decrypt(
        gcmParameters(sealed.subarray(0, IV_LENGTH), context),
        key,
        sealed.subarray(IV_LENGTH),
      )
      return decoder.decode(opened)
    } catch (error) {
      if (error instanceof CryptoError) throw error
      throw new CryptoError(CryptoErrorCode.DecryptionFailed, "decryption failed", {
        cause: error instanceof Error ? error : undefined,
      })
    }
  }

  /**
   * Imports and caches the AES-256 key, retrying after a failure. The single
   * import site for both entry points: `#keyBytes()` returns the SHA-256 digest
   * for a passphrase instance and the decoded raw bytes for a `fromHexKey`
   * instance, and both are valid `BufferSource` key material.
   */
  #getKey(): Promise<CryptoKey> {
    if (!this.#key) {
      this.#key = (async () => {
        try {
          return await crypto.subtle.importKey(
            "raw",
            await this.#keyBytes(),
            { name: AES_ALGORITHM, length: KEY_BITS },
            false,
            ["encrypt", "decrypt"],
          )
        } catch (error) {
          this.#key = null
          throw new CryptoError(CryptoErrorCode.EncryptionFailed, "key derivation failed", {
            cause: error instanceof Error ? error : undefined,
          })
        }
      })()
    }
    return this.#key
  }
}

/**
 * The AES-GCM parameters for one call.
 *
 * `additionalData` is left off entirely when there is no context, rather than
 * set to an empty array: the two are the same to GCM, and leaving the field out
 * keeps the call identical to the one the template's module makes.
 */
function gcmParameters(iv: Uint8Array<ArrayBuffer>, context: string | undefined): AesGcmParams {
  return context === undefined
    ? { name: AES_ALGORITHM, iv }
    : { name: AES_ALGORITHM, iv, additionalData: encoder.encode(context) }
}

/**
 * SHA-256 of the UTF-8 secret — the passphrase entry point's key material.
 * `digest` resolves to an `ArrayBuffer`, wrapped here so both entry points hand
 * `#getKey` the same `Uint8Array` shape.
 */
async function digestOf(secret: string): Promise<Uint8Array<ArrayBuffer>> {
  return new Uint8Array(await crypto.subtle.digest("SHA-256", encoder.encode(secret)))
}

/**
 * Decodes `hex` (exactly two characters per byte, already lower-cased and
 * pattern-checked by the caller) into raw key bytes.
 */
function decodeHex(hex: string): Uint8Array<ArrayBuffer> {
  const bytes = new Uint8Array(hex.length / 2)
  for (let index = 0; index < bytes.length; index++) {
    bytes[index] = Number.parseInt(hex.slice(index * 2, index * 2 + 2), 16)
  }
  return bytes
}

/**
 * Display hint for a key: {@link MASK_LENGTH} code points, a run of asterisks
 * followed by a few trailing code points of the key, so a user recognises which
 * key is stored without the hint standing in for the key.
 *
 * Two bounds hold whatever the caller asks for, and both are why `visible` is a
 * request rather than an instruction:
 *
 * - never more than {@link MAX_MASK_VISIBLE} code points, and
 * - never more than one code point per {@link MASK_VISIBLE_DIVISOR} code points
 *   of the key, so an eight-character key shows two characters and not six.
 *
 * Every non-empty hint is {@link MASK_LENGTH} code points wide, so the hint no
 * longer reports the key's length — the asterisk run absorbs the difference.
 * Masking is per code point (`Array.from`), so a surrogate pair or an
 * emoji is never split. An empty key masks to the empty string — an absent key
 * should not render as a hint that a key exists. A non-string argument is
 * refused with {@link CryptoErrorCode.InvalidSecret} rather than coerced.
 */
export function maskKey(key: string, visible: number = DEFAULT_MASK_VISIBLE): string {
  if (typeof key !== "string") {
    throw new CryptoError(CryptoErrorCode.InvalidSecret, "maskKey requires a string key")
  }
  const points = Array.from(key)
  if (points.length === 0) return ""
  const requested = Number.isInteger(visible) && visible > 0 ? visible : 0
  const shown = Math.min(
    requested,
    MAX_MASK_VISIBLE,
    Math.floor(points.length / MASK_VISIBLE_DIVISOR),
  )
  // `points.length - shown` rather than `-shown`: `slice(-0)` is `slice(0)` and
  // would return the whole key.
  return "*".repeat(MASK_LENGTH - shown) + points.slice(points.length - shown).join("")
}

/** True when `hex` is exactly {@link HEX_KEY_LENGTH} hex characters. */
export function isHexKey(hex: string): boolean {
  return typeof hex === "string" && hex.length === HEX_KEY_LENGTH &&
    HEX_PATTERN.test(hex.toLowerCase())
}
