/**
 * The shape every money-app export reader returns: a household's accounts, categories, entries and
 * transfers, read from one file.
 *
 * @module
 */

import type { RowError } from "./statement.ts"

/** What an account is for. An expense or revenue account is a counterparty, not money held. */
export type HistoryAccountKind = "asset" | "expense" | "revenue" | "liability" | "other"

/** One account the file names. */
export interface HistoryAccount {
  name: string
  kind: HistoryAccountKind
  /** The ISO 4217 code, when every row on this asset or liability account uses one currency. */
  currency?: string
  iban?: string
}

/** One category the file names. */
export interface HistoryCategory {
  name: string
}

/** What an entry and a transfer both carry. */
export interface HistoryItem {
  /** The 1-based line of the file where the row starts, as a text editor shows it. */
  line: number
  /** The booking date, `YYYY-MM-DD`, as the file writes it. */
  date: string
  description: string
  category?: string
  tags: string[]
  notes?: string
  /** The app's own id for this row. */
  sourceId?: string
  /** The app's id for the group this row belongs to; the rows of one split share it. */
  groupId?: string
}

/** Money in or out of one account. Amounts are whole numbers of the currency's minor unit. */
export interface HistoryEntry extends HistoryItem {
  /** The name of the account the money moved on. */
  account: string
  /** Signed: money in is positive, money out negative. */
  amount: number
  /** The ISO 4217 code of `amount`. */
  currency: string
  /** The amount in the currency it was spent in, with the sign of `amount`. */
  foreignAmount?: number
  foreignCurrency?: string
  /** The other side: who was paid, or who paid. */
  payee?: string
}

/** Money moved between two of the household's accounts. Amounts are positive minor units. */
export interface HistoryTransfer extends HistoryItem {
  from: string
  to: string
  /** What left `from`, in `currency`. */
  amount: number
  currency: string
  /** What reached `to`, when it is another currency. */
  foreignAmount?: number
  foreignCurrency?: string
}

/** What a reader got from one export file. */
export interface ParsedHistory {
  accounts: HistoryAccount[]
  categories: HistoryCategory[]
  entries: HistoryEntry[]
  transfers: HistoryTransfer[]
  /** Rows that could not be read, each with its line and why. */
  rowErrors: RowError[]
}
