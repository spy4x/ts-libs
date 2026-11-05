// DKIM verifier, step 1: parse a DKIM-Signature header field (RFC 6376 §3.5).

import { type DkimAlgorithm, DkimParseError, type DkimSignatureHeader } from "./dkim-types.ts"

/** A parsed DKIM-Signature plus the offsets the `b=` rebuild needs. */
interface ParsedDkimSignature {
  header: DkimSignatureHeader
  /** Every tag in the field, keyed by lowercase name. */
  tags: Map<string, TagValue>
  /** Offset at which the `b=` tag itself starts. */
  bTagStart: number
  /** Offset just past the `b=` tag's value, before any trailing WSP. */
  bValueEnd: number
}

/** One `name=value` pair from a tag list, with the offset its value ends at. */
interface TagValue {
  /** Dequoted value: base64 for `b=`/`bh=`/`p=`, literal text otherwise. */
  value: string
  /** Offset in the source at which the value's text starts. */
  start: number
  /** Offset in the source at which the value's text ends, before trailing WSP. */
  end: number
  /** Offset in the source at which this tag's name starts. */
  tagStart: number
  /** False when the tag is present but carries no value (`bh=;`). */
  present: boolean
}

/** Tags without which a signature cannot be evaluated. */
const REQUIRED_TAGS = ["v", "a", "d", "s", "h", "bh", "b"]

/** RFC 5322 `ftext`: printable ASCII except colon. */
const HEADER_NAME_RE = /^[!-9;-~]+$/

const WSP = /[ \t]/
const WSP_OR_SEPARATOR = /[ \t\r\n;]/
const TAG_NAME_CHAR = /[A-Za-z0-9-]/

/**
 * Scan a `tag-list` (RFC 6376 §3.2) into pairs.
 *
 * Hand-rolled rather than regex-driven. The source used
 * `/(?:^|;)\s*([a-z]+)=("[^"]*"|[^;]*)/gi`, whose `[^;]*` branch swallowed the
 * `=` of the following tag when a separator was missing and whose nested
 * quantifiers made matching quadratic. A single forward scan states the
 * boundary exactly: a separator opens a new tag only when what follows parses
 * as `name=`.
 *
 * Duplicate tags throw, as RFC 6376 §3.2 forbids them; silently keeping the
 * last one let an attacker append `; b=<own signature>` and win. Unknown tags
 * do not throw: §3.5 permits extensions, and the source's own fixtures carry
 * one (`r=`).
 */
export function scanTagList(raw: string): Map<string, TagValue> {
  const tags = new Map<string, TagValue>()
  let i = 0
  while (i < raw.length) {
    while (i < raw.length && WSP_OR_SEPARATOR.test(raw[i])) i++
    if (i >= raw.length) break

    const nameStart = i
    while (i < raw.length && TAG_NAME_CHAR.test(raw[i])) i++
    const name = raw.slice(nameStart, i).toLowerCase()

    let probe = i
    while (probe < raw.length && WSP.test(raw[probe])) probe++
    if (name === "" || raw[probe] !== "=") {
      const near = JSON.stringify(raw.slice(nameStart, nameStart + 32))
      throw new DkimParseError(`DKIM tag list is malformed near: ${near}`)
    }
    i = probe + 1
    while (i < raw.length && WSP.test(raw[i])) i++

    let value: string
    let start: number
    let end: number
    if (raw[i] === '"') {
      // A quoted value keeps its spaces; only folding is removed.
      const close = raw.indexOf('"', i + 1)
      if (close === -1) {
        throw new DkimParseError(`DKIM tag ${name}= has an unterminated quote`)
      }
      value = unfold(raw.slice(i + 1, close))
      start = i
      end = close + 1
      i = close + 1
    } else {
      let valueEnd = i
      while (valueEnd < raw.length && raw[valueEnd] !== ";") valueEnd++
      // Trailing WSP before the separator is not part of the value. Internal
      // WSP may be a fold, and every consumer of a value here either is base64
      // (decoder strips WSP) or a header name list (split on colon).
      let trimmed = valueEnd
      while (trimmed > i && WSP.test(raw[trimmed - 1])) trimmed--
      value = unfold(raw.slice(i, trimmed))
      start = i
      end = trimmed
      i = valueEnd
    }

    if (tags.has(name)) {
      throw new DkimParseError(`DKIM tag repeats: ${name}`)
    }
    tags.set(name, { value, start, end, tagStart: nameStart, present: value !== "" })
  }
  return tags
}

