// DKIM signature verification per RFC 6376.
//
// Pure verifier: given a raw RFC 5322 message and a DKIM public key it decides
// whether the message's DKIM-Signature verifies against that key. It fetches
// nothing on its own unless a caller injects a DNS TXT resolver.
//
// This file runs the verification and is the package's public entry point.
// Each step lives in a sibling module of this same package, re-exported here:
// `dkim-signature.ts` (parse the field), `dkim-canonicalize.ts`,
// `dkim-key.ts` (key record and DNS lookup), `dkim-message.ts` (split the
// message, refuse ambiguous header bytes), `dkim-headers.ts` (select signed
// fields), `dkim-crypto.ts` (hash and signature check), `dkim-types.ts` and
// `dkim-body-hash.ts`. Together they use Web Crypto (`crypto.subtle`),
// platform primitives (`TextEncoder`), `@std/encoding` for base64 only (#674),
// and `resolveTxt` of `@spy4x/net/dns` for the default key lookup on Deno,
// Node and Bun.

import { type BodyHashCache, createBodyHashCache } from "./dkim-body-hash.ts"
import { canonicalizeBody, canonicalizeHeader } from "./dkim-canonicalize.ts"
import {
  binaryStringToBytes,
  bytesToBinaryString,
  sha256Base64,
  verifySignature,
} from "./dkim-crypto.ts"
import { headerNameMatches, selectSignedHeaders, trimHeaderName } from "./dkim-headers.ts"
import { fetchDkimPublicKey } from "./dkim-key.ts"
import { refuseHeaderLineEndings, splitMessage } from "./dkim-message.ts"
import { deleteTagValue, parseDkimSignatureHeader } from "./dkim-signature.ts"
import {
  DEFAULT_MAX_HEADER_FIELDS,
  DEFAULT_MAX_MESSAGE_LENGTH,
  DEFAULT_MAX_SIGNATURES,
  DEFAULT_MAX_SIGNED_HEADER_NAMES,
  type DkimBodyCoverage,
  type DkimPublicKey,
  type DkimSignatureHeader,
  type DkimVerificationResult,
  type DkimVerifyOptions,
} from "./dkim-types.ts"

export type {
  Canonicalization,
  DkimAlgorithm,
  DkimBodyCoverage,
  DkimKeyAlgorithm,
  DkimPublicKey,
  DkimSignatureHeader,
  DkimVerificationResult,
  DkimVerifyOptions,
  DnsTxtResolver,
} from "./dkim-types.ts"
export {
  DEFAULT_MAX_HEADER_FIELDS,
  DEFAULT_MAX_MESSAGE_LENGTH,
  DEFAULT_MAX_SIGNATURES,
  DEFAULT_MAX_SIGNED_HEADER_NAMES,
  DkimParseError,
  MIN_RSA_KEY_BITS,
} from "./dkim-types.ts"
export { parseDkimSignature } from "./dkim-signature.ts"
export { canonicalizeBody, canonicalizeHeader } from "./dkim-canonicalize.ts"
export { fetchDkimPublicKey, parseDkimPublicKey } from "./dkim-key.ts"
export { refuseHeaderLineEndings, splitMessage } from "./dkim-message.ts"
export { TRANSIT_ADDED_HEADER_NAMES } from "./dkim-headers.ts"
export { sha256Base64 } from "./dkim-crypto.ts"

