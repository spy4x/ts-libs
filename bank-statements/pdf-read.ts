/**
 * The PDF path without pdf.js itself: lines from a document's text items, and statement rows from
 * lines. `pdf.ts` binds it to unpdf, so the tests can hand in a fake document and see the options.
 *
 * @module
 */

import { type } from "arktype"
import { parseAmount } from "@spy4x/platform/universal/money"
import { err, ok, type Result } from "@spy4x/platform/universal/result"
import { parseDateWithPattern } from "@spy4x/time/date"
import {
  type PdfToken,
  readRow,
  type StatementPdfLayout,
  type StatementProfile,
  statementProfile,
} from "./profile.ts"
import {
  checkRowCount,
  DEFAULT_MAX_BYTES,
  DEFAULT_MAX_ROWS,
  type ParsedStatement,
  quote,
  type RowError,
  type StatementLimits,
  type StatementRow,
} from "./statement.ts"

/** A word on a PDF line. */
export interface PdfWord {
  text: string
  /** Its left edge, in PDF points from the left of the page. */
  x: number
  width: number
}

/** The words of one PDF line, left to right. */
export interface PdfLine {
  /**
   * The 1-based number of the line in the whole document, top to bottom and page after page. A
   * row read from it, and a row error or a balance failure, carries this number as its `line`.
   */
  line: number
  /** The 1-based page it is on. */
  page: number
  /** Its baseline, in PDF points from the bottom of the page. */
  y: number
  words: PdfWord[]
  /** The words joined by single spaces. */
  text: string
}

/** One page's lines, top to bottom. */
export interface PdfPage {
  page: number
  lines: PdfLine[]
}

/** Limits for {@link extractPdfLines}, each on by default. */
export interface ExtractPdfLinesOptions {
  /**
   * Most bytes the file may have, and most characters of text it may hold. Default
   * {@link DEFAULT_MAX_BYTES}, 10 MiB.
   */
  maxBytes?: number
  /** Most pages, checked before any page is read. Default {@link DEFAULT_MAX_PAGES}, 50. */
  maxPages?: number
  /** Most lines in the whole document. Default {@link DEFAULT_MAX_ROWS}, 100,000. */
  maxLines?: number
}

/** Why {@link extractPdfLines} refused a file. */
export type PdfRefusalCode =
  /** Over `maxBytes`, `maxPages` or `maxLines`. */
  | "too-large"
  /** Protected by a password. */
  | "encrypted"
  /** No page has any text: a scan. */
  | "no-text-layer"
  /** Not a PDF pdf.js can open. */
  | "malformed"

/** A refused file, with a message a person can act on. */
export interface PdfRefusal {
  code: PdfRefusalCode
  message: string
}

/** The default `maxPages`. */
export const DEFAULT_MAX_PAGES = 50

/** What a `"no-text-layer"` refusal says. */
export const NO_TEXT_LAYER_MESSAGE =
  "This PDF is a scanned image. Download a CSV or a text PDF from your bank."

/** How far apart two baselines may be, in PDF points, and still be one line. */
const BASELINE_TOLERANCE = 2

/** The options every pdf.js load gets. pdf.js runs no code from the file, and nothing renders. */
export const PDFJS_OPTIONS: Readonly<PdfLoadOptions> = Object.freeze({
  // Closes the path behind CVE-2024-4367 in builds that still have it. The bundled 6.x build
  // has no eval path left, so this guards a build swapped in through `definePDFJSModule`.
  isEvalSupported: false,
  // Text only: no font loading and no system fonts read.
  disableFontFace: true,
  useSystemFonts: false,
  // Errors only: a stranger's file must not fill the server's log with pdf.js warnings.
  verbosity: 0,
})

/** What {@link PDFJS_OPTIONS} sets. */
export interface PdfLoadOptions {
  isEvalSupported: false
  disableFontFace: true
  useSystemFonts: false
  verbosity: 0
}

