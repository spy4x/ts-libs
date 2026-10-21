/**
 * Small, dependency-free text helpers: accent and case folding (`fold`), a list filter
 * (`searchWords`, `search`, `filterRows`), a naive English pluraliser (`pluralize`), a
 * kebab-case converter (`convertToKebabCase`), edit distance and a normalised similarity score
 * (`levenshtein`, `similarity`), a forgiving ranked search over labels and aliases that allows
 * any word order, prefixes, one typo, the wrong keyboard layout and Cyrillic or Latin spelling
 * (`searchEntries`, `matchEntry`), a UTF-8 byte-length count (`utf8ByteLength`), a name's
 * initials in any script (`initials`), a check for control and invisible characters in typed
 * text (`hasUnsafeTextCharacters`), and a check for the characters no database text column can
 * store (`hasUnstorableTextCharacters`).
 *
 * @module
 */

/**
 * Combining marks after a Latin, Greek or Cyrillic letter, where they are accents. In Devanagari,
 * Thai and similar scripts the marks are vowel signs and part of the spelling, so they stay.
 */
const ACCENTS = /([\p{Script=Latin}\p{Script=Greek}\p{Script=Cyrillic}])\p{M}+/gu
/** Common letters whose stroke is not a combining mark, so `NFD` leaves them whole. */
const STROKED: Record<string, string> = { "đ": "d", "ł": "l", "ø": "o", "ħ": "h", "ŧ": "t" }
const ASCII = /^[ -~]*$/

/**
 * Fold text for matching: accents removed and lower-cased.
 *
 * `"Đà Nẵng"` and `"da nang"` fold to the same `"da nang"`, and `"ÉCU"` to `"ecu"`. Accents go
 * through `NFD` and lose the marks that follow a Latin, Greek or Cyrillic letter; marks in other
 * scripts are vowel signs and stay, so Hindi `"का"` and `"कि"` still differ. A few common letters
 * whose stroke is part of the letter (`đ`, `ł`, `ø`, `ħ`, `ŧ`) are mapped by hand; rarer ones such
 * as `ǥ` stay as they are. Case folding is `toLowerCase()`, not `toLocaleLowerCase()`, so a match
 * never depends on the host locale. Printable ASCII skips normalisation, so the common case stays
 * cheap. Like `ñ` to `n`, some letters fold into a neighbour: Cyrillic `й` matches `и`. Folding
 * only ever adds matches.
 */
export function fold(value: string): string {
  if (ASCII.test(value)) return value.toLowerCase()
  return value.normalize("NFD").replace(ACCENTS, "$1").normalize("NFC").toLowerCase().replace(
    /[đłøħŧ]/g,
    (letter) => STROKED[letter],
  )
}

/** Maximum number of words a query is split into; the rest are ignored. */
const MAX_SEARCH_WORDS = 16

/**
 * Split a search box's value into words.
 *
 * Runs of whitespace collapse, so `"  north  gate "` is `["north", "gate"]`, and an empty box is an
 * empty list, which {@link filterRows} reads as "no filter". Only the first 16 words count.
 */
export function searchWords(query: string): string[] {
  return query.trim().split(/\s+/).filter(Boolean).slice(0, MAX_SEARCH_WORDS)
}

/**
 * Whether one search word occurs in one value.
 *
 * A string matches on a substring after {@link fold}, so case and accents are ignored: `"cafe"`
 * finds `"Café"`, and `"Đà"` finds `"da"`. A number matches by equality, so
 * `search(12, "12")` is true and `search(120, "12")` is false. Anything else, including `null`,
 * `undefined`, an empty string and an object, matches nothing, so a field a row does not have
 * cannot make every word match. `condition: false` makes the match fail outright.
 */
export function search(value: unknown, word: string, condition = true): boolean {
  if (!condition || value === "") return false
  if (typeof value === "string") return fold(value).includes(fold(word))
  if (typeof value === "number") return value === Number(word)
  return false
}

/**
 * Keep the rows that every word of the query matches.
 *
 * Words are ANDed, so `"north gate"` keeps only the rows that match both. An empty query keeps
 * every row and returns the input array itself, which keeps a signal's identity stable.
 *
 * @example
 * ```ts
 * const visible = filterRows(rows, query, (row, word) => search(row.name, word))
 * ```
 */
