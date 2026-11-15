/**
 * The reader of YNAB's "Export budget": the zip, or the register CSV inside it
 * (`<Budget> as of <date> - Register.csv`). Written from the file's shape; no YNAB code is used.
 *
 * @module
 */

import { decodeTextFile, parseCsv } from "@spy4x/platform/universal/csv"
import { currencyDecimals, isCurrencyCode, parseAmount } from "@spy4x/platform/universal/money-core"
import { err, ok, type Result } from "@spy4x/platform/universal/result"
import { parseDateWithPattern } from "@spy4x/time/date"
import type {
  HistoryAccount,
  HistoryEntry,
  HistoryItem,
  HistoryTransfer,
  ParsedHistory,
} from "./history.ts"
import { csvRecords } from "./profile.ts"
import {
  checkRowCount,
  checkTextSize,
  DEFAULT_MAX_BYTES,
  quote,
  StatementError,
  type StatementLimits,
} from "./statement.ts"
import { isZip, listZipEntries, readZipEntry } from "./zip.ts"

/** The order of day, month and year in a date: `30.12.2026` is `"dmy"`, `12/30/2026` `"mdy"`. */
export type DateOrder = "dmy" | "mdy" | "ymd"

/** Options for {@link parseYnab}. */
export interface ParseYnabOptions extends StatementLimits {
  /** The budget's ISO 4217 currency. The export does not name it. */
  currency: string
  /**
   * The order of the parts of each date, as the budget's date format writes it. Without it the
   * file decides: a first part of four digits is `"ymd"`, a first part over 12 `"dmy"`, a second
   * part over 12 `"mdy"`; a file where no date tells is refused.
   */
  dateOrder?: DateOrder
}

/** The columns a register must have; without any of them it is refused whole. */
const REQUIRED_COLUMNS = ["account", "date", "payee", "outflow", "inflow"] as const

/** How YNAB writes the payee of a transfer: `Transfer : Savings`. */
const TRANSFER_PREFIX = "Transfer : "

/** The payee of the row that sets an account's first balance. */
const STARTING_BALANCE = "Starting Balance"

/** One register row, read. */
interface RegisterRow {
  item: HistoryItem
  account: string
  amount: number
  /** The other account, when the row is a transfer. */
  target?: string
  payee?: string
  split?: { part: number; parts: number }
}

/**
 * Read YNAB's "Export budget": the zip (only its register is read; the plan is not), or the
 * register CSV alone, as text or bytes. Every row becomes an entry on its account with
 * `inflow - outflow` as its amount, except transfers.
 *
 * - Accounts: every account the register names, transfer targets too, of kind `"asset"` with
 *   `options.currency`, since the register names no kinds: a credit card is an asset here.
 * - Transfers: a row whose payee is `Transfer : <account>`. YNAB writes each transfer twice, once
 *   on each account; the two rows (same date, opposite amounts, each naming the other account)
 *   become one transfer, read from the row the money left. A row whose other half is missing (a
 *   closed or deleted account) is still a transfer, from or to the account it names.
 * - Categories: `Group: Category`, as YNAB shows it. The inflow category (`Inflow: Ready to
 *   Assign`) is not a category, so such rows have none.
 * - Splits: YNAB writes each part as a row with the memo `Split (2/3) <memo>`. Each part is its own
 *   entry or transfer with the prefix gone from its notes; the parts of one split (consecutive rows
 *   on one account and date, counting 1 to the last) share a `groupId` made up here, `split:<line>`.
 * - `description` is the payee, else the memo; `notes` the memo; `tags` the flag, as `flag:red`.
 *   A `Starting Balance` row is an entry without a payee. The `Cleared` column is not read.
 *
 * Throws a {@link StatementError}: `"too-large"` over `maxBytes` (the zip, or its register before
 * and while it inflates) or `maxRows`, `"malformed"` for a broken or unsupported zip, a zip without
 * a register, a register without a required column, or dates whose order no row tells. Throws a
 * `RangeError` when `options.currency` is not an ISO 4217 code. A row that does not read (a bad
 * date or amount, no account) becomes a row error with its line.
 */
