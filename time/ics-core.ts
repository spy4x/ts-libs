// RFC 5545 iCalendar wire primitives: content-line folding, TEXT/parameter
// escaping and the UTC DATE-TIME value type.
//
// This module is the shared core for the `time/` writer (`time/ics.ts`) and for
// the CalDAV wire code in `caldav/` (issue #13). It deliberately contains no
// VCALENDAR/VEVENT structure and no parser: it is the byte-level layer both
// sides need, so neither re-implements 75-octet folding a third time.
//
// The folding algorithm originates in `mig/lib/ics.ts` (fold) and this port
// keeps its UTF-8 boundary handling unchanged.

/** Maximum octets of a content line including its line break, per RFC 5545 §3.1. */
export const FOLD_LIMIT = 75

/**
 * Octets available to a continuation line: a continuation is prefixed with one
 * SPACE (RFC 5545 §3.1), and that SPACE counts toward the 75-octet limit.
 */
export const CONTINUATION_LIMIT = FOLD_LIMIT - 1

/** RFC 5545 §3.1 requires CRLF as the content-line separator. */
export const CRLF = "\r\n"

/**
 * Bare LF. Escaping helpers normalise CRLF and CR to this before escaping, so a
 * value's own line breaks become the two-character `\n` escape regardless of
 * which convention the caller's data used.
 */
export const LF = "\n"

/**
 * Remove characters RFC 5545 does not allow in content lines: C0 controls
 * except HTAB, LF and CR, plus DEL. The three survivors are structural — HTAB
 * may appear inside a value, and LF/CR are normalised by the escaping helpers
 * rather than dropped.
 */
export function stripControlCharacters(value: string): string {
  return [...value].filter((character) => {
    const code = character.codePointAt(0)!
    return !((code <= 31 && code !== 9 && code !== 10 && code !== 13) || code === 127)
  }).join("")
}

/**
 * Escape a TEXT property value per RFC 5545 §3.3.11.
 *
 * Order matters: the backslash has to be doubled before `;` and `,` gain their
 * own backslashes, and every line break has to become the two-character `\n`
 * escape so a value containing a newline cannot terminate its own content line.
 * CRLF and bare CR are normalised to LF first.
 */
export function icsEscape(value: string): string {
  if (value === "") return ""
  return stripControlCharacters(value)
    .replaceAll(CRLF, LF)
    .replaceAll("\r", LF)
    .replaceAll("\\", "\\\\")
    .replaceAll(";", "\\;")
    .replaceAll(",", "\\,")
    .replaceAll(LF, "\\n")
}

/**
 * Escape a quoted parameter value per RFC 6868.
 *
 * `^` is doubled first so a literal `^` can never be mistaken for the start of
 * the `^'` (double quote) or `^n` (newline) escape, and line breaks become `^n`
 * so a value cannot inject a bare newline into the parameter list of a line.
 */
export function icsEscapeParameter(value: string): string {
  if (value === "") return ""
  return stripControlCharacters(value)
    .replaceAll(CRLF, LF)
    .replaceAll("\r", LF)
    .replaceAll("^", "^^")
    .replaceAll('"', "^'")
    .replaceAll(LF, "^n")
}

/**
 * Reverse {@link icsEscape}. A hand-rolled single pass rather than chained
 * `replaceAll`, because `\\n` must become a newline while `\\\\n` must stay a
 * literal backslash followed by `n` — chained replacement cannot tell them
 * apart once the first rule has rewritten the string.
 */
export function icsUnescape(value: string): string {
  let out = ""
  for (let index = 0; index < value.length; index++) {
    const character = value[index]!
    if (character !== "\\") {
      out += character
      continue
    }
    const next = value[index + 1]
    if (next === undefined) {
      out += "\\"
      continue
    }
    index++
    if (next === "n" || next === "N") out += LF
    else if (next === "\\") out += "\\"
    else if (next === ";") out += ";"
    else if (next === ",") out += ","
    else out += next
  }
  return out
}

/**
 * Reverse {@link icsEscapeParameter} per RFC 6868 §3.1: `^n` becomes a newline,
 * `^'` a double quote, `^^` a single caret.
 *
 * The `^^` case must emit one caret and then keep scanning, *not* one caret and
 * skip the next character — `^^n` is an encoded literal caret followed by `n`,
 * so decoding it to a newline would break the round trip for any value holding
 * the two characters `^n`. A caret followed by anything else is left as written,
 * per the RFC's requirement that unknown escapes pass through unchanged.
 */
