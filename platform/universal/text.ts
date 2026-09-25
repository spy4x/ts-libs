/**
 * Small, dependency-free text helpers: a list filter (`searchWords`, `search`, `filterRows`), a
 * naive English pluraliser
 * (`pluralize`), a kebab-case converter (`convertToKebabCase`), edit distance and a normalised
 * similarity score (`levenshtein`, `similarity`), and a UTF-8 byte-length count (`utf8ByteLength`).
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