/**
 * Verify a message's DKIM signatures and report one verdict.
 *
 * A message may carry several `DKIM-Signature` fields, and RFC 6376 §6.1 treats
 * them independently: the message is signed by any one of them that verifies.
 * This returns the first valid result, and the first signature's diagnosis when
 * none is valid — so a broken signature above a good one no longer condemns the
 * message, and a signature an attacker prepends no longer decides it either.
 * {@link verifyDkimSignatures} returns all of them when a caller needs to know
 * which domains signed.
 *
 * When `publicKey` is omitted the key is fetched from `options.resolver`,
 * defaulting to `resolveTxt` of `@spy4x/net/dns`, which needs `--allow-net` on
 * Deno.
 *
 * `rawMessage` may be a `string` or a `Uint8Array`. DKIM is defined over
 * octets (RFC 6376 §2.4: "the entire, unaltered message body, including any
 * MIME framing"), and a JavaScript string cannot represent an 8-bit body
 * faithfully — decoding it as UTF-8 rewrites bytes outside that encoding, and
 * decoding it as `latin1` actually runs windows-1252 and remaps 0x80-0x9F.
 * Pass the raw bytes for mail that might not be UTF-8; a `string` keeps
 * working exactly as before, UTF-8 encoded first.
 *
 * Message-shaped failures — missing header, bad grammar, expired signature,
 * unsigned `From`, body mismatch, unverifiable signature — all come back as a
 * {@link DkimVerificationResult}, and so does a resolver that throws: its message
 * becomes the reason. Nothing escapes, which means a DNS failure and a wrong
 * signature look alike here; a caller that needs RFC 6376 §6.1.2's TEMPFAIL and
 * PERMFAIL apart should fetch the key with {@link fetchDkimPublicKey}, which
 * propagates the resolver's rejection.
 */
export async function verifyDkim(
  rawMessage: string | Uint8Array,
  publicKey?: DkimPublicKey,
  options: DkimVerifyOptions = {},
): Promise<DkimVerificationResult> {
  const results = await verifyDkimSignatures(rawMessage, publicKey, options)
  return results.find((result) => result.valid) ?? results[0]
}

/**
 * Verify every `DKIM-Signature` field in the message and return one result each,
 * in the order the fields appear.
 *
 * The list is never empty: a message with no signature at all produces the single
 * "no DKIM-Signature header found" result, and so does a message longer than
 * {@link DkimVerifyOptions.maxMessageLength} or one whose header block fails
 * {@link refuseHeaderLineEndings}. Fields past
 * {@link DkimVerifyOptions.maxSignatures} get a result saying they were not
 * checked, rather than disappearing.
 *
 * See {@link verifyDkim} for `rawMessage`'s `string | Uint8Array` contract.
 */