export async function parseYnab(
  input: Uint8Array | string,
  options: ParseYnabOptions,
): Promise<ParsedHistory> {
  if (!isCurrencyCode(options.currency)) {
    throw new RangeError(
      `currency must be an ISO 4217 code, got ${quote(String(options.currency))}`,
    )
  }
  let text: string
  if (typeof input === "string") {
    checkTextSize(input, options.maxBytes)
    // A byte-order mark goes with the first header cell's `trim()`.
    text = input
  } else text = await registerText(input, options.maxBytes ?? DEFAULT_MAX_BYTES)
  return readRegister(text, options)
}

/** The register's text from the bytes of a zip or of the CSV itself. */
async function registerText(bytes: Uint8Array, maxBytes: number): Promise<string> {
  if (bytes.length > maxBytes) {
    throw new StatementError("too-large", `file is over ${maxBytes} bytes`)
  }
  if (!isZip(bytes)) return decodeTextFile(bytes).text
  const entry = listZipEntries(bytes).find((entry) =>
    entry.name.toLowerCase().endsWith("register.csv")
  )
  if (!entry) throw new StatementError("malformed", "the zip holds no register (… Register.csv)")
  return decodeTextFile(await readZipEntry(bytes, entry, maxBytes)).text
}

function readRegister(text: string, options: ParseYnabOptions): ParsedHistory {
  const records = csvRecords(text)
  if (records.length === 0) throw new StatementError("malformed", "the file has no header")
  checkRowCount(records.length - 1, options.maxRows)

  const header = parseCsv(records[0].text)
  if (!header.ok) {
    throw new StatementError("malformed", `the header does not read: ${header.error.type}`)
  }
  const columns = new Map<string, number>()
  ;(header.value[0] ?? []).forEach((name, index) => {
    const key = name.trim().toLowerCase()
    if (!columns.has(key)) columns.set(key, index)
  })
  const missing = REQUIRED_COLUMNS.filter((name) => !columns.has(name))
  if (missing.length > 0) {
    throw new StatementError("malformed", `not a YNAB register: no ${missing.join(", ")}`)
  }

  const history: ParsedHistory = {
    accounts: [],
    categories: [],
    entries: [],
    transfers: [],
    rowErrors: [],
  }
  const rows: { line: number; cell: (name: string) => string }[] = []
  for (const record of records.slice(1)) {
    const parsed = parseCsv(record.text)
    if (!parsed.ok) {
      history.rowErrors.push({ line: record.line, reason: `csv: ${parsed.error.type}` })
      continue
    }
    const fields = parsed.value[0] ?? []
    rows.push({
      line: record.line,
      cell: (name) => {
        const index = columns.get(name)
        return index === undefined ? "" : (fields[index] ?? "").trim()
      },
    })
  }
  const order = options.dateOrder ?? detectDateOrder(rows.map((row) => row.cell("date")))

  const accounts = new Set<string>()
  const noteAccount = (name: string) => {
    if (accounts.has(name)) return
    accounts.add(name)
    const account: HistoryAccount = { name, kind: "asset", currency: options.currency }
    history.accounts.push(account)
  }
  const categories = new Set<string>()
  // Transfer rows still waiting for their other half, by date, accounts and signed amount, first
  // in first out. Each holds the index of the transfer it was written to, so the pair replaces it
  // in place. A key holds only rows that pair with the same partner, so a lookup never scans.
  const waiting = new Map<string, { rows: { row: RegisterRow; index: number }[]; next: number }>()
  let split: { account: string; date: string; parts: number; next: number; id: string } | undefined

  for (const { line, cell } of rows) {
    const row = readRow(cell, line, order, options.currency)
    if ("reason" in row) {
      history.rowErrors.push(row)
      continue
    }
    const { item } = row
    if (!row.split) split = undefined
    else {
      const { part, parts } = row.split
      if (
        !split || split.account !== row.account || split.date !== item.date ||
        split.parts !== parts || split.next !== part
      ) {
        split = part === 1
          ? { account: row.account, date: item.date, parts, next: 1, id: `split:${line}` }
          : undefined
      }
      if (split) {
        item.groupId = split.id
        split.next++
        if (split.next > split.parts) split = undefined
      }
    }
    noteAccount(row.account)
    if (item.category && !categories.has(item.category)) {
      categories.add(item.category)
      history.categories.push({ name: item.category })
    }

    if (row.target === undefined) {
      const entry: HistoryEntry = {
        ...item,
        account: row.account,
        amount: row.amount,
        currency: options.currency,
      }
      if (row.payee) entry.payee = row.payee
      history.entries.push(entry)
      continue
    }

    noteAccount(row.target)
    const partner = waiting.get(`${item.date}\n${row.target}\n${row.account}\n${-row.amount}`)
    if (partner && partner.next < partner.rows.length) {
      const other = partner.rows[partner.next++]
      const [out, into] = other.row.amount <= row.amount ? [other.row, row] : [row, other.row]
      history.transfers[other.index] = transferOf(out, out.account, into.account, options.currency)
      continue
    }
    const [from, to] = row.amount < 0 ? [row.account, row.target] : [row.target, row.account]
    const key = `${item.date}\n${row.account}\n${row.target}\n${row.amount}`
    const own = waiting.get(key) ?? { rows: [], next: 0 }
    own.rows.push({ row, index: history.transfers.length })
    waiting.set(key, own)
    history.transfers.push(transferOf(row, from, to, options.currency))
  }
  return history
}