/** Remove folding from a tag value: a fold becomes nothing, other WSP one SP. */
function unfold(value: string): string {
  return value.replace(/\r?\n[ \t]+/g, "").replace(/[ \t\r\n]+/g, " ")
}

/**
 * Parse a `DKIM-Signature` header value (without the leading
 * `DKIM-Signature:`) into structured form. Tag values may be folded across
 * lines.
 *
 * Throws {@link DkimParseError} on a missing required tag, a repeated or
 * RFC-unknown tag, an invalid `h=` entry, a malformed numeric tag, and an
 * unsupported algorithm or canonicalization.
 */
export function parseDkimSignature(raw: string): DkimSignatureHeader {
  return parseDkimSignatureHeader(raw).header
}

export function parseDkimSignatureHeader(raw: string, requireB = true): ParsedDkimSignature {
  const tags = scanTagList(raw)

  for (const tag of REQUIRED_TAGS) {
    // The de-tagged field the signature covers always has an empty b=, so the
    // emptiness rule below must not apply when that field is what is parsed.
    if (tag === "b" && !requireB) continue
    // An empty value is as unusable as a missing tag, and `bh=;` is what a
    // signer emits when it fails to fill the hash in — reporting it as absent
    // is more honest than verifying against the empty string.
    if (!tags.has(tag) || !tags.get(tag)!.present) {
      throw new DkimParseError(`DKIM-Signature missing required tag: ${tag}`)
    }
  }

  const version = tags.get("v")!.value
  if (version !== "1") {
    throw new DkimParseError(`unsupported DKIM version: ${version}`)
  }

  // RFC 6376 §3.5 does not make `c=` mandatory; §3.4 gives simple as the
  // default for header and body. Requiring it rejected every signer that
  // legitimately omitted the tag.
  const canonicalization = parseCanonicalization(
    tags.get("c")?.value ?? "simple/simple",
  )
  const algorithm = parseAlgorithm(tags.get("a")!.value)

  const signedHeaders = tags.get("h")!.value
    .toLowerCase()
    .split(":")
    // §3.5 allows FWS on either side of the colon, so `h=from : to` names two
    // headers rather than one called "from ". Case is already normalised.
    .map((name) => name.replace(/[ \t]+/g, ""))
    .filter(Boolean)
  if (!signedHeaders.length) {
    throw new DkimParseError("DKIM-Signature h= tag has no headers")
  }
  for (const name of signedHeaders) {
    if (!HEADER_NAME_RE.test(name)) {
      throw new DkimParseError(
        `DKIM-Signature h= tag has an invalid header name: ${name}`,
      )
    }
  }
  // §3.5: h= "MUST NOT include the DKIM-Signature header field that is being
  // created or verified", but it may name *other* DKIM-Signature fields: a
  // mailing list that re-signs covers the author's signature that way. The
  // field being verified is kept out of the selection in `verifyOneSignature`,
  // and §3.7 adds it to the hash as its own step.

  const domain = tags.get("d")!.value.toLowerCase()
  const selector = tags.get("s")!.value.toLowerCase()
  if (domain === "") throw new DkimParseError("DKIM-Signature d= tag is empty")
  if (selector === "") {
    throw new DkimParseError("DKIM-Signature s= tag is empty")
  }

  // §3.5 gives i= the grammar `[ Local-part ] "@" domain-name`, so a value with
  // no "@" carries no domain for §6.1.1 to compare against d= and is malformed.
  // (An earlier revision rejected a `dt=` tag here instead, which no RFC defines:
  // §3.2 says an unrecognised tag MUST be ignored, and the README documented the
  // opposite of what the code did.)
  const identity = tags.get("i")?.value
  if (identity !== undefined && !identity.includes("@")) {
    throw new DkimParseError(`DKIM-Signature i= tag has no domain: ${identity}`)
  }

  const header: DkimSignatureHeader = {
    version,
    algorithm,
    domain,
    selector,
    signedHeaders,
    // §3.5 on bh=: "Whitespace is ignored in this value and MUST be ignored when
    // reassembling the original signature. In particular, the signing process can
    // safely insert FWS in this value in arbitrary places to conform to
    // line-length limits." §3.2 retains whitespace inside a value only when the
    // tag's own description does not exclude it, and bh='s does. `unfold` leaves
    // one SP where a WSP run stood, and the digest this is compared against never
    // contains WSP, so one leftover space failed the comparison by length alone —
    // a correctly signed message reported as "body modified after signing".
    //
    // Stripped here, in the value the comparison and the caller see, and *not* in
    // the field §3.7 step 2 hashes: there it is part of the signed bytes exactly
    // as the signer wrote them — a signer that folded bh= signed the fold's SP —
    // so removing it there would hash bytes no signer signed.
    bodyHash: tags.get("bh")!.value.replace(/\s+/g, ""),
    signature: tags.get("b")!.value,
    canonicalization,
    timestamp: tags.has("t") ? parseEpoch(tags.get("t")!.value, "t") : undefined,
    expiration: tags.has("x") ? parseEpoch(tags.get("x")!.value, "x") : undefined,
    bodyLength: tags.has("l") ? parseBodyLength(tags.get("l")!.value) : undefined,
    queryMethod: tags.get("q")?.value,
    identity,
    raw,
  }
  const b = tags.get("b")
  return {
    header,
    tags,
    bTagStart: b?.tagStart ?? raw.length,
    bValueEnd: b?.end ?? raw.length,
  }
}

