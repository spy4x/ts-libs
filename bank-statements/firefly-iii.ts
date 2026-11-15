/**
 * The reader of Firefly III's transactions export (`Export data`, `export_transactions.csv`).
 * Written from the file's documented shape; no Firefly III code is used.
 *
 * @module
 */

import { parseCsv } from "@spy4x/platform/universal/csv"
import type {
  HistoryAccount,
  HistoryAccountKind,
  HistoryEntry,
  HistoryItem,
  HistoryTransfer,
  ParsedHistory,
} from "./history.ts"
import { csvRecords } from "./profile.ts"
import {
  checkRowCount,
  checkTextSize,
  quote,
  readDecimal,
  readIsoDate,
  type RowError,
  StatementError,
  type StatementLimits,
} from "./statement.ts"

/** The columns a file must have; without any of them it is refused whole. */
const REQUIRED_COLUMNS = [
  "type",
  "amount",
  "currency_code",
  "date",
  "source_name",
  "destination_name",
  "description",
] as const

/** Firefly III's account types, by the kind they map to. A type not listed is `"other"`. */
const ACCOUNT_KINDS: Record<string, HistoryAccountKind> = {
  "asset account": "asset",
  "default account": "asset",
  "expense account": "expense",
  "beneficiary account": "expense",
  "revenue account": "revenue",
  "loan": "liability",
  "debt": "liability",
  "mortgage": "liability",
  "credit card": "liability",
}

/** Accounts Firefly III makes to balance its books. They hold no money and are left out. */
const BOOKKEEPING_ACCOUNTS = new Set([
  "initial balance account",
  "reconciliation account",
  "liability credit account",
])

/** Transaction types that set a balance on one account against a bookkeeping account. */
const BALANCE_TYPES = new Set(["opening balance", "reconciliation", "liability credit"])

/** What League CSV's formula escape puts a `'` before: `=`, `-`, `+`, `@`, tab and carriage return. */
const ESCAPED_LEADS = "=-+@\t\r"

/** `cell` without the `'` Firefly III puts before a cell that starts like a spreadsheet formula. */
function unescapeCell(cell: string): string {
  return cell.length > 1 && cell[0] === "'" && ESCAPED_LEADS.includes(cell[1])
    ? cell.slice(1)
    : cell
}

/**
 * Read Firefly III's transactions export. The header may list the columns in any order and may
 * carry extra ones. Withdrawals become entries on their source account, deposits entries on their
 * destination account, transfers transfers, and opening balances, reconciliations and liability
 * credits entries on the real account, signed as that account sees them. Each split is its own
 * entry; the rows of a split share `groupId`. Dates are the local date as written, never shifted
 * by the offset.
 *
 * Throws a {@link StatementError}: `"too-large"` over `maxBytes` or `maxRows`, `"malformed"` when
 * the header lacks a required column. A row that does not read (an unknown type, a bad date,
 * amount or currency, a missing account) becomes a row error with its line.
 */
export function parseFireflyIii(text: string, limits: StatementLimits = {}): ParsedHistory {
  checkTextSize(text, limits.maxBytes)
  const records = csvRecords(text)
  if (records.length === 0) throw new StatementError("malformed", "the file has no header")
  checkRowCount(records.length - 1, limits.maxRows)

  const header = parseCsv(records[0].text)
  if (!header.ok) {
    throw new StatementError("malformed", `the header does not read: ${header.error.type}`)
  }
  const columns = new Map<string, number>()
  ;(header.value[0] ?? []).forEach((name, index) => {
    const key = unescapeCell(name).trim().toLowerCase()
    if (!columns.has(key)) columns.set(key, index)
  })
  const missing = REQUIRED_COLUMNS.filter((name) => !columns.has(name))
  if (missing.length > 0) {
    throw new StatementError("malformed", `not a Firefly III export: no ${missing.join(", ")}`)
  }

  const history: ParsedHistory = {
    accounts: [],
    categories: [],
    entries: [],
    transfers: [],
    rowErrors: [],
  }
  const accounts = new Map<string, HistoryAccount>()
  const mixedCurrency = new Set<string>()
  const categories = new Set<string>()

  const noteAccount = (name: string, type: string, iban: string, currency: string) => {
    const kind = Object.hasOwn(ACCOUNT_KINDS, type) ? ACCOUNT_KINDS[type] : "other"
    const key = `${kind}\n${name}`
    let account = accounts.get(key)
    if (!account) {
      account = { name, kind }
      accounts.set(key, account)
      history.accounts.push(account)
    }
    if (iban && !account.iban) account.iban = iban
    if (kind !== "asset" && kind !== "liability" || mixedCurrency.has(key)) return
    if (!account.currency) account.currency = currency
    else if (account.currency !== currency) {
      delete account.currency
      mixedCurrency.add(key)
    }
  }

  for (const record of records.slice(1)) {
    const parsed = parseCsv(record.text)
    if (!parsed.ok) {
      history.rowErrors.push({ line: record.line, reason: `csv: ${parsed.error.type}` })
      continue
    }
    const fields = parsed.value[0] ?? []
    const cell = (name: string) => {
      const index = columns.get(name)
      return index === undefined ? "" : unescapeCell(fields[index] ?? "").trim()
    }
    const row = readRow(cell, record.line)
    if ("reason" in row) {
      history.rowErrors.push(row)
      continue
    }
    const source = cell("source_type").toLowerCase()
    const destination = cell("destination_type").toLowerCase()
    if (!BOOKKEEPING_ACCOUNTS.has(source)) {
      noteAccount(cell("source_name"), source, cell("source_iban"), row.currency)
    }
    if (!BOOKKEEPING_ACCOUNTS.has(destination)) {
      const currency = "to" in row ? row.foreignCurrency ?? row.currency : row.currency
      noteAccount(cell("destination_name"), destination, cell("destination_iban"), currency)
    }
    if (row.category && !categories.has(row.category)) {
      categories.add(row.category)
      history.categories.push({ name: row.category })
    }
    if ("to" in row) history.transfers.push(row)
    else history.entries.push(row)
  }
  return history
}

