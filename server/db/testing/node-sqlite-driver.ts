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
 * The database is handed over as it is, with no promise wrapper around any method.
 * That is the documented wiring — `createDriver: ({ path }) => new DatabaseSync(path)`
 * — and passing the synchronous object straight through is what makes every real-engine
 * test in `sqlite.test.ts` an exercise of the synchronous path. The asynchronous path
 * stays covered by the recording doubles there, which answer with promises.
 *
 * Only `loadNodeSqlite` is asynchronous, because the module is loaded through a
 * non-literal specifier; see the header for why.
 */
export async function createNodeSqliteDriver(
  options: SqliteOpenOptions,
): Promise<SqliteDriver> {
  const module = await loadNodeSqlite()
  const DatabaseSync = module.DatabaseSync
  const database = new DatabaseSync(options.path)
  return {
    exec: (sql: string) => database.exec(sql),
    prepare: (sql: string): SqliteStatement => database.prepare(sql),
    close: () => database.close(),
  }
}
