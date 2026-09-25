/**
 * RFC 4180 CSV writer. Plain functions only — no DOM, no Deno, no Preact — so this module runs in
 * a browser tab as well as on the server. Ported from `spy4x/preact-components`'s package-private
 * `ui/csv.ts` (spy4x/preact-components#141, spy4x/ts-libs#175), which stays the reviewed source of
 * this guard until that repo switches its import to here.
 */

/**
 * What a `format` function, or an unformatted field, may hand back for one cell.
 *
 * A `number` or a `bigint` is written unguarded — see {@link csvField} — because neither can hold
 * a separator or a formula body: `String()` of either produces digits, at most one `.`, an
 * `e`/`E` exponent marker, or one of the literal words `Infinity`/`-Infinity`/`NaN`. None of it is
 * formula syntax a spreadsheet acts on by itself, checked in LibreOffice 26.2: `NaN` and
 * `-Infinity` open as text, `-1e+21` opens as a number, and none opens as a formula. A `string` is
 * guarded regardless of what it contains, because a string is exactly the type a
 * spreadsheet-formula payload arrives as.
 */
export type CsvCellValue = string | number | bigint

/**
 * One column of a CSV export: the row field to read, its header text, and how to render a value.
 */
export interface CsvColumn<T> {
  /** Row field this column reads. */
  key: Extract<keyof T, string>
  /** Header cell text. */
  header: string
  /**
   * Cell value for this field. Defaults to the raw value, or `""` for `null`/`undefined`.
   *
   * Returning a `number` or a `bigint` — rather than a string built from one, `` `${amount}` `` —
   * is what keeps a formatted numeric column live in the opened file instead of guarded text; see
   * {@link CsvCellValue}. Anything else this callback hands back — an array, an object, a
   * `boolean` — is not `CsvCellValue` by the type this callback declares, but {@link csvField}
   * still guards and quotes it exactly like a `string`: see its own doc for why that is not a
   * loophole, only a caller's type violation being handled safely instead of trusted blindly.
   *
   * Takes the raw field value as `unknown` rather than `T[K]`: correlating it exactly to `key`
   * needs either a per-column generic (which cannot be threaded through a plain array without an
   * awkward union of single-column types) or a cast inside every `format` — this pushes the one
   * cast to the caller, who already knows what the field holds.
   */
  format?: (value: unknown, row: T) => CsvCellValue
}

/**
 * Leading characters a spreadsheet reads as the start of a formula: the four ASCII characters
 * (`=`, `+`, `-`, `@`) and their full-width Unicode equivalents (`＝`, `＋`, `－`, `＠`) — OWASP's
 * CSV-injection guidance names both the ASCII characters and, separately, the full-width forms
 * (as well as line feed; see {@link CELL_START_GUARD_CHARS}). A bare first-character check on the
 * ASCII set alone misses a full-width form, which OWASP says "may be interpreted as formulas in
 * some locales (e.g., Japanese environments)". LibreOffice 26.2 reads them as text (measured).
 *
 * Known gap: this module does not guard a handful of Unicode characters that resemble a formula
 * character or a space, because they were not found to open a formula in LibreOffice 26.2
 * (measured; LibreOffice reads them as plain text) and Excel's behavior with them is unverified
 * here: zero-width space (U+200B), Mongolian vowel separator (U+180E), next line (U+0085), the
 * small equals sign `﹦` (U+FE66), and the minus sign `−` (U+2212).
 */
const FORMULA_LEAD_CHARS = new Set(["=", "+", "-", "@", "＝", "＋", "－", "＠"])

/**
 * Leading characters guarded only when they open the whole cell, not after an inner separator: the
 * formula-lead characters above, plus a bare leading tab, carriage return or line feed. OWASP's
 * CSV-injection guidance lists a leading tab, carriage return and line feed as dangerous on their
 * own, separately from the formula-lead characters that can also start a formula further into the
 * guidance.
 */
const CELL_START_GUARD_CHARS = new Set([...FORMULA_LEAD_CHARS, "\t", "\r", "\n"])

/**
 * Characters that start a new cell, or a new row, when this file is opened with a separator other
 * than the comma this writer chose.
 *
 * A comma-separated file is exactly what this writer emits, but nothing forces the spreadsheet that
 * opens it to read it that way: Excel's default list separator is a semicolon in most European
 * locales, and a `.csv` opened by double-click is split on whatever that locale setting is, not on
 * a comma. A cell this writer never quotes for its own comma-based rule can still be read as *more
 * than one* cell by a semicolon reader, and a line break — even one this writer wrapped in quotes —
 * can still be read as starting a new row, because a quote-then-newline pairing does not survive
 * every reader's own separator setting unchanged (measured in LibreOffice 26.2: a cell holding a
 * guarded, quoted `\r=1+1` still split into a new, unguarded `=1+1` cell). Guarding only the first
 * character of the cell this writer wrote is not guarding the cell a different reader sees.
 */
