import { describe, it } from "@std/testing/bdd"
import { expect } from "@std/expect"

import { createIndex, loadIndex, type SearchEntry, type TextPart } from "./mod.ts"

const gosuslugi = { label: "ГосУслуги", detail: "Портал госуслуг", href: "/gosuslugi" }
const darkTheme = { label: "Тёмная тема", aliases: ["dark mode", "night theme"], href: "/theme" }
const entries: SearchEntry[] = [
  { label: "Combobox", href: "/combobox" },
  gosuslugi,
  darkTheme,
  { label: "Passport renewal", text: "Bring your old passport and a photo.", href: "/passport" },
]
const index = createIndex(entries)

/** The labels of the hits for `query`, best first. */
function labels(query: string): string[] {
  return index.search(query).hits.map((hit) => hit.entry.label)
}

/** Only the marked words of `parts`. */
function marked(parts: TextPart[] | undefined): string[] {
  return (parts ?? []).filter((part) => part.match).map((part) => part.text)
}

describe("search finds the cases of the issue's spike", () => {
  const cases: [query: string, label: string, correction?: string][] = [
    ["gosuslugi", "ГосУслуги"],
    ["госуслуги", "ГосУслуги"],
    ["gosuslugy", "ГосУслуги"],
    ["Gosuslugi", "ГосУслуги"],
    ["госуслу", "ГосУслуги"],
    ["ujcecke", "ГосУслуги", "layout"],
    ["темная", "Тёмная тема"],
    ["dark", "Тёмная тема"],
  ]
  for (const [query, label, correction] of cases) {
    it(`"${query}" finds ${label}${correction ? ` through the ${correction} pass` : ""}`, () => {
      const results = index.search(query)
      expect(results.hits.map((hit) => hit.entry.label)).toEqual([label])
      expect(results.correction).toBe(correction)
    })
  }
})

describe("search passes", () => {
  it("every word of the query must match, each as a word prefix", () => {
    const rooms = createIndex([{ label: "Dark theme" }, { label: "Dark room" }, { label: "Room" }])
    expect(rooms.search("dar roo").hits.map((hit) => hit.entry.label)).toEqual(["Dark room"])
  })

  it("a query that matches as typed runs neither the layout nor the typo pass", () => {
    const words = createIndex([{ label: "Dork" }, { label: "Dark" }, { label: "вфкл" }])
    const results = words.search("dark")
    expect(results.hits.map((hit) => hit.entry.label)).toEqual(["Dark"])
    expect(results.correction).toBeUndefined()
  })

  it("layout pass runs before typo pass", () => {
    // "ujceckeub" is ГосУслуги typed on QWERTY keys, and one edit away from "ujceckeuz".
    const words = createIndex([{ label: "ujceckeuz" }, gosuslugi])
    const results = words.search("ujceckeub")
    expect(results.hits.map((hit) => hit.entry.label)).toEqual(["ГосУслуги"])
    expect(results.correction).toBe("layout")
  })

  it("typo pass allows one edit in words of four letters or more", () => {
    expect(index.search("pasport").correction).toBe("typo")
    expect(labels("pasport")).toEqual(["Passport renewal"])
    expect(labels("pasprt")).toEqual([])
  })

  it("typo pass keeps words of three letters exact", () => {
    const pets = createIndex([{ label: "Cat" }, { label: "Cart" }])
    expect(pets.search("cot").hits).toEqual([])
    expect(pets.search("crt").hits).toEqual([])
  })

  it("an empty query or one without letters finds nothing", () => {
    expect(index.search("").hits).toEqual([])
    expect(index.search(" ,. ").hits).toEqual([])
  })
})

describe("search ranking", () => {
  it("weighs aliases and label over keywords over detail over text", () => {
    const fields = createIndex([
      { label: "Text", text: "beacon one two" },
      { label: "Detail", detail: "beacon one two" },
      { label: "Keywords", keywords: ["beacon", "one", "two"] },
      { label: "Alias", aliases: ["beacon one two"] },
      { label: "beacon one two" },
    ])
    const order = fields.search("beacon").hits.map((hit) => hit.entry.label)
    expect(order.slice(0, 2).sort()).toEqual(["Alias", "beacon one two"])
    expect(order.slice(2)).toEqual(["Keywords", "Detail", "Text"])
  })

  it("equal scores keep the order the entries were passed in", () => {
    const twins = [{ label: "Settings", href: "/a" }, { label: "Settings", href: "/b" }]
    expect(createIndex(twins).search("set").hits.map((hit) => hit.entry.href)).toEqual(["/a", "/b"])
    expect(createIndex(twins.toReversed()).search("set").hits.map((hit) => hit.entry.href))
      .toEqual(["/b", "/a"])
  })

  it("limit returns only the best hits", () => {
    const many = createIndex([{ label: "Note one" }, { label: "Note" }, { label: "Note two" }])
    expect(many.search("note", { limit: 1 }).hits.map((hit) => hit.entry.label)).toEqual(["Note"])
  })

  it("returns the entry the caller passed, with its group, href and id", () => {
    const entry = { label: "Billing", group: "Settings", href: "/billing", id: "billing" }
    expect(createIndex([entry]).search("bill").hits[0].entry).toBe(entry)
  })
})

