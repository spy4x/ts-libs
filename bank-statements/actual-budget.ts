/**
 * The reader of Actual Budget's `Export data` zip: `db.sqlite`, the budget's SQLite database, read
 * with sql.js (SQLite compiled to WebAssembly), which loads only when an export is read. Its build
 * with the WebAssembly inlined is used, so nothing is read from disk or fetched, on a server or in
 * a browser. Written from the database's documented schema; no Actual Budget code is used.
 *
 * @module
 */

import { currencyDecimals, isCurrencyCode } from "@spy4x/platform/universal/money-core"
import type {
  HistoryAccount,
  HistoryCategory,
  HistoryEntry,
  HistoryItem,
  HistoryTransfer,
  ParsedHistory,
} from "./history.ts"
import {
  DEFAULT_MAX_ROWS,
  quote,
  readIsoDate,
  StatementError,
  type StatementLimits,
} from "./statement.ts"
import { isZip, listZipEntries, readZipEntry } from "./zip.ts"

/** Options of {@link parseActualBudget}. */
export interface ActualBudgetOptions extends StatementLimits {
  /** Most bytes the zip may have. Default {@link DEFAULT_MAX_ACTUAL_BYTES}, 32 MiB. */
  maxBytes?: number
  /** Most bytes `db.sqlite` may have once inflated. Default {@link DEFAULT_MAX_DATABASE_BYTES}. */
  maxDatabaseBytes?: number
  /**
   * The ISO 4217 code of every amount. Default: the budget's own currency setting
   * (`defaultCurrencyCode`); a budget without one is refused unless this is given.
   */
  currency?: string
}

/** The default `maxBytes` of an Actual Budget export: 32 MiB of zip. */
export const DEFAULT_MAX_ACTUAL_BYTES = 32 * 1024 * 1024

/** The default `maxDatabaseBytes`: 128 MiB, room for years of history and Actual's sync log. */
export const DEFAULT_MAX_DATABASE_BYTES = 128 * 1024 * 1024

/** The most characters a name or a note may have; a longer one makes its row a row error. */
const MAX_TEXT = 10_000

/** What every SQLite 3 file starts with. */
const SQLITE_MAGIC = "SQLite format 3\0"

/**
 * The tables read, each by one fixed query that {@link readTable} ends with a `LIMIT`. A table that
 * is missing refuses the file.
 */
const QUERIES = {
  accounts: "SELECT id, name, tombstone FROM accounts ORDER BY sort_order, id",
  payees: "SELECT id, name, transfer_acct, tombstone FROM payees",
  payee_mapping: "SELECT id, targetId FROM payee_mapping",
  categories: "SELECT id, name, cat_group, tombstone FROM categories ORDER BY sort_order, id",
  category_groups: "SELECT id, name, tombstone FROM category_groups",
  category_mapping: "SELECT id, transferId FROM category_mapping",
  transactions:
    "SELECT id, isParent, isChild, acct, category, IFNULL(amount, 0), description, notes, date, " +
    "parent_id, transferred_id FROM transactions WHERE IFNULL(tombstone, 0) = 0 ORDER BY date, id",
} as const

/** Each table's columns, by a fixed query, to find a generated column, which runs code on read. */
const COLUMN_QUERIES = {
  accounts: "SELECT hidden FROM pragma_table_xinfo('accounts')",
  payees: "SELECT hidden FROM pragma_table_xinfo('payees')",
  payee_mapping: "SELECT hidden FROM pragma_table_xinfo('payee_mapping')",
  categories: "SELECT hidden FROM pragma_table_xinfo('categories')",
  category_groups: "SELECT hidden FROM pragma_table_xinfo('category_groups')",
  category_mapping: "SELECT hidden FROM pragma_table_xinfo('category_mapping')",
  transactions: "SELECT hidden FROM pragma_table_xinfo('transactions')",
  preferences: "SELECT hidden FROM pragma_table_xinfo('preferences')",
} as const

const CURRENCY_QUERY = "SELECT value FROM preferences WHERE id = 'defaultCurrencyCode' LIMIT 1"
const SCHEMA_QUERY = "SELECT type, name, sql FROM sqlite_master WHERE name IN (" +
  Object.keys(COLUMN_QUERIES).map((table) => `'${table}'`).join(", ") + ")"