export function icsUnescapeParameter(value: string): string {
  let out = ""
  for (let index = 0; index < value.length; index++) {
    const character = value[index]!
    if (character !== "^") {
      out += character
      continue
    }
    const next = value[index + 1]
    if (next === "^") {
      // One caret, then continue scanning: "^^n" is an encoded caret followed
      // by a literal "n", not an encoded newline.
      out += "^"
      index++
    } else if (next === "'") {
      out += '"'
      index++
    } else if (next === "n" || next === "N") {
      out += LF
      index++
    } else {
      out += "^"
    }
  }
  return out
}

/**
 * Format a `Date` as an RFC 5545 UTC DATE-TIME value, `YYYYMMDDTHHMMSSZ`.
 *
 * Callers must convert wall-clock times to the correct instant before calling
 * (see `time/tz.ts`); this helper only serialises, so it never consults the
 * host timezone and never applies an offset of its own.
 */
export function formatIcsUtc(instant: Date): string {
  if (Number.isNaN(instant.getTime())) {
    throw new TypeError("formatIcsUtc requires a valid Date")
  }
  const pad = (value: number, width = 2) => String(value).padStart(width, "0")
  return `${pad(instant.getUTCFullYear(), 4)}${pad(instant.getUTCMonth() + 1)}${
    pad(instant.getUTCDate())
  }` +
    `T${pad(instant.getUTCHours())}${pad(instant.getUTCMinutes())}${pad(instant.getUTCSeconds())}Z`
}

/**
 * Fold one logical content line to at most {@link FOLD_LIMIT} octets per
 * physical line, per RFC 5545 §3.1.
 *
 * Iterates by code point, never by UTF-16 code unit or by octet, so a
 * multi-byte UTF-8 sequence is never split across a fold — splitting one would
 * corrupt the byte stream for every conforming parser. A line whose encoded
 * length is already at or under the limit is returned untouched, which is also
 * what keeps `BEGIN:VCALENDAR` and friends byte-exact.
 */
export function foldLine(line: string): string {
  const encoder = new TextEncoder()
  if (encoder.encode(line).length <= FOLD_LIMIT) return line

  const chunks: string[] = []
  let chunk = ""
  let chunkOctets = 0
  let limit = FOLD_LIMIT

  for (const character of line) {
    const characterOctets = encoder.encode(character).length
    // A pathological single code point cannot fit anyway; only flush once the
    // current chunk holds something, so the chunk is never left empty and the
    // emitted line always begins with its continuation SPACE.
    if (chunkOctets > 0 && chunkOctets + characterOctets > limit) {
      chunks.push(chunk)
      chunk = ""
      chunkOctets = 0
      limit = CONTINUATION_LIMIT
    }
    chunk += character
    chunkOctets += characterOctets
  }
  if (chunkOctets > 0) chunks.push(chunk)

  return chunks.map((value, index) => index === 0 ? value : ` ${value}`).join(CRLF)
}

/**
 * Unfold every content line in an iCalendar document: a CRLF (or bare LF)
 * followed by SPACE or HTAB continues the previous line (RFC 5545 §3.1).
 *
 * Exported because it is the inverse of {@link foldLine} and because #13 needs
 * the same definition; tests use it to assert octet-exact round trips.
 */
export function unfoldLines(text: string): string {
  return text.replace(/\r?\n[ \t]/g, "")
}

/**
 * Fold each logical line and terminate every one with CRLF, including the last.
 *
 * Returns an empty string for an empty input, so a caller that assembles no
 * lines does not emit a stray blank content line.
 */
export function joinContentLines(lines: readonly string[]): string {
  if (lines.length === 0) return ""
  return lines.map(foldLine).join(CRLF) + CRLF
}

/**
 * Assert that a logical line fits one physical content line.
 *
 * Cheap ingress check for callers that hand-write a line: throws instead of
 * silently emitting a document a strict parser will reject.
 */
export function assertFoldable(line: string): void {
  const octets = new TextEncoder().encode(line).length
  if (octets > FOLD_LIMIT) {
    throw new RangeError(`content line is ${octets} octets; fold it to <= ${FOLD_LIMIT}`)
  }
}
