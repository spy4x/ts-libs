/**
 * RFC 4180-shaped CSV field splitting.
 *
 * One physical line in, one array of field values out. Deliberately *line*-oriented: an embedded
 * CR/LF inside a quoted field would need a record reader that consumes a whole stream, and every
 * caller in the batch reads line-by-line first. Pass `{ keepQuotes: true }` when the caller wants
 * the raw quoted form.
 *
 * Every field is trimmed, which is also what strips a trailing `\r\n` / `\n` / `\r` terminator from
 * the last field. The source parser did the same (`warthunder-stats/libs/domain/stats/parser.ts:120`)
 * and this module exists to keep that behaviour, not to change it.
 */

/** Options for {@link splitCsvLine}. */
export interface SplitCsvLineOptions {
  /** Field separator. Defaults to `","`. */
  delimiter?: string
  /** Quote character. Defaults to `'"'`. */
  quote?: string
  /** Keep the surrounding quote characters instead of stripping them. Defaults to `false`. */
  keepQuotes?: boolean
}

/**
 * Split one CSV line into fields, throwing on malformed quoting.
 *
 * - A doubled quote inside a quoted field is one literal quote (`""` → `"`).
 * - A delimiter inside a quoted field is part of the value.
 * - A trailing delimiter yields a trailing empty field.
 * - **A quote may only open a field.** A quote anywhere else — a stray mid-field `"` such as
 *   `5" pipe,7` — throws `"malformed CSV quoting"`. Accepting it would swallow the delimiter and
 *   silently merge two fields, which is worse than refusing the line.
 * - **A quoted field must be closed.** `a,"broken` throws `"unterminated quoted cell"`.
 * - Fields are trimmed. A quoted field is trimmed inside its quotes, so `" padded "` yields
 *   `"padded"`; that is the source's behaviour.
 *
 * Byte-exact pass-through of a field with meaningful leading or trailing whitespace is therefore
 * not supported. Use `keepQuotes: true` when the quoted form itself must be preserved.
 */
export function splitCsvLine(line: string, options: SplitCsvLineOptions = {}): string[] {
  const delimiter = options.delimiter ?? ","
  const quote = options.quote ?? '"'
  const keepQuotes = options.keepQuotes ?? false
  if (delimiter.length !== 1) throw new Error("delimiter must be a single character")
  if (quote.length !== 1) throw new Error("quote must be a single character")

  const fields: string[] = []
  /** Raw field content, before trimming; `rawQuoted` is the quoted form of this field. */
  let content = ""
  let quoted = false
  let rawQuoted = ""
  let wasQuoted = false
  /** Set once a quoted field closes, and cleared only when the field ends. */
  let quoteClosed = false

  const endField = () => {
    // `rawQuoted` was captured at the closing quote, before any trailing text could be appended.
    fields.push(wasQuoted && keepQuotes ? rawQuoted : content.trim())
    content = ""
    rawQuoted = ""
    wasQuoted = false
    quoteClosed = false
  }

  for (let i = 0; i < line.length; i++) {
    const char = line[i]
    if (quoted) {
      if (char === quote) {
        if (line[i + 1] === quote) {
          content += quote
          i++
        } else {
          quoted = false
          quoteClosed = true
          rawQuoted = `${quote}${content.replaceAll(quote, quote + quote)}${quote}`
        }
      } else {
        content += char
      }
      continue
    }
    if (char === quote) {
      // Quoting opens a field only at its start. Anywhere else the line is malformed, and pretending
      // otherwise merges the surrounding fields — `5" pipe,7` would lose both the delimiter and the
      // quote. `quoteClosed` catches text after the closing quote even when the quoted field was
      // empty, which `content !== ""` alone would let through.
      if (content !== "" || quoteClosed || wasQuoted) throw new Error("malformed CSV quoting")
      quoted = true
      wasQuoted = true
      continue
    }
    if (char === delimiter) {
      endField()
      continue
    }
    if (quoteClosed) throw new Error("malformed CSV quoting")
    content += char
  }
  if (quoted) throw new Error("unterminated quoted cell")
  endField()
  return fields
}
