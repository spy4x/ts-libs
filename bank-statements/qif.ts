/**
 * QIF, the Quicken Interchange Format: one field per line, `^` ends a transaction.
 *
 * @module
 */

import {
  isCurrencyCode,
  type NumberFormatGuess,
  parseAmount,
} from "@spy4x/platform/universal/money-core"
import { type DatePattern, detectDatePatterns, parseDateWithPattern } from "@spy4x/time/date"
import {
  checkRowCount,
  checkTextSize,
  definedOnly,
  type ParsedStatement,
  quote,
  type RowError,
  StatementError,
  type StatementLimits,
  type StatementRow,
} from "./statement.ts"

/** The `!Type:` sections that hold transactions of one account. */
const ACCOUNT_TYPES = new Set(["bank", "cash", "ccard", "oth a", "oth l"])

/** Settings for {@link parseQif}. QIF names no currency, so the caller does. */
export interface ParseQifOptions extends StatementLimits {
  /** The account's ISO 4217 currency. */
  currency: string
  /**
   * How the `D` lines write dates, after `'` is read as `/`. Default: the one pattern all dates
   * fit, the month-first one when several do, since QIF is a US format.
   */
  datePattern?: DatePattern
  /** How the `T` lines write amounts. Default `{ decimal: ".", group: "," }`. */
  numberFormat?: NumberFormatGuess
}

/** One transaction's lines, by field code. */
interface QifRecord {
  line: number
  fields: Map<string, string>
}

/**
 * Read a QIF file's transactions. QIF states no balances, so the statement verifies as
 * `"unverifiable"`. An investment section, or more than one account, is refused as
 * `"unsupported"`.
 */
export function parseQif(
  text: string,
  options: ParseQifOptions,
): ParsedStatement {
  const { currency } = options
  if (!isCurrencyCode(currency)) {
    throw new StatementError("unsupported", `unknown currency ${quote(currency)}`)
  }
  checkTextSize(text, options.maxBytes)
  const lines = text.split(/\r\n|\r|\n/)
  checkRowCount(
    // Counted the way the loop below reads them: trimmed, so ` ^` ends a record too.
    lines.filter((line) => line.trim() === "^").length,
    options.maxRows,
  )

  const records: QifRecord[] = []
  let sections = 0
  let skipping = false
  let current: QifRecord | null = null
  for (const [index, raw] of lines.entries()) {
    const line = raw.trim()
    if (line === "") continue
    if (line.startsWith("!")) {
      const header = line.toLowerCase()
      if (header === "!account") skipping = true
      else if (header.startsWith("!type:")) {
        if (!ACCOUNT_TYPES.has(header.slice(6).trim())) {
          throw new StatementError(
            "unsupported",
            `QIF section ${quote(line)} is not an account`,
          )
        }
        if (++sections > 1) {
          throw new StatementError(
            "unsupported",
            "file holds several accounts",
          )
        }
      }
      continue
    }
    if (line === "^") {
      if (!skipping && current) records.push(current)
      skipping = false
      current = null
      continue
    }
    if (skipping) continue
    if (sections === 0) {
      throw new StatementError("malformed", "no !Type: header before a record")
    }
    current ??= { line: index + 1, fields: new Map() }
    // `S`, `E` and `$` lines are a split's parts; the transaction's own `T` is its total.
    if (!current.fields.has(line[0])) {
      current.fields.set(line[0], line.slice(1).trim())
    }
  }
  if (sections === 0) {
    throw new StatementError("malformed", "no !Type: header found")
  }
  // A last transaction without its closing `^` is still a transaction.
  if (!skipping && current) records.push(current)

  const dates = records.map((record) => qifDate(record.fields.get("D") ?? ""))
  const fitting = detectDatePatterns(dates)
  const pattern = options.datePattern ??
    fitting.find((p) => p.startsWith("MM")) ?? fitting[0] ??
    "MM/DD/YYYY"
  const format = options.numberFormat ?? { decimal: ".", group: "," }

  const rows: StatementRow[] = []
  const rowErrors: RowError[] = []
  for (const [index, { line, fields }] of records.entries()) {
    const date = parseDateWithPattern(dates[index], pattern)
    const amountText = fields.get("T") ?? fields.get("U") ?? ""
    const amount = parseAmount(amountText, currency, format)
    if (!date) {
      rowErrors.push({
        line,
        reason: `date ${quote(dates[index])} is not ${pattern}`,
      })
    } else if (!amount.ok) {
      rowErrors.push({
        line,
        reason: `amount ${quote(amountText)} is not a number`,
      })
    } else {
      rows.push(definedOnly({
        line,
        date,
        amount: amount.value,
        currency,
        payee: fields.get("P"),
        memo: fields.get("M"),
        reference: fields.get("N"),
      }))
    }
  }
  return { format: "qif", rows, rowErrors }
}

/** A QIF date with `'` (`1/15'26`) read as `/` and padding spaces (`1/ 5/26`) dropped. */
function qifDate(text: string): string {
  return text.replaceAll("'", "/").replaceAll(" ", "")
}
