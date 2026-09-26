import { expect } from "@std/expect"
import { describe, it } from "@std/testing/bdd"
import {
  parseSort,
  removeSortRule,
  serializeSort,
  type SortDirection,
  sortRows,
  type SortRule,
  toggleSort,
} from "./sort.ts"

interface Row {
  name: string
  views: number
  likes: number
}

const rows: Row[] = [
  { name: "B", views: 10, likes: 3 },
  { name: "A", views: 10, likes: 7 },
  { name: "C", views: 20, likes: 1 },
]

describe("toggleSort", () => {
  it("appends a new column as the least significant rule", () => {
    const rules = toggleSort(toggleSort<"views" | "likes">([], "views"), "likes")
    expect(rules).toEqual([
      { key: "views", direction: "asc" },
      { key: "likes", direction: "asc" },
    ])
  })

  it("cycles a column asc, desc, off", () => {
    let rules: SortRule<"views" | "likes">[] = toggleSort([], "views")
    expect(rules[0].direction).toBe("asc")
    rules = toggleSort(rules, "views")
    expect(rules[0].direction).toBe("desc")
    rules = toggleSort(rules, "views")
    expect(rules).toEqual([])
  })

  it("leaves other priorities where they were", () => {
    const rules = toggleSort<"views" | "likes">([
      { key: "views", direction: "asc" },
      { key: "likes", direction: "asc" },
    ], "views")
    expect(rules).toEqual([
      { key: "views", direction: "desc" },
      { key: "likes", direction: "asc" },
    ])
  })

  it("does not mutate the rules it was given", () => {
    const before: SortRule<"views">[] = [{ key: "views", direction: "asc" }]
    toggleSort(before, "views")
    expect(before).toEqual([{ key: "views", direction: "asc" }])
  })
})

describe("removeSortRule", () => {
  it("removes only the requested priority", () => {
    expect(
      removeSortRule<"views" | "likes" | "name">([
        { key: "views", direction: "asc" },
        { key: "likes", direction: "desc" },
        { key: "name", direction: "asc" },
      ], "likes"),
    ).toEqual([
      { key: "views", direction: "asc" },
      { key: "name", direction: "asc" },
    ])
  })
})

describe("sortRows", () => {
  it("keeps the input order when there are no rules", () => {
    expect(sortRows(rows, []).map((row) => row.name)).toEqual(["B", "A", "C"])
  })

  it("applies every rule in priority order", () => {
    expect(
      sortRows(rows, [
        { key: "views", direction: "asc" },
        { key: "likes", direction: "desc" },
      ] as SortRule<keyof Row & string>[]).map((row) => row.name),
    ).toEqual(["A", "B", "C"])
  })

  it("reverses a descending rule", () => {
    expect(
      sortRows(rows, [{ key: "views", direction: "desc" } as SortRule<keyof Row & string>])
        .map((row) => row.name),
    ).toEqual(["C", "B", "A"])
  })

  it("compares strings case-insensitively and numerically", () => {
    const items = [{ name: "item 10" }, { name: "Item 2" }, { name: "item 1" }]
    expect(
      sortRows(items, [
        { key: "name", direction: "asc" } as SortRule<keyof typeof items[0] & string>,
      ])
        .map((item) => item.name),
    ).toEqual(["item 1", "Item 2", "item 10"])

    // Case has to be the only difference for the two readings to diverge: the fixture above is
    // ordered by its numbers whether case counts or not. Ignoring case makes these two equal, so
    // they keep the order they arrived in; counting it would put `alpha` ahead of `Alpha`.
    const cased = [{ name: "Alpha" }, { name: "alpha" }]
    const rule = [{ key: "name", direction: "asc" } as SortRule<"name">]
    expect(sortRows(cased, rule).map((item) => item.name)).toEqual(["Alpha", "alpha"])
    expect(sortRows([...cased].reverse(), rule).map((item) => item.name))
      .toEqual(["alpha", "Alpha"])
  })

  it("is stable for rows that tie", () => {
    const tied: Row[] = [
      { name: "first", views: 1, likes: 0 },
      { name: "second", views: 1, likes: 0 },
      { name: "third", views: 1, likes: 0 },
    ]
    expect(sortRows(tied, [{ key: "views", direction: "asc" }]).map((row) => row.name))
      .toEqual(["first", "second", "third"])
  })

  it("does not reorder the input array", () => {
    const input = [...rows]
    sortRows(input, [{ key: "views", direction: "asc" } as SortRule<keyof Row & string>])
    expect(input.map((row) => row.name)).toEqual(["B", "A", "C"])
  })
})

