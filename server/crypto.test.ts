/**
 * Tests for `server/crypto.ts`. They pin the wire format inherited from
 * `template/libs/server/crypto` — standard base64 of `[IV (12 bytes)][ciphertext
 * + tag]`, AES-256-GCM, key = `SHA-256(utf8(secret))` — and the two fixes made
 * at port time (no AES-128 hex key, no failure classification by message text).
 *
 * Everything is deterministic: no network, no sleeps, no clock, and the one
 * random input used (the per-call IV) is injected by stubbing
 * `crypto.getRandomValues` inside a `try`/`finally`.
 */

import {
  assertEquals,
  assertFalse,
  assertInstanceOf,
  AssertionError,
  assertThrows,
} from "@std/assert"
import { encodeBase64 } from "@std/encoding/base64"
import {
  AES_ALGORITHM,
  AES_KEY_BYTES,
  CryptoError,
  CryptoErrorCode,
  CryptoService,
  DEFAULT_MASK_VISIBLE,
  HEX_KEY_LENGTH,
  isHexKey,
  IV_LENGTH,
  KEY_BITS,
  maskKey,
} from "./crypto.ts"

/** Obviously fake fixture — never a realistic key format. */
const SECRET = "test-secret-not-real-0123456789"

/** 64 hex characters = 32 bytes = AES-256. */
const HEX_KEY = "0123456789abcdef0123456789abcdef0123456789abcdef0123456789abcdef"

/** Ciphertext produced by `encrypt("pinned wire format check")` with `FIXED_IV`. */
const PINNED_CIPHERTEXT = "AAECAwQFBgcICQoL1mUajvWV9AThj0Cb0yi3pjPWNn1SxBgqaiJ7azQqR4SxpIEBi/W+IQ=="

const FIXED_IV = Uint8Array.from([0, 1, 2, 3, 4, 5, 6, 7, 8, 9, 10, 11])

/** Runs `body` with `crypto.getRandomValues` pinned to `bytes`, then restores it. */
async function withFixedRandomValues(bytes: Uint8Array, body: () => Promise<void>): Promise<void> {
  const original = crypto.getRandomValues.bind(crypto)
  crypto.getRandomValues = ((array: Uint8Array) => {
    array.set(bytes.subarray(0, array.length))
    return array
  }) as typeof crypto.getRandomValues
  try {
    await body()
  } finally {
    crypto.getRandomValues = original
  }
}

/** Asserts the rejected value is a `CryptoError` with `code`, and returns it. */
async function captureCryptoError(
  promise: Promise<unknown>,
  code: CryptoErrorCode,
): Promise<CryptoError> {
  let caught: unknown
  try {
    await promise
  } catch (error) {
    caught = error
  }
  assertInstanceOf(caught, CryptoError)
  if (!(caught instanceof CryptoError)) throw new AssertionError("expected a CryptoError")
  assertEquals(caught.code, code)
  return caught
}

/** Captures a rejection so the typed error can be asserted on. */
async function captureRejection(promise: Promise<unknown>): Promise<unknown> {
  try {
    await promise
  } catch (error) {
    return error
  }
  throw new AssertionError("expected the promise to reject")
}

const cryptoService = new CryptoService(SECRET)

Deno.test("crypto: constants describe the AES-256-GCM scheme", () => {
  assertEquals(AES_ALGORITHM, "AES-GCM")
  assertEquals(AES_KEY_BYTES, 32)
  assertEquals(KEY_BITS, 256)
  assertEquals(IV_LENGTH, 12)
  assertEquals(HEX_KEY_LENGTH, 64)
  assertEquals(DEFAULT_MASK_VISIBLE, 4)
})

Deno.test("crypto: round-trip returns the original, including empty, huge and unicode payloads", async () => {
  for (
    const plaintext of [
      "",
      "provider_token_example_123",
      "a".repeat(10_000),
      "🔐 émojis & spëcial çhars: !@#$%^&*()",
    ]
  ) {
    assertEquals(await cryptoService.decrypt(await cryptoService.encrypt(plaintext)), plaintext)
  }
})

Deno.test("crypto: two encryptions of one plaintext differ and both decrypt", async () => {
  const plaintext = "same_token"
  const first = await cryptoService.encrypt(plaintext)
  const second = await cryptoService.encrypt(plaintext)

  assertFalse(first === second)
  assertEquals(await cryptoService.decrypt(first), plaintext)
  assertEquals(await cryptoService.decrypt(second), plaintext)
})