describe("search marks what matched", () => {
  it("returns the first alias that matched", () => {
    expect(index.search("night").hits[0].alias).toBe("night theme")
    expect(index.search("mode").hits[0].alias).toBe("dark mode")
  })

  it("returns no alias when only the label matched", () => {
    expect(index.search("тема").hits[0].alias).toBeUndefined()
  })

  it("labelParts marks exactly the matched Latin words", () => {
    const labelled = createIndex([{ label: "Dark theme, settings" }])
    expect(labelled.search("sett dar").hits[0].labelParts).toEqual([
      { text: "Dark", match: true },
      { text: " theme, ", match: false },
      { text: "settings", match: true },
    ])
  })

  it("labelParts marks exactly the matched Cyrillic words, typed in Latin too", () => {
    const labelled = createIndex([{ label: "Тёмная тема оформления" }])
    expect(labelled.search("oformlen temnaya").hits[0].labelParts).toEqual([
      { text: "Тёмная", match: true },
      { text: " тема ", match: false },
      { text: "оформления", match: true },
    ])
  })

  it("detailParts marks exactly the matched words, Latin and Cyrillic", () => {
    const detailed = createIndex([{ label: "Help", detail: "Портал госуслуг and passports" }])
    expect(marked(detailed.search("gosuslug pass").hits[0].detailParts))
      .toEqual(["госуслуг", "passports"])
    expect(createIndex([{ label: "Help" }]).search("help").hits[0].detailParts).toEqual([])
  })

  it("the snippet is about 90 characters around the first body hit, cut at spaces", () => {
    const filler = "lorem ipsum dolor sit amet ".repeat(8)
    const body = `${filler}Renew your passport at the office.\n\n${filler}Another passport here.`
    const hit = createIndex([{ label: "Help", text: body }]).search("passport").hits[0]
    const snippet = hit.snippet!.map((part) => part.text).join("")
    expect(marked(hit.snippet)).toEqual(["passport"])
    expect(snippet).toMatch(/^…(\w+ )+Renew your passport at the office\. lorem( \w+)+…$/)
    expect(snippet.length).toBeLessThanOrEqual(92)
    expect(snippet.length).toBeGreaterThan(70)
  })

  it("the snippet marks Cyrillic words and keeps a short body whole", () => {
    const hit = createIndex([{ label: "Help", text: "Войдите на Госуслуги с паролем." }])
      .search("gosuslugi").hits[0]
    expect(hit.snippet).toEqual([
      { text: "Войдите на ", match: false },
      { text: "Госуслуги", match: true },
      { text: " с паролем.", match: false },
    ])
  })

  it("has no snippet when the body did not match", () => {
    expect(index.search("renewal").hits[0].snippet).toBeUndefined()
  })
})

describe("a serialised index", () => {
  it("loads from its JSON text and answers like the index it came from", () => {
    const loaded = loadIndex(JSON.stringify(index))
    for (const query of ["gosuslugy", "ujcecke", "pasport", "dark"]) {
      expect(loaded.search(query)).toEqual(index.search(query))
    }
  })

  it("loads from the parsed object", () => {
    const loaded = loadIndex(JSON.parse(JSON.stringify(index)))
    expect(loaded.search("dark").hits[0].entry).toEqual(darkTheme)
  })

  it("refuses data that is not a serialised index", () => {
    expect(() => loadIndex("{}")).toThrow("Not a serialised search index")
    expect(() => loadIndex("null")).toThrow("Not a serialised search index")
  })
})

describe("createIndex", () => {
  it("refuses an entry without a label", () => {
    expect(() => createIndex([{ label: "Ok" }, {} as SearchEntry])).toThrow("entry 1 has no label")
  })
})

/** A seeded generator, so every run indexes and queries the same words. */
function random(seed: number): () => number {
  return () => (seed = (seed * 1103515245 + 12345) >>> 0) / 2 ** 32
}

/**
 * The 95th-percentile time of the queries, the best of five rounds, so one busy moment on a
 * loaded CI machine does not fail the test while a slow engine still does.
 */
function p95(count: number): number {
  const next = random(count)
  const syllables = "ka lo mi ser ta von dra pel ni gu ros te bal fi mun zo kre ast ul ve".split(
    " ",
  )
  const vocabulary = Array.from(
    { length: 3000 },
    () =>
      Array.from(
        { length: 2 + Math.floor(next() * 3) },
        () => syllables[Math.floor(next() * syllables.length)],
      ).join(""),
  )
  const word = () => vocabulary[Math.floor(next() * vocabulary.length)]
  const words = (n: number) => Array.from({ length: n }, word).join(" ")
  const built = createIndex(Array.from({ length: count }, (_, i) => ({
    label: words(3),
    aliases: [words(2)],
    keywords: [word(), word()],
    detail: words(8),
    text: words(150),
    href: `/page/${i}`,
  })))
  // Prefixes, two words, typos and whole words, as a person types them.
  const queries = Array.from({ length: 200 }, (_, i) => {
    const typed = word()
    return [typed.slice(0, 3), `${typed} ${word().slice(0, 4)}`, `${typed.slice(0, -1)}q`, typed][
      i % 4
    ]
  })
  let best = Infinity
  for (let round = 0; round < 5; round++) {
    const times = queries.map((query) => {
      const start = performance.now()
      built.search(query, { limit: 20 })
      return performance.now() - start
    }).sort((a, b) => a - b)
    best = Math.min(best, times[Math.floor(times.length * 0.95)])
  }
  return best
}

describe("search speed, 150-word bodies, 20 hits drawn", () => {
  it("300 entries answer at the 95th percentile in under 5 ms", () => {
    expect(p95(300)).toBeLessThan(5)
  })

  it("2,000 entries answer at the 95th percentile in under 25 ms", () => {
    expect(p95(2000)).toBeLessThan(25)
  })
})