describe("sortRows with empty cells", () => {
  interface Score {
    name: string
    score: number | undefined
  }

  const scores: Score[] = [
    { name: "three", score: 3 },
    { name: "none", score: undefined },
    { name: "one", score: 1 },
    { name: "two", score: 2 },
  ]

  it("orders the rows that have a value when one row has none", () => {
    expect(sortRows(scores, [{ key: "score", direction: "asc" }]).map((row) => row.name))
      .toEqual(["one", "two", "three", "none"])
  })

  it("keeps a row with no value last when the column is reversed", () => {
    expect(sortRows(scores, [{ key: "score", direction: "desc" }]).map((row) => row.name))
      .toEqual(["three", "two", "one", "none"])
  })

  it("puts a null and a NaN where it puts a missing value", () => {
    const mixed: { name: string; score: number | null }[] = [
      { name: "nan", score: Number.NaN },
      { name: "two", score: 2 },
      { name: "null", score: null },
      { name: "one", score: 1 },
    ]
    expect(sortRows(mixed, [{ key: "score", direction: "asc" }]).map((row) => row.name))
      .toEqual(["one", "two", "nan", "null"])
  })

  it("reads an empty string as an empty cell rather than as the first word", () => {
    const labels: { label: string }[] = [{ label: "beta" }, { label: "" }, { label: "alpha" }]
    expect(sortRows(labels, [{ key: "label", direction: "asc" }]).map((row) => row.label))
      .toEqual(["alpha", "beta", ""])
    expect(sortRows(labels, [{ key: "label", direction: "desc" }]).map((row) => row.label))
      .toEqual(["beta", "alpha", ""])
  })

  it("lets the next rule decide between two empty cells", () => {
    const pairs: Score[] = [
      { name: "second", score: undefined },
      { name: "first", score: 1 },
      { name: "first", score: undefined },
    ]
    expect(
      sortRows(pairs, [
        { key: "score", direction: "asc" },
        { key: "name", direction: "asc" },
      ]).map((row) => row.name),
    ).toEqual(["first", "first", "second"])
  })

  it("keeps two empty cells in their input order when no rule separates them", () => {
    const blanks: Score[] = [
      { name: "second", score: undefined },
      { name: "first", score: undefined },
    ]
    expect(sortRows(blanks, [{ key: "score", direction: "asc" }]).map((row) => row.name))
      .toEqual(["second", "first"])
  })

  it("still orders a column that mixes a number with a word", () => {
    const cells: { cell: number | string }[] = [{ cell: 2 }, { cell: "apple" }, { cell: 1 }]
    expect(sortRows(cells, [{ key: "cell", direction: "asc" }]).map((row) => row.cell))
      .toEqual([1, 2, "apple"])
  })

  it("sorts a NaN with the empty cells and not with the numbers", () => {
    // Words chosen to sort after the string `NaN` prints as: a NaN read as a number would lead the
    // column, and a NaN read as text would lead it too. Empty puts it last, which is the decision.
    const cells: { cell: number | string }[] = [
      { cell: "orange" },
      { cell: Number.NaN },
      { cell: "zebra" },
    ]
    expect(sortRows(cells, [{ key: "cell", direction: "asc" }]).map((row) => row.cell))
      .toEqual(["orange", "zebra", Number.NaN])
    expect(sortRows(cells, [{ key: "cell", direction: "desc" }]).map((row) => row.cell))
      .toEqual(["zebra", "orange", Number.NaN])
  })
})

/** One column of loose cells, sorted: the shape every ordering test below reads. */
function sortColumn(cells: unknown[], direction: SortDirection = "asc"): unknown[] {
  return sortRows(cells.map((cell) => ({ cell })), [{ key: "cell", direction }])
    .map((row) => row.cell)
}

/** Every ordering of `values`, so a test can ask what the sort does with each of them. */
function permutations<T>(values: T[]): T[][] {
  if (values.length <= 1) return [values]
  return values.flatMap((value, index) =>
    permutations([...values.slice(0, index), ...values.slice(index + 1)])
      .map((rest) => [value, ...rest])
  )
}

/** A cell as a failure message names it, since a table of cells is a table of anything. */
function label(value: unknown): string {
  if (typeof value === "string") return JSON.stringify(value)
  if (typeof value === "bigint") return `${value}n`
  if (value instanceof Date) return `Date(${value.getTime()})`
  return String(value)
}