/** The part of a pdf.js text item this package reads. */
interface PdfTextItem {
  str?: string
  /** `[a, b, c, d, x, y]`. */
  transform?: number[]
  width?: number
}

/** The part of a pdf.js document this package uses. */
export interface PdfDocument {
  numPages: number
  getPage(page: number): Promise<{
    streamTextContent(): ReadableStream<{ items: PdfTextItem[] }>
  }>
  loadingTask: { destroy(): Promise<void> }
}

/** Opens a PDF with pdf.js. A wrong or missing password rejects with a `PasswordException`. */
export type OpenPdf = (data: Uint8Array, options: PdfLoadOptions) => Promise<PdfDocument>

const refuse = (code: PdfRefusalCode, message: string): Result<never, PdfRefusal> =>
  err({ code, message })

/**
 * The lines of every page of a PDF, opened with `open`. Size and page count are checked before
 * any page's text is read; the text read is counted as it streams in, so a page that inflates
 * past `maxBytes` stops there.
 */
export async function readPdfLines(
  bytes: Uint8Array,
  options: ExtractPdfLinesOptions,
  open: OpenPdf,
): Promise<Result<PdfPage[], PdfRefusal>> {
  const maxBytes = options.maxBytes ?? DEFAULT_MAX_BYTES
  const maxPages = options.maxPages ?? DEFAULT_MAX_PAGES
  const maxLines = options.maxLines ?? DEFAULT_MAX_ROWS
  if (bytes.length > maxBytes) {
    return refuse("too-large", `The file is over ${maxBytes} bytes.`)
  }
  let document: PdfDocument
  try {
    // pdf.js takes ownership of the buffer it is given, so it gets a copy.
    document = await open(bytes.slice(), PDFJS_OPTIONS)
  } catch (error) {
    return (error as Error)?.name === "PasswordException"
      ? refuse("encrypted", "This PDF is protected by a password. Remove it and upload again.")
      : refuse("malformed", "This file is not a PDF that can be read.")
  }
  try {
    if (document.numPages > maxPages) {
      return refuse(
        "too-large",
        `The PDF has ${document.numPages} pages, over the limit of ${maxPages}.`,
      )
    }
    const pages: PdfPage[] = []
    let characters = 0
    let lineCount = 0
    for (let page = 1; page <= document.numPages; page++) {
      const words: (PdfWord & { y: number })[] = []
      const reader = (await document.getPage(page)).streamTextContent().getReader()
      for (let chunk = await reader.read(); !chunk.done; chunk = await reader.read()) {
        for (const item of chunk.value.items) {
          characters += item.str?.length ?? 0
          if (characters > maxBytes) {
            await reader.cancel()
            return refuse("too-large", `The PDF holds over ${maxBytes} characters of text.`)
          }
          words.push(...itemWords(item))
        }
      }
      const lines = groupLines(words, page, lineCount)
      lineCount += lines.length
      if (lineCount > maxLines) {
        return refuse("too-large", `The PDF has over ${maxLines} lines, the limit.`)
      }
      pages.push({ page, lines })
    }
    if (lineCount === 0) return refuse("no-text-layer", NO_TEXT_LAYER_MESSAGE)
    return ok(pages)
  } catch {
    return refuse("malformed", "This file is not a PDF that can be read.")
  } finally {
    // Freeing pdf.js' memory must not turn a result into a crash.
    await document.loadingTask.destroy().catch(() => {})
  }
}

/**
 * The words of one text item, each with its x. pdf.js gives no position inside an item, so a
 * word's x is the item's x plus its share of the item's width.
 */
function itemWords(item: PdfTextItem): (PdfWord & { y: number })[] {
  const text = item.str ?? ""
  const [, , , , x = 0, y = 0] = item.transform ?? []
  const width = item.width ?? 0
  const words: (PdfWord & { y: number })[] = []
  for (const match of text.matchAll(/\S+/g)) {
    const at = (match.index / text.length) * width
    words.push({ text: match[0], x: x + at, width: (match[0].length / text.length) * width, y })
  }
  return words
}