export async function verifyDkimSignatures(
  rawMessage: string | Uint8Array,
  publicKey?: DkimPublicKey,
  options: DkimVerifyOptions = {},
): Promise<DkimVerificationResult[]> {
  // Every octet, header scan and canonicalization step below works on one
  // byte-exact string — one UTF-16 code unit per octet — whether the caller
  // passed a `string` or a `Uint8Array`. A `string` is UTF-8 encoded first,
  // which is what this verifier hashed all along; that also makes the size
  // cap below count octets rather than code units, matching what §2.4 and
  // §3.7 size a message and a body in.
  const octets = typeof rawMessage === "string" ? new TextEncoder().encode(rawMessage) : rawMessage

  const maxMessageLength = options.maxMessageLength ?? DEFAULT_MAX_MESSAGE_LENGTH
  if (octets.length > maxMessageLength) {
    return [{
      valid: false,
      reason: `message is ${octets.length} octets, over the ` +
        `${maxMessageLength}-octet limit`,
    }]
  }

  // A pure-ASCII string round-trips through UTF-8 as itself — every code unit
  // is already its own octet — so rebuilding it byte by byte below would only
  // waste a second linear pass over the whole message. `octets.length ===
  // rawMessage.length` holds exactly then: any non-ASCII character encodes to
  // more than one octet, which can only make the encoded form longer.
  const raw = typeof rawMessage === "string" && octets.length === rawMessage.length
    ? rawMessage
    : bytesToBinaryString(octets)

  // Before any field is parsed: a header block whose line endings are not uniform
  // does not have one reading, and this verifier's reading is the one an attacker
  // gets to choose against. See `refuseHeaderLineEndings`.
  const lineEndings = refuseHeaderLineEndings(raw)
  if (lineEndings !== undefined) {
    return [{ valid: false, reason: lineEndings }]
  }

  const { headers, body } = splitMessage(raw)
  const maxHeaderFields = options.maxHeaderFields ?? DEFAULT_MAX_HEADER_FIELDS
  if (headers.length > maxHeaderFields) {
    return [{
      valid: false,
      reason: `message has ${headers.length} header fields, over the ` +
        `${maxHeaderFields}-field limit`,
    }]
  }
  // Every signature is verified, not just the first: a broken one above a good
  // one used to condemn the whole message, and a valid one an attacker put on top
  // used to decide it. Each field's value keeps its exact bytes, so the canonical
  // form reconstructed for hashing matches what that signer saw.
  // The name is compared trimmed, as `selectSignedHeaders` compares it: RFC 5322's
  // obsolete syntax allows WSP before the colon, so `DKIM-Signature :` is a field.
  const fields: number[] = []
  headers.forEach((line, index) => {
    const colon = line.indexOf(":")
    if (colon === -1) return
    if (trimHeaderName(line.slice(0, colon)).toLowerCase() === "dkim-signature") fields.push(index)
  })
  if (fields.length === 0) {
    return [{ valid: false, reason: "no DKIM-Signature header found" }]
  }

  // One cache for the whole message: RFC 6376 §6.1 verifies every signature
  // field independently, and most real messages sign the body once — the same
  // `c=` and `l=` — no matter how many `DKIM-Signature` fields they carry. See
  // `dkim-body-hash.ts` for why splitting this out gave the caching seam a
  // name a test could reach without widening the package's exports.
  const bodyHashCache = createBodyHashCache({
    canonicalize: (algorithm) => canonicalizeBody(body, algorithm),
    encode: binaryStringToBytes,
    digest: (bytes) => sha256Base64(bytes),
  })

  const maxSignatures = options.maxSignatures ?? DEFAULT_MAX_SIGNATURES
  const results: DkimVerificationResult[] = []
  for (const [index, at] of fields.entries()) {
    // §6.1: a verifier may limit how many signatures it tries. Without a limit,
    // every extra field buys an attacker one key lookup and one public-key
    // operation.
    if (index >= maxSignatures) {
      results.push({
        valid: false,
        reason: `not verified: only the first ${maxSignatures} DKIM-Signature ` +
          `fields of a message are checked`,
      })
      continue
    }
    // §3.5: the field being verified is never one of the headers h= selects, so
    // an h= that names `dkim-signature` reaches only the other signatures.
    const others = headers.filter((_, i) => i !== at)
    results.push(await verifyOneSignature(headers[at], others, publicKey, options, bodyHashCache))
  }
  return results
}

