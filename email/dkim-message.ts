// DKIM verifier, step 4: split a raw message into header fields and body, and
// refuse header bytes that receivers read differently.

/**
 * Split a raw RFC 5322 message into raw header lines and a raw body.
 *
 * RFC 5322 mandates CRLF, but messages that round-tripped through mailbox
 * storage often carry bare LF, so either separator is accepted. A bare CR is not
 * a separator here and stays inside the value it sits in, which is a reading a
 * mail client may not share: a caller who splits a message for a security
 * decision should run {@link refuseHeaderLineEndings} over it first, as
 * {@link verifyDkimSignatures} does.
 *
 * RFC 5322 §2.2 ends the header section at the **first** empty line,
 * unconditionally. What follows that empty line is body, WSP or not: a fold
 * cannot open there, because §2.2.3 defines a fold as a line ending that is
 * itself followed by WSP, with no empty line in between. Requiring the
 * character after the empty line to be non-WSP swallowed every body beginning
 * with SP or HTAB into the header region, where it was never hashed — and
 * RFC 6376 §3.4.5 Example 1's own body begins with a space.
 *
 * @deprecated An internal step of `verifyDkim`, exported by mistake; it goes in 2.0.
 * Call `verifyDkim` or `verifyDkimSignatures` instead.
 */
export function splitMessage(raw: string): { headers: string[]; body: string } {
  const { headerEnd, sepLen } = locateHeaderEnd(raw)

  if (headerEnd === -1) {
    return { headers: parseHeaders(raw), body: "" }
  }
  return {
    headers: parseHeaders(raw.slice(0, headerEnd)),
    body: raw.slice(headerEnd + sepLen),
  }
}

/**
 * Find the empty line that ends the header section, as RFC 5322 §2.2 defines it:
 * the first line ending immediately followed by a second one.
 *
 * `headerEnd` is the offset of the first of those two line endings, or `-1` when
 * the message has no empty line at all; `sepLen` is how many characters the two
 * endings occupy together. Shared by {@link splitMessage} and
 * {@link refuseHeaderLineEndings} so the two can never disagree about where the
 * header block stops.
 */
function locateHeaderEnd(raw: string): { headerEnd: number; sepLen: number } {
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
    return { headerEnd: i, sepLen: len1 + len2 }
  }
  return { headerEnd: -1, sepLen: 0 }
}

/**
 * A code point this file treats as hiding a header line break the way a lone
 * CR does (issue #121), and everything {@link FORBIDDEN_HEADER_BYTES} and
 * {@link FORBIDDEN_MULTIBYTE_SEQUENCES} are generated from — round 2 review
 * asked for the table to be generated from this list rather than hand-listed
 * byte sequences, after finding gaps a hand-picked list kept leaving: round 1
 * caught 0x85 exempted as a false continuation byte, round 2 found the same
 * exemption problem applies to *any* of these code points once an attacker
 * is allowed to pick *any* UTF-8 byte length and any amount of overlong
 * padding, including of LF and CR themselves — `C0 8A` is an overlong 2-byte
 * encoding of LF that a lenient decoder reads as a line break, even though
 * the raw byte 0x0A never appears in the message at all, so the CR/LF
 * uniformity check above never sees it either.
 *
 * `minimalLength` is how many bytes RFC 3629 needs to reach this code point
 * *as UTF-8* without padding — 1 for the seven that are ASCII (a 1-byte
 * value is already valid UTF-8), 3 for the two Unicode separators, and 2 for
 * NEL: 0x85 is not ASCII, so its own least-overlong *UTF-8* encoding is the
 * two-byte `C2 85`, one byte longer than its raw-octet form. That raw form
 * is a different thing entirely — not UTF-8 at all, just the byte value
 * 0x85 on its own, the Latin-1/windows-1252 reading round 1 review named —
 * which is exactly what `flatScanSingleByte` covers instead, so 0x85 is the
 * one code point both fields apply to. `minimalLength` tells
 * {@link FORBIDDEN_MULTIBYTE_SEQUENCES} which generated packing is the
 * non-overlong one, for its description; getting it wrong for 0x85 would
 * call its ordinary, minimal two-byte UTF-8 form "overlong", which it is
 * not. `flatScanSingleByte` is false only for LF and CR: their *raw*
 * single-byte form is ordinary, necessary content — every header line
 * legitimately ends in one — governed by the CR/LF uniformity check above
 * instead, so only their multi-byte (inherently overlong, since 1 byte
 * already suffices) forms are refused here.
 *
 * No conformant *sender* emits any of these code points in a header value.
 * RFC 5322 §4.1's `obs-NO-WS-CTL` is where VT, FF and 0x1C-0x1E appear in
 * the grammar at all, inside the *obsolete* syntax a generator "MUST NOT"
 * produce — a parser may still accept it from someone else's mail, but this
 * verifier is not obliged to. 0x85 and the two Unicode separators are not
 * ASCII at all; RFC 6532 is what lets a header value carry them, as UTF-8.
 * Refusing every UTF-8 packing of every one of these here is therefore the
 * safe direction, not a free one: it costs genuine RFC 6532 mail whose text
 * needs one of the two rare Unicode code points, by UTF-8 byte content
 * rather than by meaning. `email/README.md` states that cost beside this
 * rule: a legitimate header value whose UTF-8 encoding happens to contain
 * 0x85 (`Å` C3 85, `ą` C4 85, `久` E4 B9 85, `😅` F0 9F 98 85) is refused too.
 */