function parseEpoch(value: string, tag: string): bigint {
  if (!/^[0-9]+$/.test(value)) {
    throw new DkimParseError(
      `DKIM-Signature ${tag}= tag is not a number: ${value}`,
    )
  }
  return BigInt(value)
}

function parseBodyLength(value: string): number {
  if (!/^[0-9]+$/.test(value)) {
    throw new DkimParseError(`DKIM-Signature l= tag is not a number: ${value}`)
  }
  const parsed = Number(value)
  if (!Number.isSafeInteger(parsed)) {
    throw new DkimParseError(`DKIM-Signature l= tag is out of range: ${value}`)
  }
  return parsed
}

function parseCanonicalization(
  value: string,
): DkimSignatureHeader["canonicalization"] {
  // c=<header>/<body>. Either part may be omitted; both default to simple.
  const [header = "simple", body = "simple"] = value.toLowerCase().split("/")
  if (header !== "simple" && header !== "relaxed") {
    throw new DkimParseError(`unsupported header canonicalization: ${header}`)
  }
  if (body !== "simple" && body !== "relaxed") {
    throw new DkimParseError(`unsupported body canonicalization: ${body}`)
  }
  return { header, body }
}

function parseAlgorithm(value: string): DkimAlgorithm {
  const normalized = value.toLowerCase()
  if (normalized !== "rsa-sha256" && normalized !== "ed25519-sha256") {
    throw new DkimParseError(`unsupported DKIM algorithm: ${value}`)
  }
  return normalized
}

/**
 * Return the same tag-list with one tag's value deleted, keeping the tag name,
 * the `=` and the raw folding around it — exactly what RFC 6376 §3.7 step 2
 * hashes for the `b=` tag.
 *
 * The deletion is bounded by the parsed offsets of the value, so a folded `b=`,
 * a quoted `b=`, or an unrelated tag carrying the characters `b=` all behave the
 * same; an earlier revision re-scanned with `\bb=` and dropped everything after
 * it. Nothing after the value is touched: `b=` need not be the last tag, and a
 * tag that follows it stays inside the signed bytes, where §3.7 leaves it.
 * `raw` is the field value, without the field name.
 */
export function deleteTagValue(raw: string, tag: string): string {
  const parsed = parseDkimSignatureHeader(raw)
  const span = parsed.tags.get(tag)
  if (span === undefined) return raw
  const valueStart = raw.indexOf("=", span.tagStart) + 1
  return raw.slice(0, valueStart) + raw.slice(span.end)
}
