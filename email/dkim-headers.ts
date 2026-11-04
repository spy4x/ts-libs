// DKIM verifier, step 5: pick the header fields a signature's `h=` tag signs
// (RFC 6376 §5.4.2).

import { DkimParseError } from "./dkim-types.ts"

/**
 * Header field names a relay is expected to add to a message in transit.
 *
 * RFC 6376 §5.4.2 lets a signer detect an added field by listing its name in `h=`
 * more often than the message carries it, and {@link selectSignedHeaders} refuses
 * a message that grew one. Trace fields break that: every hop that forwards a
 * message prepends its own `Received:`, and a signature over `Received` would be
 * refused the moment the mail was forwarded, which is ordinary mail rather than
 * an attack.
 *
 * So these names, and only these, are exempt from that refusal; the added
 * instances are simply not selected, because §5.4.2's bottom-up pairing already
 * reaches the instances the signer signed. Every other name — `From` above all —
 * keeps the refusal.
 *
 * What makes a name belong here is that a later hop prepends it by design, so a
 * message that arrives with one more of it than the signer signed is ordinary
 * mail rather than a forgery. It is not that a person never sees these fields:
 * `Resent-From` is on the list and some mail clients display it as the sender. It
 * is on the list because a redirect prepends a fresh `Resent-*` block exactly the
 * way a relay prepends a `Received:` field, and a verifier that implements RFC
 * 6376 and nothing more accepts that message too, having no growth check at all.
 *
 * A signer who wants one of these names protected has the remedy RFC 6376 §5.4
 * gives for exactly this: list the name in `h=` once more than the message
 * carries it. That oversigned instance is still paired and still hashed, so a
 * message that gained a field of that name fails the signature — the exemption
 * only stops the *growth check* from refusing the message, it never removes bytes
 * from the hash.
 *
 * An entry ending in `-*` matches every name that starts with it.
 */
export const TRANSIT_ADDED_HEADER_NAMES: readonly string[] = Object.freeze([
  "received",
  "x-received",
  "return-path",
  "delivered-to",
  "authentication-results",
  "resent-*",
  "arc-*",
])

/** True when `name`, already lowercased, is in {@link TRANSIT_ADDED_HEADER_NAMES}. */
function isTransitAddedHeaderName(name: string): boolean {
  return TRANSIT_ADDED_HEADER_NAMES.some((entry) =>
    entry.endsWith("*") ? name.startsWith(entry.slice(0, -1)) : name === entry
  )
}

/**
 * True for an octet **outside** RFC 5322's printable-ASCII range, 0x21-0x7E —
 * the same range `ftext` restricts a genuine field name to (`HEADER_NAME_RE`,
 * minus the colon it also excludes). {@link trimHeaderName} strips every
 * octet this returns `true` for from a name's ends, which is why the two
 * ranges do not need to match exactly: a byte this returns `true` for is
 * never part of a name a conformant sender would write, so stripping it can
 * only ever make a forged line's name easier to recognise, never harder.
 */
function isHeaderNamePadding(code: number): boolean {
  return code < 0x21 || code > 0x7e
}

/**
 * Trim every octet outside printable ASCII (0x21-0x7E) from both ends of a
 * header **name**, before {@link selectSignedHeaders} and
 * {@link refuseSignatureHeader} compare it against a name in `h=`.
 *
 * The previous version of this comparison trimmed an explicit byte set
 * — space, tab, vertical tab, form feed and U+00A0 — copied from what
 * `String.prototype.trim()` stripped on `main` before this file could handle
 * raw octets. That set was narrower than `trim()`'s own Unicode whitespace
 * list, which also strips U+FEFF, U+1680, U+2000-U+200A, U+2028, U+2029,
 * U+202F, U+205F and U+3000 — each several bytes in UTF-8, none in the old
 * set — so a genuine signed mail with, for instance, `From` followed by
 * U+00A0 (a no-break space, still one of `trim()`'s own characters) and then
 * the colon, placed above it, verified here and was refused on `main`: the
 * guard's name match had shrunk, the opposite of what widening it to handle
 * bytes was supposed to do. Review of this pull request found it does not go
 * far enough either: a control character (U+0000-U+001F, U+007F), U+0085 or a
 * zero-width space (U+200B) before the colon verifies on `main` too (issue
 * #106) — `trim()` never stripped any of those, so the byte set inherited
 * from it never could either.
 *
 * Stripping everything *outside* printable ASCII, rather than enumerating
 * more characters to strip, closes both at once and cannot regress again the
 * same way: RFC 5322's `ftext` restricts a genuine field name to exactly this
 * range already (`HEADER_NAME_RE`), so every character this now strips is one
 * no conformant sender's field name would contain in the first place, and
 * removing it can only ever make a disguised name easier to recognise as the
 * name it is disguising.
 *
 * This also means CR and LF are stripped now, unlike the narrower set before
 * — and that is load-bearing, not incidental. RFC 5322 does not let a field
 * name fold before its own colon — the obsolete syntax it does allow there is
 * plain spaces and tabs, `obs-from = "From" *WSP ":"` — but §2.2.3 defines
 * unfolding as deleting every CRLF that is immediately followed by WSP,
 * without asking where the CRLF sits, so a reader that unfolds first (this
 * verifier, and most mail programs) turns `From<CRLF><TAB>: ceo@bank.example`
 * into `From<TAB>: ceo@bank.example` and reads it as that same obsolete
 * `From` form. `From<CRLF><TAB>:` is a *uniform* CRLF block, so
 * {@link refuseHeaderLineEndings} accepts it, and the raw name substring
 * `selectSignedHeaders` reads still carries the CRLF and the tab before this
 * function runs. Stripping them is what lets the comparison still read that
 * line as `From` — the same thing `String.trim()` did on `main` — so the
 * growth guard in {@link selectSignedHeaders} refuses the extra instance
 * instead of missing it. Leaving CR and LF in the padding set is therefore
 * not a safe simplification: a version of this file that stopped trimming
 * them let `From<CRLF><TAB>: ceo@bank.example` verify, which `main` refuses.
 */