async function verifyOneSignature(
  dkimHeaderLine: string,
  headers: string[],
  publicKey: DkimPublicKey | undefined,
  options: DkimVerifyOptions,
  bodyHashCache: BodyHashCache,
): Promise<DkimVerificationResult> {
  // §3.7 step 2 hashes "the DKIM-Signature header field that exists" in the
  // message, so the field name is taken from the message rather than assumed.
  // Under `simple` canonicalization the name's case is part of the hashed
  // bytes: hashing a literal "DKIM-Signature" verified a field renamed to
  // `dkim-signature:`, i.e. bytes the message no longer contained, and rejected
  // a signer that emitted the lower-case name.
  const dkimFieldName = dkimHeaderLine.slice(0, dkimHeaderLine.indexOf(":"))
  const dkimRaw = dkimHeaderLine.slice(dkimFieldName.length + 1)
  if (dkimRaw.trim() === "") {
    return { valid: false, reason: "DKIM-Signature header is empty" }
  }

  let parsed: DkimSignatureHeader
  try {
    const field = parseDkimSignatureHeader(dkimRaw)
    parsed = field.header
  } catch (err) {
    return { valid: false, reason: errorMessage(err) }
  }

  const refusal = refuseSignatureHeader(parsed, headers, options)
  if (refusal !== undefined) return { valid: false, parsed, reason: refusal }

  let key = publicKey
  if (!key) {
    try {
      const fetched = await fetchDkimPublicKey(
        parsed.domain,
        parsed.selector,
        options,
      )
      if (fetched === null) {
        return {
          valid: false,
          parsed,
          reason: "DKIM key revoked (p= is empty)",
        }
      }
      key = fetched
    } catch (err) {
      return { valid: false, parsed, reason: errorMessage(err) }
    }
  }

  const keyRefusal = refuseKeyRecord(key, parsed)
  if (keyRefusal !== undefined) return { valid: false, parsed, reason: keyRefusal }

  let signedHeaders: { name: string; value: string }[]
  let computedBodyHash: string
  let bodyCoverage: DkimBodyCoverage
  try {
    signedHeaders = selectSignedHeaders(headers, parsed.signedHeaders)
    // §3.7 step 1: the body is hashed "canonicalized using the body
    // canonicalization algorithm specified in the c= tag and then truncated to
    // the length specified in the l= tag". The bound counts canonical *octets*,
    // so the truncation happens on encoded bytes, not on `String.prototype.slice`
    // — which counts UTF-16 code units and, before every octet here was already
    // byte-exact, diverged from octets at the first non-ASCII character and
    // falsely rejected valid non-ASCII mail. The bound may also land inside a
    // multi-octet character, which is what rules out decoding the sliced bytes
    // back to a string: U+FFFD would be hashed in place of the declared octets.
    // A bound longer than the body it accompanies is not an error: the slice
    // then covers all of it, which is what a signer that declared a longer bound
    // produced.
    //
    // `bodyHashCache` does the canonicalizing and hashing, at most once per
    // `(c=, l=)` combination for the whole message — see `dkim-body-hash.ts`
    // and issue #88's third finding: verifying this per signature field, as an
    // earlier revision did, cost one full canonicalize-and-hash pass over the
    // body for every `DKIM-Signature` field, so a message with several of them
    // multiplied the one thing here that scales with the body's size.
    const hashed = await bodyHashCache.get(parsed.canonicalization.body, parsed.bodyLength)
    computedBodyHash = hashed.hash
    bodyCoverage = {
      signedOctets: hashed.signedOctets,
      totalOctets: hashed.totalOctets,
      complete: hashed.signedOctets === hashed.totalOctets,
    }
  } catch (err) {
    return { valid: false, parsed, reason: errorMessage(err) }
  }

  // Neither side of this comparison is a secret — `computedBodyHash` is derived
  // from the public message body, and `parsed.bodyHash` is copied straight out
  // of the `bh=` tag the sender put on the wire — so a plain compare needs no
  // constant-time treatment: there is nothing here a timing channel could leak
  // that the message itself does not already show. #71's constant-time copy
  // that used to sit here is removed, not moved to a shared home.
  if (computedBodyHash !== parsed.bodyHash) {
    return {
      valid: false,
      parsed,
      reason: "body hash mismatch (body modified after signing)",
      computedBodyHash,
      bodyCoverage,
    }
  }

  // Signature input, §3.7 step 2, assembled in one place so there is no second
  // copy of the field to drift:
  //   1. every header named in h=, in h= order, each terminated by one CRLF;
  //   2. the DKIM-Signature field with its b= value deleted, canonicalized, and
  //      *without a trailing CRLF*.
  let canonicalInput: string
  try {
    const signedParts = signedHeaders.map(({ name, value }) =>
      canonicalizeHeader(name, value, parsed.canonicalization.header)
    )
    const signatureField = canonicalizeHeader(
      dkimFieldName,
      deleteTagValue(dkimRaw, "b"),
      parsed.canonicalization.header,
    ).replace(/\r\n$/, "")
    // Nothing follows the DKIM-Signature field: §3.7 step 2 hashes the field
    // bare, and the body hash the signer covered is the `bh=` tag inside that
    // very field. Appending it here would hash 44 bytes no signer hashed, and
    // every externally produced signature failed.
    canonicalInput = signedParts.join("") + signatureField
  } catch (err) {
    return { valid: false, parsed, reason: errorMessage(err), computedBodyHash, bodyCoverage }
  }

  let verified: boolean
  try {
    verified = await verifySignature(parsed, canonicalInput, key)
  } catch (err) {
    return {
      valid: false,
      parsed,
      reason: errorMessage(err),
      computedBodyHash,
      bodyCoverage,
    }
  }

  return {
    valid: verified,
    parsed,
    computedBodyHash,
    computedInputPreview: canonicalInput.slice(0, 240),
    bodyCoverage,
    reason: verified ? undefined : "signature did not verify against public key",
  }
}

