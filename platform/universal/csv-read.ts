/**
 * Reading an uploaded CSV file: its encoding, its delimiter and header, and its rows, within size
 * limits. Re-exported by `./csv.ts`; import it from `@spy4x/platform/universal/csv`.
 *
 * RFC 4180 parsing itself is `@std/csv`'s `parse`. What this module adds is what an upload needs
 * before and around it: bytes turned into text in the right encoding, a guess of the delimiter and
 * the header, and limits on rows, columns and field length. The input is a file a stranger may have
 * crafted, so the limits are on by default and are checked in one pass over the text before
 * `parse` builds a single row: a file past a limit costs one scan, never an array per row.
 *
 * @module
 */

import { parse } from "@std/csv"

import { err, ok, type Result } from "./result.ts"

/** Every single-byte encoding {@link decodeTextFile} can fall back to. */
export const SINGLE_BYTE_ENCODINGS = [
  "windows-1252",
  "windows-1251",
  "windows-1250",
  "iso-8859-2",
  "koi8-r",
  "ibm866",
] as const

/** A single-byte encoding a file without a byte-order mark and not valid UTF-8 may be in. */
export type SingleByteEncoding = typeof SINGLE_BYTE_ENCODINGS[number]

/** An encoding {@link decodeTextFile} reads, as a `TextDecoder` label. */
export type TextFileEncoding = "utf-8" | "utf-16le" | "utf-16be" | SingleByteEncoding

/** Optional settings for {@link decodeTextFile}. */
export interface DecodeTextFileOptions {
  /**
   * The encoding to use when the bytes have no byte-order mark and are not valid UTF-8. Defaults to
   * `windows-1252`, the Western European one; pass `windows-1251` for a Cyrillic file.
   */
  fallback?: SingleByteEncoding
}

/** What {@link decodeTextFile} read. */
export interface DecodedTextFile {
  /** The text, without a byte-order mark. */
  text: string
  /** The encoding the text was read with. */
  encoding: TextFileEncoding
  /**
   * Other encodings the same bytes decode under, for a "read as" select. Empty when the choice was
   * certain: a byte-order mark, or bytes that are valid UTF-8.
   */
  candidates: TextFileEncoding[]
}

/**
 * Decode an uploaded text file. A byte-order mark picks UTF-8, UTF-16LE or UTF-16BE; otherwise the
 * bytes are read as strict UTF-8; when they are not valid UTF-8, `options.fallback`
 * (`windows-1252` by default) is used, and the other single-byte encodings are listed as
 * candidates, because any byte sequence decodes under every one of them and only a person can tell
 * which text is right.
 */
export function decodeTextFile(
  bytes: Uint8Array,
  options: DecodeTextFileOptions = {},
): DecodedTextFile {
  const bom = byteOrderMark(bytes)
  if (bom) return { text: new TextDecoder(bom).decode(bytes), encoding: bom, candidates: [] }
  try {
    const text = new TextDecoder("utf-8", { fatal: true }).decode(bytes)
    return { text, encoding: "utf-8", candidates: [] }
  } catch {
    const fallback = options.fallback ?? "windows-1252"
    return {
      text: new TextDecoder(fallback).decode(bytes),
      encoding: fallback,
      candidates: SINGLE_BYTE_ENCODINGS.filter((encoding) => encoding !== fallback),
    }
  }
}

/** The encoding a byte-order mark at the start of `bytes` names, or `null` without one. */
function byteOrderMark(bytes: Uint8Array): TextFileEncoding | null {
  if (bytes[0] === 0xef && bytes[1] === 0xbb && bytes[2] === 0xbf) return "utf-8"
  if (bytes[0] === 0xff && bytes[1] === 0xfe) return "utf-16le"
  if (bytes[0] === 0xfe && bytes[1] === 0xff) return "utf-16be"
  return null
}

/** The delimiters {@link sniffCsv} considers, in the order it prefers them on a tie. */
export const CSV_DELIMITERS = [",", ";", "\t", "|"] as const

/** A delimiter {@link sniffCsv} can find. */
export type CsvDelimiter = typeof CSV_DELIMITERS[number]

/** What {@link sniffCsv} guessed about a CSV sample. */
export interface CsvSniff {
  /** The best delimiter: the first of {@link delimiters}. */
  delimiter: CsvDelimiter
  /**
   * Every delimiter that splits most lines into the same number of fields (two or more), best
   * first. Holds only `","` when none does, as for a file with a single column.
   */
  delimiters: CsvDelimiter[]
  /**
   * Whether the first row is a header: none of its cells looks like a date or a number, while a
   * column below it holds them.
   */
  header: boolean
}

/** How many records {@link sniffCsv} looks at. */
const SNIFF_RECORDS = 50

/** How many characters of the sample {@link sniffCsv} looks at. */
const SNIFF_CHARACTERS = 65_536

/** How many rows below the first {@link sniffCsv} reads to decide on the header. */
const HEADER_ROWS = 20

