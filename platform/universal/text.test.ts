import { describe, it } from "@std/testing/bdd"
import { expect } from "@std/expect"

import {
  convertToKebabCase,
  filterRows,
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
