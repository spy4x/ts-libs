/**
 * Small text helpers for UI copy: a list-filter match and a naive English pluraliser.
 *
 * @module
 */

/** Substring/equality match used by list filters. */
export function search(
  value: string | number | null | undefined,
  word: string,
  condition = true,
): boolean {
  if (!condition || value === null || value === undefined || value === "") return false
  if (typeof value === "string") return value.toLowerCase().includes(word.toLowerCase())
  return value === Number(word)
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
