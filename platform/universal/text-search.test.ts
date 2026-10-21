import { describe, it } from "@std/testing/bdd"
import { expect } from "@std/expect"

import { matchEntry, searchEntries, type SearchEntry } from "./text.ts"

const entries: SearchEntry[] = [
  { label: "Combobox" },
  { label: "Date picker", aliases: ["calendar"] },
  { label: "Toast", aliases: ["notification"] },
  { label: "ГосУслуги" },
  { label: "Тост" },
]

function labels(query: string): string[] {
  return searchEntries(query, entries).map((match) => match.entry.label)
}

describe("matchEntry", () => {
  it("matches the label exactly, ignoring case and accents", () => {
    expect(matchEntry("COMBOBÖX", { label: "Combobox" })?.how).toBe("exact")
  })

  it("matches the start of the label", () => {
    expect(matchEntry("comb", { label: "Combobox" })?.how).toBe("prefix")
  })

  it("matches words in any order, each a word's start", () => {
    expect(matchEntry("picker date", { label: "Date picker" })?.how).toBe("words")
    expect(matchEntry("pick", { label: "DatePicker" })?.how).toBe("words")
  })

  it("matches an alias", () => {
    expect(matchEntry("calen", { label: "Date picker", aliases: ["calendar"] })?.how).toBe("alias")
  })

  it("forgives one typo of each kind in a word of four letters or more", () => {
    for (const query of ["cmbobox", "combobbox", "combpbox", "combboox"]) {
      expect(matchEntry(query, { label: "Combobox" })?.how).toBe("typo")
    }
  })

  it("forgives no typo in a word shorter than four letters", () => {
    expect(matchEntry("cpm", { label: "Combobox" })).toBeNull()
  })

  it("forgives only one typo per word", () => {
    expect(matchEntry("cmbobx", { label: "Combobox" })).toBeNull()
  })

  it("reads a query typed in the Russian layout as English", () => {
    expect(matchEntry("ещфые", { label: "Toast" })?.how).toBe("layout")
  })

  it("reads a query typed in the English layout as Russian", () => {
    expect(matchEntry("njcn", { label: "Тост" })?.how).toBe("layout")
  })

  it("transliterates Latin to Cyrillic and back", () => {
    expect(matchEntry("GosUslugi", { label: "ГосУслуги" })?.how).toBe("translit")
    expect(matchEntry("ГосУслуги", { label: "GosUslugi" })?.how).toBe("translit")
    expect(matchEntry("tost", { label: "Тост" })?.how).toBe("translit")
  })

  it("matches a Cyrillic query to its English look-alike through one typo", () => {
    expect(matchEntry("тост", { label: "Toast" })?.how).toBe("typo")
  })

  it("matches no Latin entry for a letter with no Latin spelling, typed or from the layout", () => {
    for (const query of ["m", "mmmm", "ь", "]"]) {
      for (const label of ["Toast", "Dialog", "Settings"]) {
        expect(matchEntry(query, { label })).toBeNull()
      }
    }
  })

  it("does not transliterate a query of one or two letters read in the other layout", () => {
    expect(matchEntry("x", { label: "Checkbox" })).toBeNull()
    expect(matchEntry("q", { label: "Invoices" })).toBeNull()
    expect(matchEntry("xt", { label: "Checkbox" })).toBeNull()
    expect(matchEntry("ytw", { label: "Nets" })?.how).toBe("layout")
  })

  it("reads punctuation typed in the English layout as a Russian word", () => {
    expect(matchEntry("[];'", { label: "хъжэ" })?.how).toBe("layout")
    expect(matchEntry("[];'", { label: "Toast" })).toBeNull()
  })

  it("matches every entry on an empty query", () => {
    expect(matchEntry("  ", { label: "Toast" })).toEqual({ how: "prefix", score: 0 })
  })

  it("matches nothing for an unrelated query", () => {
    for (const entry of entries) expect(matchEntry("xylophone", entry)).toBeNull()
  })
})

describe("searchEntries", () => {
  it("finds every example of the issue", () => {
    expect(labels("combobx")[0]).toBe("Combobox")
    expect(labels("picker date")[0]).toBe("Date picker")
    expect(labels("ещфые")[0]).toBe("Toast")
    expect(labels("тост")).toEqual(["Тост", "Toast"])
    expect(labels("GosUslugi")).toEqual(["ГосУслуги"])
  })

  it("ranks exact, prefix, words, alias, layout and translit, then typo", () => {
    // Listed weakest first, so the order of the result comes from the ranking alone.
    const ranked: SearchEntry[] = [
      { label: "Nobe" },
      { label: "тщеу" },
      { label: "Ноте" },
      { label: "Other", aliases: ["note"] },
      { label: "Pinned note" },
      { label: "Notebook" },
      { label: "Note" },
    ]
    const matches = searchEntries("note", ranked)
    expect(matches.map((match) => match.how)).toEqual([
      "exact",
      "prefix",
      "words",
      "alias",
      "layout",
      "translit",
      "typo",
    ])
    expect(matches[4].score).toBe(matches[5].score)
  })

  it("returns every entry in its order on an empty query", () => {
    expect(labels("")).toEqual(entries.map((entry) => entry.label))
  })

  it("keeps the order of entries with equal scores", () => {
    const twins = [{ label: "Alpha one" }, { label: "Alpha two" }]
    expect(searchEntries("alpha", twins).map((match) => match.entry)).toEqual(twins)
  })

  it("sees a label or an alias changed in place", () => {
    const entry = { label: "Toast", aliases: ["notification"] }
    expect(searchEntries("toast", [entry])).toHaveLength(1)
    entry.label = "Dialog"
    expect(searchEntries("toast", [entry])).toEqual([])
    entry.aliases[0] = "popup"
    expect(searchEntries("notif", [entry])).toEqual([])
  })

  it("returns at most limit matches", () => {
    expect(searchEntries("", entries, { limit: 2 })).toHaveLength(2)
  })

  it("refuses a negative limit", () => {
    expect(() => searchEntries("toast", entries, { limit: -1 })).toThrow(RangeError)
  })

  it("returns nothing for an unrelated query", () => {
    expect(searchEntries("xylophone", entries)).toEqual([])
  })
})