/** One row as an entry or a transfer, or the row error that says why it does not read. */
function readRow(
  cell: (name: string) => string,
  line: number,
): HistoryEntry | HistoryTransfer | RowError {
  const fail = (reason: string): RowError => ({ line, reason })
  const type = cell("type")
  const kind = type.toLowerCase()
  if (
    kind !== "withdrawal" && kind !== "deposit" && kind !== "transfer" && !BALANCE_TYPES.has(kind)
  ) {
    return fail(`unknown type ${quote(type)}`)
  }
  const date = readIsoDate(cell("date"), false)
  if (!date) return fail(`date ${quote(cell("date"))} is not ISO 8601`)
  const source = cell("source_name")
  const destination = cell("destination_name")
  if (!source) return fail("no source account")
  if (!destination) return fail("no destination account")

  const currency = cell("currency_code")
  const amount = readDecimal(cell("amount"), currency)
  if (!amount.ok) return fail(amount.error)
  let foreign: { amount: number; currency: string } | undefined
  if (cell("foreign_amount")) {
    const foreignCurrency = cell("foreign_currency_code")
    const read = readDecimal(cell("foreign_amount"), foreignCurrency)
    if (!read.ok) return fail(`foreign ${read.error}`)
    foreign = { amount: Math.abs(read.value), currency: foreignCurrency }
  }

  const item: HistoryItem = {
    line,
    date,
    description: cell("description"),
    tags: cell("tags").split(",").map((tag) => tag.trim()).filter((tag) => tag !== ""),
  }
  for (
    const [field, column] of [
      ["category", "category"],
      ["notes", "notes"],
      ["sourceId", "journal_id"],
      ["groupId", "group_id"],
    ] as const
  ) {
    if (cell(column)) item[field] = cell(column)
  }
  if (kind === "transfer") {
    const transfer: HistoryTransfer = {
      ...item,
      from: source,
      to: destination,
      amount: Math.abs(amount.value),
      currency,
    }
    if (foreign) {
      transfer.foreignAmount = foreign.amount
      transfer.foreignCurrency = foreign.currency
    }
    return transfer
  }

  // Which side holds the money, and so the sign as that account sees it.
  let account = source
  let payee: string | undefined = destination
  let sign = -1
  if (kind === "deposit") {
    account = destination
    payee = source
    sign = 1
  } else if (kind !== "withdrawal") {
    payee = undefined
    if (BOOKKEEPING_ACCOUNTS.has(cell("source_type").toLowerCase())) {
      account = destination
      sign = 1
    } else if (!BOOKKEEPING_ACCOUNTS.has(cell("destination_type").toLowerCase())) {
      return fail(`${type} has no initial balance or reconciliation account`)
    }
  }
  const entry: HistoryEntry = {
    ...item,
    account,
    // `|| 0` keeps a zero withdrawal at 0, not -0.
    amount: sign * Math.abs(amount.value) || 0,
    currency,
  }
  if (payee) entry.payee = payee
  if (foreign) {
    entry.foreignAmount = sign * foreign.amount || 0
    entry.foreignCurrency = foreign.currency
  }
  return entry
}
