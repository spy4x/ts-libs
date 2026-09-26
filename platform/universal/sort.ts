/**
 * Multi-column sort rules for a table: toggle them, write them to a URL parameter, read them back,
 * and sort rows by them.
 *
 * Plain data and no framework, so the page that writes `?sort=name:asc,size:desc` and the API that
 * reads it share one parser, and a server-rendered table sorts exactly the way the client one does.
 *
 * @module
 */

/** Sort direction of one rule. */
export type SortDirection = "asc" | "desc"

/** One column in the sort order. The first rule is the primary sort. */
export interface SortRule<K extends string = string> {
  key: K
  direction: SortDirection
}

/**
 * Advance one column through `asc` → `desc` → `off`.
 *
 * A column not yet sorted is appended as the least significant rule, so the priorities a user has
 * already built up are preserved.
 */
export function toggleSort<K extends string>(rules: SortRule<K>[], key: K): SortRule<K>[] {
  const index = rules.findIndex((rule) => rule.key === key)
  if (index === -1) return [...rules, { key, direction: "asc" }]

  const current = rules[index]
  if (current.direction === "asc") {
    return rules.map((rule, ruleIndex) =>
      ruleIndex === index ? { ...rule, direction: "desc" } : rule
    )
  }
  return rules.filter((_, ruleIndex) => ruleIndex !== index)
}

/** Removes one sort priority while preserving all remaining priorities. */
export function removeSortRule<K extends string>(rules: SortRule<K>[], key: K): SortRule<K>[] {
  return rules.filter((rule) => rule.key !== key)
}

/**
 * Whether a cell holds nothing a reader would call a value.
 *
 * `null`, `undefined`, the empty string and `NaN` are the four ways a column ends up with a blank
 * cell, and a table shows all four the same way. `0` and `false` are values and are not empty.
 */
function isEmptyCell(value: unknown): boolean {
  return value === null || value === undefined || value === "" ||
    (typeof value === "number" && Number.isNaN(value))
}

/** Compare two strings the way a column of text sorts: case-insensitive, `"item 2"` before `"item 10"`. */
function compareText(left: string, right: string): number {
  return left.localeCompare(right, "en", { numeric: true, sensitivity: "base" })
}

/** Order two numbers without subtracting them: `Infinity - Infinity` is `NaN`, `Infinity > 1` is not. */
function compareNumbers(left: number, right: number): number {
  if (left < right) return -1
  return left > right ? 1 : 0
}

/**
 * The number a cell sorts by, or `null` when the cell is not one of the kinds that sort numerically.
 *
 * The four kinds are the ones with a numeric meaning a reader would recognise in a column: a number,
 * a boolean, a `bigint`, and a `Date` by its time. A date that carries no time is not a date to sort
 * by, so it falls through to the text group and sorts under what it prints. A `bigint` past
 * `Number.MAX_SAFE_INTEGER` loses precision here and can tie with its neighbour, which the next sort
 * rule — and failing that the stable input order — then decides.
 *
 * `NaN` cannot reach this function: {@link isEmptyCell} has already taken it.
 */
function numericValue(value: unknown): number | null {
  if (typeof value === "number") return value
  if (typeof value === "boolean") return value ? 1 : 0
  if (typeof value === "bigint") return Number(value)
  if (value instanceof Date) {
    const time = value.getTime()
    return Number.isNaN(time) ? null : time
  }
  return null
}

/**
 * Compare two non-empty cells, by kind first and then within the kind.
 *
 * **Every numeric cell sorts before every other cell**, and each group is ordered within itself:
 * numbers numerically, everything else as the text it prints. The kind decides first *because* the
 * comparison has to be the same whichever pair it is shown. Choosing the method per pair is what the
 * first version of this did, and three cells were enough to break it: `5` beats `"1e3"`
 * numerically, `"1e3"` beats `"2"` as text, and `"2"` beats `5` numerically, so the three sort into
 * three different orders depending on the order they arrive in. A comparator that contradicts itself
 * like that leaves `Array.prototype.sort` free to return anything at all.
 */
function compareCells(left: unknown, right: unknown): number {
  const leftNumber = numericValue(left)
  const rightNumber = numericValue(right)
  if (leftNumber !== null && rightNumber !== null) return compareNumbers(leftNumber, rightNumber)
  if (leftNumber !== null) return -1
  if (rightNumber !== null) return 1
  return compareText(String(left), String(right))
}

/**
 * Sort rows by every rule in order.
 *
 * A cell is read as one of three kinds, and the kind decides before anything else does: **an empty
 * cell sorts last, a numeric cell sorts before a textual one**, and two cells of one kind compare
 * within it — numbers numerically, text with `localeCompare` at numeric granularity (`"item 2"`
 * before `"item 10"`). Rows that tie on every rule keep their input order, so the sort is stable and
 * a re-render never shuffles equal rows.
 *
 * **Empty is `null`, `undefined`, `""` and `NaN`, and it sorts last in both directions**, because
 * that is where a reader looks for the rows a column says nothing about, whichever way the column is
 * pointing. Two empty cells tie, so the next rule decides. Comparing them arithmetically is what
 * produced `NaN` from `Number(undefined)`, and a comparator that returns `NaN` leaves the array in
 * its input order: one blank cell used to stop the whole column sorting.
 *
 * Ordering by kind first is what makes the comparison independent of the pair it is looking at, and
 * a sort needs that: see {@link compareCells} for the three cells that broke the version which chose
 * its method per pair.
 */
export function sortRows<T, K extends Extract<keyof T, string>>(
  rows: T[],
  rules: SortRule<K>[],
): T[] {
  return rows.map((row, index) => ({ row, index })).sort((a, b) => {
    for (const rule of rules) {
      const left = a.row[rule.key]
      const right = b.row[rule.key]
      const leftEmpty = isEmptyCell(left)
      const rightEmpty = isEmptyCell(right)
      // Returned before the direction is applied: empty last means last either way.
      if (leftEmpty !== rightEmpty) return leftEmpty ? 1 : -1
      if (leftEmpty) continue
      const result = compareCells(left, right)
      if (result !== 0) return rule.direction === "asc" ? result : -result
    }
    return a.index - b.index
  }).map(({ row }) => row)
}

/**
 * Read sort rules out of a URL parameter.
 *
 * Accepts `"key:dir,key:dir"`. Unknown keys, repeated keys and invalid directions are dropped
 * rather than rejected, so an old bookmark degrades to the rules it can still honour. `"none"`
 * means the user turned sorting off and stays off; an empty value means "not in the URL yet" and
 * yields `fallback`.
 */
export function parseSort<K extends string>(
  value: string | null,
  allowed: readonly K[],
  fallback: SortRule<K>[],
): SortRule<K>[] {
  if (value === "none") return []
  if (!value) return fallback
  const allowedSet = new Set<string>(allowed)
  const seen = new Set<string>()
  const rules: SortRule<K>[] = []
  for (const part of value.split(",")) {
    const [key, direction] = part.split(":")
    if (!allowedSet.has(key) || seen.has(key) || !["asc", "desc"].includes(direction)) continue
    seen.add(key)
    rules.push({ key: key as K, direction: direction as SortDirection })
  }
  return rules.length > 0 ? rules : fallback
}

/** Write sort rules into a URL parameter. No rules serializes to `"none"`, not to `""`. */
export function serializeSort<K extends string>(rules: SortRule<K>[]): string {
  return rules.length === 0
    ? "none"
    : rules.map((rule) => `${rule.key}:${rule.direction}`).join(",")
}
