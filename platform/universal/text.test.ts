import { describe, it } from "@std/testing/bdd"
import { expect } from "@std/expect"

import {
  convertToKebabCase,
  filterRows,
  initials,
  levenshtein,
  pluralize,
  search,
  searchWords,
  similarity,
  utf8ByteLength,
} from "./text.ts"

describe("searchWords", () => {
  it("splits on whitespace and drops the empties", () => {
    expect(searchWords("  north   gate ")).toEqual(["north", "gate"])
  })

  it("reads an empty box as no filter", () => {
    expect(searchWords("   ")).toEqual([])
  })

  it("keeps only the first 16 words", () => {
    const words = Array.from({ length: 20 }, (_, i) => `w${i}`)
    expect(searchWords(words.join(" "))).toEqual(words.slice(0, 16))
  })
})

describe("search", () => {
  it("matches a substring case-insensitively", () => {
    expect(search("Hello World", "wor")).toBe(true)
    expect(search("Hello World", "xyz")).toBe(false)
  })

  it("matches a number by exact numeric equality, not by substring", () => {
    expect(search(42, "42")).toBe(true)
    expect(search(442, "42")).toBe(false)
  })

  it("returns false for null, undefined, empty string and a false condition", () => {
    expect(search(null, "a")).toBe(false)
    expect(search(undefined, "a")).toBe(false)
    expect(search("", "a")).toBe(false)
    expect(search("", "")).toBe(false)
    expect(search("a", "", false)).toBe(false)
  })

  it("treats zero as a matcher, not as an absent value", () => {
    expect(search(0, "0")).toBe(true)
  })

  it("matches nothing for a value that is neither a string nor a number", () => {
    expect(search({ id: 1 }, "1")).toBe(false)
    expect(search(true, "1")).toBe(false)
    expect(search(1n, "1")).toBe(false)
  })
})

describe("filterRows", () => {
  const rows = [{ name: "North Gate" }, { name: "South Gate" }, { name: "River" }]
  const match = (row: { name: string }, word: string) => search(row.name, word)

  it("returns the input array itself for an empty query", () => {
    expect(filterRows(rows, "  ", match)).toBe(rows)
  })

  it("keeps the rows every word matches", () => {
    expect(filterRows(rows, "north gate", match).map((row) => row.name)).toEqual(["North Gate"])
  })

  it("drops the rows a later word excludes", () => {
    expect(filterRows(rows, "gate river", match)).toEqual([])
  })
})

describe("pluralize", () => {
  it("appends s to a regular noun", () => {
    expect(pluralize("cat")).toBe("cats")
  })

  it("turns a consonant-y ending into ies", () => {
    expect(pluralize("category")).toBe("categories")
    // A vowel before the y keeps the y: "key" is not "kies".
    expect(pluralize("key")).toBe("keys")
  })

  it("appends es after a sibilant", () => {
    expect(pluralize("box")).toBe("boxes")
    expect(pluralize("dish")).toBe("dishes")
    expect(pluralize("class")).toBe("classes")
  })

  it("appends es after a trailing o", () => {
    expect(pluralize("hero")).toBe("heroes")
  })
})

describe("convertToKebabCase", () => {
  it("splits camelCase and PascalCase", () => {
    expect(convertToKebabCase("getUserName")).toBe("get-user-name")
    expect(convertToKebabCase("UserName")).toBe("user-name")
  })

  it("collapses whitespace, underscores and slashes to single dashes", () => {
    expect(convertToKebabCase("Hello   World")).toBe("hello-world")
    expect(convertToKebabCase("a_b__c")).toBe("a-b-c")
    expect(convertToKebabCase("a/b/c")).toBe("a-b-c")
  })

  it("drops characters that are neither word characters nor dashes", () => {
    expect(convertToKebabCase("a.b!c")).toBe("abc")
  })
})

describe("levenshtein", () => {
  it("returns 0 for identical strings", () => {
    expect(levenshtein("kitten", "kitten")).toBe(0)
  })

  it("counts substitutions, insertions and deletions", () => {
    expect(levenshtein("kitten", "sitting")).toBe(3)
    expect(levenshtein("flaw", "lawn")).toBe(2)
  })

  it("returns the other string's length when one side is empty", () => {
    expect(levenshtein("", "abc")).toBe(3)
    expect(levenshtein("abc", "")).toBe(3)
    expect(levenshtein("", "")).toBe(0)
  })

  it("counts code points, so an astral character is one edit", () => {
    expect(levenshtein("a", "😀")).toBe(1)
    expect(levenshtein("😀😀", "😀")).toBe(1)
  })

  it("is symmetric", () => {
    expect(levenshtein("abc", "xyzzy")).toBe(levenshtein("xyzzy", "abc"))
  })
})