function transferOf(row: RegisterRow, from: string, to: string, currency: string): HistoryTransfer {
  return { ...row.item, from, to, amount: Math.abs(row.amount), currency }
}

/** One row read, or the row error that says why it does not read. */
function readRow(
  cell: (name: string) => string,
  line: number,
  order: DateOrder,
  currency: string,
): RegisterRow | { line: number; reason: string } {
  const fail = (reason: string) => ({ line, reason })
  const account = cell("account")
  if (!account) return fail("no account")
  const date = readDate(cell("date"), order)
  if (!date) return fail(`date ${quote(cell("date"))} is not ${order} order`)
  const outflow = readMoney(cell("outflow"), currency)
  if (!outflow.ok) return fail(`outflow ${outflow.error}`)
  const inflow = readMoney(cell("inflow"), currency)
  if (!inflow.ok) return fail(`inflow ${inflow.error}`)

  let notes = cell("memo")
  const split = splitPart(notes)
  if (split) notes = split.memo
  const payee = cell("payee")
  let category = cell("category group/category")
  if (!category) {
    const group = cell("category group")
    category = group && cell("category") ? `${group}: ${cell("category")}` : cell("category")
  }
  const flag = cell("flag").toLowerCase()
  const item: HistoryItem = {
    line,
    date,
    description: payee || notes,
    tags: flag ? [`flag:${flag}`] : [],
  }
  if (category && !category.toLowerCase().startsWith("inflow:")) item.category = category
  if (notes) item.notes = notes

  const row: RegisterRow = { item, account, amount: inflow.value - outflow.value }
  if (split) row.split = { part: split.part, parts: split.parts }
  const target = payee.startsWith(TRANSFER_PREFIX) ? payee.slice(TRANSFER_PREFIX.length).trim() : ""
  if (target) row.target = target
  else if (payee && payee !== STARTING_BALANCE) row.payee = payee
  return row
}

