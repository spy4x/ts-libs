/**
 * Read one cookie's value out of `document.cookie`.
 *
 * Two deliberate fixes over a common hand-rolled version:
 *
 * 1. **No `RegExp` built from the cookie name.** A pattern like
 *    `new RegExp(`(^| )${name}=([^;]+)`)` treats `.` and `[` in `name` as regex syntax, so a name
 *    like `foo.bar` also matches an unrelated `fooXbar` cookie, and a name like `foo[bar` throws a
 *    `SyntaxError` instead of reading a cookie at all. Splitting `document.cookie` into entries and
 *    comparing each entry's name with `===` has no such hole.
 * 2. **No global read at import time, and no throw with no `document`.** `doc` is a plain optional
 *    parameter, not a default expression — a default expression referencing the bare `document`
 *    identifier throws in a runtime with no global `document`, even when the caller passes nothing.
 *    The real global is read only inside the function body, and only when the caller passed none,
 *    the same shape `download.ts`'s `downloadResponseAsFile` uses for its own `document` parameter.
 */

/**
 * Look up `name` in `doc.cookie`, decoding its value.
 *
 * `document.cookie` is one string of `name=value` pairs separated by `"; "`. This splits on that
 * separator (tolerating a missing space), then splits each entry on its *first* `=` only, so a
 * value that itself contains `=` — a base64-encoded value, for instance — is kept whole rather than
 * cut short. The value is passed through `decodeURIComponent`; a malformed percent-escape makes
 * that throw `URIError`, and this lets it propagate rather than swallow it, since a cookie value
 * that fails to decode is a real error the caller should see.
 *
 * @param name Cookie name, compared with `===` against each entry — never used to build a pattern.
 * @param doc Document-like object providing `cookie`. Defaults to the global `document`, read only
 * when this argument is omitted, so calling this with no browser `document` in scope returns `null`
 * instead of throwing.
 * @returns The decoded value, or `null` when there is no `document` or no matching entry. A
 * cookie set as `a=` (empty value) returns `""`, not `null` — the old regex-based helper's
 * capture group required at least one character, so it never matched an empty value at all.
 */
export function getCookie(name: string, doc?: Pick<Document, "cookie">): string | null {
  const document_ = doc ?? (globalThis as { document?: Pick<Document, "cookie"> }).document
  if (!document_) return null

  for (const entry of document_.cookie.split(/; ?/)) {
    const separatorIndex = entry.indexOf("=")
    if (separatorIndex === -1) continue
    const entryName = entry.slice(0, separatorIndex)
    if (entryName !== name) continue
    return decodeURIComponent(entry.slice(separatorIndex + 1))
  }
  return null
}
