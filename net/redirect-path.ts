/**
 * The one check for a "go here next" value that anyone can set, such as `?next=` on a sign-in
 * page. Following such a value without a check is an open redirect: a link to your sign-in page
 * could send a person on to another site that looks like yours.
 *
 * Pure and dependency-free: the platform `URL` and `decodeURIComponent` only, so it runs on a
 * server and in a browser alike.
 * @module
 */

/** Options of {@link safeRedirectPath}. */
export interface SafeRedirectPathOptions {
  /**
   * Where to go when the value is missing or refused. A fixed path of the app's own, such as
   * `/notes`; it is returned as given.
   */
  fallback: string
  /**
   * Paths on this origin that are refused anyway, such as `/api`, where a redirect would show raw
   * JSON or fire a request. Each one refuses itself and everything below it (`/api` refuses
   * `/api/x` but not `/apiary`), compared without letter case after decoding and after `..`
   * segments are resolved, so `/notes/../API/x` and `/%61pi/x` are refused too.
   */
  refuse?: readonly string[]
}

/** C0 and C1 control characters and DEL. Browsers drop some of them silently from a URL. */
// deno-lint-ignore no-control-regex -- matching control characters is the point of this pattern
const CONTROL_CHARACTERS = /[\u0000-\u001F\u007F-\u009F]/

/** Decoding stops here; a value still changing after this many rounds is refused. */
const MAX_DECODE_ROUNDS = 4

/** A base no real request reaches: only the origin comparison uses it. */
const BASE = new URL(`http://redirect-path.invalid`)

/**
 * True when `text` starts with exactly one `/` and holds no backslash and no control character.
 * A browser reads a leading `//` or `/\` as another host, and a tab or a newline inside it is
 * dropped before that reading.
 */
function isPlainPath(text: string): boolean {
  return text.startsWith(`/`) && text[1] !== `/` && !text.includes(`\\`) &&
    !CONTROL_CHARACTERS.test(text)
}

/**
 * `text` and each percent-decoded form of it, or `null` when one does not decode. Each form is
 * checked, so `/%2F%2Fevil.example` or a doubly encoded `%255C` is refused like its plain form.
 */
function decodedForms(text: string): string[] | null {
  const forms = [text]
  for (let round = 0; round < MAX_DECODE_ROUNDS; round++) {
    const current = forms[forms.length - 1]
    let next: string
    try {
      next = decodeURIComponent(current)
    } catch {
      return null
    }
    if (next === current) return forms
    forms.push(next)
  }
  return null
}

/**
 * True when `pathname`, without letter case, is one of `prefixes` or below one. The caller passes
 * every decoded form of the value, so this compares one form as it is.
 */
function isRefused(pathname: string, prefixes: readonly string[]): boolean {
  const path = pathname.toLowerCase()
  return prefixes.some((prefix) => {
    const refused = prefix.toLowerCase().replace(/\/+$/, ``)
    return path === refused || path.startsWith(`${refused}/`)
  })
}

/**
 * The path to send a person to next: `value` when it is a path on this origin, `fallback`
 * otherwise.
 *
 * Accepted: a path that starts with exactly one `/`, with any query and hash, returned with its
 * `.` and `..` segments resolved. Refused, so `fallback` comes back: a missing or empty value, a
 * scheme (`https:`, `javascript:`), a leading `//`, a backslash anywhere, a control character,
 * the percent-encoded forms of these (`/%2F%2Fevil.example`, `%5C`, `%09`), percent encoding that
 * does not decode, a path whose `.` and `..` segments resolve to a leading `//`, and every path
 * under one of `options.refuse`. Each decoded form of the value (up to four rounds) is checked,
 * with its dot segments resolved, so `/.%2F/evil.example` and `/notes/%252e%252e/api` are refused
 * like their plain forms.
 *
 * Check the value again on every hop that carries it, such as each page of a sign-in that takes
 * two steps: a value that passed once may have been changed in between.
 *
 * @example
 * ```ts
 * const next = safeRedirectPath(new URL(request.url).searchParams.get("next"), {
 *   fallback: "/notes",
 *   refuse: ["/api"],
 * })
 * ```
 */
export function safeRedirectPath(
  value: string | null | undefined,
  options: SafeRedirectPathOptions,
): string {
  // The checks run on forms of the value (decoded, then resolved), never on forms of the path it
  // returns (resolved, then decoded). An encoded slash inside a segment that `..` removes makes
  // those differ, so a result is kept only if checking it again returns it unchanged.
  const once = checkOnce(value, options)
  if (once === options.fallback) return once
  return checkOnce(once, options) === once ? once : options.fallback
}

function checkOnce(
  value: string | null | undefined,
  options: SafeRedirectPathOptions,
): string {
  const { fallback, refuse = [] } = options
  if (!value) return fallback
  const forms = decodedForms(value)
  if (!forms || !forms.every(isPlainPath)) return fallback
  let url: URL
  let resolved: string[]
  try {
    url = new URL(value, BASE)
    // Each decoded form with its `.` and `..` segments resolved: a browser or a server may decode
    // the value once more before it resolves them, so `/.%2F/evil.example`, which is
    // `/.//evil.example` once decoded, resolves to `//evil.example`.
    resolved = forms.map((form) => new URL(form, BASE).pathname)
  } catch {
    return fallback
  }
  // Defence in depth: a value that passed `isPlainPath` always parses onto `BASE`'s origin.
  if (url.origin !== BASE.origin) return fallback
  const path = `${url.pathname}${url.search}${url.hash}`
  if (!isPlainPath(path) || !resolved.every(isPlainPath)) return fallback
  if (resolved.some((pathname) => isRefused(pathname, refuse))) return fallback
  return path
}