Deno.test("crypto: wire format stays template's standard base64 of [IV][ciphertext+tag]", async () => {
  await withFixedRandomValues(FIXED_IV, async () => {
    const ciphertext = await cryptoService.encrypt("pinned wire format check")
    assertEquals(ciphertext, PINNED_CIPHERTEXT)
    // Standard base64, not base64url: `+`/`/` and `=` padding are present.
    assertEquals(/^[A-Za-z0-9+/]+={0,2}$/.test(ciphertext), true)
    assertEquals(/[+/]/.test(ciphertext), true)
    assertEquals(ciphertext.endsWith("="), true)
    // Cross-format guard: ciphertext is not decodable as base64url either.
    assertFalse(/^[A-Za-z0-9\-_]+$/.test(ciphertext))
  })
  assertEquals(await cryptoService.decrypt(PINNED_CIPHERTEXT), "pinned wire format check")
})

Deno.test("crypto: a different secret cannot decrypt, and fails as a typed CryptoError", async () => {
  const ciphertext = await cryptoService.encrypt("secret payload")
  const other = new CryptoService("a-completely-different-secret")
  const error = await captureCryptoError(
    other.decrypt(ciphertext),
    CryptoErrorCode.DecryptionFailed,
  )
  assertEquals(error.message, "decryption failed")
  assertFalse(error.message.includes(ciphertext))
  assertFalse(error.message.includes("a-completely-different-secret"))
})

Deno.test("crypto: decrypt failures are typed, never raw DOMException, and leak nothing", async () => {
  const badInputs = [
    "invalid_base64!@#",
    encodeBase64(new Uint8Array(4)),
    encodeBase64(new Uint8Array(IV_LENGTH)),
    encodeBase64(new Uint8Array(IV_LENGTH + 4)),
  ]

  for (const bad of badInputs) {
    const caught = await captureRejection(cryptoService.decrypt(bad))
    assertInstanceOf(caught, CryptoError)
    if (!(caught instanceof CryptoError)) throw new AssertionError("expected a CryptoError")
    assertFalse(caught instanceof DOMException)
    const known = caught.code === CryptoErrorCode.MalformedCiphertext ||
      caught.code === CryptoErrorCode.DecryptionFailed
    assertFalse(!known, `unexpected code ${caught.code} for ${JSON.stringify(bad)}`)
    assertFalse(caught.message.includes(bad))
    assertFalse(caught.message.includes(SECRET))
  }
})

Deno.test("crypto: a blob shorter than one IV fails as MalformedCiphertext, not DecryptionFailed", async () => {
  for (const length of [0, 4, IV_LENGTH - 1]) {
    const error = await captureCryptoError(
      cryptoService.decrypt(encodeBase64(new Uint8Array(length))),
      CryptoErrorCode.MalformedCiphertext,
    )
    assertEquals(error.message, "ciphertext is shorter than one IV")
  }
})

Deno.test("crypto: a corrupted valid blob throws DecryptionFailed and keeps the cause", async () => {
  const ciphertext = await cryptoService.encrypt("tamper target")
  const tampered = `${ciphertext.slice(0, 8)}${ciphertext[8] === "A" ? "B" : "A"}${
    ciphertext.slice(9)
  }`
  assertFalse(tampered === ciphertext)

  const error = await captureCryptoError(
    cryptoService.decrypt(tampered),
    CryptoErrorCode.DecryptionFailed,
  )
  assertInstanceOf(error.cause, Error)
  assertFalse(error.message.includes(tampered))
  assertFalse(error.message.includes("tamper target"))
  assertFalse(error.message.includes(SECRET))
})

Deno.test("crypto: fromHexKey accepts exactly 64 hex characters and round-trips", async () => {
  const fromHex = CryptoService.fromHexKey(HEX_KEY)
  const fromUpperHex = CryptoService.fromHexKey(HEX_KEY.toUpperCase())
  const payload = "hex-key payload 🔐"

  assertEquals(await fromHex.decrypt(await fromHex.encrypt(payload)), payload)
  // Case is normalised: upper-case hex is the same key, not a rejected one.
  assertEquals(await fromHex.decrypt(await fromUpperHex.encrypt(payload)), payload)
  assertEquals(await fromUpperHex.decrypt(await fromHex.encrypt(payload)), payload)
})

Deno.test("crypto: fromHexKey rejects a 32-hex-character AES-128 key", () => {
  const aes128 = "0123456789abcdef0123456789abcdef"
  const error = assertThrows(() => CryptoService.fromHexKey(aes128), CryptoError)
  assertEquals(error.code, CryptoErrorCode.InvalidHexKey)
  assertFalse(error.message.includes(aes128))
})