describe("sortRows is a consistent order", () => {
  /**
   * One cell of every kind the comparator can be shown, including the three the first version of
   * this comparator ordered cyclically: `5` beat `"1e3"` numerically, `"1e3"` beat `"2"` as text,
   * and `"2"` beat `5` numerically.
   */
  const probes: unknown[] = [
    5,
    "1e3",
    "2",
    0,
    -1,
    "apple",
    "Apple",
    true,
    false,
    10n,
    new Date(0),
    new Date("not a date"),
    null,
    undefined,
    "",
    Number.NaN,
  ]

  it("puts one cell before another for the same reason whichever pair it is shown", () => {
    // Transitivity, which is the property `Array.prototype.sort` needs and the only one a handful of
    // examples cannot establish: `a` at or before `b` and `b` at or before `c` has to mean `a` at or
    // before `c`, for every three cells. A comparator that contradicts itself on one triple leaves
    // the sort free to return anything, which is what the pair-by-pair version did.
    const atOrBefore = probes.map((left) =>
      probes.map((right) => Object.is(sortColumn([left, right])[0], left))
    )
    const contradictions: string[] = []

    for (let a = 0; a < probes.length; a++) {
      for (let b = 0; b < probes.length; b++) {
        for (let c = 0; c < probes.length; c++) {
          if (atOrBefore[a][b] && atOrBefore[b][c] && !atOrBefore[a][c]) {
            contradictions.push(
              `${label(probes[a])} ≤ ${label(probes[b])} ≤ ${label(probes[c])}, ` +
                `but ${label(probes[c])} < ${label(probes[a])}`,
            )
          }
        }
      }
    }

    expect(contradictions, contradictions.slice(0, 5).join(" | ")).toEqual([])
  })

  it("sorts a mixed column the same way whatever order the rows arrive in", () => {
    // The consequence a reader sees: the same six cells, entered in any of their 720 orders, come
    // out as one table. The first version produced three different tables from these cells alone.
    const cells = [5, "1e3", "2", "apple", true, undefined]
    const results = new Set(
      permutations(cells).map((order) => sortColumn(order).map(label).join(" ")),
    )

    expect(results.size, [...results].slice(0, 3).join(" / ")).toBe(1)
    expect([...results][0]).toBe(`true 5 "1e3" "2" "apple" undefined`)
  })

  it("puts every numeric cell before every textual one", () => {
    expect(sortColumn([5, "1e3", "2"])).toEqual([5, "1e3", "2"])
    expect(sortColumn(["apple", 2, true])).toEqual([true, 2, "apple"])
  })

  it("orders booleans as off then on, among the numbers", () => {
    expect(sortColumn([true, false, true])).toEqual([false, true, true])
    // The pair that separates the two readings: as numbers the booleans lead, as the words they
    // print they would follow `"alpha"`. A fixture of booleans alone sorts the same either way.
    expect(sortColumn(["alpha", true, false])).toEqual([false, true, "alpha"])
  })

  it("orders bigints by their value, among the numbers", () => {
    expect(sortColumn([3n, 21n, 100n])).toEqual([3n, 21n, 100n])
    // Same trap: `[3n, 21n, 100n]` comes out in that order whether it is read as three numbers or
    // as three digit strings under numeric collation. Against a number, the two readings differ —
    // `1n` sorts below `5` as a number, and behind it as the text `"1"` would.
    expect(sortColumn([5, 1n])).toEqual([1n, 5])
  })

  it("orders dates by their time, among the numbers", () => {
    const early = new Date("2025-06-01T00:00:00Z")
    const late = new Date("2026-01-02T00:00:00Z")
    expect(sortColumn([late, early])).toEqual([early, late])
    // And the pair that separates the readings, without depending on what a date prints: read as
    // a time it is a number and leads, read as text it follows `"apple"`.
    expect(sortColumn(["apple", new Date(0)])).toEqual([new Date(0), "apple"])
  })

  it("sorts a date that carries no time under what it prints", () => {
    // `new Date("nope")` is a date object with a NaN time: not a number to sort by, and not empty
    // either — it is a cell holding something, so it sorts with the text as `Invalid Date`.
    const invalid = new Date("nope")
    expect(sortColumn([invalid, 5, "apple"])).toEqual([5, "apple", invalid])
  })
})

describe("parseSort", () => {
  const allowed = ["name", "views", "likes"] as const
  const fallback: SortRule<typeof allowed[number]>[] = [{ key: "views", direction: "desc" }]

  it("reads a well-formed value", () => {
    expect(parseSort("views:asc,likes:desc", allowed, fallback)).toEqual([
      { key: "views", direction: "asc" },
      { key: "likes", direction: "desc" },
    ])
  })

  it("rejects unknown keys, duplicates and invalid directions", () => {
    expect(parseSort("likes:asc,nope:desc,likes:desc,name:up", allowed, fallback)).toEqual([
      { key: "likes", direction: "asc" },
    ])
  })

  it("falls back when nothing survives", () => {
    expect(parseSort("bad:value", allowed, fallback)).toEqual(fallback)
  })

  it("reads an absent value as 'not in the URL yet'", () => {
    expect(parseSort(null, allowed, fallback)).toEqual(fallback)
    expect(parseSort("", allowed, fallback)).toEqual(fallback)
  })

  it("reads the literal 'none' as sorting switched off", () => {
    expect(parseSort("none", allowed, fallback)).toEqual([])
  })

  it("ignores a direction with no key", () => {
    expect(parseSort(":asc", allowed, fallback)).toEqual(fallback)
  })
})

describe("serializeSort", () => {
  it("writes rules in priority order", () => {
    expect(serializeSort([
      { key: "views", direction: "asc" },
      { key: "likes", direction: "desc" },
    ])).toBe("views:asc,likes:desc")
  })

  it("writes 'none' for no rules, never an empty string", () => {
    expect(serializeSort([])).toBe("none")
  })

  it("round-trips through parseSort", () => {
    const rules: SortRule<"views" | "likes">[] = [
      { key: "views", direction: "asc" },
      { key: "likes", direction: "desc" },
    ]
    expect(parseSort(serializeSort(rules), ["views", "likes"], [])).toEqual(rules)
  })

  it("round-trips the switched-off state", () => {
    expect(parseSort(serializeSort([]), ["views"], [{ key: "views", direction: "desc" }]))
      .toEqual([])
  })
})