/**
 * The checks RFC 6376 §6.1.1 puts on the signature header itself, before a key
 * is fetched. Returns the reason to refuse, or `undefined` to carry on.
 *
 * Every one of these is a MUST in the standard, and the first is the one this
 * verifier shipped without: a signature whose `h=` never names `From` binds
 * nothing to the address a person reads, so rewriting `From` left the signature
 * valid and the mail was accepted as coming from whoever the attacker liked.
 */
function refuseSignatureHeader(
  parsed: DkimSignatureHeader,
  headers: string[],
  options: DkimVerifyOptions,
): string | undefined {
  // The work a signature can ask for is bounded before any of it is done: the
  // selection below walks h= once per name, and h= comes from the sender.
  const maxSignedHeaderNames = options.maxSignedHeaderNames ?? DEFAULT_MAX_SIGNED_HEADER_NAMES
  if (parsed.signedHeaders.length > maxSignedHeaderNames) {
    return `h= names ${parsed.signedHeaders.length} headers, over the ` +
      `${maxSignedHeaderNames}-name limit`
  }

  // §6.1.1: "If the 'h=' tag does not include the From header field, the Verifier
  // MUST ignore the DKIM-Signature header field and return PERMFAIL (From field
  // not signed)."
  if (!parsed.signedHeaders.includes("from")) {
    return "From field not signed (h= does not name from)"
  }
  // §5.4 requires the From field to be signed, which a message that has no From
  // field cannot satisfy: `h=from` over a message with no From hashes nothing for
  // it, so the signature would say nothing about the author either. The name is
  // read through `headerNameMatches`, not a plain end-trimmed comparison, so a
  // line whose only "From" is disguised inside the name still counts as present
  // here (issue #113) — this check only ever widens what counts as an instance
  // to reject; `selectSignedHeaders`' own #113 guard is what actually refuses
  // such a line, whether or not a genuine `From:` sits elsewhere in the message.
  // A line with no colon at all is not a header field this verifier can name —
  // `line.indexOf(":")` is `-1`, and `line.slice(0, -1)` would drop only that
  // line's last character rather than naming the whole line, which let an mbox
  // `From sender Mon Sep …` envelope line (no colon, and `From` padded by the
  // space that follows it) count as a `From` field being present. Skipping a
  // colon-less line here is what a real field-name comparison would do anyway.
  if (
    !headers.some((line) => {
      const colon = line.indexOf(":")
      return colon !== -1 && headerNameMatches(line.slice(0, colon), "from")
    })
  ) {
    return "From field not signed (the message has no From field)"
  }

  // §6.1.1: "Verifiers MUST confirm that the domain specified in the 'd=' tag is
  // the same as or a parent domain of the domain part of the 'i=' tag."
  const identityDomain = signerIdentityDomain(parsed)
  if (identityDomain !== undefined && !isSameOrParentDomain(parsed.domain, identityDomain)) {
    return `i= domain ${identityDomain} is not d= (${parsed.domain}) or a subdomain of it`
  }

  // §3.5 on x=: "The value of the 'x=' tag MUST be greater than the value of the
  // 't=' tag if both are present." A signature that expires before it was made
  // covers no window at all.
  if (
    parsed.expiration !== undefined && parsed.timestamp !== undefined &&
    parsed.expiration <= parsed.timestamp
  ) {
    return `x= (${parsed.expiration}) is not later than t= (${parsed.timestamp})`
  }

  if (parsed.expiration !== undefined) {
    const now = options.now ?? BigInt(Math.floor(Date.now() / 1000))
    if (parsed.expiration < now) return "signature expired"
  }

  // §3.5 on q=: the only method this verifier implements is `dns/txt`, which is
  // also the default when the tag is absent. A signer that asks for a method
  // nobody here speaks has not published a key this code can find.
  if (parsed.queryMethod !== undefined) {
    const methods = parsed.queryMethod.toLowerCase().split(":").map((method) =>
      method.replace(/[ \t]+/g, "")
    )
    if (!methods.some((method) => method === "dns/txt" || method === "dns")) {
      return `unsupported q= query method: ${parsed.queryMethod}`
    }
  }

  return undefined
}

