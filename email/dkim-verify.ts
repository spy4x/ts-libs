// DKIM signature verification per RFC 6376.
//
// Pure verifier: given a raw RFC 5322 message and a DKIM public key it decides
// whether the message's DKIM-Signature verifies against that key. It fetches
// nothing on its own unless a caller injects a DNS TXT resolver.
//
// Zero imports on purpose — Web Crypto (`crypto.subtle`) and platform
// primitives (`atob`/`btoa`, `TextEncoder`, `Deno.resolveDns`) only. Anything
// this file "needs" from `@std/*` is a smell, not a dependency to add.

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

/** Outcome of {@link verifyDkim}. A malformed message returns, it does not throw. */
export interface DkimVerificationResult {
  valid: boolean
  /** Present when `valid` is false; a stable, human-readable diagnosis. */
  reason?: string
  /** Present whenever the signature header could be parsed. */
  parsed?: DkimSignatureHeader
  /** The recomputed body hash, for diagnostics. */
  computedBodyHash?: string
  /** First 240 characters of the recomputed signature input, for diagnostics. */
  computedInputPreview?: string
}

/**
 * DNS TXT lookup contract, defaulting to `Deno.resolveDns(name, "TXT")`, which
 * needs `--allow-net`. Inject one to run the verifier hermetically — no socket,
 * no cache, no upstream.
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
   * Longest message this verifier will look at, in characters. Defaults to
   * {@link DEFAULT_MAX_MESSAGE_LENGTH}. A longer message is refused before it is
   * canonicalized: every pass here is linear, and the cap is what bounds the work
   * an unauthenticated sender can ask for.
   */
  maxMessageLength?: number
}

/**
 * Default {@link DkimVerifyOptions.maxMessageLength}: 10 MiB of characters, which
 * is above the message size limit relays usually impose and far below anything
 * that takes a noticeable time to canonicalize.
 */
export const DEFAULT_MAX_MESSAGE_LENGTH = 10 * 1024 * 1024

/**
 * RFC 8301 §3.2: "Verifiers MUST NOT consider signatures using RSA keys of less
 * than 1024 bits as valid."
 */
export const MIN_RSA_KEY_BITS = 1024

