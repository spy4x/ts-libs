// The transaction-or-savepoint rule shared by the Postgres stores of `auth` and `lockout`.
// Internal: no entry point of the package exports this file.

import type { Sql, Transaction } from "../db/index.ts"

/**
 * Runs `body` isolated from the rest of the caller's work, on the handle a store was given
 * (`postgres@3.4.7`):
 *
 * - A pool (`postgres(...)`, `createSql`) has `begin`: `body` runs in a new transaction on one
 *   connection, and commits when it returns.
 * - A transaction handle (the `tx` inside the caller's `sql.begin`, or a savepoint's handle) has
 *   `savepoint` and no `begin`: `body` runs in a savepoint of the caller's transaction. Its writes
 *   commit or roll back with the caller's transaction; when `body` throws, only the savepoint rolls
 *   back, so the caller can catch the error and keep using its transaction.
 * - A reserved connection (`sql.reserve()`) has neither, and is refused with a `TypeError` rather
 *   than written through without a transaction.
 *
 * @param store Names the store in the `TypeError`, such as `"auth store"`.
 */
export async function runIsolated<T>(
  sql: Sql,
  body: (tx: Sql) => Promise<T>,
  store: string,
): Promise<T> {
  if (typeof (sql as { begin?: unknown }).begin === "function") {
    return (await sql.begin((tx) => body(tx))) as T
  }
  const handle = sql as Partial<Transaction>
  if (typeof handle.savepoint === "function") {
    return (await handle.savepoint((tx) => body(tx))) as T
  }
  throw new TypeError(
    `the Postgres ${store} needs a pool or a transaction handle; this handle has neither ` +
      "`begin` nor `savepoint` (a `sql.reserve()` connection has neither)",
  )
}