const CELL_BOUNDARY_CHARS = new Set([",", ";", "\t", "\r", "\n"])

/**
 * A run of leading Unicode whitespace — a plain space, a tab, a no-break space, or any other
 * character the `\s` character class covers — that a spreadsheet may skip over before deciding
 * whether a cell (or, after a separator, the cell a different reader would split out of it) opens
 * with a formula. Guarding only a formula character sitting in position zero misses `" =1+1"`:
 * measured in LibreOffice 26.2, it runs that cell as a formula when the CSV import option "Trim
 * spaces" is turned on, and reads it as plain text with the default import options. Excel's
 * behavior with a leading space has not been verified here.
 *
 * Matched with a sticky (`y`) regex rather than `slice`-ing the tail of `field` at every boundary,
 * because a tab, carriage return or line feed is both a {@link CELL_BOUNDARY_CHARS} separator and
 * `\s` whitespace: a cell made only of one of those repeated (a real input, not a contrived one —
 * a copy-pasted block of blank lines lands in exactly one CSV cell) is a boundary at every
 * position, and a `slice` from every one of those positions is quadratic in the cell's length. A
 * sticky regex, resumed from `lastIndex`, still visits every character once in total across a
 * whole {@link guardFormulaInjection} call, but each position it starts a match from is scanned
 * once, not once per boundary before it.
 */
const WHITESPACE_RUN = /\s+/y

/**
 * Index of the first non-whitespace character at or after `from`, or `field.length` if none.
 * `cache` remembers the last run this function scanned — `[start, end)` — so a query landing
 * inside that same run of whitespace (guaranteed contiguous, since a run is bounded by its first
 * non-whitespace character on either side) returns `cache.end` without a new scan; see
 * {@link WHITESPACE_RUN}'s own doc for why that reuse is what keeps this linear.
 */
function whitespaceRunEnd(
  field: string,
  from: number,
  cache: { start: number; end: number },
): number {
  if (from >= cache.start && from < cache.end) return cache.end
  WHITESPACE_RUN.lastIndex = from
  const match = WHITESPACE_RUN.exec(field)
  cache.start = from
  cache.end = match ? from + match[0].length : from
  return cache.end
}

/**
 * Prefix `'` in front of every cell, or every reader-visible split of a cell, that opens with a
 * formula character — see {@link FORMULA_LEAD_CHARS}, {@link CELL_START_GUARD_CHARS} and
 * {@link CELL_BOUNDARY_CHARS} for exactly which characters and positions this covers, and
 * {@link WHITESPACE_RUN} for why leading whitespace before that character is skipped, not treated
 * as safe.
 *
 * Every position in the string is checked, not only the first: `x;=1+1` guards the `=` right
 * after the `;`, becoming `x;'=1+1`, so a semicolon-separated read of it never reaches a bare
 * `=1+1`. The guard mark itself is placed before that leading whitespace, not before the formula
 * character it precedes, because a leading `'` only forces the *whole* cell (or split) to read as
 * text when it is the first character a reader sees.
 *
 * The guard has no exception for a value that only looks safe: a `string` cell reading `-5` is
 * guarded exactly like `-2+3+cmd|' /C calc'!A1`, since content alone cannot tell a real negative
 * number from a payload shaped like one — {@link csvField} is what lets a caller skip the guard
 * entirely, by handing back an actual `number` or `bigint` instead of a string. The one visible
 * cost of the string path: LibreOffice (26.2, measured) shows the leading `'` on screen rather
 * than hiding it, so a cell such as `a;-5` — a string whose only fault is a `-` right after a
 * separator — reads as `a;'-5` in the opened file. This repository has not verified whether Excel
 * shows the mark too.
 *
 * Runs in linear time in `field`'s length: the loop itself is a single pass, and
 * {@link whitespaceRunEnd}'s cache keeps the whitespace lookahead from rescanning the same run of
 * characters once per boundary that precedes it — see that function's own doc.
 */
