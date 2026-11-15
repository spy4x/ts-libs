/**
 * A household's history read from another money app's export: its accounts, categories, entries
 * and transfers, amounts in minor units. Today it reads Firefly III's transactions export
 * ({@link parseFireflyIii}); every reader returns the same {@link ParsedHistory}.
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
 * The file comes from a stranger, so `maxBytes` (10 MiB) and `maxRows` (100,000) are on by
 * default, a cell is at most 10,000 characters, and no regular expression that can backtrack runs
 * over the input. A file refused whole throws a `StatementError` from `@spy4x/bank-statements`; a
 * row that does not read becomes a row error with its line.
 *
 * @module
 */

export { parseFireflyIii } from "./firefly-iii.ts"
export type {
  HistoryAccount,
  HistoryAccountKind,
  HistoryCategory,
  HistoryEntry,
  HistoryItem,
  HistoryTransfer,
  ParsedHistory,
} from "./history.ts"