/** `words` grouped into lines by baseline, top to bottom, each line left to right. */
function groupLines(words: (PdfWord & { y: number })[], page: number, before: number): PdfLine[] {
  words.sort((a, b) => b.y - a.y || a.x - b.x)
  const lines: PdfLine[] = []
  let current: (PdfWord & { y: number })[] = []
  const close = () => {
    if (current.length === 0) return
    current.sort((a, b) => a.x - b.x)
    const lineWords = current.map(({ text, x, width }) => ({ text, x, width }))
    lines.push({
      line: before + lines.length + 1,
      page,
      y: current[0].y,
      words: lineWords,
      text: lineWords.map((word) => word.text).join(" "),
    })
    current = []
  }
  for (const word of words) {
    if (current.length > 0 && current[0].y - word.y > BASELINE_TOLERANCE) close()
    current.push(word)
  }
  close()
  return lines
}

/** Most words one date or amount token may take: `14.01.2026 09:30`, `1 234,56`. */
const MAX_TOKEN_WORDS = 3

/**
 * Read the lines of a PDF statement with a profile that has a `pdf` layout. Each line becomes
 * the profile's columns, and those go through the same row reader as a CSV row, so the result
 * is the {@link ParsedStatement} that `verifyStatement` checks.
 *
 * A line is a row when it starts like one: with `columns`, when its date column reads as a date;
 * with a `pattern`, when the first token accepts its first word. Other lines (headings, page
 * footers) are skipped. A row that then does not read becomes a row error with its line.
 *
 * The profile is checked against {@link statementProfile} first; a bad one, or one without a
 * `pdf` layout, throws a `TypeError`.
 */
export function parsePdfStatement(
  pages: readonly PdfPage[],
  profile: StatementProfile,
  limits: Pick<StatementLimits, "maxRows"> = {},
): ParsedStatement {
  const checked = statementProfile(profile)
  if (checked instanceof type.errors) {
    throw new TypeError(`bad profile: ${checked.summary}`)
  }
  if (!profile.pdf) throw new TypeError("bad profile: it has no pdf layout")
  const layout = profile.pdf
  const accepts = tokenTest(profile)
  const candidates: { line: PdfLine; cells: string[] | null }[] = []
  for (const { lines } of pages) {
    for (const line of lines) {
      const cells = "columns" in layout
        ? columnCells(line.words, layout)
        : patternCells(line.words, layout.pattern, accepts)
      const isRow = "columns" in layout
        ? accepts("date", cells?.[profile.date.column] ?? "")
        : startsPattern(line.words, layout.pattern[0], accepts)
      if (isRow) candidates.push({ line, cells })
    }
  }
  checkRowCount(candidates.length, limits.maxRows)
  const rows: StatementRow[] = []
  const rowErrors: RowError[] = []
  for (const { line, cells } of candidates) {
    const row = cells
      ? readRow(cells, line.line, profile)
      : `line ${quote(line.text)} does not match the pattern`
    if (typeof row === "string") rowErrors.push({ line: line.line, reason: row })
    else rows.push(row)
  }
  return { format: "pdf", rows, rowErrors }
}

/** Whether a piece of text reads as a date or an amount in the profile's formats. */
type TokenTest = (kind: "date" | "amount", text: string) => boolean

function tokenTest(profile: StatementProfile): TokenTest {
  // Only the shape is tested here; the row reader reads the amount in the row's own currency.
  const currency = "code" in profile.currency ? profile.currency.code : "EUR"
  return (kind, text) =>
    text !== "" &&
    (kind === "date"
      ? parseDateWithPattern(text, profile.date.pattern) !== null
      : parseAmount(text, currency, profile.numberFormat, { negatives: profile.negatives }).ok)
}