Deno.test("crypto: fromHexKey rejects empty, short, long, odd and non-hex keys", () => {
  const badKeys = [
    "", // empty
    HEX_KEY.slice(0, HEX_KEY_LENGTH - 2), // 62 characters
    HEX_KEY.slice(0, HEX_KEY_LENGTH - 1), // 63 characters — odd length
    `${HEX_KEY}0`, // 65 characters
    `${HEX_KEY.slice(0, HEX_KEY_LENGTH - 2)}zz`, // non-hex characters at the right length
    `0x${HEX_KEY.slice(0, HEX_KEY_LENGTH - 2)}`,
    ` ${HEX_KEY.slice(0, HEX_KEY_LENGTH - 1)}`, // surrounding whitespace is not trimmed
    `${HEX_KEY.slice(0, HEX_KEY_LENGTH - 1)} `,
    `${HEX_KEY}\n`,
  ]

  for (const bad of badKeys) {
    const error = assertThrows(() => CryptoService.fromHexKey(bad), CryptoError)
    assertEquals(error.code, CryptoErrorCode.InvalidHexKey)
    // An empty input is trivially "contained" in every message, so only a
    // non-empty rejected key is checked for leaking into the message.
    if (bad !== "") assertFalse(error.message.includes(bad))
  }
})

Deno.test("crypto: fromHexKey rejects a non-string key argument", () => {
  const error = assertThrows(
    () => CryptoService.fromHexKey(undefined as unknown as string),
    CryptoError,
  )
  assertEquals(error.code, CryptoErrorCode.InvalidHexKey)
})

Deno.test("crypto: the AES-128 rejection applies to the hex constructor only", async () => {
  const hexKey = "0123456789abcdef0123456789abcdef0123456789abcdef0123456789abcdef"
  const asSecretString = "0123456789abcdef0123456789abcdef"

  assertEquals(isHexKey(hexKey), true)
  assertEquals(isHexKey(asSecretString), false)
  const fromHex = CryptoService.fromHexKey(hexKey)
  assertEquals(await fromHex.decrypt(await fromHex.encrypt("hex")), "hex")
  // A 32-character *string secret* is hashed to 32 bytes and stays valid.
  const hashed = new CryptoService(asSecretString)
  assertEquals(await hashed.decrypt(await hashed.encrypt("hashed")), "hashed")
})

Deno.test("crypto: fromHexKey imports raw bytes, so it is not the string-secret cipher", async () => {
  // Same 64 characters through both entry points: the string is hashed with
  // SHA-256, the hex is decoded to the AES-256 key. Different keys, so neither
  // instance may read the other's ciphertext.
  const sameCharacters = "0123456789abcdef".repeat(4)
  assertEquals(sameCharacters.length, HEX_KEY_LENGTH)

  const fromHexKey = CryptoService.fromHexKey(sameCharacters)
  const fromStringSecret = new CryptoService(sameCharacters)
  const plaintext = "same characters, different key"

  assertEquals(await fromHexKey.decrypt(await fromHexKey.encrypt(plaintext)), plaintext)
  assertEquals(
    await fromStringSecret.decrypt(await fromStringSecret.encrypt(plaintext)),
    plaintext,
  )

  const hexCiphertext = await fromHexKey.encrypt(plaintext)
  const error = await captureCryptoError(
    fromStringSecret.decrypt(hexCiphertext),
    CryptoErrorCode.DecryptionFailed,
  )
  assertFalse(error.message.includes(hexCiphertext))
  assertFalse(error.message.includes(sameCharacters))

  const stringCiphertext = await fromStringSecret.encrypt(plaintext)
  await captureCryptoError(
    fromHexKey.decrypt(stringCiphertext),
    CryptoErrorCode.DecryptionFailed,
  )
})

Deno.test("crypto: the constructor rejects empty and blank secrets without echoing them", () => {
  for (const secret of ["", "   ", "\t\n"]) {
    const error = assertThrows(() => new CryptoService(secret), CryptoError)
    assertEquals(error.code, CryptoErrorCode.InvalidSecret)
    assertEquals(error.message, "CryptoService requires a non-empty secret")
    if (secret !== "") assertFalse(error.message.includes(secret))
  }
})

