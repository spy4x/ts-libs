// DKIM verifier, step 2: header and body canonicalization (RFC 6376 §3.4).

import type { Canonicalization } from "./dkim-types.ts"

/**
 * Canonicalize one header field per RFC 6376 §3.4.1 (simple) / §3.4.2
 * (relaxed).
 *
 * `name` is the field name, `value` the field body: everything after the
 * colon, including the space that follows it. The return value is the whole
 * canonical line — `name: value CRLF` relaxed, `name:value CRLF` simple —
 * because the separator is part of what is hashed. Bare LF is normalised to
 * CRLF: RFC 6376 hashes the CRLF form even when storage kept LF endings.
 *
 * @deprecated An internal step of `verifyDkim`, exported by mistake; it goes in 2.0.
 * Call `verifyDkim` or `verifyDkimSignatures` instead.
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
  //
  // The trim is `trimWsp`, not `String.trim()`: WSP (RFC 5234) is SP and HTAB
  // only, and `trim()` also strips CR, LF, vertical tab, form feed and U+00A0.
  // Once this file's input can be raw octets rather than decoded text (see the
  // module note on {@link verifyDkim}), a header value legitimately ends in the
  // byte 0xA0 — the second byte of a UTF-8 "à" (0xC3 0xA0) split across a fold,
  // for instance — and `trim()` stripped exactly that byte, hashing one octet
  // fewer than the signer did and rejecting a genuine non-ASCII header.
  const unfolded = value.replace(/\r?\n/g, "")
  const collapsed = trimWsp(unfolded.replace(/[ \t]+/g, " "))
  return `${trimWsp(name).toLowerCase()}:${collapsed}\r\n`
}

/** Delete SP and HTAB — RFC 5234's `WSP`, and nothing else — from both ends. */
function trimWsp(value: string): string {
  let start = 0
  let end = value.length
  while (start < end && isWsp(value.charCodeAt(start))) start++
  while (end > start && isWsp(value.charCodeAt(end - 1))) end--
  return value.slice(start, end)
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
 *
 * @deprecated An internal step of `verifyDkim`, exported by mistake; it goes in 2.0.
 * Call `verifyDkim` or `verifyDkimSignatures` instead.
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
 * Only CRLF and a bare LF end a line here. A lone CR — one not immediately
 * followed by LF — is an ordinary octet of whatever line it sits in, per RFC
 * 6376 §3.4.3/§3.4.4: neither section lists CR among what a body
 * canonicalizer treats specially, and dkimpy and OpenDKIM read it the same
 * way. An earlier revision of this file treated a lone CR as a line ending
 * too, rewriting it to CRLF — which disagreed with every RFC-faithful signer
 * on a body that legitimately carries one (classic-Mac text pasted inline, an
 * 8-bit part that was never quoted-printable encoded) and reported it as
 * tampered with (issue #94). The last element is what followed the final line
 * ending — the empty string when the body ends with one, and the whole
 * remaining text when it does not end with one at all.
 */
function splitBodyLines(body: string): string[] {
  const lines: string[] = []
  let start = 0
  for (let i = 0; i < body.length; i++) {
    const code = body.charCodeAt(i)
    if (code === 0x0d && body.charCodeAt(i + 1) === 0x0a) {
      lines.push(body.slice(start, i))
      i++ // the LF is part of this ending too; do not let it start a new line
      start = i + 1
      continue
    }
    if (code === 0x0a) {
      lines.push(body.slice(start, i))
      start = i + 1
    }
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