export function trimHeaderName(value: string): string {
  let start = 0
  let end = value.length
  while (start < end && isHeaderNamePadding(value.charCodeAt(start))) start++
  while (end > start && isHeaderNamePadding(value.charCodeAt(end - 1))) end--
  return value.slice(start, end)
}

/**
 * The name an already end-trimmed header name ({@link trimHeaderName}) reads
 * as, to a mail program that is lenient about a padding byte
 * ({@link isHeaderNamePadding}) sitting *inside* the name rather than at an
 * end (issue #113, the inside-the-name half of #106), if that reading is one
 * of `targets` (each already lowercase). Returns the matched target, or
 * `undefined`.
 *
 * A byte inside a name is never part of a name a conformant sender would
 * write, same as at an end, but no single rule reads it the way every
 * lenient program might: one that deletes an invisible or control byte
 * wherever it finds one reads `Fr<U+00AD>om` as `From`, and one that stops
 * reading a name at the first byte it cannot render reads `From<NUL>x` as
 * `From` too. A first version of this function computed those two readings
 * independently over the *whole* name — strip every padding byte, or cut at
 * the first one — but a name that needs both readings *at once* defeated it:
 * `Fr<U+00AD>om<NUL>x` strips to `Fromx` and cuts to `Fr`, and neither is
 * `from`, so a client that silently drops the soft hyphen and then stops at
 * the NUL — reading `From` — was never modelled.
 *
 * This version walks the name once, building up the stripped prefix
 * character by character, and treats every point a mail program might
 * plausibly stop or resync at as a candidate: the prefix so far, tested each
 * time a run of padding bytes *begins* — as if a lenient reader swallowed the
 * run whole and kept going — and once more after the whole name, as if it
 * read to the end. `Fr<U+00AD>om<NUL>x` now matches at the NUL: the prefix by
 * then has already absorbed the soft hyphen and reads `From`.
 *
 * The prefix only ever grows — a padding byte is skipped, never subtracted
 * from what was already kept — so once it is longer than the longest name in
 * `targets`, no later candidate, at any further padding run or at the end,
 * can match one either. `maxTargetLength` is that bound, and the walk stops
 * as soon as it is passed, which is what keeps the cost linear in the name's
 * length rather than proportional to how many padding runs an attacker packs
 * into it.
 *
 * A candidate is only ever compared against `targets`, so an unrelated,
 * unsigned field's own disguised name never matches anything — but a plain
 * field whose name simply *starts* with a signed name and then a padding
 * byte, `Subject Line:` or `To Name:`, now matches at the first run (the
 * space), the same as it would have matched the old truncate-only reading:
 * this is not a new trade, only a more visible one, since issue #113's own
 * table already lists `Fr om:` as a shape a lenient reader could take for
 * `From`.
 */
function looseHeaderNameMatch(
  trimmedName: string,
  targets: ReadonlySet<string>,
  maxTargetLength: number,
): string | undefined {
  let strippedSoFar = ""
  let inPaddingRun = false
  const candidate = (): string | undefined => {
    const lowered = strippedSoFar.toLowerCase()
    return targets.has(lowered) ? lowered : undefined
  }
  for (let i = 0; i < trimmedName.length; i++) {
    if (strippedSoFar.length > maxTargetLength) return undefined // can only grow from here
    if (isHeaderNamePadding(trimmedName.charCodeAt(i))) {
      if (!inPaddingRun) {
        const match = candidate()
        if (match !== undefined) return match
        inPaddingRun = true
      }
      continue
    }
    inPaddingRun = false
    strippedSoFar += trimmedName[i]
  }
  return strippedSoFar.length > maxTargetLength ? undefined : candidate()
}

