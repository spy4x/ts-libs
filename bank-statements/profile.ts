/**
 * A statement profile: one bank's CSV format, described as data so a household's own mapping, a
 * built-in bank and an AI proposal all go through the same tested parser.
 *
 * @module
 */

import { type Type, type } from "arktype"
import {
  CSV_DELIMITERS,
  type CsvDelimiter,
  parseCsv,
  SINGLE_BYTE_ENCODINGS,
  type TextFileEncoding,
} from "@spy4x/platform/universal/csv"
import {
  currencyCode,
  isCurrencyCode,
  NEGATIVE_STYLES,
  type NegativeStyle,
  type NumberFormatGuess,
  parseAmount,
} from "@spy4x/platform/universal/money"
import { DATE_PATTERNS, type DatePattern, parseDateWithPattern } from "@spy4x/time/date"
import {
  checkRowCount,
  checkTextSize,
  definedOnly,
  type ParsedStatement,
  quote,
  type RowError,
  type StatementLimits,
  type StatementRow,
} from "./statement.ts"

/** A 0-based column index. */
type Column = number

/**
 * One bank's CSV export format. Columns are 0-based indexes into a row, so a file with two columns
 * of the same name stays unambiguous.
 */
export interface StatementProfile {
  id: string
  /** A name a person recognises: `"Example Bank, current account"`. */
  name: string
  /** The encoding the bank writes when the file is not UTF-8. */
  encoding: TextFileEncoding
  delimiter: CsvDelimiter
  /** The 1-based line of the header. Lines above it are preamble and skipped. */
  headerLine: number
  date: { column: Column; pattern: DatePattern }
  /** One signed column, or a debit and a credit column of which one is filled per row. */
  amount: { column: Column } | { debit: Column; credit: Column }
  /** How amounts and balances are written. */
  numberFormat: NumberFormatGuess
  /** Which ways of writing a negative amount to accept. Default `["minus"]`. */
  negatives?: NegativeStyle[]
  /** A column holding each row's ISO 4217 code, or one fixed code. */
  currency: { column: Column } | { code: string }
  payee?: Column
  /** Read into each row's `memo`. */
  description?: Column
  reference?: Column
  /** The balance after each row, which lets {@link verifyStatement} check every row. */
  balance?: Column
  originalAmount?: Column
  originalCurrency?: Column
  /** What {@link matchProfile} compares a file against. */
  fingerprint: {
    /** The header names, compared after {@link foldHeader}. */
    headers: string[]
    columns: number
    delimiter: CsvDelimiter
  }
}

const column = "0 <= number.integer < 1000"

/** The arktype schema of {@link StatementProfile}, for a profile read from storage or an AI. */
export const statementProfile: Type<StatementProfile> = type({
  id: "string > 0",
  name: "string > 0",
  encoding: type.enumerated(
    "utf-8",
    "utf-16le",
    "utf-16be",
    ...SINGLE_BYTE_ENCODINGS,
  ),
  delimiter: type.enumerated(...CSV_DELIMITERS),
  headerLine: "number.integer >= 1",
  date: { column, pattern: type.enumerated(...DATE_PATTERNS) },
  amount: type({ column }).or({ debit: column, credit: column }),
  numberFormat: {
    decimal: "'.' | ','",
    group: "'' | ',' | '.' | ' ' | \"'\"",
  },
  "negatives?": type.enumerated(...NEGATIVE_STYLES).array(),
  currency: type({ column }).or({ code: currencyCode }),
  "payee?": column,
  "description?": column,
  "reference?": column,
  "balance?": column,
  "originalAmount?": column,
  "originalCurrency?": column,
  fingerprint: {
    headers: "string[]",
    columns: "number.integer >= 1",
    delimiter: type.enumerated(...CSV_DELIMITERS),
  },
}) as Type<StatementProfile>

/** A header name as profiles compare it: Unicode-normalised, trimmed, lower case, one space. */
export function foldHeader(name: string): string {
  return name.normalize("NFKC").trim().toLowerCase().replace(/\s+/g, " ")
}

/**
 * Read CSV text with a profile. The profile is checked against {@link statementProfile} first,
 * and a bad one throws a `TypeError`. Each row that does not read (a bad date, an amount that is
 * not a number in the profile's format, a broken quote) becomes a row error with its line; the
 * other rows still read.
 */
