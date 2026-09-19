/**
 * Header safety: the transliteration that `Headers` demands.
 *
 * This is the trap `mig` kept a fix for and that `#16` carries. `Headers.set`
 * rejects code points the platform will not accept in a header value, and the
 * rejection surfaces from inside `fetch` as an opaque `TypeError: Value is not a
 * valid ByteString`. Two different needs follow, and `mig` conflated them:
 *
 * - A **header value** must be transliterated to printable ASCII.
 *   `toAsciiHeaderValue` maps the characters that matter for readability
 *   (`—` to `-`, `“` to `"`, `…` to `...`, non-breaking space to space) and
 *   replaces everything else — Latin-1 accents, Cyrillic, CJK, emoji — with
 *   `?`. Whitespace a header value may contain (HT, LF, CR, space) is kept.
 * - A **message body** must be left alone. `mig` passed the body through this
 *   same sanitiser (`notify.ts:119`), so `Café ☕` reached ntfy as `Caf? ?` and
 *   every accented, Cyrillic, CJK and emoji payload was destroyed. Only headers
 *   go through here; nothing in this package applies it to a body.
 */

/**
 * Replaces every code point a header value cannot carry.
 *
 * One `?` per **code point**. The `u` flag is what makes that true: without it
 * the pattern iterates UTF-16 units, so an emoji (one code point, two units)
 * would produce two `?`. The emitted header is still ASCII-safe either way, but
 * the difference is visible in the output, so a test pins it.
 */
export const toAsciiHeaderValue = (value: string): string =>
  // HT, LF, CR, space and printable ASCII are the permitted header characters.
  // deno-lint-ignore no-control-regex
  value.replace(/[^\x09\x0A\x0D\x20-\x7E]/gu, (character) => {
    switch (character) {
      case "\u2014":
      case "\u2013":
      case "\u2010":
      case "\u2011":
      case "\u2212":
        return "-"
      case "\u2018":
      case "\u2019":
      case "\u201A":
      case "\u201B":
        return "'"
      case "\u201C":
      case "\u201D":
      case "\u201E":
      case "\u201F":
        return '"'
      case "\u2026":
        return "..."
      case "\u00A0":
      case "\u2007":
      case "\u202F":
        return " "
      default:
        return "?"
    }
  })

/**
 * Builds a `Headers` instance from values that may be non-ASCII.
 *
 * Every value goes through `toAsciiHeaderValue`, so a non-Latin title cannot
 * throw from inside `fetch`. Kept as a function rather than inline `.set`
 * calls so the trap is directly testable and so the transliteration cannot be
 * dropped from one call site without a test noticing.
 */
export const createAsciiHeaders = (values: Record<string, string>): Headers => {
  const headers = new Headers()
  for (const [name, value] of Object.entries(values)) {
    headers.set(name, toAsciiHeaderValue(value))
  }
  return headers
}