describe("similarity", () => {
  it("returns 1 for identical strings and for two empty strings", () => {
    expect(similarity("abc", "abc")).toBe(1)
    expect(similarity("", "")).toBe(1)
  })

  it("returns 0 when exactly one side is empty", () => {
    expect(similarity("abc", "")).toBe(0)
    expect(similarity("", "abc")).toBe(0)
  })

  it("normalises distance by the longer string", () => {
    expect(similarity("kitten", "sitting")).toBeCloseTo(1 - 3 / 7, 10)
  })
})

describe("utf8ByteLength", () => {
  it("counts one byte per ASCII character", () => {
    expect(utf8ByteLength("hello")).toBe(5)
    expect(utf8ByteLength("")).toBe(0)
  })

  it("counts two bytes for a two-byte character", () => {
    expect(utf8ByteLength("é")).toBe(2)
    expect(utf8ByteLength("héllo")).toBe(6)
  })

  it("counts four bytes for an astral character that a .length would call two", () => {
    expect("😀".length).toBe(2)
    expect(utf8ByteLength("😀")).toBe(4)
  })
})

/**
 * A decomposed Hangul name — `"깁 철수"` written as jamo, one syllable per two or three code points.
 *
 * Built from explicit escapes with no literal jamo in the source, so no editor, formatter or
 * file-encoding round-trip can quietly normalise the input and make {@link initials} look correct
 * for the wrong reason. Every syllable is an LVT run of three jamo — `깁` is U+1100 U+1175 U+11B8,
 * `철` is U+110E U+1165 U+11AF, `수` is U+1109 U+116E — so the name is 9 code points (8 jamo and a
 * space) against 4 precomposed, and NFC composes each run in place without touching the space.
 * `NFC_FOLDED_INITIALS` is the two composed syllables the correct answer is made of.
 */
const NFD_JAMO_NAME = "\u1100\u1175\u11B8 \u110E\u1165\u11AF\u1109\u116E"
const NFC_JAMO_NAME = "\uAE41 \uCCA0\uC218"
const NFC_FOLDED_INITIALS = "\uAE41\uCCA0"

/** `"E"` + U+0301 COMBINING ACUTE ACCENT + `"mile Zola"` — decomposed Latin, never precomposed. */
const NFD_ACCENT_NAME = "E\u0301mile Zola"

/** The same name precomposed: U+00C9 LATIN CAPITAL LETTER E WITH ACUTE + `"mile Zola"`. */
const NFC_ACCENT_NAME = "\u00C9mile Zola"

describe("initials", () => {
  it("takes the first letter of the first two words", () => {
    expect(initials("John Smith")).toBe("JS")
  })

  it("stops at two letters for a three-word name", () => {
    expect(initials("John Paul Smith")).toBe("JP")
  })

  it("takes the first letter of a single-word name", () => {
    expect(initials("Cher")).toBe("C")
  })

  it("ignores leading, trailing and repeated whitespace", () => {
    expect(initials("  John   Smith  ")).toBe("JS")
    expect(initials("\tJohn\nSmith ")).toBe("JS")
  })

  it("keeps a hyphenated word as one word", () => {
    expect(initials("Anne-Marie Dupont")).toBe("AD")
    expect(initials("Mary-Jane")).toBe("M")
  })

  it("keeps an apostrophe inside the word", () => {
    expect(initials("O'Brien")).toBe("O")
    expect(initials("D'Angelo Smith")).toBe("DS")
  })

  it("uppercases a lower-case name", () => {
    expect(initials("john smith")).toBe("JS")
  })

  it("takes one code point, not one UTF-16 unit, of a combined Latin name", () => {
    expect(initials("Émile Zola")).toBe("ÉZ")
  })

  it("reads a decomposed accent as the letter, not as an accent after it", () => {
    expect(initials(NFD_ACCENT_NAME)).toBe("ÉZ")
    expect(initials(NFD_ACCENT_NAME)).toBe(initials(NFC_ACCENT_NAME))
  })

  it("composes every decomposed letter of a name, not just the first", () => {
    expect(initials("A\u030Angela O\u0308ztu\u0308rk")).toBe("\u00C5\u00D6")
    expect(initials("A\u030Angela O\u0308ztu\u0308rk")).toBe(
      initials("\u00C5ngela \u00D6zt\u00FCrk"),
    )
  })

  it("takes a digit as an initial", () => {
    expect(initials("7 of 9")).toBe("7O")
  })
})

describe("initials for CJK names", () => {
  it("treats every CJK character as its own word", () => {
    // The bug this guards: with a space-only word split, "王小明" is one word and the avatar shows
    // "王" — one letter of a three-letter name.
    expect(initials("王小明")).toBe("王小")
    expect(initials("欧阳修文")).toBe("欧阳")
  })

  it("returns two characters, not the whole name", () => {
    expect(initials("王小明").length).toBe(2)
    expect(initials("王小明")).not.toBe("王小明")
  })

  it("returns the single character of a one-character name", () => {
    expect(initials("李")).toBe("李")
  })

  it("reads a spaced CJK name as the same two characters", () => {
    expect(initials("李 明")).toBe("李明")
  })

  it("handles kana and hangul as well as ideographs", () => {
    expect(initials("山田太郎")).toBe("山田")
    expect(initials("김철수")).toBe("김철")
  })

  it("mixes scripts by the same rule", () => {
    // Two Han words fill both initials, so the Latin word after them is not reached; one Han word
    // is followed by the Latin one.
    expect(initials("李明 John")).toBe("李明")
    expect(initials("李 John")).toBe("李J")
  })
})