const FORBIDDEN_LINE_BREAKS: readonly {
  codePoint: number
  name: string
  minimalLength: number
  flatScanSingleByte: boolean
}[] = [
  {
    codePoint: 0x0a,
    name: "a line feed (LF, U+000A)",
    minimalLength: 1,
    flatScanSingleByte: false,
  },
  {
    codePoint: 0x0d,
    name: "a carriage return (CR, U+000D)",
    minimalLength: 1,
    flatScanSingleByte: false,
  },
  { codePoint: 0x0b, name: "a vertical tab (0x0B)", minimalLength: 1, flatScanSingleByte: true },
  { codePoint: 0x0c, name: "a form feed (0x0C)", minimalLength: 1, flatScanSingleByte: true },
  { codePoint: 0x1c, name: "a file separator (0x1C)", minimalLength: 1, flatScanSingleByte: true },
  { codePoint: 0x1d, name: "a group separator (0x1D)", minimalLength: 1, flatScanSingleByte: true },
  {
    codePoint: 0x1e,
    name: "a record separator (0x1E)",
    minimalLength: 1,
    flatScanSingleByte: true,
  },
  { codePoint: 0x85, name: "a NEL character (0x85)", minimalLength: 2, flatScanSingleByte: true },
  {
    codePoint: 0x2028,
    name: "a Unicode line separator (U+2028)",
    minimalLength: 3,
    flatScanSingleByte: false,
  },
  {
    codePoint: 0x2029,
    name: "a Unicode paragraph separator (U+2029)",
    minimalLength: 3,
    flatScanSingleByte: false,
  },
]

/**
 * Every 2-to-6-byte UTF-8 packing of `codePoint`: the minimal one RFC 3629
 * would emit (when its length is 2-6) and every overlong one past it, using
 * the classic FSS-UTF capacity an `n`-byte form has — an `n`-bit-1 marker
 * plus a zero separator bit in the lead byte (`7 - n` payload bits there)
 * and 6 payload bits in each of the `n - 1` continuation bytes, `5n + 1`
 * bits total. A form whose capacity is smaller than `codePoint` needs is
 * skipped rather than built: forcing the value in anyway would spill into
 * the lead byte's marker bits and corrupt the very shape that says how many
 * bytes the sequence is. Only U+2028/U+2029 are large enough (2047 is the
 * largest 2-byte form can hold) to skip `n = 2` here; every code point in
 * {@link FORBIDDEN_LINE_BREAKS} fits every other length.
 */
function utf8Packings(codePoint: number): number[][] {
  const forms: number[][] = []
  for (let n = 2; n <= 6; n++) {
    const capacityBits = 5 * n + 1
    if (codePoint >= 2 ** capacityBits) continue
    const bytes = [((0xff << (8 - n)) & 0xff) | (codePoint >> (6 * (n - 1)))]
    for (let k = n - 2; k >= 0; k--) bytes.push(0x80 | ((codePoint >> (6 * k)) & 0x3f))
    forms.push(bytes)
  }
  return forms
}

/**
 * The six {@link FORBIDDEN_LINE_BREAKS} entries whose raw single byte is
 * itself refused, wherever it occurs in the header block — generated rather
 * than hand-listed so it cannot drift from {@link FORBIDDEN_MULTIBYTE_SEQUENCES}.
 * LF and CR are excluded on purpose; see the note on {@link FORBIDDEN_LINE_BREAKS}.
 */