/**
 * The checks RFC 6376 §3.6.1 puts on the key record, once it is in hand. Returns
 * the reason to refuse, or `undefined` to carry on.
 */
function refuseKeyRecord(
  key: DkimPublicKey,
  parsed: DkimSignatureHeader,
): string | undefined {
  // §3.6.1 on t=y: "This domain is testing DKIM. Verifiers MUST NOT treat
  // messages from signers in testing mode differently from unsigned email."
  // A verdict of "valid" is exactly the different treatment that forbids, so a
  // testing key produces a reason rather than an authentication.
  if (key.flags?.includes("y")) {
    return "key record is in testing mode (t=y), so the signature authenticates nothing"
  }
  // §3.6.1 on t=s: "Any DKIM-Signature header fields using the 'i=' tag MUST have
  // the same domain value on the right-hand side of the '@' in the 'i=' tag and
  // the value of the 'd=' tag." The parent-domain allowance above is withdrawn.
  const identityDomain = signerIdentityDomain(parsed)
  if (
    key.flags?.includes("s") && identityDomain !== undefined && identityDomain !== parsed.domain
  ) {
    return `i= domain ${identityDomain} is not exactly d= (${parsed.domain}), which t=s requires`
  }
  // §3.6.1 on h=: "A colon-separated list of hash algorithms that might be used.
  // Signers and Verifiers MUST support the 'sha256' hash algorithm." Both
  // algorithms this verifier implements hash with SHA-256, so a record that does
  // not list it does not allow this signature.
  if (key.hashAlgorithms !== undefined && !key.hashAlgorithms.includes("sha256")) {
    return `key record does not allow sha256 (h=${key.hashAlgorithms.join(":")})`
  }
  // §3.6.1 on s=: a key that does not name the `email` service type, or `*`, is
  // not published for signing mail.
  if (
    key.serviceTypes !== undefined && !key.serviceTypes.includes("*") &&
    !key.serviceTypes.includes("email")
  ) {
    return `key record is not published for email (s=${key.serviceTypes.join(":")})`
  }
  return undefined
}

/**
 * The domain half of the signature's `i=` tag, lowercased, or `undefined` when
 * the tag is absent.
 *
 * §3.5 gives `i=` the grammar `[ Local-part ] "@" domain-name`, and a quoted
 * local part may itself contain an `@`, so the domain starts after the last one.
 */
function signerIdentityDomain(parsed: DkimSignatureHeader): string | undefined {
  if (parsed.identity === undefined) return undefined
  return parsed.identity.slice(parsed.identity.lastIndexOf("@") + 1).toLowerCase()
}

/** True when `candidate` is `domain` itself or a subdomain of it. */
function isSameOrParentDomain(domain: string, candidate: string): boolean {
  return candidate === domain || candidate.endsWith(`.${domain}`)
}

function errorMessage(err: unknown): string {
  return err instanceof Error ? err.message : String(err)
}