describe("initials with decomposed Unicode", () => {
  it("normalises the name before splitting it into words", () => {
    expect(NFD_JAMO_NAME.normalize("NFC")).toBe(NFC_JAMO_NAME)
  })

  it("keeps the decomposed jamo in the fixture, so the input is really NFD", () => {
    // 9 code points (3 + 3 + 2 jamo and a space) against 4 composed. A source encoding that quietly
    // normalised the literal, or a jamo dropped from a syllable, would leave the input partly
    // composed and make the next tests pass for the wrong reason, so both are pinned here first.
    expect([...NFD_JAMO_NAME].length).toBe(9)
    expect([...NFC_JAMO_NAME].length).toBe(4)
    expect(NFD_JAMO_NAME).not.toBe(NFC_JAMO_NAME)
    expect([...NFD_JAMO_NAME].every((c) => !/[\uAC00-\uD7A3]/.test(c))).toBe(true)
    expect([...NFD_JAMO_NAME].some((c) => /[\u1100-\u11FF]/.test(c))).toBe(true)
  })

  it("counts a decomposed syllable as one word, not as two or three", () => {
    // The bug: each jamo is Script=Hangul, so without normalisation every jamo is its own word and
    // the answer is the first jamo pair — U+1100 U+1175 — rather than the first two syllables.
    expect(initials(NFD_JAMO_NAME)).toBe(NFC_FOLDED_INITIALS)
    expect(initials(NFD_JAMO_NAME)).not.toBe("\u1100\u1175")
  })

  it("reads a decomposed syllable the same as the precomposed one", () => {
    expect(initials(NFD_JAMO_NAME)).toBe(initials(NFC_JAMO_NAME))
    expect([...initials(NFD_JAMO_NAME)].length).toBe(2)
    expect([...initials("\u1100\u1175\u11B8")].length).toBe(1)
    expect(initials("\u1100\u1175\u11B8")).toBe(NFC_FOLDED_INITIALS.slice(0, 1))
    expect(initials("\u110E\u1165\u11AF\u1109\u116E")).toBe("\uCCA0\uC218")
  })

  it("reads a mixed NFC/NFD name as its composed form", () => {
    // U+AE41 (NFC) first, then the same syllable written as decomposed jamo: two words either way,
    // and both characters in the result are Hangul Syllables rather than jamo.
    const mixed = initials("\uAE41 \u1100\u1175\u11B8")

    expect(mixed).toBe(`${NFC_FOLDED_INITIALS.slice(0, 1)}${NFC_FOLDED_INITIALS.slice(0, 1)}`)
    expect(mixed).toBe(initials(initials(NFD_JAMO_NAME).slice(0, 1) + " \u1100\u1175\u11B8"))
    expect(/^[\uAC00-\uD7A3]{2}$/.test(mixed)).toBe(true)
    // A decomposed Latin word beside a decomposed Hangul one: two words, one initial each.
    expect(initials("\u1100\u1175\u11B8 E\u0301mile")).toBe(
      `${NFC_FOLDED_INITIALS.slice(0, 1)}\u00C9`,
    )
  })

  it("keeps a Hangul syllable whole rather than half of a jamo pair", () => {
    expect([...initials(NFD_JAMO_NAME)[0]].length).toBe(1)
    expect(initials(NFD_JAMO_NAME)).not.toContain("\u1100")
    expect(initials("\u1100\u1175\u11B8 \u11AF")).toBe("\uAE41\u11AF")
  })
})

describe("initials with nothing usable", () => {
  it("returns an empty string for an empty name", () => {
    expect(initials("")).toBe("")
  })

  it("returns an empty string for a whitespace-only name", () => {
    expect(initials("   ")).toBe("")
    expect(initials("\n\t")).toBe("")
  })

  it("returns an empty string for null and undefined", () => {
    expect(initials(null)).toBe("")
    expect(initials(undefined)).toBe("")
    expect(initials()).toBe("")
  })

  it("returns an empty string for a name of punctuation only", () => {
    expect(initials("!!!")).toBe("")
    expect(initials("--")).toBe("")
  })

  it("returns an empty string for an emoji-only name", () => {
    expect(initials("😀")).toBe("")
    expect(initials("👩💻")).toBe("")
  })

  it("skips an emoji word rather than half of it", () => {
    expect(initials("Ada 😀 Lovelace")).toBe("AL")
    expect(initials("😀 Ada")).toBe("A")
  })

  it("skips leading punctuation instead of using it", () => {
    expect(initials("-John Smith")).toBe("JS")
    expect(initials("(Ada) Lovelace")).toBe("AL")
  })
})
