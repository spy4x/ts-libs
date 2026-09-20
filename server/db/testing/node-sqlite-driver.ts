/**
 * A `node:sqlite` driver for the tests.
 *
 * This file is a **test helper**, not part of the package's public surface, and it
 * is the only place in the repo that names a SQLite driver. The adapter takes a
 * driver through its port (`server/db/sqlite.ts`), so nothing at runtime depends on
 * this module.
 *
 * `node:sqlite` is used rather than `better-sqlite3` for two measured reasons:
 *
 *  - it is built into Deno 2.9.7, so the tests add no dependency and no `deno.lock`
 *    entry, and no native npm binary enters the tree;
 *  - importing `node:sqlite` **through a literal specifier breaks repo-wide
 *    `deno task ts:check`** — statically or dynamically, and with or without a cast. It
 *    pulls Node's typings into the whole workspace compilation and produces a
 *    `TS2322: Type 'Timeout' is not assignable to type 'number'` error in
 *    `server/healthcheck.ts:109`, because `@types/node`'s `setTimeout` returns
 *    `Timeout` while `deno.ns` declares `number`. `mcp/http.ts` and `media/timers.ts`
 *    hit the same collision before `mcp/` and `media/` were removed (#64, #66).
 *    `loadNodeSqlite` below avoids it by not being a literal at the `import()` site.
 *    Re-measured after those removals: literal → 1 error, non-literal → 0, same
 *    runtime behaviour. `node:events` cost an earlier agent the same afternoon.
 *
 * The declared interface is the smallest one that describes the calls made here. It
 * is not `@types/node`, deliberately: adding those would reintroduce the typings
 * collision this file exists to avoid.
 */

import type { SqliteDriver, SqliteOpenOptions, SqliteStatement } from "../sqlite.ts"

/**
 * Load `node:sqlite` without letting the type checker resolve it.
 *
 * The specifier is not a literal at the `import()` site on purpose. A literal
 * `import("node:sqlite")` — the same as a static `import` — makes `deno check` pull
 * `@types/node` into the workspace compilation, which breaks `server/healthcheck.ts:109`
 * with `TS2322: Type 'Timeout' is not assignable to type 'number'`, and no cast at the
 * call site prevents it: the module still gets resolved. Measured here: literal import →
 * 1 error, this → 0.
 */
async function loadNodeSqlite(): Promise<{
  DatabaseSync: new (path: string) => NodeDatabase
}> {
  const specifier = ["node", "sqlite"].join(":")
  return await import(specifier) as { DatabaseSync: new (path: string) => NodeDatabase }
}

/** `node:sqlite`'s synchronous statement, as far as this file uses it. */
interface NodeStatement {
  get(...parameters: unknown[]): unknown
  all(...parameters: unknown[]): unknown[]
  run(...parameters: unknown[]): { changes: number | bigint; lastInsertRowid: number | bigint }
}

/** `node:sqlite`'s synchronous connection, as far as this file uses it. */
interface NodeDatabase {
  exec(sql: string): void
  prepare(sql: string): NodeStatement
  close(): void
}

/**
 * Open a `node:sqlite` database through the {@link SqliteDriver} port.
 *
 * The driver is synchronous and the port is not, so each method is wrapped in
 * `Promise.resolve` — the cost the port's async shape accepts so one migration
 * runner serves a synchronous and an asynchronous driver.
 */
export async function createNodeSqliteDriver(
  options: SqliteOpenOptions,
): Promise<SqliteDriver> {
  const module = await loadNodeSqlite()
  const DatabaseSync = module.DatabaseSync
  const database = new DatabaseSync(options.path)
  return {
    exec: (sql: string) => {
      database.exec(sql)
      return Promise.resolve()
    },
    prepare: (sql: string) => {
      const statement = database.prepare(sql)
      const wrapped: SqliteStatement = {
        get: (...parameters: unknown[]) => Promise.resolve(statement.get(...parameters)),
        all: (...parameters: unknown[]) => Promise.resolve(statement.all(...parameters)),
        run: (...parameters: unknown[]) => {
          const result = statement.run(...parameters)
          return Promise.resolve({
            changes: Number(result.changes),
            lastInsertRowid: typeof result.lastInsertRowid === "bigint"
              ? result.lastInsertRowid
              : Number(result.lastInsertRowid),
          })
        },
      }
      return Promise.resolve(wrapped)
    },
    close: () => {
      database.close()
      return Promise.resolve()
    },
  }
}