/** One SQLite value as sql.js returns it. */
type SqlValue = number | string | Uint8Array | null

/** The part of sql.js this reader uses. */
interface SqlDatabase {
  exec(sql: string): { columns: string[]; values: SqlValue[][] }[]
  close(): void
}

/** sql.js, loaded on the first export read and kept for the next. */
let sqlJs: Promise<{ Database: new (data: Uint8Array) => SqlDatabase }> | undefined

/** sql.js's module, loaded once. */
function loadSqlJs() {
  sqlJs ??= import("sql.js/dist/sql-wasm-inline.js").then(({ default: init }) => init())
  return sqlJs
}

/**
 * Read Actual Budget's `Export data` zip. Every account is an asset account, since Actual marks no
 * debt; closed and off-budget accounts are listed too. Every category is listed, with its group.
 * Each transaction becomes an entry on its account, its payee as both `payee` and `description`;
 * the parent of a split is left out and its parts are entries sharing `groupId`, the parent's id.
 * The two sides of a transfer become one transfer, from the account the money left. A transfer
 * whose other side is gone is an entry, so its account still adds up. Merged payees and categories
 * read as the one they were merged into; deleted rows are skipped. Tags stay inside `notes`, as
 * Actual keeps them.
 *
 * Actual stores every amount in hundredths. They become `currency`'s minor units: multiplied for a
 * currency with three decimals, divided for one with none, and a row error when that leaves a
 * fraction (¥1,500.50). `line` is the 1-based place of the transaction among the live ones, by
 * date and then id; `sourceId` is Actual's id.
 *
 * `maxRows` caps every table read, not only the live transactions: accounts, payees, categories,
 * category groups and the two merge tables may each hold at most that many rows, deleted ones
 * included (default 100,000; a real budget has a few thousand payees at most). Each table is read
 * with a `LIMIT` one past `maxRows`, so no read loads more rows than that, whatever the file's
 * indexes claim.
 *
 * Throws a {@link StatementError}: `"too-large"` over `maxBytes` or `maxDatabaseBytes`, checked
 * before the database opens, or over `maxRows` in any table, found when its read returns one row
 * past the limit; `"malformed"` when the file is not a zip, holds no `db.sqlite`, or that is not
 * SQLite or lacks one of Actual's tables; `"unsupported"` for a zip it does not read (encrypted,
 * zip64), a table that is a view or computes a column, or a budget without a currency when
 * `currency` is not given. A `currency` that is not an ISO 4217 code, or a `maxRows` that is not
 * a positive whole number, throws a `RangeError`.
 */
export async function parseActualBudget(
  zip: Uint8Array,
  options: ActualBudgetOptions = {},
): Promise<ParsedHistory> {
  if (options.currency !== undefined && !isCurrencyCode(options.currency)) {
    throw new RangeError(`currency ${quote(options.currency)} is not an ISO 4217 code`)
  }
  // It is written into each query's LIMIT.
  const maxRows = options.maxRows ?? DEFAULT_MAX_ROWS
  if (!Number.isSafeInteger(maxRows) || maxRows < 1) {
    throw new RangeError(`maxRows ${maxRows} is not a positive whole number`)
  }
  const maxBytes = options.maxBytes ?? DEFAULT_MAX_ACTUAL_BYTES
  if (zip.length > maxBytes) {
    throw new StatementError("too-large", `file is over ${maxBytes} bytes`)
  }
  if (!isZip(zip)) throw new StatementError("malformed", "not an Actual Budget export: not a zip")
  const entry = listZipEntries(zip).find((entry) => entry.name === `db.sqlite`)
  if (!entry) throw new StatementError("malformed", "not an Actual Budget export: no db.sqlite")
  const file = await readZipEntry(
    zip,
    entry,
    options.maxDatabaseBytes ?? DEFAULT_MAX_DATABASE_BYTES,
  )
  if (new TextDecoder().decode(file.subarray(0, SQLITE_MAGIC.length)) !== SQLITE_MAGIC) {
    throw new StatementError("malformed", "db.sqlite is not a SQLite database")
  }

  const { Database } = await loadSqlJs()
  let db: SqlDatabase | undefined
  try {
    db = new Database(file)
    return readBudget(db, options.currency, maxRows)
  } catch (error) {
    if (error instanceof StatementError) throw error
    throw new StatementError("malformed", "db.sqlite is not an Actual Budget database")
  } finally {
    db?.close()
  }
}

