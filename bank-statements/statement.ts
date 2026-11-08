/**
 * The shapes every parser returns, the error they throw and the size limits they share.
 *
 * @module
 */

import { parseXml, type XmlElement, XmlErrorCode } from "@spy4x/caldav/xml"
import { isCurrencyCode, parseAmount } from "@spy4x/platform/universal/money-core"
import { err, type Result } from "@spy4x/platform/universal/result"
import { parseDateWithPattern } from "@spy4x/time/date"

/** A file format {@link detectFormat} can name. */
export type StatementFormat =
  | "ofx"
  | "qif"
  | "camt053"
  | "mt940"
  | "csv"
  | "pdf"
  | "unknown"

/** One transaction read from a statement. Amounts are whole numbers of the currency's minor unit. */
export interface StatementRow {
  /** The 1-based line of the file where the row starts, as a text editor shows it. */
  line: number
  /** The booking date, `YYYY-MM-DD`. */
  date: string
  /** Signed: money in is positive, money out negative. */
  amount: number
  /** The ISO 4217 code of `amount`. */
  currency: string
  payee?: string
  memo?: string
  /** The bank's or the payer's reference for the row. */
  reference?: string
  /** The account balance after this row, when the file gives one. */
  balance?: number
  /** The amount in the currency it was spent in, before conversion. */
  originalAmount?: number
  originalCurrency?: string
}

/** A balance the file states, with the line it is written on. */
export interface StatementBalance {
  amount: number
  line: number
}

/** A row the parser could not read, and why. */
export interface RowError {
  line: number
  reason: string
}

/** What a parser read from one file. */
export interface ParsedStatement {
  format: StatementFormat
  rows: StatementRow[]
  /** The balance before the first row, when the file states it. */
  openingBalance?: StatementBalance
  /** The balance after the last row, when the file states it. */
  closingBalance?: StatementBalance
  /** Rows that could not be read. A statement with any is never verified. */
  rowErrors: RowError[]
}

/** Why a whole file was refused. */
export type StatementErrorCode =
  /** Larger than `maxBytes`, more rows than `maxRows`, or nested too deep. */
  | "too-large"
  /** A DTD or an entity the reader does not allow. */
  | "forbidden"
  /** Not the format it claims to be. */
  | "malformed"
  /** A file this package does not read: a PDF, several accounts in one file, a CSV without a profile. */
  | "unsupported"

/** Thrown when a whole file is refused. Problems with single rows go to `rowErrors` instead. */
export class StatementError extends Error {
  constructor(readonly code: StatementErrorCode, message: string) {
    super(message)
    this.name = "StatementError"
  }
}

/** Size limits for a file from a stranger. Both are on by default. */
export interface StatementLimits {
  /** Most bytes the file may have. Default {@link DEFAULT_MAX_BYTES}, 10 MiB. */
  maxBytes?: number
  /** Most transactions the file may hold. Default {@link DEFAULT_MAX_ROWS}, 100,000. */
  maxRows?: number
}

/** The default `maxBytes`: 10 MiB. */
export const DEFAULT_MAX_BYTES = 10 * 1024 * 1024

/** The default `maxRows`. */
export const DEFAULT_MAX_ROWS = 100_000

/** Throws `too-large` when `text` is longer than `maxBytes` in UTF-8. Stops counting at the limit. */
export function checkTextSize(
  text: string,
  maxBytes = DEFAULT_MAX_BYTES,
): void {
  let bytes = 0
  for (let index = 0; index < text.length; index++) {
    const code = text.charCodeAt(index)
    // A surrogate pair is 4 bytes in UTF-8: 2 for each half.
    bytes += code < 0x80 ? 1 : code < 0x800 || (code >= 0xd800 && code < 0xe000) ? 2 : 3
    if (bytes > maxBytes) {
      throw new StatementError("too-large", `file is over ${maxBytes} bytes`)
    }
  }
}