/** `Split (2/3) Lunch` as part 2 of 3 with the memo `Lunch`, or `null` for any other memo. */
function splitPart(memo: string): { part: number; parts: number; memo: string } | null {
  if (!memo.startsWith("Split (")) return null
  const close = memo.indexOf(")", 7)
  if (close === -1) return null
  const numbers = memo.slice(7, close).split("/")
  if (numbers.length !== 2 || !numbers.every((number) => /^\d{1,4}$/.test(number))) return null
  const [part, parts] = numbers.map(Number)
  if (part < 1 || part > parts) return null
  return { part, parts, memo: memo.slice(close + 1).trim() }
}

/** The three digit groups of a date such as `30.12.2026` or `2026-12-30`, or `null`. */
function dateParts(text: string): string[] | null {
  const parts = text.split(/[./-]/)
  return parts.length === 3 && parts.every((part) => /^\d{1,4}$/.test(part)) ? parts : null
}

/** `text` as `YYYY-MM-DD`, its parts in `order`, or `null` when it is no calendar date. */
function readDate(text: string, order: DateOrder): string | null {
  const parts = dateParts(text)
  if (!parts) return null
  const [year, month, day] = order === "ymd"
    ? parts
    : order === "dmy"
    ? [parts[2], parts[1], parts[0]]
    : [parts[2], parts[0], parts[1]]
  if (year.length !== 4 || month.length > 2 || day.length > 2) return null
  return parseDateWithPattern(
    `${year}-${month.padStart(2, "0")}-${day.padStart(2, "0")}`,
    "YYYY-MM-DD",
  )
}

/** The date order every date in `texts` fits, or a `malformed` error when none or two do. */
function detectDateOrder(texts: string[]): DateOrder {
  let dayFirst = false
  let monthFirst = false
  let short = false
  for (const text of texts) {
    const parts = dateParts(text)
    if (!parts || parts[0].length === 4) continue
    short = true
    if (Number(parts[0]) > 12) dayFirst = true
    else if (Number(parts[1]) > 12) monthFirst = true
  }
  if (!short) return "ymd"
  if (dayFirst && monthFirst) {
    throw new StatementError("malformed", "dates are day-first and month-first; pass dateOrder")
  }
  if (dayFirst) return "dmy"
  if (monthFirst) return "mdy"
  throw new StatementError(
    "malformed",
    "no date tells day-first from month-first; pass dateOrder",
  )
}

/**
 * An amount written in the budget's currency format (`$1,234.56`, `1.234,56 €`, `kr. 5,00`,
 * `-$5.00`) as minor units of `currency`; an empty cell is 0. Symbols, letters and spaces are
 * dropped. The last `.` or `,` is the decimal mark when the digits after it are no more than the
 * currency has (two for EUR, none for JPY); otherwise it groups thousands.
 */
function readMoney(text: string, currency: string): Result<number, string> {
  let kept = ""
  for (const char of text) if ("0123456789.,-()".includes(char)) kept += char
  // A mark is kept only between digits, so the dot of `kr.` or `Fr.` goes with its symbol.
  let number = ""
  for (let at = 0; at < kept.length; at++) {
    const char = kept[at]
    if (
      (char === "." || char === ",") &&
      !(isDigit(kept[at - 1]) && isDigit(kept[at + 1]))
    ) continue
    number += char
  }
  if (number === "") return text === "" ? ok(0) : err(`${quote(text)} is not an amount`)

  const last = Math.max(number.lastIndexOf("."), number.lastIndexOf(","))
  let decimal: "." | "," = "."
  let group: "." | "," = ","
  if (last !== -1) {
    let digits = 0
    while (isDigit(number[last + 1 + digits])) digits++
    const mark = number[last] as "." | ","
    const other = mark === "." ? "," : "."
    if (digits <= currencyDecimals(currency)) [decimal, group] = [mark, other]
    else [decimal, group] = [other, mark]
  }
  const read = parseAmount(number, currency, { decimal, group }, {
    negatives: ["minus", "parentheses", "trailing-minus"],
  })
  return read.ok ? read : err(`${quote(text)} is not an amount`)
}

function isDigit(char: string | undefined): boolean {
  return char !== undefined && char >= "0" && char <= "9"
}
