/**
 * Reusable arktype predicates for untrusted text, ported from `mig/routes/api/_validators.ts`.
 *
 * `BookingSchema` itself is product domain — a booking form — so it is not ported. What is ported
 * are the four reusable checks it was built from: the two control-character refinements, the
 * honeypot field, and the time-zone probe.
 *
 * Control characters are what make CRLF/header injection possible: a value carrying LF can end the
 * header it is written into and start an attacker-authored one. Two different sets are needed
 * because the two destinations have different rules — a *header* value admits no control character
 * at all, while stored *free text* must keep accepting TAB, LF and CR or a multi-line note becomes
 * illegal. {@link hasHeaderControlCharacters} and {@link hasTextControlCharacters} are exactly that
 * asymmetry, and a value can be safe for one and unsafe for the other.
 *
 * Ported and fixed at extraction time (`mig/routes/api/_validators.ts:35`): the honeypot field was
 * `z.string()` — required to be present, but never checked. A filled honeypot (a bot, or an
 * accessibility autofill) was accepted silently, so the anti-bot signal the field exists for was
 * thrown away. {@link honeypotField} requires present *and* empty, and {@link isHoneypotFilled}
 * gives the caller the positive signal it can act on.
 *
 * A caveat on messages: arktype appends the offending value to a refinement message
 * (`must be empty (was "http://spam.example")`). That is the right copy for a form field, and it
 * means an arktype message must **never** be surfaced for a value holding secret material — the
 * recipient would read the secret straight out of the error. A secret needs a constant message
 * instead.
 */

import { Type, type } from "arktype"

/** Highest ASCII control code point, inclusive: the C0 block. */
export const HEADER_MAX_CODE_POINT = 31

/** ASCII `DEL`. Still a control character, and not part of the contiguous C0 block. */
export const DEL_CODE_POINT = 127

/**
 * Control code points free text is allowed to keep: TAB, LF and CR.
 *
 * These three are what makes multi-line prose legal. Everything else in C0 has no legitimate place
 * in a note or a name.
 */
export const TEXT_ALLOWED_CODE_POINTS: readonly number[] = [9, 10, 13]

/**
 * Iterate `value` by code point and return the first character `isForbidden` rejects, if any.
 *
 * Iteration is by code point (`for...of`), matching the source's `[...value]` spread: an astral
 * character such as an emoji arrives as one code point above `0xFFFF`, never as its two surrogate
 * halves — so a surrogate (`>= 0xD800`) can not be mistaken for a control character. A code-unit
 * regex would be equivalent *only* because every code point in these ranges is in the BMP, which is
 * a property of the ranges and not something to rely on.
 */
function firstForbiddenCharacter(
  value: string,
  isForbidden: (codePoint: number) => boolean,
): string | undefined {
  for (const character of value) {
    const codePoint = character.codePointAt(0)
    if (codePoint !== undefined && isForbidden(codePoint)) return character
  }
  return undefined
}

/**
 * True when `value` contains a code point ≤ 31 or 127 — unsafe in any HTTP header.
 *
 * Deliberately stricter than {@link hasTextControlCharacters}: a header value has no legitimate
 * multi-line form, so TAB, LF and CR are rejected here even though free text keeps them.
 */
export function hasHeaderControlCharacters(value: string): boolean {
  return firstForbiddenCharacter(
    value,
    (codePoint) => codePoint <= HEADER_MAX_CODE_POINT || codePoint === DEL_CODE_POINT,
  ) !== undefined
}

/**
 * True when `value` contains a code point ≤ 31 other than TAB/LF/CR, or 127 — unsafe in stored
 * free text.
 *
 * The exceptions are what keep multi-line notes legal; NUL and DEL stay forbidden, because a
 * truncating sink (C string, SQL parameter, log line) treats NUL as a terminator and DEL as
 * invisible noise.
 */
export function hasTextControlCharacters(value: string): boolean {
  return firstForbiddenCharacter(
    value,
    (codePoint) =>
      (codePoint <= HEADER_MAX_CODE_POINT && !TEXT_ALLOWED_CODE_POINTS.includes(codePoint)) ||
      codePoint === DEL_CODE_POINT,
  ) !== undefined
}

/**
 * True when a honeypot field was filled in, i.e. the submission is very likely automated.
 *
 * Any non-empty value counts, whitespace included: a bot that fills `" "` is still a bot, and
 * trimming first would turn that signal into a silent acceptance — the same bug the source's
 * `z.string()` had. The caller decides what to do with the signal (reject, or accept into a spam
 * queue); this predicate only reports it.
 */
export function isHoneypotFilled(value: string): boolean {
  return value !== ""
}

/**
 * True when `Intl.DateTimeFormat` accepts `value` as a time zone.
 *
 * There is no zone-name API to ask, so the check is a probe: `Intl` throws `RangeError` for a name
 * its tzdata does not know, and that throw *is* the answer. The probe is code-point exact, which is
 * why `"Europe/Berlin"` and `"UTC"` pass while `"EST5EDT "` — one trailing space — fails.
 *
 * `time/tz.ts:107` is the canonical plain version of this predicate (`isValidTimeZone`). It is not
 * imported here: a sibling import (`@ts-libs/time`) would make this package depend on an
 * unpublished package at `deno publish` time, and the repo has no sibling imports anywhere. So the
 * probe is repeated — and the exported name is {@link isValidTimeZoneName} precisely so the two can
 * not be confused or shadow each other.
 */
export function isValidTimeZoneName(value: string): boolean {
  try {
    new Intl.DateTimeFormat("en", { timeZone: value })
    return true
  } catch {
    return false
  }
}

/**
 * `string` that is safe to place in a header value (no control characters at all).
 *
 * The message is pinned with `ctx.mustBe`: a bare second-argument message function is **ignored** by
 * arktype 2.2.3, and arktype's anonymous-predicate default says nothing a user can act on. A
 * `narrow` callback has to call `ctx.mustBe` itself — the context is arktype's internal state, not a
 * plain error factory that can be passed around.
 */
export const headerSafeString: Type<string> = type("string").narrow((value, ctx) =>
  !hasHeaderControlCharacters(value) || ctx.mustBe("contains a control character")
)

/** `string` that is safe as free text: TAB, LF and CR are allowed. */
export const textSafeString: Type<string> = type("string").narrow((value, ctx) =>
  !hasTextControlCharacters(value) || ctx.mustBe("contains a control character")
)

/**
 * The honeypot field: present and an empty string.
 *
 * The `value is ""` predicate is what makes the inferred type `""` rather than `string`, so a
 * caller holding a non-empty honeypot can not assign it to this schema's output.
 */
export const honeypotField: Type<""> = type("string").narrow(
  (value: string, ctx): value is "" => value === "" || ctx.mustBe("must be empty"),
)

/** A time zone name `Intl` accepts. */
export const timeZoneName: Type<string> = type("string").narrow((value, ctx) =>
  isValidTimeZoneName(value) || ctx.mustBe("must be a recognised IANA time zone name")
)

export type HeaderSafeString = typeof headerSafeString.infer
export type TextSafeString = typeof textSafeString.infer
export type HoneypotField = typeof honeypotField.infer
export type TimeZoneName = typeof timeZoneName.infer