/** Throws `too-large` when `count` is over `maxRows`. */
export function checkRowCount(count: number, maxRows = DEFAULT_MAX_ROWS): void {
  if (count > maxRows) {
    throw new StatementError(
      "too-large",
      `file holds ${count} rows, over the limit of ${maxRows}`,
    )
  }
}

/** The 1-based line of every offset in `offsets`, which must be ascending. One pass over `text`. */
export function linesAt(text: string, offsets: readonly number[]): number[] {
  const lines: number[] = []
  let line = 1
  let at = 0
  for (const offset of offsets) {
    for (; at < offset; at++) if (text.charCodeAt(at) === 10) line++
    lines.push(line)
  }
  return lines
}

/**
 * The offset of every opening tag named `name` in XML or SGML text, with or without a namespace
 * prefix, self-closing too: `<Ntry>`, `<camt:Ntry attr="1">`, `<STMTTRN/>`. Used to give rows of a tree-shaped file their line.
 */
export function openingTagOffsets(text: string, name: string): number[] {
  const offsets: number[] = []
  for (
    let at = text.indexOf(name);
    at !== -1;
    at = text.indexOf(name, at + name.length)
  ) {
    const after = text[at + name.length]
    if (
      after !== ">" && after !== "/" && after !== " " && after !== "\t" && after !== "\r" &&
      after !== "\n"
    ) {
      continue
    }
    let start = at - 1
    if (text[start] === ":") {
      // Linear overall: each prefix run ends at its own colon, so no character is walked twice.
      while (start > 0 && /[\w.-]/.test(text[start - 1])) start--
      start--
    }
    if (text[start] === "<") offsets.push(start)
  }
  return offsets
}

/** `text` cut to 40 characters for an error message, so a hostile file cannot make it huge. */
export function quote(text: string): string {
  return JSON.stringify(text.length > 40 ? `${text.slice(0, 40)}…` : text)
}

/**
 * A plain decimal (`-12.34`, `12,34`, `1234`) as minor units of `currency`, or why not. Standard
 * formats write no grouping marks, so the one `.` or `,` is the decimal mark.
 */
export function readDecimal(
  text: string,
  currency: string,
): Result<number, string> {
  if (!isCurrencyCode(currency)) {
    return err(`unknown currency ${quote(currency)}`)
  }
  const decimal = text.includes(",") ? "," : "."
  const read = parseAmount(text.trim(), currency, { decimal, group: "" })
  return read.ok ? read : err(`amount ${quote(text)} is not a number`)
}

/** `text` parsed by `@spy4x/caldav/xml`, which refuses a DTD; a refusal is a {@link StatementError}. */
export function readXml(
  text: string,
  maxBytes = DEFAULT_MAX_BYTES,
): XmlElement {
  const parsed = parseXml(text, { maxBytes })
  if (parsed.success) return parsed.output
  const code = parsed.error.code === XmlErrorCode.TooLarge
    ? "too-large"
    : parsed.error.code === XmlErrorCode.Forbidden
    ? "forbidden"
    : "malformed"
  throw new StatementError(code, parsed.error.message)
}

/** The `YYYY-MM-DD` date at the start of `text` (`20260131`, `2026-01-31T10:00:00+01:00`), or `null`. */
export function readIsoDate(text: string, compact: boolean): string | null {
  const value = text.trim()
  if (compact) {
    if (!/^\d{8}/.test(value)) return null
    return parseDateWithPattern(
      `${value.slice(0, 4)}-${value.slice(4, 6)}-${value.slice(6, 8)}`,
      "YYYY-MM-DD",
    )
  }
  return /^\d{4}-\d{2}-\d{2}/.test(value)
    ? parseDateWithPattern(value.slice(0, 10), "YYYY-MM-DD")
    : null
}

/** `row` without the optional fields that are empty strings. */
export function definedOnly(row: StatementRow): StatementRow {
  for (const key of Object.keys(row) as (keyof StatementRow)[]) {
    if (row[key] === "" || row[key] === undefined) delete row[key]
  }
  return row
}