/**
 * Guess the delimiter of a CSV sample and whether its first row is a header. Pass the start of the
 * decoded text; only its first 64 KiB and 50 records are read, so passing the whole file costs no
 * more.
 *
 * A delimiter is a candidate when the field count it gives, counting quoted fields as one, is the
 * same on more than half of the records and is two or more. Candidates rank by how many records
 * share that count, then by the count itself, then by {@link CSV_DELIMITERS} order. A German bank
 * file (`Datum;Betrag` over `01.02.2026;1.234,56`) picks `;`: a comma splits only the amounts, so
 * the header line disagrees with the rows.
 */
export function sniffCsv(sample: string): CsvSniff {
  const text = sample.slice(0, SNIFF_CHARACTERS).replace(/^\uFEFF/, "")
  const ranked = CSV_DELIMITERS
    .map((delimiter, order) => ({ delimiter, order, ...fieldCountAgreement(text, delimiter) }))
    .filter(({ count, agreeing, records }) => count >= 2 && agreeing * 2 > records)
    .sort((a, b) => b.agreeing - a.agreeing || b.count - a.count || a.order - b.order)
  const delimiters: CsvDelimiter[] = ranked.length > 0
    ? ranked.map(({ delimiter }) => delimiter)
    : [","]
  const delimiter = delimiters[0]
  return { delimiter, delimiters, header: hasHeader(text, delimiter) }
}

/** The most common field count over the first records of `text`, and how many records have it. */
function fieldCountAgreement(
  text: string,
  delimiter: string,
): { count: number; agreeing: number; records: number } {
  const counts: number[] = []
  scanCsv(text, delimiter, SNIFF_LIMITS, (fields) => counts.push(fields) < SNIFF_RECORDS)
  const tally = new Map<number, number>()
  for (const count of counts) tally.set(count, (tally.get(count) ?? 0) + 1)
  let best = { count: 0, agreeing: 0, records: counts.length }
  for (const [count, agreeing] of tally) {
    if (agreeing > best.agreeing) best = { count, agreeing, records: counts.length }
  }
  return best
}