const FORBIDDEN_HEADER_BYTES: ReadonlyMap<number, string> = new Map(
  FORBIDDEN_LINE_BREAKS
    .filter((entry) => entry.flatScanSingleByte)
    .map((entry) => [entry.codePoint, entry.name]),
)

/**
 * Every UTF-8 packing of every {@link FORBIDDEN_LINE_BREAKS} code point,
 * generated by {@link utf8Packings} rather than hand-listed. A packing whose
 * length equals the code point's `minimalLength` is described as itself —
 * `C2 85` for NEL and the 3-byte forms of U+2028/U+2029; every other one,
 * which is every multi-byte packing of the seven ASCII code points and every
 * longer packing of those three, is described as an overlong encoding of it.
 * Grouped by lead byte in
 * {@link FORBIDDEN_MULTIBYTE_SEQUENCES_BY_LEAD_BYTE}, which is what
 * {@link scanForbiddenHeaderBytes} actually scans with.
 */
const FORBIDDEN_MULTIBYTE_SEQUENCES: readonly { bytes: readonly number[]; description: string }[] =
  FORBIDDEN_LINE_BREAKS.flatMap(({ codePoint, name, minimalLength }) =>
    utf8Packings(codePoint).map((bytes) => ({
      bytes,
      description: bytes.length === minimalLength ? name : `an overlong UTF-8 encoding of ${name}`,
    }))
  )

/**
 * {@link FORBIDDEN_MULTIBYTE_SEQUENCES} indexed by each sequence's first
 * byte, so {@link scanForbiddenHeaderBytes} does one map lookup per header
 * position — matching only the handful of sequences that could possibly
 * start there — rather than testing all of them, which is what keeps the
 * scan linear in the header block's length rather than in the size of this
 * table.
 */
const FORBIDDEN_MULTIBYTE_SEQUENCES_BY_LEAD_BYTE: ReadonlyMap<
  number,
  readonly { bytes: readonly number[]; description: string }[]
> = (() => {
  const byLeadByte = new Map<number, { bytes: readonly number[]; description: string }[]>()
  for (const sequence of FORBIDDEN_MULTIBYTE_SEQUENCES) {
    const lead = sequence.bytes[0]
    const existing = byLeadByte.get(lead)
    if (existing) existing.push(sequence)
    else byLeadByte.set(lead, [sequence])
  }
  return byLeadByte
})()

/**
 * True when `raw` holds `sequence` starting at `i`, entirely before `end`.
 *
 * `i + sequence.length > end`, not `>=`: a sequence that ends *exactly* at
 * `end` — the last bytes in a header block that has no trailing empty line
 * — fits entirely inside the block and must match, not be treated as
 * spilling past it. Round 2 review asked this boundary be pinned by a test
 * rather than left to reviewers to notice by reading the comparison.
 */
function matchesSequenceAt(
  raw: string,
  i: number,
  end: number,
  sequence: readonly number[],
): boolean {
  if (i + sequence.length > end) return false
  for (let k = 0; k < sequence.length; k++) {
    if (raw.charCodeAt(i + k) !== sequence[k]) return false
  }
  return true
}

/**
 * Scan a header block for {@link FORBIDDEN_HEADER_BYTES} and
 * {@link FORBIDDEN_MULTIBYTE_SEQUENCES}, byte by byte with no decoding step
 * for the single-byte set (issue #121). `end` is the same header-block
 * boundary {@link refuseHeaderLineEndings} computes and passes in, so the
 * two checks can never disagree about where the block stops, and the scan
 * runs the full block rather than stopping at the first line ending — the
 * whole point is to catch a forgery placed *anywhere* in it. Every
 * multi-byte candidate is matched in full (see {@link matchesSequenceAt}),
 * lead byte included, so a legitimate character that merely happens to
 * *end* the same way as a forbidden sequence — U+3028 is `E3 80 A8`, the
 * same last two bytes as U+2028's `E2 80 A8` — is not mistaken for one.
 */