/** The rows of one fixed query. */
function rows(db: SqlDatabase, sql: string): SqlValue[][] {
  return db.exec(sql)[0]?.values ?? []
}

/**
 * The rows of `table`, read by its query in {@link QUERIES} with a `LIMIT` one past `maxRows`. A
 * count would not do: SQLite counts through an index, and the file brings its own, which may list
 * none of the rows. Throws `"too-large"` when the read returns more than `maxRows` rows.
 */
function readTable(db: SqlDatabase, table: keyof typeof QUERIES, maxRows: number): SqlValue[][] {
  const result = rows(db, `${QUERIES[table]} LIMIT ${maxRows + 1}`)
  if (result.length > maxRows) {
    throw new StatementError("too-large", `${table} holds more than ${maxRows} rows`)
  }
  return result
}

/** A cell as text: `""` for null, a number written out, and a blob as nothing. */
function text(value: SqlValue): string {
  return typeof value === "string" ? value : typeof value === "number" ? String(value) : ""
}

/** The history in an open Actual Budget database. */
function readBudget(
  db: SqlDatabase,
  currencyOption: string | undefined,
  maxRows: number,
): ParsedHistory {
  const hasPreferences = checkSchema(db)
  const fromFile = hasPreferences ? rows(db, CURRENCY_QUERY)[0]?.[0] : undefined
  const currency = currencyOption ?? (isCurrencyCode(fromFile) ? fromFile : undefined)
  if (!currency) {
    throw new StatementError(
      "unsupported",
      "the budget names no currency; pass the currency option",
    )
  }
  // Actual stores hundredths whatever the currency.
  const decimals = currencyDecimals(currency)

  const history: ParsedHistory = {
    accounts: [],
    categories: [],
    entries: [],
    transfers: [],
    rowErrors: [],
  }

  const accounts = new Map<string, string>()
  for (const [id, name, tombstone] of readTable(db, "accounts", maxRows)) {
    if (tombstone === 1) continue
    accounts.set(text(id), text(name))
    if (text(name).length > MAX_TEXT) continue
    const account: HistoryAccount = { name: text(name), kind: "asset", currency }
    history.accounts.push(account)
  }

  const payeeTargets = new Map(
    readTable(db, "payee_mapping", maxRows).map(([id, to]) => [text(id), text(to)]),
  )
  const payees = new Map<string, { name: string; transferAccount: string }>()
  for (const [id, name, transferAccount, tombstone] of readTable(db, "payees", maxRows)) {
    if (tombstone !== 1) {
      payees.set(text(id), { name: text(name), transferAccount: text(transferAccount) })
    }
  }

  const groups = new Map<string, string>()
  for (const [id, name, tombstone] of readTable(db, "category_groups", maxRows)) {
    if (tombstone !== 1) groups.set(text(id), text(name))
  }
  const categoryTargets = new Map(
    readTable(db, "category_mapping", maxRows).map(([id, to]) => [text(id), text(to)]),
  )
  const categories = new Map<string, HistoryCategory>()
  for (const [id, name, group, tombstone] of readTable(db, "categories", maxRows)) {
    if (tombstone === 1) continue
    const category: HistoryCategory = { name: text(name) }
    const groupName = groups.get(text(group))
    if (groupName) category.group = groupName
    categories.set(text(id), category)
    if (category.name.length <= MAX_TEXT && (groupName ?? "").length <= MAX_TEXT) {
      history.categories.push(category)
    }
  }

  const transactions = readTable(db, "transactions", maxRows).map((
    [id, isParent, isChild, account, category, amount, payee, notes, date, parent, transfer],
    index,
  ) => ({
    line: index + 1,
    id: text(id),
    isParent: isParent === 1,
    isChild: isChild === 1,
    account: text(account),
    category: text(category),
    amount,
    payee: text(payee),
    notes: text(notes),
    date: text(date),
    parent: text(parent),
    transfer: text(transfer),
  }))
  const byId = new Map(transactions.map((row) => [row.id, row]))
  type Row = typeof transactions[number]

  /** `row`'s amount in minor units of `currency`, or why not. */
  const minorUnits = (row: Row): number | string => {
    if (typeof row.amount !== "number" || !Number.isSafeInteger(row.amount)) {
      return `amount ${quote(text(row.amount))} is not a whole number of hundredths`
    }
    if (decimals >= 2) {
      const scaled = row.amount * 10 ** (decimals - 2)
      return Number.isSafeInteger(scaled) ? scaled : `amount ${row.amount} is too large`
    }
    const divisor = 10 ** (2 - decimals)
    if (row.amount % divisor !== 0) {
      return `amount ${row.amount / 100} has a fraction ${currency} does not have`
    }
    return row.amount / divisor
  }

  for (const row of transactions) {
    if (row.isParent) continue
    if (row.isChild) {
      const parent = byId.get(row.parent)
      // Actual itself hides the parts of a deleted split.
      if (!parent?.isParent) continue
    }
    const fail = (reason: string) => history.rowErrors.push({ line: row.line, reason })
    const account = accounts.get(row.account)
    if (account === undefined) {
      fail(`account ${quote(row.account)} is not in the budget`)
      continue
    }
    const date = readIsoDate(row.date, true)
    if (!date || row.date.length !== 8) {
      fail(`date ${quote(row.date)} is not YYYYMMDD`)
      continue
    }
    const amount = minorUnits(row)
    if (typeof amount === "string") {
      fail(amount)
      continue
    }

    const category = categories.get(categoryTargets.get(row.category) ?? row.category)
    const payee = payees.get(payeeTargets.get(row.payee) ?? row.payee)
    const item: HistoryItem = { line: row.line, date, description: "", tags: [], sourceId: row.id }
    if (category) item.category = category.name
    if (row.notes) item.notes = row.notes
    if (row.isChild) item.groupId = row.parent

    const other = row.transfer ? byId.get(row.transfer) : undefined
    const otherAccount = other?.transfer === row.id ? accounts.get(other.account) : undefined
    // A transfer whose other side is gone is paid to the account its payee stands for.
    const payeeName = payee?.transferAccount
      ? accounts.get(payee.transferAccount) ?? payee.name
      : payee?.name ?? ""
    const texts = [account, otherAccount ?? "", payeeName, row.notes, category?.name ?? ""]
    if (texts.some((value) => value.length > MAX_TEXT)) {
      fail(`a name or note is over ${MAX_TEXT} characters`)
      continue
    }

    if (other && otherAccount !== undefined) {
      // One transfer, written from the side the money left; the other side is skipped.
      if (amount > 0 || amount === 0 && row.id > other.id) continue
      const transfer: HistoryTransfer = {
        ...item,
        from: account,
        to: otherAccount,
        amount: -amount || 0,
        currency,
      }
      history.transfers.push(transfer)
      continue
    }

    const entry: HistoryEntry = { ...item, account, amount, currency }
    if (payeeName) {
      entry.payee = payeeName
      entry.description = payeeName
    }
    history.entries.push(entry)
  }
  return history
}

/**
 * Throws unless every table read is a plain table: a view runs a query of the file's choosing, and
 * a generated column runs an expression on each read. A missing table is `"malformed"`, except
 * `preferences`, which budgets made before 2024 lack. Returns whether `preferences` is there.
 */
function checkSchema(db: SqlDatabase): boolean {
  const objects = new Map<string, { type: string; sql: string }>()
  for (const [type, name, sql] of rows(db, SCHEMA_QUERY)) {
    objects.set(text(name), { type: text(type), sql: text(sql) })
  }
  for (const [table, columns] of Object.entries(COLUMN_QUERIES)) {
    const object = objects.get(table)
    if (!object) {
      if (table === "preferences") continue
      throw new StatementError("malformed", `not an Actual Budget database: no ${table} table`)
    }
    if (object.type !== "table" || !/^create table/i.test(object.sql)) {
      throw new StatementError("unsupported", `${table} is not a plain table`)
    }
    if (rows(db, columns).some(([hidden]) => hidden === 2 || hidden === 3)) {
      throw new StatementError("unsupported", `${table} has a generated column`)
    }
  }
  return objects.has("preferences")
}