Deno.test("crypto: encryption failures are typed and carry the cause", async () => {
  const service = new CryptoService(SECRET)
  const original = crypto.subtle.importKey.bind(crypto.subtle)
  const boom = new Error("importKey unavailable")
  crypto.subtle.importKey = (() => Promise.reject(boom)) as typeof crypto.subtle.importKey
  try {
    const error = await captureCryptoError(
      service.encrypt("plaintext that must not leak"),
      CryptoErrorCode.EncryptionFailed,
    )
    assertEquals(error.cause, boom)
    assertFalse(error.message.includes("plaintext that must not leak"))
    assertFalse(error.message.includes(SECRET))
  } finally {
    crypto.subtle.importKey = original
  }
})

Deno.test("crypto: a failed key import is not cached — the next call retries", async () => {
  const service = new CryptoService(SECRET)
  const original = crypto.subtle.importKey.bind(crypto.subtle)
  let calls = 0
  crypto.subtle.importKey = ((...args: Parameters<typeof crypto.subtle.importKey>) => {
    calls += 1
    if (calls === 1) return Promise.reject(new Error("transient import failure"))
    return original(...args)
  }) as typeof crypto.subtle.importKey

  try {
    const error = await captureCryptoError(
      service.encrypt("first attempt"),
      CryptoErrorCode.EncryptionFailed,
    )
    assertEquals(error.message, "key derivation failed")
    assertEquals(calls, 1)
    // The cached promise was reset to null, so the second attempt derives again.
    assertEquals(await service.decrypt(await service.encrypt("second attempt")), "second attempt")
    assertEquals(calls, 2)
  } finally {
    crypto.subtle.importKey = original
  }
})

Deno.test("maskKey: reveals only trailing code points and never the whole key", () => {
  const masked = maskKey("sk-abcdefgh", 4)
  assertEquals(masked, "*******efgh")
  assertEquals(masked.slice(0, 7), "*******")
  assertEquals(masked.endsWith("efgh"), true)

  const key40 = "abcdefghijklmnopqrstuvwxyz0123456789abcd"
  assertEquals(maskKey(key40).length, key40.length)
  assertEquals(maskKey(key40).slice(-DEFAULT_MASK_VISIBLE), "abcd")
  assertEquals(maskKey(key40), `${"*".repeat(36)}abcd`)

  for (const key of ["sk-abcdefgh", key40, "a", "🔐🔑", "🔐🔑🗝🔒🧪🌟🔥🧩"]) {
    assertFalse(maskKey(key) === key, `maskKey leaked the key ${JSON.stringify(key)}`)
  }
})

Deno.test("maskKey: a key no longer than visible becomes all asterisks", () => {
  assertEquals(maskKey("abc", 4), "***")
  assertEquals(maskKey("abcd", 4), "****")
  assertEquals(maskKey("a", 4), "*")
  assertEquals(maskKey("ab", 2), "**")
  assertEquals(maskKey("abcd", 3), "*bcd")
  assertEquals(maskKey("abcd", 0), "****")
  assertEquals(maskKey("abcd", -1), "****")
  assertEquals(maskKey("abcd", 2.5), "****")
  assertEquals(maskKey("abcd", Number.NaN), "****")
  assertEquals(maskKey(""), "")
})

Deno.test("maskKey: masks by code point so a surrogate pair is never split", () => {
  const key = "🔐🔑🗝🔒🧪🌟🔥🧩"
  const masked = maskKey(key, 2)
  assertEquals(masked, "******🔥🧩")
  assertEquals(Array.from(masked).length, Array.from(key).length)
  assertFalse(masked === key)
  // No unpaired surrogate survived masking.
  assertFalse(/[\uD800-\uDBFF](?![\uDC00-\uDFFF])|(?<![\uD800-\uDBFF])[\uDC00-\uDFFF]/.test(masked))
})

Deno.test("maskKey: a non-string key is refused with a typed error", () => {
  const error = assertThrows(() => maskKey(undefined as unknown as string), CryptoError)
  assertEquals(error.code, CryptoErrorCode.InvalidSecret)
})

Deno.test("isHexKey: exactly 64 hex characters, either case", () => {
  assertEquals(isHexKey(HEX_KEY), true)
  assertEquals(isHexKey(HEX_KEY.toUpperCase()), true)
  assertEquals(isHexKey("0123456789abcdef0123456789abcdef"), false)
  assertEquals(isHexKey(HEX_KEY.slice(0, 63)), false)
  assertEquals(isHexKey(`${HEX_KEY}0`), false)
  assertEquals(isHexKey(""), false)
  assertEquals(isHexKey(`${HEX_KEY.slice(0, 62)}zz`), false)
})