function scanForbiddenHeaderBytes(raw: string, end: number): string | undefined {
  for (let i = 0; i < end; i++) {
    const code = raw.charCodeAt(i)
    const candidates = FORBIDDEN_MULTIBYTE_SEQUENCES_BY_LEAD_BYTE.get(code)
    if (candidates !== undefined) {
      for (const sequence of candidates) {
        if (matchesSequenceAt(raw, i, end, sequence.bytes)) {
          return `header block carries ${sequence.description}, which some readers treat as ` +
            "a line break, so where its header fields end is ambiguous"
        }
      }
    }
    const description = FORBIDDEN_HEADER_BYTES.get(code)
    if (description !== undefined) {
      return `header block carries ${description}, which some readers treat as a line break, ` +
        "so where its header fields end is ambiguous"
    }
  }
  return undefined
}

/**
 * Refuse a header block whose line endings are not uniform, and say why.
 *
 * Returns a reason string for a block that carries a carriage return no line
 * feed follows, one that ends some lines with CRLF and others with a bare LF,
 * or one that carries one of {@link FORBIDDEN_HEADER_BYTES} or
 * {@link FORBIDDEN_MULTIBYTE_SEQUENCES} anywhere; `undefined` for a block
 * this verifier will read. The check runs before a single field is parsed,
 * because the disagreement it catches is about *where the fields are*, not
 * about their contents.
 *
 * A lone CR is what hides a header field. Every reader downstream — this
 * verifier, a mail store, a mail client — decides for itself whether a bare CR
 * ends a line, and they do not all decide the same way. A message carrying
 * `X-Note: a<CR>From: ceo@bank.example` above a signed block therefore has one
 * `From:` here, where the CR stays inside the `X-Note:` value and the signature
 * covers the genuine field, and two in a client that breaks the line, where the
 * forged one is displayed. The signature verified, the sender shown was not the
 * sender signed for.
 *
 * Mixed endings are refused for the same reason and not because RFC 5322 says
 * CRLF: a block whose lines end both ways has already passed through something
 * that rewrote line endings, and which of the two a later reader honours is again
 * a guess. A block that uses a bare LF *throughout* keeps verifying, because that
 * is what mailbox storage produces — RFC 6376 §3.4.5's own example message, as
 * this package's `rfc6376-rsa` fixture carries it, has no CR anywhere.
 *
 * Issue #121: a raw CR or LF are not the only way a reader can take a byte
 * sequence for a line break inside a header value. A vertical tab, a form
 * feed, the file/group/record separators (0x1C-0x1E) and NEL (0x85) are
 * refused as raw bytes wherever they occur, and every UTF-8 packing — the
 * minimal one and every overlong one, up to 6 bytes — of all ten of LF, CR,
 * those five, and the Unicode LINE/PARAGRAPH SEPARATOR characters
 * (U+2028/U+2029) is refused as well: an overlong `C0 8A` reads as LF to a
 * decoder that does not enforce the shortest-form rule, hiding a header
 * boundary this verifier would otherwise never see, exactly as
 * `X-Note: a<FF>From: ceo@bank.example` hides one behind a raw byte. See the
 * note on {@link FORBIDDEN_LINE_BREAKS} for why every packing of every one
 * of these ten code points is refused unconditionally, with no exemption for
 * a byte or sequence that merely looks like part of a longer, legitimate
 * UTF-8 character.
 *
 * @deprecated An internal step of `verifyDkim`, exported by mistake; it goes in 2.0.
 * Call `verifyDkim` or `verifyDkimSignatures` instead.
 */
export function refuseHeaderLineEndings(raw: string): string | undefined {
  const { headerEnd, sepLen } = locateHeaderEnd(raw)
  // With no empty line the whole message is header (see `splitMessage`), and the
  // empty line that ends the block is part of it.
  const end = headerEnd === -1 ? raw.length : headerEnd + sepLen

  let sawCrLf = false
  let sawBareLf = false
  for (let i = 0; i < end; i++) {
    const code = raw.charCodeAt(i)
    if (code === 0x0d) {
      if (raw.charCodeAt(i + 1) !== 0x0a) {
        return "header block carries a carriage return that no line feed follows, " +
          "so where its header fields end is ambiguous"
      }
      sawCrLf = true
      i++
      continue
    }
    if (code === 0x0a) sawBareLf = true
  }
  if (sawCrLf && sawBareLf) {
    return "header block mixes CRLF and bare LF line endings, " +
      "so where its header fields end is ambiguous"
  }
  return scanForbiddenHeaderBytes(raw, end)
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