export function filterRows<M>(
  rows: M[],
  query: string,
  match: (row: M, word: string) => boolean,
): M[] {
  const words = searchWords(query)
  if (words.length === 0) return rows
  return rows.filter((row) => words.every((word) => match(row, word)))
}

/**
 * Naive English pluraliser for UI copy.
 *
 * Deliberately not an inflection library: it covers the endings that appear in labels
 * (`category` → `categories`, `box` → `boxes`, `hero` → `heroes`). Irregulars such as
 * `child` → `children` are not handled and would need a lookup table.
 */
export function pluralize(word: string): string {
  if (word.endsWith("y") && !/[aeiou]y$/.test(word)) return `${word.slice(0, -1)}ies`
  if (/(s|sh|ch|x|z)$/.test(word)) return `${word}es`
  if (word.endsWith("o")) return `${word}es`
  return `${word}s`
}

/**
 * Convert a free-form identifier to kebab-case.
 *
 * `camelCase`, `snake_case`, `slash/separated` and surrounding punctuation all collapse to
 * single dashes. Runs of whitespace or underscores become one dash; other non-word characters
 * are dropped rather than replaced, so `"A/B"` is `"a-b"` but `"a.b"` is `"ab"`.
 */
export function convertToKebabCase(str: string): string {
  return str
    .replace(/([a-z])([A-Z])/g, "$1-$2")
    .replace(/[\s_]+/g, "-")
    .replace(/\//g, "-")
    .replace(/[^\w-]/g, "")
    .toLowerCase()
}

/** Levenshtein edit distance between two strings, computed over code points. */
export function levenshtein(a: string, b: string): number {
  const left = Array.from(a)
  const right = Array.from(b)
  if (left.length === 0) return right.length
  if (right.length === 0) return left.length

  let previous = new Array<number>(right.length + 1)
  let current = new Array<number>(right.length + 1)
  for (let j = 0; j <= right.length; j++) previous[j] = j

  for (let i = 1; i <= left.length; i++) {
    current[0] = i
    for (let j = 1; j <= right.length; j++) {
      const substitution = previous[j - 1] + (left[i - 1] === right[j - 1] ? 0 : 1)
      current[j] = Math.min(current[j - 1] + 1, previous[j] + 1, substitution)
    }
    const swap = previous
    previous = current
    current = swap
  }
  return previous[right.length]
}

/**
 * Similarity of two strings in `[0, 1]`, derived from {@link levenshtein}.
 *
 * `1` means identical. Two empty strings are identical (`1`); one empty and one non-empty
 * string are maximally dissimilar (`0`).
 */
export function similarity(a: string, b: string): number {
  if (a === b) return 1
  const longest = Math.max(Array.from(a).length, Array.from(b).length)
  if (longest === 0) return 1
  return 1 - levenshtein(a, b) / longest
}

/** UTF-8 byte length, i.e. what a `Content-Length` or a storage quota counts. */
export function utf8ByteLength(value: string): number {
  return new TextEncoder().encode(value).byteLength
}

/**
 * The character classes that are a whole word on their own: ideographs, kana and hangul syllables.
 *
 * Latin names are written with spaces between words, CJK names are not, so the two need different
 * word boundaries. Without this split `"王小明"` is one word and an avatar shows `"王"`, which is
 * one letter of a three-letter name; with it the name has three words and the usual rule gives two
 * of them.
 */
const cjk = "\\p{Script=Han}\\p{Script=Hiragana}\\p{Script=Katakana}\\p{Script=Hangul}"

/**
 * The words of a name: every CJK character alone, every other run of non-space characters whole.
 *
 * A hyphen or an apostrophe is part of the word, so `"Anne-Marie Dupont"` is
 * `["Anne-Marie", "Dupont"]` — two words, `"AD"` — and `"O'Brien"` is one word. Global, but only
 * ever used through `String.prototype.match`, which aims it at the start of the string first, so
 * `lastIndex` left over from an earlier call cannot skip a name.
 */
const wordPattern = new RegExp(`[${cjk}]|[^\\s${cjk}]+`, "gu")

/** One code point that can stand as an initial: a letter or a digit, never punctuation or emoji. */
const letterOrDigit = /^[\p{L}\p{N}]$/u

/**
 * First usable code point of one word, or `""` when the word has none.
 *
 * Iterates code points rather than UTF-16 units, so an astral letter or a single-code-point emoji
 * comes back whole instead of as half a surrogate pair. Leading punctuation is skipped rather than
 * used, and a word of nothing but symbols contributes nothing.
 */
function initialOf(word: string): string {
  for (const character of word) {
    if (letterOrDigit.test(character)) return character
  }

  return ""
}

/**
 * Reduce a name to one or two initials, e.g. for an avatar's fallback face.
 *
 * The rule, exactly:
 *
 * 1. The name is normalised to NFC first. A decomposed Hangul syllable is two or three jamo, and
 *    each jamo is `Script=Hangul`, so without normalisation one syllable counts as two or three
 *    words: the decomposed spelling of `"깁철"` returns its first two jamo rather than its first two
 *    syllables. NFC composes each jamo run in place, leaving the space between words alone. Latin
 *    decomposes the same way — `"E\u0301mile Zola"` is `"EZ"` where the precomposed `"Émile Zola"`
 *    is `"ÉZ"` — but there the base letter is the initial either way, so Hangul is the visible one.
 * 2. A word is a maximal run of non-space characters, except that each CJK character is a word of
 *    its own — `"王小明"` is three words, `"Anne-Marie"` is one.
 * 3. A word's initial is its first code point that is a letter or a digit. Leading punctuation is
 *    skipped (`"-John"` is `"J"`); a word with neither (an emoji, a symbol) contributes nothing.
 * 4. The result is the first initial plus the second when there is one, so a name of three or more
 *    words still yields two characters — `"John Paul Smith"` is `"JP"`, never `"JPS"`.
 * 5. The result is uppercased, so `initials("js")` is `"JS"`. A character that uppercases to more
 *    than one — the German `"ß"` — expands, and the result is then longer than two characters.
 * 6. A name with nothing usable — `""`, `"   "`, `null`, `undefined`, `"!!!"`, `"😀"` — returns
 *    `""`, which a caller reads as "no initials to show".
 *
 * Two tradeoffs worth stating. The CJK rule gives two characters (`"王小明"` → `"王小"`) rather than
 * the surname alone, because that is one rule for every script; a design that wants `"王"` has to
 * say so. And there is deliberately no `Intl.Segmenter`: code-point iteration is already enough for
 * the scripts this rule splits, astral ideographs (Extension B, `"𠀀"`) and single-code-point emoji
 * included, so Segmenter would buy only the whole grapheme of a name that starts with a ZWJ emoji
 * sequence, and it would cost a platform probe for a runtime without it plus a type assertion for
 * the `Intl` typings. Availability is *not* the reason: `deno.jsonc` compiles against
 * `["ES2020", "DOM", "DOM.Iterable", "deno.ns"]`, and `deno.ns` supplies esnext `Intl`, so
 * `new Intl.Segmenter(...)` type-checks clean here — an earlier revision of this comment claimed
 * otherwise and was wrong.
 *
 * @param name Full name, in any script. `null` and `undefined` are treated as empty.
 * @returns One or two upper-case characters, or `""` when the name has no usable initial.
 */
export function initials(name?: string | null): string {
  if (typeof name !== "string") return ""

  const found: string[] = []

  for (const word of name.normalize("NFC").match(wordPattern) ?? []) {
    const initial = initialOf(word)
    if (initial) found.push(initial)
    if (found.length === 2) break
  }

  return found.join("").toUpperCase()
}

/**
 * The characters {@link hasUnsafeTextCharacters} refuses besides tab, line feed and carriage
 * return, as the inside of a character class:
 *
 * - `\u0000-\u0008`, `\u000b`, `\u000c`, `\u000e-\u001f`: the C0 controls, NUL among them, which
 *   Postgres `text` cannot store;
 * - `\u007f-\u009f`: DEL and the C1 controls (NEL, U+0085, is a line break to some readers);
 * - `\u00ad`: the soft hyphen, invisible inside a word;
 * - `\u061c`, `\u200e`, `\u200f`, `\u202a-\u202e`, `\u2066-\u2069`: the bidirectional controls,
 *   which can make text render in another order than it is stored;
 * - `\u2028`, `\u2029`: the line and paragraph separators (one range with the five after them);
 * - `\u200b`, `\u2060`, `\ufeff`: zero-width space, word joiner and the byte-order mark;
 * - `\p{Cs}`: a lone surrogate, which is all a `u`-flag pattern can match there, since a valid
 *   pair is read as one character.
 */
const UNSAFE_IN_ANY_TEXT =
  "\\u0000-\\u0008\\u000b\\u000c\\u000e-\\u001f\\u007f-\\u009f\\u00ad\\u061c\\u200b\\u200e\\u200f" +
  "\\u2028-\\u202e\\u2060\\u2066-\\u2069\\ufeff\\p{Cs}"
const UNSAFE_IN_MULTILINE_TEXT = new RegExp(`[${UNSAFE_IN_ANY_TEXT}]`, "u")
const UNSAFE_IN_SINGLE_LINE_TEXT = new RegExp(`[\\t\\n\\r${UNSAFE_IN_ANY_TEXT}]`, "u")

/** Options of {@link hasUnsafeTextCharacters}. */
export interface UnsafeTextOptions {
  /**
   * Allow tab, line feed and carriage return, for text typed into a multi-line field such as a
   * note body. Default `false`: a name or a title is one line.
   */
  multiline?: boolean
}

/**
 * Whether text a person typed holds one of a fixed list of characters that a display name must
 * not: control characters, which a database may refuse, and the common invisible and
 * text-direction characters.
 *
 * True for a control character (C0 with NUL, tab and the line breaks, DEL, C1), the line and
 * paragraph separators U+2028 and U+2029, a bidirectional control (U+061C, U+200E, U+200F, U+202A
 * to U+202E, U+2066 to U+2069), an invisible character (zero-width space U+200B, word joiner
 * U+2060, U+FEFF, soft hyphen U+00AD) and a lone surrogate. Check a name with it before storing
 * it, and answer a validation error instead of letting the database fail.
 *
 * The zero-width non-joiner and joiner (U+200C, U+200D) are allowed. Persian, Arabic and the Indic
 * scripts need them inside ordinary words, and an emoji family or a profession is several emoji
 * held together by U+200D. Variation selectors and emoji tag characters are allowed for the same
 * reason.
 *
 * The list is closed, so a `false` does not mean that two names cannot look the same. Other
 * characters with no visible glyph pass: the invisible operators U+2061 to U+2064, the Hangul
 * fillers U+115F, U+1160, U+3164 and U+FFA0, the combining grapheme joiner U+034F, the Mongolian
 * vowel separator U+180E, and an emoji tag character or a variation selector placed outside an
 * emoji. Letters of two scripts that look alike (Latin `a`, Cyrillic `а`) pass too. So does every
 * kind of space, the no-break space among them, and a name made only of spaces: trim, collapse and
 * require a visible character separately.
 *
 * It never throws for a string and never repeats the value, so its answer is safe to log.
 *
 * Use it for a one-line name shown in lists and mails. It is too strict for prose, even with
 * `multiline`: pasted text holds soft hyphens and zero-width spaces, and Hebrew or Arabic text
 * holds direction marks. For anything a person writes as prose, use
 * {@link hasUnstorableTextCharacters}.
 *
 * @example
 * ```ts
 * hasUnsafeTextCharacters("Zoë's notes") // false
 * hasUnsafeTextCharacters("work\u0000") // true: NUL
 * hasUnsafeTextCharacters("line one\nline two") // true: a name is one line
 * hasUnsafeTextCharacters("line one\nline two", { multiline: true }) // false
 * ```
 */
export function hasUnsafeTextCharacters(value: string, options?: UnsafeTextOptions): boolean {
  const pattern = options?.multiline ? UNSAFE_IN_MULTILINE_TEXT : UNSAFE_IN_SINGLE_LINE_TEXT
  return pattern.test(value)
}

/**
 * Whether text holds a character that no database text column can store and give back unchanged:
 * NUL (U+0000) or a lone surrogate, which is half of a surrogate pair without its other half.
 *
 * Postgres refuses a NUL in `text` and in `jsonb` with an error. A lone surrogate cannot be written
 * as UTF-8: a `text` column stores U+FFFD in its place without an error, and `jsonb` refuses it.
 * Check a value with it before storing it, and answer a validation error instead of letting the
 * database fail.
 *
 * Everything else passes: tab and the line breaks, every other control character, the soft
 * hyphen, the zero-width characters, the byte-order mark, the direction marks, and an emoji, which
 * is a complete surrogate pair. So a `false` says nothing about how the text looks.
 *
 * Use it for anything a person writes as prose: a note body, a description, a comment, pasted
 * text. For a one-line name shown in lists and mails, use the strict
 * {@link hasUnsafeTextCharacters}, which also refuses invisible and text-direction characters.
 *
 * It never throws for a string and never repeats the value, so its answer is safe to log.
 *
 * @example
 * ```ts
 * hasUnstorableTextCharacters("line one\n\tline two") // false
 * hasUnstorableTextCharacters("soft\u00adhyphen, \u200fשלום") // false
 * hasUnstorableTextCharacters("notes \u{1F4DD}") // false: a whole surrogate pair
 * hasUnstorableTextCharacters("work\u0000") // true: NUL
 * hasUnstorableTextCharacters("half \ud83d") // true: a lone surrogate
 * ```
 */
export function hasUnstorableTextCharacters(value: string): boolean {
  // `isWellFormed`, not `\p{Cs}` in a pattern: Bun's engine misses some lone surrogates there.
  return value.includes("\u0000") || !value.isWellFormed()
}

/** What {@link maskEmail} writes in place of the hidden part of an address, whatever its length. */
const EMAIL_MASK = "***"
/** Longest domain {@link maskEmail} returns: the limit of a DNS name in text form. */
const MAX_MASKED_DOMAIN_LENGTH = 253

/**
 * Longest text {@link maskEmail} returns, in UTF-16 code units: one code point (at most two units),
 * the three stars, `@`, and a domain of at most 253.
 */
export const MAX_MASKED_EMAIL_LENGTH = 259

/**
 * An email address with its local part hidden behind its first character, for showing a person
 * which address they used without spelling it out: `jane.doe@example.com` gives
 * `j***@example.com`. The domain is returned as it was given.
 *
 * - The mask is always three stars, so the result does not tell how long the local part is. A
 *   one-letter local part reads the same way: `j@example.com` gives `j***@example.com`.
 * - The address is split at its last `@`. An empty local part gives `***@example.com`.
 * - A value with no `@`, an empty one, or one that is not a string gives `***`: it is not an
 *   address, so nothing of it is shown.
 * - A domain longer than 253 characters, the limit of a DNS name, gives `***` too. The result is
 *   therefore never longer than {@link MAX_MASKED_EMAIL_LENGTH}, whatever the input's length.
 * - Surrounding white space is dropped first.
 * - Non-ASCII input is kept: the first character is one whole code point, so an emoji or a letter
 *   outside the basic plane is never cut in half (`Ünal@пример.рф` gives `Ü***@пример.рф`). A first
 *   letter written as a base letter plus a combining accent keeps only the base letter.
 *
 * Never returns more of the local part than its first code point, with one exception that follows
 * from the next rule: a local part that is exactly `***` is returned as it is.
 *
 * Masking is stable: `maskEmail(maskEmail(x))` equals `maskEmail(x)` for every `x`. A local part
 * that is exactly `***` is read as already masked, so `***@example.com` stays as it is.
 *
 * With `{ domain: true }` the domain is masked too, for a record that must not tell which
 * organisation an address belongs to: see {@link MaskEmailOptions.domain}.
 */
export function maskEmail(email: string, options?: MaskEmailOptions): string {
  if (typeof email !== "string") return EMAIL_MASK
  const text = email.trim()
  const at = text.lastIndexOf("@")
  if (at < 0) return EMAIL_MASK
  if (text.length - at - 1 > MAX_MASKED_DOMAIN_LENGTH) return EMAIL_MASK
  const local = maskLabel(text.slice(0, at))
  if (options?.domain !== true) return `${local}${text.slice(at)}`
  return `${local}@${maskDomain(text.slice(at + 1))}`
}

/** Options of {@link maskEmail}. */
export interface MaskEmailOptions {
  /**
   * Mask the domain as well: its first label keeps only its first character, and only its last
   * label is kept whole, so `jane@example.com` gives `j***@e***.com`.
   *
   * - Every label between the first and the last is dropped: `a@mail.example.co.uk` gives
   *   `a***@m***.uk`. Telling `co.uk` apart from `example.com` needs a list of public suffixes,
   *   which this function does not carry, so it keeps the one label that is always public.
   * - A domain with one label keeps only its first character: `a@localhost` gives `a***@l***`.
   * - A last label longer than 63 characters, the limit of a DNS label, is not a real ending, so
   *   the whole domain becomes `***`. The result therefore stays within
   *   {@link MAX_MASKED_EMAIL_LENGTH}.
   * - An empty domain stays empty, and masking stays stable: `j***@e***.com` is returned as it is.
   *
   * Off by default: the default result keeps the domain exactly as it was given.
   */
  domain?: boolean
}

/** Longest last label {@link maskEmail} keeps when it masks a domain: the limit of a DNS label. */
const MAX_KEPT_DOMAIN_LABEL_LENGTH = 63

/** The first code point of `label` and the mask; `***` alone when `label` is empty or `***`. */
function maskLabel(label: string): string {
  const first = label === EMAIL_MASK ? undefined : label.codePointAt(0)
  return `${first === undefined ? "" : String.fromCodePoint(first)}${EMAIL_MASK}`
}

/** A domain with its first label masked by {@link maskLabel} and only its last label kept. */
function maskDomain(domain: string): string {
  if (domain === "") return ""
  const firstDot = domain.indexOf(".")
  if (firstDot < 0) return maskLabel(domain)
  const ending = domain.slice(domain.lastIndexOf(".") + 1)
  if (ending.length > MAX_KEPT_DOMAIN_LABEL_LENGTH) return EMAIL_MASK
  return `${maskLabel(domain.slice(0, firstDot))}.${ending}`
}

/** Something {@link searchEntries} can find: a label and, optionally, other names for it. */
export interface SearchEntry {
  /** The name a person sees, such as `"Date picker"`. */
  label: string
  /** Other names that should find the entry, such as `["calendar", "календарь"]`. */
  aliases?: readonly string[]
}

/**
 * How a query matched an entry, from the strongest to the weakest:
 *
 * - `exact`: the label, ignoring case, accents, spaces and punctuation.
 * - `prefix`: the start of the label.
 * - `words`: every query word starts a word of the label, in any order.
 * - `alias`: one of the aliases, by any of the three above.
 * - `layout`: the query was typed in the other keyboard layout (ЙЦУКЕН and QWERTY).
 * - `translit`: the query and the entry are in different scripts (Cyrillic and Latin).
 * - `typo`: a query word needed one typo fixed.
 */
export type SearchMatchKind =
  | "exact"
  | "prefix"
  | "words"
  | "alias"
  | "layout"
  | "translit"
  | "typo"

/** How well a query matched one entry. */
export interface EntryMatch {
  /** The weakest step the match needed (see {@link SearchMatchKind}). */
  how: SearchMatchKind
  /** Higher is better. Compare scores only between matches of the same query. */
  score: number
}

/** One result of {@link searchEntries}. */
export interface SearchMatch<E extends SearchEntry> extends EntryMatch {
  entry: E
}

/** Options for {@link searchEntries}. */
export interface SearchEntriesOptions {
  /** Return at most this many matches, the best first. Default: all of them. */
  limit?: number
}

const KIND_SCORE: Record<SearchMatchKind, number> = {
  exact: 70,
  prefix: 60,
  words: 50,
  alias: 40,
  layout: 30,
  translit: 30,
  typo: 10,
}
/** Bonus inside a tier for the shape of the match, so an exact alias beats a word-start one. */
const SHAPE_BONUS = { exact: 3, prefix: 2, words: 1, typo: 0 } as const
type Shape = keyof typeof SHAPE_BONUS

/** Keys of the same physical keyboard position, QWERTY then ЙЦУКЕН. */
const LATIN_KEYS = "qwertyuiop[]asdfghjkl;'zxcvbnm,.`"
const CYRILLIC_KEYS = "йцукенгшщзхъфывапролджэячсмитьбюё"
let layoutSwap: Map<string, string> | undefined

/** The text a person meant when they typed `value` in the other keyboard layout. */
function swapLayout(value: string): string {
  if (!layoutSwap) {
    layoutSwap = new Map()
    for (let i = 0; i < LATIN_KEYS.length; i++) {
      layoutSwap.set(LATIN_KEYS[i], CYRILLIC_KEYS[i])
      layoutSwap.set(CYRILLIC_KEYS[i], LATIN_KEYS[i])
    }
  }
  let swapped = ""
  for (const char of value.toLowerCase()) swapped += layoutSwap.get(char) ?? char
  return swapped
}

/** Cyrillic letters that {@link fold} leaves (`й` and `ё` fold to `и` and `е`) and their Latin spelling. */
const CYRILLIC_LETTERS = "абвгґдеєжзиіклмнопрстуфхцчшщъыьэюя"
const LATIN_SPELLINGS =
  "a b v g g d e e zh z i i k l m n o p r s t u f h ts ch sh shch _ y _ e yu ya"
    .replaceAll("_", "").split(" ")
const CYRILLIC_LETTER = /[а-яґєі]/g

/** A query or a name, folded and split into words. */
interface Prepared {
  words: string[]
  /** The words joined with nothing between them. */
  compact: string
}

const NON_WORD = /[^\p{L}\p{N}]+/u

function prepare(folded: string, maxWords = Infinity): Prepared {
  const words = folded.split(NON_WORD).filter(Boolean).slice(0, maxWords)
  return { words, compact: words.join("") }
}

/** The same words in Latin letters, or `undefined` when there was nothing to transliterate. */
function latinOf(prepared: Prepared): Prepared | undefined {
  if (!/[а-яґєі]/.test(prepared.compact)) return undefined
  const words = prepared.words.map((word) =>
    word.replace(CYRILLIC_LETTER, (letter) => LATIN_SPELLINGS[CYRILLIC_LETTERS.indexOf(letter)])
  )
  return { words, compact: words.join("") }
}

/** A name ready to match: `"DatePicker"` gives the words `date`, `picker` and `datepicker`. */
function prepareName(name: string): Prepared {
  const prepared = prepare(fold(name.replace(/(\p{Ll})(\p{Lu})/gu, "$1 $2")))
  if (prepared.words.length > 1) prepared.words.push(prepared.compact)
  return prepared
}

/** Whether `query` from index `q` on is a prefix of `word` from index `w` on. */
function restMatches(query: string, q: number, word: string, w: number): boolean {
  for (; q < query.length; q++, w++) if (query[q] !== word[w]) return false
  return true
}

/** Whether `query` is one edit (insert, delete, substitute, transpose) from a prefix of `word`. */
function nearPrefix(query: string, word: string): boolean {
  let i = 0
  while (i < query.length && query[i] === word[i]) i++
  return i === query.length ||
    restMatches(query, i + 1, word, i + 1) || // a wrong letter
    restMatches(query, i + 1, word, i) || // a letter too many
    restMatches(query, i, word, i + 1) || // a letter missing
    (query[i] === word[i + 1] && query[i + 1] === word[i] && restMatches(query, i + 2, word, i + 2))
}

/** The strongest shape in which `query` matches `name`, or `undefined`. */
function shapeOf(query: Prepared, name: Prepared): Shape | undefined {
  if (query.compact === name.compact) return "exact"
  if (name.compact.startsWith(query.compact)) return "prefix"
  let shape: Shape = "words"
  for (const word of query.words) {
    if (startsSome(name.words, word)) continue
    if (word.length < 4 || !nearSome(name.words, word)) return undefined
    shape = "typo"
  }
  return shape
}

function startsSome(words: string[], query: string): boolean {
  for (const word of words) if (word.startsWith(query)) return true
  return false
}

function nearSome(words: string[], query: string): boolean {
  for (const word of words) if (nearPrefix(query, word)) return true
  return false
}

/** A query or a name, with its Latin spelling when it has Cyrillic letters. */
interface Spelling {
  plain: Prepared
  latin: Prepared | undefined
}

function spell(prepared: Prepared): Spelling {
  return { plain: prepared, latin: latinOf(prepared) }
}

/** The query as typed, then as meant in the other keyboard layout when that differs. */
function querySpellings(query: string): Spelling[] {
  const typed = prepare(fold(query), MAX_SEARCH_WORDS)
  const swapped = prepare(fold(swapLayout(query)), MAX_SEARCH_WORDS)
  return swapped.compact === typed.compact ? [spell(typed)] : [spell(typed), spell(swapped)]
}

/** Each entry's names, prepared once and reused while its label and aliases stay the same. */
const nameCache = new WeakMap<
  SearchEntry,
  { label: string; aliases: string[]; spellings: Spelling[] }
>()

function nameSpellings(entry: SearchEntry): Spelling[] {
  const aliases = entry.aliases ?? []
  const cached = nameCache.get(entry)
  if (
    cached?.label === entry.label && cached.aliases.length === aliases.length &&
    cached.aliases.every((alias, i) => alias === aliases[i])
  ) return cached.spellings
  const spellings = [entry.label, ...aliases].map((name) => spell(prepareName(name)))
  nameCache.set(entry, { label: entry.label, aliases: [...aliases], spellings })
  return spellings
}

/** The weakest of the steps a match needed. */
function weakest(a: SearchMatchKind, b: SearchMatchKind): SearchMatchKind {
  return KIND_SCORE[b] < KIND_SCORE[a] ? b : a
}

function bestMatch(queries: Spelling[], entry: SearchEntry): EntryMatch | null {
  let best: EntryMatch | null = null
  const names = nameSpellings(entry)
  for (let n = 0; n < names.length; n++) {
    const name = names[n]
    for (let q = 0; q < queries.length; q++) {
      const query = queries[q]
      // Transliterate only across scripts: two Cyrillic spellings already met as typed.
      const across = !name.latin !== !query.latin
      for (let t = 0; t < (across ? 2 : 1); t++) {
        const shape = t === 0
          ? shapeOf(query.plain, name.plain)
          : shapeOf(query.latin ?? query.plain, name.latin ?? name.plain)
        if (!shape) continue
        let how: SearchMatchKind = shape
        if (n > 0) how = weakest(how, "alias")
        if (q > 0) how = weakest(how, "layout")
        if (t > 0) how = weakest(how, "translit")
        const score = KIND_SCORE[how] + (how === shape ? 0 : SHAPE_BONUS[shape])
        if (!best || score > best.score) best = { how, score }
      }
    }
  }
  return best
}

/**
 * How well `query` matches one entry, or `null` when it does not.
 *
 * The match forgives what people get wrong in a search box. Case and accents are ignored
 * ({@link fold}). Words count in any order, and each query word only has to start a word of the
 * label or of an alias, so `"picker date"` finds `"Date picker"`; a name written as `"DatePicker"`
 * has the words `date` and `picker`. A query word of four letters or more may carry one typo (a
 * letter added, missing, wrong or two swapped): `"combobx"` finds `"Combobox"`. A query typed in
 * the other keyboard layout is read in both directions, so `"ещфые"` finds `"Toast"` and `"njcn"`
 * finds `"Тост"`. Cyrillic and Latin are compared through a Latin transliteration, so
 * `"GosUslugi"` finds `"ГосУслуги"`, and `"тост"` finds `"Toast"` through `"tost"` and one typo.
 *
 * An empty query matches every entry with score `0` and `how: "prefix"`.
 */
export function matchEntry(query: string, entry: SearchEntry): EntryMatch | null {
  const queries = querySpellings(query)
  if (queries[0].plain.words.length === 0) return { how: "prefix", score: 0 }
  return bestMatch(queries, entry)
}

/**
 * The entries that `query` matches, the best first (see {@link matchEntry} for what matches).
 *
 * The order is exact, then prefix, then words in any order, then alias, then the other layout or
 * script, then a typo; equal scores keep the order of `entries`. An empty query returns every
 * entry in its order. Only the first 16 query words count. Each entry's label and aliases are
 * prepared once and reused while they stay the same, so a list of a few hundred entries can be
 * ranked on every keystroke.
 *
 * @example
 * ```ts
 * const commands = [{ label: "Toast" }, { label: "Date picker", aliases: ["calendar"] }]
 * searchEntries("picker date", commands)[0].entry.label // "Date picker"
 * searchEntries("ещфые", commands)[0].how // "layout"
 * ```
 */
export function searchEntries<E extends SearchEntry>(
  query: string,
  entries: readonly E[],
  options?: SearchEntriesOptions,
): SearchMatch<E>[] {
  const queries = querySpellings(query)
  const matches: SearchMatch<E>[] = []
  if (queries[0].plain.words.length === 0) {
    for (const entry of entries) matches.push({ entry, how: "prefix", score: 0 })
  } else {
    for (const entry of entries) {
      const match = bestMatch(queries, entry)
      if (match) matches.push({ entry, ...match })
    }
    matches.sort((a, b) => b.score - a.score)
  }
  return options?.limit === undefined ? matches : matches.slice(0, options.limit)
}
