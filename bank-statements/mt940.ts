/**
 * SWIFT MT940, the customer statement message: tagged fields such as `:60F:` (opening balance),
 * `:61:` (a transaction), `:86:` (its details) and `:62F:` (closing balance).
 *
 * @module
 */

import { parseDateWithPattern } from "@spy4x/time/date"
import { err, ok, type Result } from "@spy4x/platform/universal/result"
import {
  checkRowCount,
  checkTextSize,
  definedOnly,
  type ParsedStatement,
  quote,
  readDecimal,
  type RowError,
  type StatementBalance,
  StatementError,
  type StatementLimits,
  type StatementRow,
} from "./statement.ts"

/** One tagged field and the 1-based line it starts on. Continuation lines are joined with `\n`. */
interface Field {
  tag: string
  value: string
  line: number
}

/**
 * Read an MT940 file. Several statements of the same account in one file (one per day, or `:60M:`
 * and `:62M:` pages) are read as one: the opening balance is the first one, the closing the last
 * one. Statements of different accounts (`:25:`) are refused as `"unsupported"`.
 */
export function parseMt940(
  text: string,
  limits: StatementLimits = {},
): ParsedStatement {
  checkTextSize(text, limits.maxBytes)
  const lines = text.split(/\r\n|\r|\n/)
  checkRowCount(
    lines.filter((line) => line.startsWith(":61:")).length,
    limits.maxRows,
  )

  const fields: Field[] = []
  for (const [index, line] of lines.entries()) {
    const tag = /^:(\d\d[A-Z]?):/.exec(line)
    if (tag) {
      fields.push({
        tag: tag[1],
        value: line.slice(tag[0].length),
        line: index + 1,
      })
    } // `{1:…}{2:…}{4:` opens a SWIFT envelope and `-}` closes it; neither is statement text.
    else if (line.startsWith("{") || line === "-" || line.startsWith("-}")) {
      continue
    } else if (fields.length > 0) {
      fields[fields.length - 1].value += `\n${line}`
    }
  }
  if (!fields.some((field) => field.tag.startsWith("60"))) {
    throw new StatementError("malformed", "no :60F: opening balance found")
  }

  const result: ParsedStatement = { format: "mt940", rows: [], rowErrors: [] }
  const rowErrors: RowError[] = result.rowErrors
  let account: string | undefined
  let currency = ""
  let last: StatementRow | undefined
  for (const field of fields) {
    const { tag, value, line } = field
    if (tag === "25") {
      if (account !== undefined && account !== value.trim()) {
        throw new StatementError(
          "unsupported",
          "file holds statements of several accounts",
        )
      }
      account = value.trim()
    } else if (
      tag === "60F" || tag === "60M" || tag === "62F" || tag === "62M"
    ) {
      const balance = readBalance(value, line)
      if (!balance.ok) {
        rowErrors.push({ line, reason: balance.error })
        continue
      }
      currency = balance.value.currency
      if (tag.startsWith("60")) result.openingBalance ??= balance.value.balance
      else result.closingBalance = balance.value.balance
    } else if (tag === "61") {
      const row = readRow(value, line, currency)
      last = row.ok ? row.value : undefined
      if (row.ok) result.rows.push(row.value)
      else rowErrors.push({ line, reason: row.error })
    } else if (tag === "86" && last) {
      last.memo = value.replaceAll("\n", "").trim() || undefined
      definedOnly(last)
      last = undefined
    }
  }
  return result
}

/** A balance field, `C260131EUR1234,56`: credit or debit mark, date, currency, amount. */
function readBalance(
  value: string,
  line: number,
): Result<{ balance: StatementBalance; currency: string }, string> {
  const mark = value[0]
  const currency = value.slice(7, 10)
  const amount = readDecimal(value.slice(10).trim(), currency)
  if (mark !== "C" && mark !== "D") {
    return err(`balance ${quote(value)} has no C or D mark`)
  }
  if (!amount.ok) return err(`balance: ${amount.error}`)
  return ok({
    balance: { amount: mark === "D" ? 0 - amount.value : amount.value, line },
    currency,
  })
}

/**
 * A `:61:` statement line: value date `YYMMDD`, optional entry date `MMDD`, mark (`C`, `D`, or
 * `RC`/`RD` for a reversal), optional funds code, amount `1234,56`, transaction type, the
 * customer's reference and, after `//`, the bank's. Read by position, without a regular expression.
 */
function readRow(
  value: string,
  line: number,
  currency: string,
): Result<StatementRow, string> {
  const [main] = value.split("\n")
  const valueDate = yymmdd(main.slice(0, 6))
  if (!valueDate) {
    return err(`value date ${quote(main.slice(0, 6))} is not YYMMDD`)
  }
  let at = 6
  let date = valueDate
  if (/^\d{4}$/.test(main.slice(6, 10))) {
    date = entryDate(valueDate, main.slice(6, 8), main.slice(8, 10)) ?? ""
    if (!date) return err(`entry date ${quote(main.slice(6, 10))} is not MMDD`)
    at = 10
  }
  const reversal = main[at] === "R"
  if (reversal) at++
  const mark = main[at++]
  if (mark !== "C" && mark !== "D") {
    return err(`no C or D mark in ${quote(main)}`)
  }
  // A reversed credit takes money out; a reversed debit puts it back.
  const negative = (mark === "D") !== reversal
  if (/[A-Z]/.test(main[at] ?? "")) at++
  const amountStart = at
  while (at < main.length && /[\d,]/.test(main[at])) at++
  const amount = readDecimal(main.slice(amountStart, at), currency)
  if (!amount.ok) return err(amount.error)
  const [customer = "", bank = ""] = main.slice(at + 4).split("//")
  return ok(definedOnly({
    line,
    date,
    amount: negative ? 0 - amount.value : amount.value,
    currency,
    reference: customer.trim() && customer.trim() !== "NONREF" ? customer.trim() : bank.trim(),
  }))
}

/** `YYMMDD` as `YYYY-MM-DD`, or `null`. */
function yymmdd(text: string): string | null {
  if (!/^\d{6}$/.test(text)) return null
  return parseDateWithPattern(
    `${text.slice(4, 6)}.${text.slice(2, 4)}.${text.slice(0, 2)}`,
    "DD.MM.YY",
  )
}

/** The entry date `MMDD` in the year that puts it nearest the value date, across New Year too. */
function entryDate(
  valueDate: string,
  month: string,
  day: string,
): string | null {
  let year = Number(valueDate.slice(0, 4))
  const valueMonth = Number(valueDate.slice(5, 7))
  if (valueMonth === 1 && month === "12") year--
  if (valueMonth === 12 && month === "01") year++
  return parseDateWithPattern(`${year}-${month}-${day}`, "YYYY-MM-DD")
}