function guardFormulaInjection(field: string): string {
  let guarded = ""
  const whitespaceCache = { start: -1, end: -1 }
  for (let index = 0; index < field.length; index++) {
    const char = field[index]
    const atStart = index === 0
    const afterBoundary = index > 0 && CELL_BOUNDARY_CHARS.has(field[index - 1])
    let opensCell = false
    if (atStart && CELL_START_GUARD_CHARS.has(char)) {
      opensCell = true
    } else if (atStart || afterBoundary) {
      const leadIndex = whitespaceRunEnd(field, index, whitespaceCache)
      const leadChar = field[leadIndex]
      opensCell = leadChar !== undefined && FORMULA_LEAD_CHARS.has(leadChar)
    }
    if (opensCell) guarded += "'"
    guarded += char
  }
  return guarded
}

/** Characters whose presence in a cell forces RFC 4180 quoting. */
const NEEDS_QUOTING = /[",\r\n]/

/**
 * Render one value as an RFC 4180 CSV cell.
 *
 * A `number` or a `bigint` is written with a plain `String()` conversion, unguarded — see
 * {@link CsvCellValue}. Everything else — a `string`, or a value a `format` callback hands back
 * that is neither a `number` nor a `bigint` — is converted with `String()` and guarded against
 * formula injection, then quoted when it holds a comma, a double quote or a line break, doubling
 * every embedded double quote. Guarding an array or an object this way, rather than trusting the
 * `CsvCellValue` type a `format` callback is declared to return, is what stops
 * `["=HYPERLINK(...)", "x"]` from opening as a live formula in one cell and a bare `x` leaking
 * into the next: `Array.prototype.toString` joins it into one comma-bearing string first, and that
 * string goes through the same guard and quoting every other string does.
 *
 * Guarding runs first and quoting is decided on the guarded text, but the two never conflict: the
 * `'` the guard adds is not itself a character quoting cares about, and every character quoting
 * does care about survives the guard step unchanged.
 */
export function csvField(raw: CsvCellValue): string {
  if (typeof raw === "number" || typeof raw === "bigint") return String(raw)
  const guarded = guardFormulaInjection(String(raw))
  return NEEDS_QUOTING.test(guarded) ? `"${guarded.replaceAll('"', '""')}"` : guarded
}

/** One column's rendered value for one row, before CSV escaping. */
function fieldValue<T>(column: CsvColumn<T>, row: T): CsvCellValue {
  const value = (row as Record<string, unknown>)[column.key]
  if (column.format) return column.format(value, row)
  if (value === null || value === undefined) return ""
  if (typeof value === "number" || typeof value === "bigint") return value
  return String(value)
}

/** One data row, rendered and escaped, comma-joined. */
export function csvRow<T>(columns: readonly CsvColumn<T>[], row: T): string {
  return columns.map((column) => csvField(fieldValue(column, row))).join(",")
}

/** The header row, escaped the same way a data row is. */
export function csvHeaderRow<T>(columns: readonly CsvColumn<T>[]): string {
  return columns.map((column) => csvField(column.header)).join(",")
}

/**
 * The line ending this writer emits: `\r\n`, exactly as RFC 4180 §2.1 specifies. Excel reads a
 * bare `\n` too, but a `\r\n` file is unambiguous with every spreadsheet on every platform, which
 * a bare `\n` is not guaranteed to be — RFC 4180 is the one line ending nothing gets to disagree
 * with.
 */
const LINE_ENDING = "\r\n"

/**
 * Render every row as RFC 4180 CSV text: a header row, one line per row of `rows`, each terminated
 * by {@link LINE_ENDING} — including the last line, which the RFC leaves optional but which every
 * row here carries for one uniform rule instead of a special case for the final row.
 *
 * `rows` empty renders the header alone. That is a deliberate default, not an omission: an export
 * of a filtered view that currently matches nothing is still a real, openable file naming its own
 * columns, and a caller who would rather show nothing for zero rows can check its own row count
 * before calling this.
 */
export function toCsvText<T>(columns: readonly CsvColumn<T>[], rows: readonly T[]): string {
  const lines = [csvHeaderRow(columns), ...rows.map((row) => csvRow(columns, row))]
  return lines.map((line) => line + LINE_ENDING).join("")
}

/**
 * UTF-8 byte-order mark. Excel opens a BOM-less CSV with the system codepage, which mangles
 * anything outside it; a leading BOM is what tells Excel — and only Excel needs telling, every
 * other reader treats UTF-8 as its default — to read the file as UTF-8 instead.
 */
export const CSV_BYTE_ORDER_MARK = "\uFEFF"

/** {@link toCsvText}, encoded as UTF-8 bytes with a leading {@link CSV_BYTE_ORDER_MARK}. */
export function toCsvBytes<T>(
  columns: readonly CsvColumn<T>[],
  rows: readonly T[],
): Uint8Array<ArrayBuffer> {
  return new TextEncoder().encode(CSV_BYTE_ORDER_MARK + toCsvText(columns, rows))
}