export function parseWithProfile(
  text: string,
  profile: StatementProfile,
  limits: StatementLimits = {},
): ParsedStatement {
  const checked = statementProfile(profile)
  if (checked instanceof type.errors) {
    throw new TypeError(`bad profile: ${checked.summary}`)
  }
  checkTextSize(text, limits.maxBytes)
  const records = csvRecords(text, profile.headerLine).slice(1)
  checkRowCount(records.length, limits.maxRows)

  const rows: StatementRow[] = []
  const rowErrors: RowError[] = []
  for (const record of records) {
    const parsed = parseCsv(record.text, { delimiter: profile.delimiter })
    if (!parsed.ok) {
      rowErrors.push({
        line: record.line,
        reason: `csv: ${parsed.error.type}`,
      })
      continue
    }
    const row = readRow(parsed.value[0] ?? [], record.line, profile)
    if (typeof row === "string") {
      rowErrors.push({ line: record.line, reason: row })
    } else rows.push(row)
  }
  return { format: "csv", rows, rowErrors }
}

/** One row read with `profile`, or the reason it does not read. */
function readRow(
  fields: string[],
  line: number,
  profile: StatementProfile,
): StatementRow | string {
  const cell = (index: Column | undefined) =>
    index === undefined ? "" : (fields[index] ?? "").trim()
  const currency = "code" in profile.currency
    ? profile.currency.code
    : cell(profile.currency.column)
  if (!isCurrencyCode(currency)) return `unknown currency ${quote(currency)}`
  const amountOf = (text: string, code = currency) =>
    parseAmount(text, code, profile.numberFormat, {
      negatives: profile.negatives,
    })

  const dateText = cell(profile.date.column)
  const date = parseDateWithPattern(dateText, profile.date.pattern)
  if (!date) return `date ${quote(dateText)} is not ${profile.date.pattern}`

  let amount: number
  if ("column" in profile.amount) {
    const read = amountOf(cell(profile.amount.column))
    if (!read.ok) {
      return `amount ${quote(cell(profile.amount.column))} is not a number`
    }
    amount = read.value
  } else {
    const debitText = cell(profile.amount.debit)
    const creditText = cell(profile.amount.credit)
    const debit = debitText ? amountOf(debitText) : { ok: true as const, value: 0 }
    const credit = creditText ? amountOf(creditText) : { ok: true as const, value: 0 }
    if (!debit.ok) return `debit ${quote(debitText)} is not a number`
    if (!credit.ok) return `credit ${quote(creditText)} is not a number`
    if (!debitText && !creditText) return "no debit and no credit"
    if (debit.value !== 0 && credit.value !== 0) {
      return "both a debit and a credit"
    }
    // Some banks write a debit as negative, some as positive: either way it takes money out.
    amount = Math.abs(credit.value) - Math.abs(debit.value)
  }

  const row: StatementRow = definedOnly({
    line,
    date,
    amount,
    currency,
    payee: cell(profile.payee),
    memo: cell(profile.description),
    reference: cell(profile.reference),
  })
  const balanceText = cell(profile.balance)
  if (balanceText) {
    const balance = amountOf(balanceText)
    if (!balance.ok) return `balance ${quote(balanceText)} is not a number`
    row.balance = balance.value
  }
  const originalText = cell(profile.originalAmount)
  if (originalText) {
    const originalCurrency = cell(profile.originalCurrency)
    if (!isCurrencyCode(originalCurrency)) {
      return `unknown original currency ${quote(originalCurrency)}`
    }
    const original = amountOf(originalText, originalCurrency)
    if (!original.ok) {
      return `original amount ${quote(originalText)} is not a number`
    }
    row.originalAmount = original.value
    row.originalCurrency = originalCurrency
  }
  return row
}

/**
 * The CSV records of `text` from line `fromLine` on, each with its 1-based first line. A record
 * runs on past a line break while a quote is open; blank lines are skipped. One pass.
 */
export function csvRecords(
  text: string,
  fromLine = 1,
): { line: number; text: string }[] {
  let line = 1
  let start = 0
  while (line < fromLine && start < text.length) {
    const next = text.indexOf("\n", start)
    if (next === -1) return []
    start = next + 1
    line++
  }
  const records: { line: number; text: string }[] = []
  let recordLine = line
  let open = false
  for (let at = start; at <= text.length; at++) {
    const char = text.charCodeAt(at)
    if (char === 34) open = !open
    if ((char === 10 && !open) || at === text.length) {
      const body = text.slice(start, at).replace(/\r$/, "")
      if (body.trim() !== "") records.push({ line: recordLine, text: body })
      start = at + 1
      recordLine = line + 1
    }
    if (char === 10) line++
  }
  return records
}
