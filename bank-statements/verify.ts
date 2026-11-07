/**
 * Checking a statement against its own balances, so a misread column shows instead of corrupting
 * every total after it.
 *
 * @module
 */

import type { ParsedStatement, StatementBalance, StatementRow } from "./statement.ts"

/** One reason a statement did not verify. */
export type BalanceFailure =
  /** A row the parser could not read. */
  | { type: "row-error"; line: number; reason: string }
  /** A row whose balance is not the one before it plus its amount. */
  | { type: "running"; line: number; expected: number; found: number }
  /** A closing balance that the opening balance and the amounts do not add up to. */
  | { type: "closing"; line: number; expected: number; found: number }

/** What {@link verifyStatement} found. */
export type Verification =
  | { status: "verified" }
  /** The file states no balance to check against. */
  | { status: "unverifiable" }
  | { status: "failed"; failures: BalanceFailure[] }

/**
 * Check a statement against its own balances.
 *
 * - **Running balance**, when every row has one: each row's balance equals the one before plus its
 *   amount, starting from the opening balance when there is one and ending at the closing one. Rows
 *   may come oldest or newest first; the order with fewer failures is the file's.
 * - **Totals**, otherwise, when the file states both: opening plus every amount equals closing.
 *
 * A statement with any row error is never `"verified"`: each one is a failure. Without balances to
 * check, the answer is `"unverifiable"`.
 */
export function verifyStatement(statement: ParsedStatement): Verification {
  const { rows, openingBalance: opening, closingBalance: closing } = statement
  const failures: BalanceFailure[] = statement.rowErrors.map((error) => ({
    type: "row-error",
    ...error,
  }))
  let checked = false
  if (rows.length > 0 && rows.every((row) => row.balance !== undefined)) {
    checked = true
    const forward = runningFailures(rows, opening, closing)
    const backward = runningFailures(rows.toReversed(), opening, closing)
    failures.push(...(backward.length < forward.length ? backward : forward))
  } else if (opening && closing) {
    checked = true
    const expected = rows.reduce(
      (sum, row) => sum + row.amount,
      opening.amount,
    )
    if (!Number.isSafeInteger(expected) || expected !== closing.amount) {
      failures.push({
        type: "closing",
        line: closing.line,
        expected,
        found: closing.amount,
      })
    }
  }
  if (failures.length > 0) return { status: "failed", failures }
  return checked ? { status: "verified" } : { status: "unverifiable" }
}

/** The running-balance failures of `rows` taken oldest first. Every row has a balance. */
function runningFailures(
  rows: readonly StatementRow[],
  opening: StatementBalance | undefined,
  closing: StatementBalance | undefined,
): BalanceFailure[] {
  const failures: BalanceFailure[] = []
  let previous = opening?.amount
  for (const row of rows) {
    const found = row.balance as number
    if (previous !== undefined) {
      const expected = previous + row.amount
      if (!Number.isSafeInteger(expected) || expected !== found) {
        failures.push({ type: "running", line: row.line, expected, found })
      }
    }
    previous = found
  }
  if (closing && previous !== closing.amount) {
    failures.push({
      type: "closing",
      line: closing.line,
      expected: previous as number,
      found: closing.amount,
    })
  }
  return failures
}
