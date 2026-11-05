// DKIM verifier, step 6: hashing and the signature check with Web Crypto
// (`crypto.subtle`), plus the DER wrapping an RSA key record needs.

import { decodeBase64Url, encodeBase64 } from "@std/encoding"
import { base64Decode } from "./dkim-key.ts"
import {
  DkimParseError,
  type DkimPublicKey,
  type DkimSignatureHeader,
  MIN_RSA_KEY_BITS,
} from "./dkim-types.ts"

/**
 * Compute the base64 SHA-256 digest of a string or of raw octets.
 *
 * A string is encoded as UTF-8 first, which is what RFC 6376 hashes: the
 * canonical form of a message body is a sequence of octets, not of characters.
 * Passing `Uint8Array` is what lets a caller bound *octets* — an `l=` bound can
 * land inside a multi-octet character, and decoding the sliced bytes back to a
 * string would hash the replacement character instead of the declared bytes.
 *
 * @deprecated An internal step of `verifyDkim`, exported by mistake; it goes in 2.0.
 * Call `verifyDkim` or `verifyDkimSignatures` instead.
 */
export async function sha256Base64(input: string | Uint8Array): Promise<string> {
  const bytes = typeof input === "string" ? new TextEncoder().encode(input) : input
  const digest = await crypto.subtle.digest("SHA-256", asBytes(bytes))
  return encodeBase64(digest)
}

/**
 * Decode raw octets into the byte-exact string this module scans and hashes:
 * one UTF-16 code unit per octet, values 0-255.
 *
 * This is not text decoding, on purpose: `new TextDecoder("latin1")` is
 * really windows-1252 in the WHATWG standard and remaps the bytes 0x80-0x9F
 * to different code points, which corrupts exactly the bytes DKIM most needs
 * kept whole. `String.fromCharCode(...bytes)` would do the identity mapping
 * this wants, but it blows the call stack on a multi-megabyte body, hence the
 * chunking.
 */
export function bytesToBinaryString(bytes: Uint8Array): string {
  const CHUNK = 0x8000
  let out = ""
  for (let i = 0; i < bytes.length; i += CHUNK) {
    out += String.fromCharCode(...bytes.subarray(i, i + CHUNK))
  }
  return out
}

/**
 * The inverse of {@link bytesToBinaryString}: one octet per code unit.
 *
 * Not `TextEncoder`: `canonicalInput` and a cached canonical body are already
 * this module's byte-exact strings, where a code unit in 0x80-0xFF *is* one
 * raw octet already — UTF-8 encoding one would turn it into two bytes,
 * corrupting the very content {@link bytesToBinaryString} preserved.
 */
export function binaryStringToBytes(value: string): Uint8Array {
  const out = new Uint8Array(value.length)
  for (let i = 0; i < value.length; i++) out[i] = value.charCodeAt(i) & 0xff
  return out
}

/**
 * Narrow a byte array to a non-shared ArrayBuffer view. Every value hashed or
 * imported here was freshly allocated by this module and cannot alias a
 * SharedArrayBuffer; TypeScript 6 widens `Uint8Array` to `ArrayBufferLike`,
 * which `BufferSource` rejects.
 */
function asBytes(bytes: Uint8Array): Uint8Array<ArrayBuffer> {
  return new Uint8Array(bytes)
}

export async function verifySignature(
  parsed: DkimSignatureHeader,
  canonicalInput: string,
  publicKey: DkimPublicKey,
): Promise<boolean> {
  const signatureBytes = asBytes(base64Decode(parsed.signature))
  // `canonicalInput` is this module's byte-exact string (see `verifyDkimSignatures`
  // and `bytesToBinaryString`), not decoded text — `TextEncoder` would re-encode
  // any octet at or above 0x80 as two or more UTF-8 bytes, hashing bytes the
  // signer never signed. `binaryStringToBytes` is the matching inverse.
  const data = asBytes(binaryStringToBytes(canonicalInput))

  if (parsed.algorithm === "rsa-sha256") {
    if (publicKey.algorithm !== "rsa") {
      throw new DkimParseError(
        "algorithm/key mismatch (signature rsa-sha256 vs key ed25519)",
      )
    }
    const cryptoKey = await crypto.subtle.importKey(
      "spki",
      asBytes(spkiForRsaPublicKey(publicKey.keyBytes)),
      { name: "RSASSA-PKCS1-v1_5", hash: "SHA-256" },
      // Extractable so the modulus can be measured below. It is a public key:
      // exporting it gives away nothing that the DNS record did not publish.
      true,
      ["verify"],
    )
    // RFC 8301 §3.2: "Verifiers MUST NOT consider signatures using RSA keys of
    // less than 1024 bits as valid." A 512-bit key is breakable by anyone who
    // wants to forge mail from the domain that published it.
    //
    // The bits are counted from the modulus itself rather than read from
    // `algorithm.modulusLength`, which for an imported key is the modulus rounded
    // up to a whole byte: a 1023-bit key reports 1024 there and passed the floor
    // it fails.
    const modulusBits = await rsaModulusBits(cryptoKey)
    if (modulusBits < MIN_RSA_KEY_BITS) {
      throw new DkimParseError(
        `RSA key is ${modulusBits} bits; RFC 8301 requires at least ${MIN_RSA_KEY_BITS}`,
      )
    }
    return await crypto.subtle.verify(
      { name: "RSASSA-PKCS1-v1_5" },
      cryptoKey,
      signatureBytes,
      data,
    )
  }

  if (parsed.algorithm === "ed25519-sha256") {
    if (publicKey.algorithm !== "ed25519") {
      throw new DkimParseError(
        "algorithm/key mismatch (signature ed25519-sha256 vs key rsa)",
      )
    }
    // RFC 8463 §3: the signer "computes a message hash of the input using
    // SHA-256 ... and signs the hash with PureEdDSA Ed25519". RFC 8463's own
    // Appendix A.3 example verifies only over SHA-256 of the canonical input;
    // handing Web Crypto the raw input rejects every conformant Ed25519
    // message, because Web Crypto's Ed25519 is pure and adds no pre-hash.
    const digest = new Uint8Array(await crypto.subtle.digest("SHA-256", data))
    const cryptoKey = await crypto.subtle.importKey(
      "raw",
      asBytes(publicKey.keyBytes),
      { name: "Ed25519" },
      false,
      ["verify"],
    )
    return await crypto.subtle.verify({ name: "Ed25519" }, cryptoKey, signatureBytes, digest)
  }

  throw new DkimParseError(`unsupported algorithm: ${parsed.algorithm}`)
}

