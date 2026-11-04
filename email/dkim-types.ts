// Types, limits and the parse error shared by the DKIM verifier's steps.
// Public through `./dkim-verify.ts`, which re-exports them.

/** Which canonicalization RFC 6376 §3.4 applies to a header or a body. */
export type Canonicalization = "simple" | "relaxed"

/** Signature algorithms this verifier implements (RFC 6376 §3.3, RFC 8463). */
export type DkimAlgorithm = "rsa-sha256" | "ed25519-sha256"

/** Key algorithms a DNS TXT record's `k=` tag may name. */
export type DkimKeyAlgorithm = "rsa" | "ed25519"

/** Parsed `DKIM-Signature` header value. */
export interface DkimSignatureHeader {
  /** `v=` — RFC 6376 §3.5 defines exactly one version: `1`. */
  version: string
  /** `a=` */
  algorithm: DkimAlgorithm
  /** `d=` — the signing domain (SDID), lowercased. */
  domain: string
  /** `s=` — the selector, lowercased. */
  selector: string
  /** `h=` — signed header field names, lowercased, in signed order. */
  signedHeaders: string[]
  /** `bh=` — base64 body hash, with folding and WSP removed (RFC 6376 §3.5). */
  bodyHash: string
  /** `b=` — base64 signature, as it appeared in the header. */
  signature: string
  /** `c=` — header/body canonicalization; `simple` for both when omitted. */
  canonicalization: { header: Canonicalization; body: Canonicalization }
  /** `t=` — signature timestamp, seconds since the Unix epoch. */
  timestamp?: bigint
  /** `x=` — signature expiration, seconds since the Unix epoch. */
  expiration?: bigint
  /** `l=` — octets of the canonicalized body covered by `bh=`. */
  bodyLength?: number
  /** `q=` — query methods the signer suggests; not used by this verifier. */
  queryMethod?: string
  /** `i=` — agent or user identifier (AUID). */
  identity?: string
  /** The header value exactly as it appeared in the message. */
  raw: string
}

/** A DKIM public key extracted from a DNS TXT record. */
export interface DkimPublicKey {
  /** `k=` from the record; `rsa` when the tag is absent. */
  algorithm: DkimKeyAlgorithm
  /**
   * The key exactly as `p=` carried it: a bare PKCS#1 `RSAPublicKey` or a
   * complete SubjectPublicKeyInfo for RSA, raw for Ed25519. Not normalised —
   * RFC 6376 §3.6.1 specifies PKCS#1 and its own example record publishes SPKI,
   * so both shapes occur and both are left alone.
   */
  keyBytes: Uint8Array
  /** `v=` when the record carries one. §3.6.1 defines exactly one value: `DKIM1`. */
  version?: string
  /**
   * `h=` — the hash algorithms the key may be used with, lowercased. Absent when
   * the record names none, which §3.6.1 reads as "all algorithms are allowed".
   */
  hashAlgorithms?: string[]
  /**
   * `s=` — the service types the key applies to, lowercased. Absent when the
   * record names none, which §3.6.1 reads as `*`.
   */
  serviceTypes?: string[]
  /**
   * `t=` — the record's flags, lowercased. §3.6.1 defines `y` (the domain is
   * testing DKIM) and `s` (`i=` must carry exactly `d=`, not a subdomain).
   */
  flags?: string[]
}

/**
 * How much of the canonicalized body a signature's `bh=` tag actually covers.
 *
 * RFC 6376 §3.5's `l=` tag lets a signer sign a prefix of the body and leave the
 * rest unsigned; with `l=0` the signature covers no body at all, and any text may
 * be appended to the message without breaking it. That is legal, so it does not
 * make the signature invalid — but a caller who reads "valid" as "the whole
 * message is authentic" is wrong whenever {@link DkimBodyCoverage.complete} is
 * false, which is why every result that hashed a body carries this.
 */
export interface DkimBodyCoverage {
  /** Canonical body octets the body hash covers. */
  signedOctets: number
  /** Canonical body octets the message has. */
  totalOctets: number
  /** True when the signature covers the whole canonical body. */
  complete: boolean
}

