/**
 * A household's history read from another money app's export: its accounts, categories, entries
 * and transfers, amounts in minor units. It reads Firefly III's transactions export
 * ({@link parseFireflyIii}) and Actual Budget's `Export data` zip ({@link parseActualBudget});
 * every reader returns the same {@link ParsedHistory}.
 *
 * ```ts
 * import { parseFireflyIii } from "@spy4x/bank-statements/app-exports"
 *
 * const csv = [
 *   "group_id,journal_id,type,currency_code,amount,description,date,source_name,source_type," +
 *   "destination_name,destination_type,category,tags",
 *   "1,1,Withdrawal,EUR,'-12.34,Lunch,2024-03-01T00:00:00+01:00,Checking,Asset account," +
 *   "Cafe,Expense account,Food,work",
 * ].join("\n")
 * const history = parseFireflyIii(csv)
 * // history.entries[0]: { account: "Checking", amount: -1234, currency: "EUR", payee: "Cafe", … }
 * ```
 *
 * Actual Budget's export is a SQLite database in a zip. It is read with sql.js, SQLite compiled to
 * WebAssembly, loaded only on the first call, so an app that reads only Firefly III never loads it:
 *
 * ```ts ignore
 * import { parseActualBudget } from "@spy4x/bank-statements/app-exports"
 *
 * const zip = new Uint8Array(await upload.arrayBuffer())
 * const history = await parseActualBudget(zip, { currency: "EUR" })
 * ```
 *
 * The file comes from a stranger, so `maxBytes` (10 MiB for Firefly III, 32 MiB for an Actual zip)
 * and `maxRows` (100,000) are on by default, and Actual's database may inflate to at most 128 MiB,
 * checked against the zip's directory before inflating and again while inflating. A cell is at
 * most 10,000 characters, and no regular expression that can backtrack runs over the input. A file
 * refused whole throws a `StatementError` from `@spy4x/bank-statements`; a row that does not read
 * becomes a row error with its line.
 *
 * @module
 */

export { parseFireflyIii } from "./firefly-iii.ts"
export {
  type ActualBudgetOptions,
  DEFAULT_MAX_ACTUAL_BYTES,
  DEFAULT_MAX_DATABASE_BYTES,
  parseActualBudget,
} from "./actual-budget.ts"
export type {
  HistoryAccount,
  HistoryAccountKind,
  HistoryCategory,
  HistoryEntry,
  HistoryItem,
  HistoryTransfer,
  ParsedHistory,
} from "./history.ts"