/** Thrown for a malformed DKIM-Signature header or DNS key record. */
export class DkimParseError extends Error {
  override name = "DkimParseError"
}

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
function scanTagList(raw: string): Map<string, TagValue> {
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

function parseDkimSignatureHeader(raw: string, requireB = true): ParsedDkimSignature {
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
  // §3.5: the field "MUST NOT include the DKIM-Signature header field that is
  // being created or verified", and §3.7 adds that field to the header hash
  // unconditionally as its own step. Every standard signer omits it, so
  // demanding it rejected all of them.
  if (signedHeaders.includes("dkim-signature")) {
    throw new DkimParseError("DKIM-Signature h= tag must not name dkim-signature")
  }

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
 * Canonicalize one header field per RFC 6376 §3.4.1 (simple) / §3.4.2
 * (relaxed).
 *
 * `name` is the field name, `value` the field body: everything after the
 * colon, including the space that follows it. The return value is the whole
 * canonical line — `name: value CRLF` relaxed, `name:value CRLF` simple —
 * because the separator is part of what is hashed. Bare LF is normalised to
 * CRLF: RFC 6376 hashes the CRLF form even when storage kept LF endings.
 */
export function canonicalizeHeader(
  name: string,
  value: string,
  algorithm: Canonicalization,
): string {
  if (algorithm !== "relaxed") {
    // Simple (§3.4.1): nothing changes at all — not the field name's case, not
    // the value's whitespace, not a fold. The RFC's own Example 2 keeps
    // `B <SP> : <SP> Y <HTAB><CRLF><HTAB> Z` byte for byte, so unfolding here
    // would sign bytes no other implementation signs.
    return `${name}:${value}\r\n`
  }
  // Relaxed (§3.4.2): lowercase the name with all WSP removed around it, unfold
  // every fold (CRLF *and* any bare LF) with nothing in its place, compress WSP
  // runs to one SP, strip WSP from both ends of the value. §3.4.2 step 5 puts no
  // SP after the colon either — Example 1 requires `a:X`, not `a: X`.
  const unfolded = value.replace(/\r?\n/g, "")
  const collapsed = unfolded.replace(/[ \t]+/g, " ").trim()
  return `${name.toLowerCase().trim()}:${collapsed}\r\n`
}

/**
 * Canonicalize a message body per RFC 6376 §3.4.3 (simple) / §3.4.4 (relaxed).
 *
 * Both algorithms drop trailing empty lines and end a non-empty body with
 * exactly one CRLF. The two empty cases differ, and §3.4.5's published digests
 * pin which is which: an empty body under simple is `<CRLF>` (SHA-256
 * `frcCV1k9oG9oKj3dpUqdJg1PxRT2RSN/XKdLCPjaYaY=`), while a body of one empty
 * line under relaxed is the empty string (`47DEQpj8HBSa+/TImW+5JCeuQeRkm5NMpJWZG3hSuFU=`).
 * Returning the empty string in both cases made `simple` hash zero bytes.
 *
 * An `l=` bound is applied afterwards, to these canonical octets, by
 * {@link verifyDkim} — the bound is counted in octets, not in characters.
 */
export function canonicalizeBody(body: string, algorithm: Canonicalization): string {
  // One pass to split, one pass per line, one join: the cost grows with the body,
  // not with its square. The regular expressions this replaced backtracked —
  // `/[ \t]+\r\n/g` retried a whole run of spaces at every offset inside it and
  // `/(?:\r\n)+$/` retried every run of line endings — so 80 KB of either took
  // about four seconds, and each doubling of the body cost four times as much.
  // The body arrives from an unauthenticated sender, so that was a freeze
  // anybody could trigger by sending one large message.
  const lines = splitBodyLines(body)
  // §3.4.4 order: strip trailing WSP from every line and compress the remaining
  // WSP runs to one SP, *then* ignore trailing empty lines — a line of nothing
  // but WSP is empty by the time the last step looks at it.
  const canonical = algorithm === "relaxed" ? lines.map(relaxBodyLine) : lines

  let end = canonical.length
  while (end > 0 && canonical[end - 1] === "") end--
  // §3.4.5 pins the two empty cases apart: simple hashes the CRLF the algorithm
  // appends (`frcCV1k9…`), relaxed hashes nothing at all (`47DEQpj8…`).
  if (end === 0) return algorithm === "relaxed" ? "" : "\r\n"
  return `${canonical.slice(0, end).join("\r\n")}\r\n`
}

/**
 * Split a body into lines, dropping the line endings.
 *
 * CRLF, a bare LF and a lone CR each end a line, which is how the canonical body
 * comes out CRLF-terminated whatever the message's storage did to it. The last
 * element is what followed the final line ending — the empty string when the body
 * ends with one.
 */
function splitBodyLines(body: string): string[] {
  const lines: string[] = []
  let start = 0
  for (let i = 0; i < body.length; i++) {
    const code = body.charCodeAt(i)
    if (code !== 0x0d && code !== 0x0a) continue
    lines.push(body.slice(start, i))
    if (code === 0x0d && body.charCodeAt(i + 1) === 0x0a) i++
    start = i + 1
  }
  lines.push(body.slice(start))
  return lines
}

/**
 * §3.4.4 for one line: every WSP run becomes one SP, and the run at the end of
 * the line disappears.
 *
 * A leading run becomes one SP rather than nothing — §3.4.5's own Example 3
 * canonicalizes `" C "` to `" C"`, space included — so the leading SP is emitted
 * with the first word rather than trimmed away.
 */
function relaxBodyLine(line: string): string {
  let out = ""
  let at = 0
  let pendingSpace = false
  while (at < line.length) {
    if (isWsp(line.charCodeAt(at))) {
      pendingSpace = true
      at++
      continue
    }
    const start = at
    while (at < line.length && !isWsp(line.charCodeAt(at))) at++
    if (pendingSpace) out += " "
    pendingSpace = false
    out += line.slice(start, at)
  }
  return out
}

function isWsp(code: number): boolean {
  return code === 0x20 || code === 0x09
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
function deleteTagValue(raw: string, tag: string): string {
  const parsed = parseDkimSignatureHeader(raw)
  const span = parsed.tags.get(tag)
  if (span === undefined) return raw
  const valueStart = raw.indexOf("=", span.tagStart) + 1
  return raw.slice(0, valueStart) + raw.slice(span.end)
}

/**
 * Parse a DKIM TXT record's `p=` field into a public key. The record must
 * already be concatenated and dequoted per RFC 6376 §3.6.2.2.
 *
 * Returns `null` when the key is revoked — `p=` present but empty. Throws
 * {@link DkimParseError} on a missing `p=`, an unknown `k=`, an unknown `v=`, a
 * `v=` that is not the first tag, an empty `h=` or `s=` list, a repeated tag, or
 * a `p=` whose base64 does not decode.
 *
 * The restriction tags — `h=`, `s=`, `t=` — are read here and applied by
 * {@link verifyDkim}, which is the only place that knows which hash the
 * signature used and that the service is email.
 */
export function parseDkimPublicKey(txtRecord: string): DkimPublicKey | null {
  const tags = scanTagList(txtRecord)
  // §3.6.1: "v= ... MUST be the first tag in the record", and the only value it
  // defines is DKIM1. A record from a future version is not one this verifier
  // may guess at, so it is a syntax error rather than an ignored tag.
  const version = tags.get("v")?.value
  if (version !== undefined) {
    if (version !== "DKIM1") {
      throw new DkimParseError(`unsupported DKIM key record version: ${version}`)
    }
    if ([...tags.keys()][0] !== "v") {
      throw new DkimParseError("DKIM TXT record v= tag must come first")
    }
  }
  if (!tags.has("p")) {
    throw new DkimParseError("DKIM TXT record has no p= tag")
  }
  const p = tags.get("p")!.value
  // `p=` with no value is how RFC 6376 §3.6.1 revokes a key; a `p=` that was
  // never there at all is a malformed record and was rejected above.
  if (p === "") return null
  const algorithm = (tags.get("k")?.value ?? "rsa").toLowerCase()
  if (algorithm !== "rsa" && algorithm !== "ed25519") {
    throw new DkimParseError(`unsupported DKIM key algorithm: ${algorithm}`)
  }
  return {
    algorithm,
    keyBytes: base64Decode(p),
    version,
    hashAlgorithms: parseRecordList(tags.get("h")?.value, "h"),
    serviceTypes: parseRecordList(tags.get("s")?.value, "s"),
    flags: parseRecordList(tags.get("t")?.value, "t"),
  }
}

/**
 * Split a colon-separated key-record list (`h=`, `s=`, `t=`) into lowercase
 * entries, or `undefined` when the tag is absent.
 *
 * A tag that is present but lists nothing is a syntax error rather than "no
 * restriction": `s=` names the service types the key may be used for, and reading
 * an empty list as "any" would turn a typo into a wider permission.
 */
function parseRecordList(value: string | undefined, tag: string): string[] | undefined {
  if (value === undefined) return undefined
  const entries = value.toLowerCase().split(":").map((entry) => entry.replace(/[ \t]+/g, ""))
    .filter(Boolean)
  if (entries.length === 0) {
    throw new DkimParseError(`DKIM TXT record ${tag}= tag is empty`)
  }
  return entries
}

/**
 * Fetch and parse a DKIM public key from DNS, from
 * `<selector>._domainkey.<domain>`.
 *
 * The resolver defaults to `Deno.resolveDns(name, "TXT")`, which requires
 * `--allow-net`. An injected resolver that returns no record causes a
 * {@link DkimParseError} rather than a missing-key result, so a resolver bug
 * cannot be mistaken for a revoked key. Resolver failures are not swallowed.
 */
export async function fetchDkimPublicKey(
  domain: string,
  selector: string,
  options: DkimVerifyOptions = {},
): Promise<DkimPublicKey | null> {
  assertDnsLabels(domain, "d=")
  assertDnsLabels(selector, "s=")
  const name = `${selector}._domainkey.${domain}`
  const { resolveTxt = defaultResolveTxt } = options.resolver ?? {}
  const records = await resolveTxt(name)
  // §3.6.2.2: concatenate the strings of *one* record, with no separator — a long
  // key is published as several strings of one record and joining them with
  // anything at all corrupts it. §3.6.2.2 also leaves the order of several
  // records unspecified, so an unrelated TXT record at the front is not an
  // answer: each record is tried and the first one that parses is the key. When
  // none parses, the first record's own error is what the caller sees.
  if (records.length === 0) return parseDkimPublicKey("")
  let firstError: unknown
  for (const record of records) {
    try {
      return parseDkimPublicKey(record.join(""))
    } catch (err) {
      firstError ??= err
    }
  }
  throw firstError
}

/**
 * Reject a domain or selector that is not a dot-separated run of RFC 5321
 * `sub-domain` labels, before it is interpolated into a query name.
 *
 * `d=` and `s=` come from the message, and an injected resolver may put the name
 * into a URL (DNS over HTTPS) or a command line. Letters, digits and interior
 * hyphens are all RFC 6376 §3.1's grammar allows, so anything else is a
 * malformed signature rather than a name to look up.
 */
function assertDnsLabels(value: string, tag: string): void {
  const labels = value.split(".")
  const valid = labels.length > 0 &&
    labels.every((label) => /^[a-z0-9]([a-z0-9-]*[a-z0-9])?$/.test(label))
  if (!valid) {
    throw new DkimParseError(`DKIM ${tag} tag is not a domain name: ${JSON.stringify(value)}`)
  }
}

async function defaultResolveTxt(name: string): Promise<string[][]> {
  return await Deno.resolveDns(name, "TXT")
}

function base64Decode(input: string): Uint8Array {
  // Strip WSP: a folded b=/bh= and a TXT record split across quoted strings
  // both leave whitespace inside the base64.
  const cleaned = input.replace(/\s+/g, "")
  let binary: string
  try {
    binary = atob(cleaned)
  } catch {
    throw new DkimParseError("value is not valid base64")
  }
  const out = new Uint8Array(binary.length)
  for (let i = 0; i < binary.length; i++) out[i] = binary.charCodeAt(i)
  return out
}

/**
 * Split a raw RFC 5322 message into raw header lines and a raw body.
 *
 * RFC 5322 mandates CRLF, but messages that round-tripped through mailbox
 * storage often carry bare LF, so either separator is accepted.
 *
 * RFC 5322 §2.2 ends the header section at the **first** empty line,
 * unconditionally. What follows that empty line is body, WSP or not: a fold
 * cannot open there, because §2.2.3 defines a fold as a line ending that is
 * itself followed by WSP, with no empty line in between. Requiring the
 * character after the empty line to be non-WSP swallowed every body beginning
 * with SP or HTAB into the header region, where it was never hashed — and
 * RFC 6376 §3.4.5 Example 1's own body begins with a space.
 */
export function splitMessage(raw: string): { headers: string[]; body: string } {
  let headerEnd = -1
  let sepLen = 0
  for (let i = 0; i < raw.length - 1; i++) {
    const at = (pos: number) => raw.charCodeAt(pos)
    let len1 = 0
    if (at(i) === 0x0d && at(i + 1) === 0x0a) len1 = 2
    else if (at(i) === 0x0a) len1 = 1
    if (!len1) continue

    const j = i + len1
    let len2 = 0
    if (at(j) === 0x0d && at(j + 1) === 0x0a) len2 = 2
    else if (at(j) === 0x0a) len2 = 1
    if (!len2) continue

    // Two consecutive line endings: the header section ends here, whatever
    // the next character is.
    headerEnd = i
    sepLen = len1 + len2
    break
  }

  if (headerEnd === -1) {
    return { headers: parseHeaders(raw), body: "" }
  }
  return {
    headers: parseHeaders(raw.slice(0, headerEnd)),
    body: raw.slice(headerEnd + sepLen),
  }
}

function parseHeaders(block: string): string[] {
  // RFC 5322 folding: a line ending followed by WSP continues the previous
  // field. Continuations are re-joined with CRLF so downstream
  // canonicalization sees a fold it can unfold, whatever the input used.
  const lines = block.split(/\r?\n/)
  const out: string[] = []
  for (const line of lines) {
    if (line.length > 0 && (line[0] === " " || line[0] === "\t")) {
      if (out.length > 0) {
        out[out.length - 1] += "\r\n" + line
        continue
      }
      // Stray leading WSP with no parent field: keep it as its own line so a
      // caller can still see it, rather than dropping it silently.
    }
    out.push(line)
  }
  return out
}

/**
 * Select the raw header lines named by an `h=` list.
 *
 * RFC 6376 §5.4.2: a signer signs repeated instances "in order from the bottom
 * of the header field block to the top", so a verification that pairs from the
 * top picks the wrong bytes whenever the list is longer than the message is
 * long. `h=received:received` over three `Received:` fields must hash C then B.
 *
 * §3.5: names in `h=` that match no header field in the message contribute
 * nothing — "the null input" — so they are skipped, not fatal. Signers are
 * explicitly allowed to list more instances than exist.
 *
 * Throws {@link DkimParseError} when a name matches more occurrences than the
 * `h=` list consumes, which means the message grew a field after signing.
 */
function selectSignedHeaders(
  headers: string[],
  names: string[],
): { name: string; value: string }[] {
  const occurrences = new Map<string, number[]>()
  headers.forEach((header, index) => {
    const colon = header.indexOf(":")
    if (colon === -1) return
    const name = header.slice(0, colon).trim().toLowerCase()
    const list = occurrences.get(name)
    if (list) list.push(index)
    else occurrences.set(name, [index])
  })

  const remaining = new Map<string, number[]>()
  for (const [name, list] of occurrences) remaining.set(name, [...list])

  const selected: { name: string; value: string }[] = []
  for (const name of names) {
    const list = remaining.get(name)
    if (!list || list.length === 0) continue // §3.5: contributes nothing
    const index = list.pop()! // §5.4.2: bottom-up
    const header = headers[index]
    const colon = header.indexOf(":")
    selected.push({
      name: header.slice(0, colon),
      value: header.slice(colon + 1),
    })
  }

  // For every name the h= list asks for, all of its instances must have been
  // consumed: a leftover means the message grew a field of that name after
  // signing, which is exactly the addition §5.4.2 lets a signer detect by
  // listing a name more times than the field occurs.
  for (const [name, list] of occurrences) {
    const asked = names.filter((n) => n === name).length
    // Names the h= list never asks for are outside this signature entirely; only
    // a name it does ask for has a defined number of expected instances.
    if (asked === 0 || asked >= list.length) continue
    throw new DkimParseError(`unsigned additional instances of a signed header: ${name}`)
  }
  return selected
}

/**
 * Compute the base64 SHA-256 digest of a string or of raw octets.
 *
 * A string is encoded as UTF-8 first, which is what RFC 6376 hashes: the
 * canonical form of a message body is a sequence of octets, not of characters.
 * Passing `Uint8Array` is what lets a caller bound *octets* — an `l=` bound can
 * land inside a multi-octet character, and decoding the sliced bytes back to a
 * string would hash the replacement character instead of the declared bytes.
 */
export async function sha256Base64(input: string | Uint8Array): Promise<string> {
  const bytes = typeof input === "string" ? new TextEncoder().encode(input) : input
  const digest = await crypto.subtle.digest("SHA-256", asBytes(bytes))
  return base64Encode(new Uint8Array(digest))
}

function base64Encode(bytes: Uint8Array): string {
  let bin = ""
  for (let i = 0; i < bytes.length; i++) bin += String.fromCharCode(bytes[i])
  return btoa(bin)
}

/**
 * Verify a DKIM signature against the supplied public key. When `publicKey` is
 * omitted the key is fetched from `options.resolver`, defaulting to
 * `Deno.resolveDns` and therefore to needing `--allow-net`.
 *
 * Message-shaped failures — missing header, bad grammar, expired signature,
 * body mismatch, unverifiable signature — all come back as a
 * {@link DkimVerificationResult}. Only a throwing injected resolver escapes.
 */
export async function verifyDkim(
  rawMessage: string,
  publicKey?: DkimPublicKey,
  options: DkimVerifyOptions = {},
): Promise<DkimVerificationResult> {
  const maxMessageLength = options.maxMessageLength ?? DEFAULT_MAX_MESSAGE_LENGTH
  if (rawMessage.length > maxMessageLength) {
    return {
      valid: false,
      reason: `message is ${rawMessage.length} characters, over the ` +
        `${maxMessageLength}-character limit`,
    }
  }

  const { headers, body } = splitMessage(rawMessage)

  // A message may carry several signatures; the first one is verified. The
  // header value keeps its exact bytes, so the canonical form reconstructed
  // for hashing matches what the signer saw.
  const dkimHeaderLine = headers.find((line) => line.toLowerCase().startsWith("dkim-signature:"))
  if (dkimHeaderLine === undefined) {
    return { valid: false, reason: "no DKIM-Signature header found" }
  }
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
  try {
    signedHeaders = selectSignedHeaders(headers, parsed.signedHeaders)
    const canonicalBody = canonicalizeBody(body, parsed.canonicalization.body)
    if (parsed.bodyLength === undefined) {
      computedBodyHash = await sha256Base64(canonicalBody)
    } else {
      // §3.7 step 1: the body is hashed "canonicalized using the body
      // canonicalization algorithm specified in the c= tag and then truncated to
      // the length specified in the l= tag". The bound counts canonical *octets*,
      // so the truncation happens on the UTF-8 bytes: `String.prototype.slice`
      // counts UTF-16 code units, which diverge from octets at the first
      // non-ASCII character, and the verifier hashed a different byte range than
      // the signer did — falsely rejecting valid non-ASCII mail. The bound may
      // also land inside a multi-octet character, which is what rules out
      // decoding the sliced bytes back to a string: U+FFFD would be hashed in
      // place of the declared octets. A bound longer than the body it accompanies
      // is not an error: the slice then covers all of it, which is what a signer
      // that declared a longer bound produced.
      const bounded = new TextEncoder().encode(canonicalBody).slice(0, parsed.bodyLength)
      computedBodyHash = await sha256Base64(bounded)
    }
  } catch (err) {
    return { valid: false, parsed, reason: errorMessage(err) }
  }

  if (!constantTimeEqualBase64(computedBodyHash, parsed.bodyHash)) {
    return {
      valid: false,
      parsed,
      reason: "body hash mismatch (body modified after signing)",
      computedBodyHash,
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
    return { valid: false, parsed, reason: errorMessage(err), computedBodyHash }
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
    }
  }

  return {
    valid: verified,
    parsed,
    computedBodyHash,
    computedInputPreview: canonicalInput.slice(0, 240),
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
  // §6.1.1: "If the 'h=' tag does not include the From header field, the Verifier
  // MUST ignore the DKIM-Signature header field and return PERMFAIL (From field
  // not signed)."
  if (!parsed.signedHeaders.includes("from")) {
    return "From field not signed (h= does not name from)"
  }
  // §5.4 requires the From field to be signed, which a message that has no From
  // field cannot satisfy: `h=from` over a message with no From hashes nothing for
  // it, so the signature would say nothing about the author either.
  if (!headers.some((line) => line.slice(0, line.indexOf(":")).trim().toLowerCase() === "from")) {
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

function constantTimeEqualBase64(a: string, b: string): boolean {
  if (a.length !== b.length) return false
  let diff = 0
  for (let i = 0; i < a.length; i++) diff |= a.charCodeAt(i) ^ b.charCodeAt(i)
  return diff === 0
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

async function verifySignature(
  parsed: DkimSignatureHeader,
  canonicalInput: string,
  publicKey: DkimPublicKey,
): Promise<boolean> {
  const signatureBytes = asBytes(base64Decode(parsed.signature))
  const data = asBytes(new TextEncoder().encode(canonicalInput))

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
      false,
      ["verify"],
    )
    // RFC 8301 §3.2: "Verifiers MUST NOT consider signatures using RSA keys of
    // less than 1024 bits as valid." The modulus length comes from the imported
    // key rather than from counting DER bytes, so it is the length the crypto
    // implementation will actually use. A 512-bit key is breakable by anyone who
    // wants to forge mail from the domain that published it.
    const modulusLength = (cryptoKey.algorithm as RsaHashedKeyAlgorithm).modulusLength
    if (modulusLength < MIN_RSA_KEY_BITS) {
      throw new DkimParseError(
        `RSA key is ${modulusLength} bits; RFC 8301 requires at least ${MIN_RSA_KEY_BITS}`,
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