/** Outcome of {@link verifyDkim}. A malformed message returns, it does not throw. */
export interface DkimVerificationResult {
  valid: boolean
  /** Present when `valid` is false; a stable, human-readable diagnosis. */
  reason?: string
  /** Present whenever the signature header could be parsed. */
  parsed?: DkimSignatureHeader
  /** The recomputed body hash, for diagnostics. */
  computedBodyHash?: string
  /**
   * First 240 octets of the recomputed signature input, for diagnostics — one
   * character of this string per octet (see the module note on `verifyDkim`),
   * so non-ASCII text shows as its raw UTF-8 bytes rather than as the
   * characters they encode.
   */
  computedInputPreview?: string
  /** How much of the body the signature covers; present once the body was hashed. */
  bodyCoverage?: DkimBodyCoverage
}

/**
 * DNS TXT lookup contract, defaulting to `resolveTxt` of `@spy4x/net/dns`, which
 * works on Deno, Node and Bun and needs `--allow-net` on Deno. Inject one to run
 * the verifier hermetically — no socket, no cache, no upstream.
 *
 * The shape is one array of strings per TXT record. RFC 6376 §3.6.2.2 requires
 * a record's strings to be concatenated with no separator, which
 * {@link fetchDkimPublicKey} does before parsing.
 */
export interface DnsTxtResolver {
  resolveTxt: (name: string) => Promise<string[][]>
}

/** Options for {@link verifyDkim} and {@link fetchDkimPublicKey}. */
export interface DkimVerifyOptions {
  /** Override the signature clock. Defaults to the current epoch second. */
  now?: bigint
  /** DNS TXT resolver used to fetch the public key when none is supplied. */
  resolver?: DnsTxtResolver
  /**
   * Longest message this verifier will look at, in octets. Defaults to
   * {@link DEFAULT_MAX_MESSAGE_LENGTH}. A longer message is refused before it is
   * canonicalized: every pass here is linear, and the cap is what bounds the work
   * an unauthenticated sender can ask for. Counted in octets, not in UTF-16 code
   * units, whether `rawMessage` was passed as a `string` or a `Uint8Array` — RFC
   * 6376 sizes a message in octets, and a string's `.length` is code units.
   */
  maxMessageLength?: number
  /**
   * How many `DKIM-Signature` fields to verify. Defaults to
   * {@link DEFAULT_MAX_SIGNATURES}. RFC 6376 §6.1 allows the limit; without one,
   * a message full of signature fields buys one key lookup and one public-key
   * operation each.
   */
  maxSignatures?: number
  /**
   * How many header fields a message may carry. Defaults to
   * {@link DEFAULT_MAX_HEADER_FIELDS}. Neither RFC 5322 nor RFC 6376 sets a
   * limit, and ordinary mail is two orders of magnitude below this one; a message
   * that is only header fields is not mail.
   */
  maxHeaderFields?: number
  /**
   * How many names a signature's `h=` tag may list. Defaults to
   * {@link DEFAULT_MAX_SIGNED_HEADER_NAMES}. A signer that oversigns lists every
   * field twice, so real values are tens, not hundreds.
   */
  maxSignedHeaderNames?: number
}

/**
 * Default {@link DkimVerifyOptions.maxSignatures}. Real mail carries one to three
 * signatures, and a mailing list that re-signs adds one more.
 */
export const DEFAULT_MAX_SIGNATURES = 10

/**
 * Default {@link DkimVerifyOptions.maxMessageLength}: 10 MiB of octets, which is
 * above the message size limit relays usually impose and far below anything
 * that takes a noticeable time to canonicalize.
 */
export const DEFAULT_MAX_MESSAGE_LENGTH = 10 * 1024 * 1024

/**
 * Default {@link DkimVerifyOptions.maxHeaderFields}. Mail carries tens of header
 * fields; a long mailing-list chain with a `Received` line per hop carries
 * hundreds at the very worst.
 */
export const DEFAULT_MAX_HEADER_FIELDS = 1000

/**
 * Default {@link DkimVerifyOptions.maxSignedHeaderNames}. Signers list ten to
 * twenty names, or twice that when they oversign.
 */
export const DEFAULT_MAX_SIGNED_HEADER_NAMES = 200

/**
 * RFC 8301 §3.2: "Verifiers MUST NOT consider signatures using RSA keys of less
 * than 1024 bits as valid."
 */
export const MIN_RSA_KEY_BITS = 1024

/** Thrown for a malformed DKIM-Signature header or DNS key record. */
export class DkimParseError extends Error {
  override name = "DkimParseError"
}