/** Each column's words, joined by single spaces. A word outside every range is dropped. */
function columnCells(
  words: readonly PdfWord[],
  layout: Extract<StatementPdfLayout, { columns: unknown }>,
): string[] {
  const cells: string[][] = layout.columns.map(() => [])
  for (const word of words) {
    const index = layout.columns.findIndex(({ from, to }) => word.x >= from && word.x < to)
    if (index !== -1) cells[index].push(word.text)
  }
  return cells.map((cell) => cell.join(" "))
}

/** Whether `token` accepts the first words of `words`. */
function startsPattern(words: readonly PdfWord[], token: PdfToken, accepts: TokenTest): boolean {
  return tokenLengths(words, 0, token, accepts).length > 0
}

/**
 * How many words from `at` on `token` may take, in the order to try them; empty when it does not
 * match there. A `text` token tries the shortest run first, so the tokens after it get the
 * numbers in a description's tail; a date or amount tries the longest run first, so `1 234,56` is
 * one amount and not `1`.
 */
function tokenLengths(
  words: readonly PdfWord[],
  at: number,
  token: PdfToken,
  accepts: TokenTest,
): number[] {
  if ("literal" in token) {
    const expected = token.literal.split(" ")
    return expected.every((word, index) => words[at + index]?.text === word)
      ? [expected.length]
      : []
  }
  const left = words.length - at
  if (token.type === "text") return Array.from({ length: left }, (_, index) => index + 1)
  const lengths: number[] = []
  for (let length = Math.min(MAX_TOKEN_WORDS, left); length > 0; length--) {
    if (accepts(token.type, joined(words, at, at + length))) lengths.push(length)
  }
  return lengths
}

/**
 * The cells a pattern fills from `words`, or `null` when the line does not match it whole. A
 * `text` token tries the shortest run first and a date or amount the longest first, and a token
 * takes the first run after which the rest of the pattern still matches, so `Invoice 2024 paid`
 * stays one description although `2024` reads as an amount. Whether the rest matches comes from a
 * table filled from the end of the line, so the work is tokens times words times
 * {@link MAX_TOKEN_WORDS}, and each date or amount run is tested once.
 */
function patternCells(
  words: readonly PdfWord[],
  pattern: readonly PdfToken[],
  accepts: TokenTest,
): string[] | null {
  const width = words.length + 1
  // reaches[index * width + at]: tokens from `index` on match the words from `at` to the end.
  const reaches = new Uint8Array((pattern.length + 1) * width)
  reaches[pattern.length * width + words.length] = 1
  const runs = new Map<string, number[]>()
  const lengths = (token: PdfToken, at: number): number[] => {
    if ("literal" in token || token.type === "text") return tokenLengths(words, at, token, accepts)
    const key = `${token.type} ${at}`
    let found = runs.get(key)
    if (!found) runs.set(key, found = tokenLengths(words, at, token, accepts))
    return found
  }
  const fits = (index: number, at: number, length: number) =>
    reaches[(index + 1) * width + at + length] === 1
  for (let index = pattern.length - 1; index >= 0; index--) {
    const token = pattern[index]
    let later = false // whether the next token reaches the end from some position after `at`
    for (let at = words.length; at >= 0; at--) {
      if (!("literal" in token) && token.type === "text") {
        if (at < words.length && reaches[(index + 1) * width + at + 1]) later = true
        reaches[index * width + at] = later ? 1 : 0
      } else {
        reaches[index * width + at] = lengths(token, at).some((length) => fits(index, at, length))
          ? 1
          : 0
      }
    }
  }
  if (!reaches[0]) return null
  const cells: string[] = []
  let at = 0
  for (let index = 0; index < pattern.length; index++) {
    const token = pattern[index]
    let length = 0
    if (!("literal" in token) && token.type === "text") {
      length = 1
      while (!fits(index, at, length)) length++
    } else length = lengths(token, at).find((run) => fits(index, at, run)) ?? 0
    if (!("literal" in token)) cells.push(joined(words, at, at + length))
    at += length
  }
  return cells
}

const joined = (words: readonly PdfWord[], from: number, to: number) =>
  words.slice(from, to).map((word) => word.text).join(" ")