/**
 * True when `rawName`, read the way {@link selectSignedHeaders} and {@link
 * refuseSignatureHeader} read a header name — end-trimmed, and then also
 * through {@link looseHeaderNameMatch} for a byte disguised inside it — could
 * be mistaken for `target` (already lowercase). `target` is compared against
 * the end-trimmed name first because that is the common case and needs no
 * extra work; the loose reading only matters when it does not match.
 */
export function headerNameMatches(rawName: string, target: string): boolean {
  const trimmedName = trimHeaderName(rawName)
  if (trimmedName.toLowerCase() === target) return true
  return looseHeaderNameMatch(trimmedName, new Set([target]), target.length) !== undefined
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
 * `h=` list consumes, which means the message grew a field after signing —
 * unless the name is one of {@link TRANSIT_ADDED_HEADER_NAMES}, which a relay
 * adds on the way and a forwarded message therefore always has more of. It
 * also throws when a header line's name is not `h=`-asked-for as written but
 * a lenient mail program could still read it as one ({@link
 * looseHeaderNameMatch}, issue #113): such a line is never selected by the
 * bottom-up pairing above — it sits in its own bucket, under its own literal
 * name — so it is always an instance beyond what the signer signed, for
 * every name it disguises as that `h=` actually lists. Unlike the leftover
 * check above, this one has no {@link TRANSIT_ADDED_HEADER_NAMES} exemption:
 * a disguised line was never written by a relay and can never be reached by
 * the oversigning remedy either, since it is never selected or hashed, so
 * exempting it would hand a forged trace field exactly the bypass this scan
 * exists to close.
 */
export function selectSignedHeaders(
  headers: string[],
  names: string[],
): { name: string; value: string }[] {
  const occurrences = new Map<string, number[]>()
  headers.forEach((header, index) => {
    const colon = header.indexOf(":")
    if (colon === -1) return
    const name = trimHeaderName(header.slice(0, colon)).toLowerCase()
    const list = occurrences.get(name)
    if (list) list.push(index)
    else occurrences.set(name, [index])
  })

  const remaining = new Map<string, number[]>()
  for (const [name, list] of occurrences) remaining.set(name, [...list])

  // How often the h= list asks for each name, counted once. Asking the list per
  // distinct header name instead — `names.filter(…)` inside the loop below — cost
  // one pass over h= for every name in the message, so a message made of headers
  // that h= all names took time proportional to the square of its size: 3 MB of
  // them froze the process for 63 seconds, with no valid signature needed.
  const asked = new Map<string, number>()
  for (const name of names) asked.set(name, (asked.get(name) ?? 0) + 1)

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
    // Names the h= list never asks for are outside this signature entirely; only
    // a name it does ask for has a defined number of expected instances.
    const count = asked.get(name) ?? 0
    if (count === 0 || count >= list.length) continue
    // A relay adds its trace fields above the message it forwards, so a mail that
    // was forwarded carries more of them than the signer signed. Refusing that is
    // refusing ordinary mail; the instances the signer signed are still the ones
    // §5.4.2's bottom-up pairing selected above.
    if (isTransitAddedHeaderName(name)) continue
    throw new DkimParseError(`unsigned additional instances of a signed header: ${name}`)
  }

  // #113: a header line whose end-trimmed name is not itself asked for can
  // still disguise as one that is, by a padding byte sitting inside the name
  // rather than at an end. Such a line was bucketed above under its own
  // literal (undisguised) name and so never took part in the pairing or the
  // leftover count either — it is unconditionally an extra instance of
  // whichever asked-for name it disguises as, for the same reason a real
  // extra instance is: the signer never had the chance to sign it under that
  // name.
  //
  // No {@link TRANSIT_ADDED_HEADER_NAMES} exemption here, unlike the pairing
  // loop above: that exemption exists because a relay prepends a real,
  // correctly named trace field, and the remedy for a signer who wants one
  // protected — oversigning it — reaches that field, since it has an exact
  // name and is paired and hashed like any other. Neither holds for a name
  // that only reads as `resent-from` or `received` once a padding byte is
  // dropped or a name is cut short: no relay wrote it that way, and
  // oversigning cannot reach it, because a disguised line is never selected
  // or hashed by the pairing loop at all — it sits in its own bucket. Exempting
  // it here would hand a forged `Resent-From` the exact bypass this scan
  // exists to close.
  const askedNames = new Set(asked.keys())
  const maxAskedNameLength = names.reduce((max, name) => Math.max(max, name.length), 0)
  for (const header of headers) {
    const colon = header.indexOf(":")
    if (colon === -1) continue
    const rawName = header.slice(0, colon)
    const trimmedName = trimHeaderName(rawName)
    const exact = trimmedName.toLowerCase()
    if (asked.has(exact)) continue // already accounted for above
    const loose = looseHeaderNameMatch(trimmedName, askedNames, maxAskedNameLength)
    if (loose === undefined) continue
    throw new DkimParseError(`unsigned additional instances of a signed header: ${loose}`)
  }

  return selected
}