/**
 * The true bit length of an RSA key's modulus.
 *
 * `CryptoKey.algorithm.modulusLength` is not it: for a key that was imported
 * rather than generated, the platform reports the modulus rounded up to a whole
 * byte, so keys of 1017 to 1023 bits all say 1024 and slip past RFC 8301's floor.
 * The JWK export carries the modulus itself (`n`, base64url, big-endian), and its
 * leading zero bits are not part of the number.
 */
async function rsaModulusBits(key: CryptoKey): Promise<number> {
  const jwk = await crypto.subtle.exportKey("jwk", key)
  if (jwk.n === undefined) throw new DkimParseError("RSA key has no modulus")
  return bitLength(base64UrlDecode(jwk.n))
}

/** Bits in a big-endian unsigned integer, leading zeros not counted. */
function bitLength(bytes: Uint8Array): number {
  let at = 0
  while (at < bytes.length && bytes[at] === 0) at++
  if (at === bytes.length) return 0
  let bits = (bytes.length - at - 1) * 8
  for (let byte = bytes[at]; byte > 0; byte >>= 1) bits++
  return bits
}

/** Decode base64url, which is what JWK uses: `-_` for `+/`, and no padding. */
function base64UrlDecode(value: string): Uint8Array {
  try {
    return decodeBase64Url(value)
  } catch {
    throw new DkimParseError("value is not valid base64url")
  }
}

/**
 * Wrap a bare RSA public key (PKCS#1 `RSAPublicKey`, which is what `p=` holds)
 * in the SubjectPublicKeyInfo envelope SubtleCrypto imports.
 *
 * SPKI = SEQUENCE { AlgorithmIdentifier, BIT STRING { pkcs1 } }, with
 * AlgorithmIdentifier = SEQUENCE { OID 1.2.840.113549.1.1.1, NULL }.
 */
function spkiForRsaPublicKey(rsaPublicKey: Uint8Array): Uint8Array {
  // §3.6.1: for `k=rsa` the p= tag holds "an ASN.1 DER-encoded RSAPublicKey",
  // i.e. a bare PKCS#1 SEQUENCE { modulus, exponent } — which is what real
  // selector records publish. RFC 6376's own example record, however, publishes
  // a complete SubjectPublicKeyInfo, so both shapes occur in the wild and both
  // have to import. Detect the envelope rather than guessing: an SPKI carries an
  // AlgorithmIdentifier SEQUENCE, a PKCS#1 key carries an INTEGER modulus.
  if (rsaPublicKey[0] !== 0x30) {
    throw new DkimParseError("RSA public key is not a DER SEQUENCE")
  }
  if (looksLikeSpki(rsaPublicKey)) return rsaPublicKey
  const bitStringContent = new Uint8Array(rsaPublicKey.length + 1)
  bitStringContent[0] = 0x00
  bitStringContent.set(rsaPublicKey, 1)

  const algorithmIdentifier = new Uint8Array([
    0x30,
    0x0d,
    0x06,
    0x09,
    0x2a,
    0x86,
    0x48,
    0x86,
    0xf7,
    0x0d,
    0x01,
    0x01,
    0x01,
    0x05,
    0x00,
  ])

  const bitString = encodeDerLengthPrefixed(0x03, bitStringContent)
  return encodeDerLengthPrefixed(0x30, concat(algorithmIdentifier, bitString))
}

/**
 * True when `der` is already a SubjectPublicKeyInfo rather than a bare
 * PKCS#1 `RSAPublicKey`. The two are distinguishable at the first element after
 * the outer SEQUENCE: SPKI wraps an AlgorithmIdentifier SEQUENCE (tag 0x30),
 * PKCS#1 wraps the modulus INTEGER (tag 0x02).
 */
function looksLikeSpki(der: Uint8Array): boolean {
  let at = 1
  const first = der[at++]
  if (first >= 0x80) at += first & 0x7f
  return der[at] === 0x30
}

function encodeDerLengthPrefixed(tag: number, content: Uint8Array): Uint8Array {
  const lengthBytes = encodeDerLength(content.length)
  const out = new Uint8Array(1 + lengthBytes.length + content.length)
  out[0] = tag
  out.set(lengthBytes, 1)
  out.set(content, 1 + lengthBytes.length)
  return out
}

function encodeDerLength(length: number): Uint8Array {
  if (length < 0x80) return new Uint8Array([length])
  const bytes: number[] = []
  let n = length
  while (n > 0) {
    bytes.unshift(n & 0xff)
    n >>= 8
  }
  return new Uint8Array([0x80 | bytes.length, ...bytes])
}

function concat(a: Uint8Array, b: Uint8Array): Uint8Array {
  const out = new Uint8Array(a.length + b.length)
  out.set(a, 0)
  out.set(b, a.length)
  return out
}
