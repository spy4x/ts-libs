/**
 * Small, dependency-free text helpers: a list filter (`searchWords`, `search`, `filterRows`), a
 * naive English pluraliser (`pluralize`), a kebab-case converter (`convertToKebabCase`), edit
 * distance and a normalised similarity score (`levenshtein`, `similarity`), a UTF-8
 * byte-length count (`utf8ByteLength`), and a name's initials in any script (`initials`).
 *
 * @module
 */

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
 * A string matches on a case-insensitive substring. A number matches by equality, so
 * `search(12, "12")` is true and `search(120, "12")` is false. Anything else, including `null`,
 * `undefined`, an empty string and an object, matches nothing, so a field a row does not have
 * cannot make every word match. `condition: false` makes the match fail outright.
 */
export function search(value: unknown, word: string, condition = true): boolean {
  if (!condition || value === "") return false
  if (typeof value === "string") return value.toLowerCase().includes(word.toLowerCase())
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