/** Whether a cell looks like a date (`01.02.2026`, `2026-02-01`) or a number (`-1.234,56`). */
function looksLikeValue(cell: string): boolean {
  const value = cell.trim()
  return /^\d{1,4}[./-]\d{1,2}[./-]\d{1,4}\b/.test(value) ||
    /^[-+−(]?\s*\d[\d.,'’   ]*\)?-?$/.test(value)
}

/** Whether the first record of `text`, split on `delimiter`, is a header. */
function hasHeader(text: string, delimiter: string): boolean {
  let end = text.length
  let seen = 0
  scanCsv(text, delimiter, SNIFF_LIMITS, (_fields, _line, recordEnd) => {
    end = recordEnd
    return ++seen <= HEADER_ROWS
  })
  let rows: string[][]
  try {
    rows = parse(text.slice(0, end), { separator: delimiter, lazyQuotes: true })
  } catch {
    return false
  }
  const [first, ...below] = rows
  if (!first || below.length === 0 || first.some(looksLikeValue)) return false
  return first.some((cell, column) => {
    if (cell.trim() === "") return false
    const values = below.filter((row) => looksLikeValue(row[column] ?? "")).length
    return values * 2 > below.length
  })
}

/** Size limits for {@link parseCsv}. Each is on by default. */
export interface CsvLimits {
  /** Most records the file may hold, the header included. Default 100,000. */
  maxRows?: number
  /** Most characters one field may hold. Default 10,000. */
  maxFieldLength?: number
  /** Most fields one record may hold. Default 1,000. */
  maxColumns?: number
}

/** Settings for {@link parseCsv}: the delimiter and the size limits. */
export interface ParseCsvOptions extends CsvLimits {
  /** The field delimiter, one character. Default `","`; {@link sniffCsv} guesses it. */
  delimiter?: string
}

/** The default {@link CsvLimits}, applied when an option is left out. */
export const CSV_DEFAULT_LIMITS: Readonly<Required<CsvLimits>> = Object.freeze({
  maxRows: 100_000,
  maxFieldLength: 10_000,
  maxColumns: 1_000,
})

/** Limits for sniffing: the sample is already short, so only the field length matters. */
const SNIFF_LIMITS: Required<CsvLimits> = {
  maxRows: Number.MAX_SAFE_INTEGER,
  maxFieldLength: SNIFF_CHARACTERS,
  maxColumns: Number.MAX_SAFE_INTEGER,
}

/**
 * Why {@link parseCsv} refused a file. `line` is 1-based and counts line breaks in the text, so it
 * matches what a text editor shows.
 */
export type CsvParseError =
  /** More records than `maxRows`; `line` is where the first record past the limit starts. */
  | { type: "too-many-rows"; line: number; maxRows: number }
  /** A field longer than `maxFieldLength`; `line` is where that field starts. */
  | { type: "field-too-long"; line: number; maxFieldLength: number }
  /** A record with more fields than `maxColumns`; `line` is where that record starts. */
  | { type: "too-many-columns"; line: number; maxColumns: number }
  /** A quoted field that never closes; `line` is where its opening quote is. */
  | { type: "unclosed-quote"; line: number }
  /** Any other RFC 4180 fault, such as a stray quote; `line` is where the record starts. */
  | { type: "malformed"; line: number; message: string }

/**
 * Parse CSV text into rows of fields, within size limits. Blank lines are skipped, rows may have
 * different field counts, and a leading byte-order mark is dropped. Parsing is `@std/csv`'s strict
 * RFC 4180 mode; the limits ({@link CSV_DEFAULT_LIMITS} for any left out) are checked first, in one
 * pass, so a file past one is refused before any row is built.
 */
export function parseCsv(
  text: string,
  options: ParseCsvOptions = {},
): Result<string[][], CsvParseError> {
  const { delimiter = ",", ...limits } = options
  if (delimiter.length !== 1 || delimiter === '"' || /[\r\n]/.test(delimiter)) {
    throw new RangeError(`csv delimiter must be one character other than a quote or line break`)
  }
  const checked = { ...CSV_DEFAULT_LIMITS, ...definedLimits(limits) }
  const input = text.replace(/^\uFEFF/, "")
  const fault = scanCsv(input, delimiter, checked)
  if (fault) return err(fault)
  try {
    return ok(parse(input, { separator: delimiter }))
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error)
    const line = Number(/line (\d+)/.exec(message)?.[1] ?? 1)
    return err({ type: "malformed", line, message })
  }
}

/** `limits` without the keys set to `undefined`, each checked to be a positive whole number. */
function definedLimits(limits: CsvLimits): CsvLimits {
  const defined: CsvLimits = {}
  for (const key of Object.keys(CSV_DEFAULT_LIMITS) as (keyof CsvLimits)[]) {
    const value = limits[key]
    if (value === undefined) continue
    if (!Number.isSafeInteger(value) || value < 1) {
      throw new RangeError(`csv ${key} must be a whole number above zero, got ${value}`)
    }
    defined[key] = value
  }
  return defined
}

/**
 * One pass over CSV text that enforces `limits` and reports each record, without building any
 * field. It follows RFC 4180 quoting the way `@std/csv`'s strict mode does — a quote opens a quoted
 * field only at the field's start, and `""` inside one is a single quote — so on any text `parse`
 * accepts, the two agree on where every record and field begins and ends.
 *
 * `onRecord` receives the record's field count, its first line and the offset just past it; it
 * returns `false` to stop the scan. Blank lines are not records, as in `parse`.
 */
function scanCsv(
  text: string,
  delimiter: string,
  limits: Required<CsvLimits>,
  onRecord?: (fields: number, line: number, end: number) => boolean,
): CsvParseError | null {
  let line = 1
  let rows = 0
  let fields = 1
  let fieldLength = 0
  let fieldLine = 1
  let recordLine = 1
  let recordStarted = false
  let fieldStart = true
  let quoteLine = 0
  let index = 0

  const tooLong = (): CsvParseError => ({
    type: "field-too-long",
    line: fieldLine,
    maxFieldLength: limits.maxFieldLength,
  })

  while (index < text.length) {
    const char = text[index]
    if (quoteLine > 0) {
      if (char === '"') {
        if (text[index + 1] !== '"') {
          quoteLine = 0
          index++
          continue
        }
        index++
      } else if (char === "\n") line++
      if (++fieldLength > limits.maxFieldLength) return tooLong()
      index++
      continue
    }
    if (char === "\n" || (char === "\r" && text[index + 1] === "\n")) {
      index += char === "\r" ? 2 : 1
      if (recordStarted) {
        if (++rows > limits.maxRows) {
          return { type: "too-many-rows", line: recordLine, maxRows: limits.maxRows }
        }
        if (onRecord && !onRecord(fields, recordLine, index)) return null
      }
      line++
      fields = 1
      fieldLength = 0
      fieldLine = recordLine = line
      recordStarted = false
      fieldStart = true
      continue
    }
    recordStarted = true
    if (char === delimiter) {
      if (++fields > limits.maxColumns) {
        return { type: "too-many-columns", line: recordLine, maxColumns: limits.maxColumns }
      }
      fieldLength = 0
      fieldLine = line
      fieldStart = true
    } else if (char === '"' && fieldStart) {
      quoteLine = line
      fieldStart = false
    } else {
      if (++fieldLength > limits.maxFieldLength) return tooLong()
      fieldStart = false
    }
    index++
  }
  if (quoteLine > 0) return { type: "unclosed-quote", line: quoteLine }
  if (recordStarted) {
    if (++rows > limits.maxRows) {
      return { type: "too-many-rows", line: recordLine, maxRows: limits.maxRows }
    }
    onRecord?.(fields, recordLine, index)
  }
  return null
}
