/**
 * Tests for the SQLite adapter.
 *
 * Two kinds of test live here, and the difference matters when reading them:
 *
 *  - tests over the **real** driver (`node:sqlite`, through
 *    `testing/node-sqlite-driver.ts`) run against `:memory:`, so SQL execution,
 *    `STRICT` table shape, statement binding and foreign key enforcement are the
 *    engine's, not a double's;
 *  - tests over a **recording driver** assert the exact statements the adapter
 *    issues — the two pragmas, and the `BEGIN`/`COMMIT` around a transaction.
 *
 * The repo's `test` task grants `--allow-read --allow-env` and no write access, so
 * no test opens a file-backed database and none observes `-wal`/`-shm` on disk. That
 * is a real gap and it is named in the PR body rather than papered over: a
 * file-backed open on the real driver is the one path a recording driver cannot
 * exercise. Every assertion here is unconditional — nothing skips.
 */

import { assertEquals, assertRejects, assertStrictEquals } from "@std/assert"
import type { SqliteDriver, SqliteStatement } from "./sqlite.ts"
import {
  applySqliteSchema,
  openSqliteDb,
  resolveSqlitePath,
  SqliteDb,
  SqliteEnvName,
} from "./sqlite.ts"
import { createNodeSqliteDriver } from "./testing/node-sqlite-driver.ts"

const SCHEMA = `
  CREATE TABLE IF NOT EXISTS entries (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    label TEXT NOT NULL UNIQUE,
    amount INTEGER NOT NULL
  ) STRICT
`

/** Opens an in-memory database on the real driver, with no pragmas read back. */
async function openMemory(): Promise<SqliteDb> {
  const driver = await createNodeSqliteDriver({ path: ":memory:" })
  return new SqliteDb(driver, ":memory:")
}

/**
 * A {@link SqliteDriver} that records every statement it issues and wraps a real
 * in-memory driver.
 *
 * `answers` scripts the two pragma *reads*. Those have to be scripted rather than
 * answered by the engine: `journal_mode` is `memory` for an in-memory database, so an
 * unscripted `PRAGMA journal_mode` read would fail the WAL check every time, and a
 * driver double that always says `wal` is the only way to assert that the adapter
 * applies the pragma and reads it back. Everything else reaches `node:sqlite`.
 */
async function recordingDriverWithRealDb(
  answers: Record<string, unknown> = {},
  reads: string[] = [],
): Promise<{ driver: SqliteDriver; issued: string[] }> {
  const real = await createNodeSqliteDriver({ path: ":memory:" })
  const issued: string[] = []
  return {
    issued,
    driver: {
      exec: (sql: string) => {
        issued.push(sql)
        return real.exec(sql)
      },
      prepare: (sql: string) => {
        reads.push(sql)
        if (Object.hasOwn(answers, sql)) {
          const answer = answers[sql]
          const statement: SqliteStatement = {
            get: () => Promise.resolve(answer),
            all: () => Promise.resolve([]),
            run: () => Promise.resolve({ changes: 0, lastInsertRowid: 0 }),
          }
          return Promise.resolve(statement)
        }
        return real.prepare(sql)
      },
      close: () => real.close(),
    },
  }
}

Deno.test("openSqliteDb applies foreign_keys and journal_mode before returning", async () => {
  const reads: string[] = []
  const answers: Record<string, unknown> = {
    "PRAGMA foreign_keys": 1,
    "PRAGMA journal_mode": "wal",
  }
  const { driver, issued } = await recordingDriverWithRealDb(answers, reads)
  const db = await openSqliteDb({ createDriver: () => driver, path: ":memory:" })

  // The `exec` calls, in order: enforcement first, then the journal mode.
  assertEquals(issued, ["PRAGMA foreign_keys = ON", "PRAGMA journal_mode = WAL"])
  // Each is read back before the next statement, so a pragma the engine ignored fails the
  // open rather than leaving a connection whose declared constraints are not enforced.
  assertEquals(reads, ["PRAGMA foreign_keys", "PRAGMA journal_mode"])
  await db.close()
})

Deno.test("openSqliteDb skips both pragmas when they are opted out", async () => {
  const { driver, issued } = await recordingDriverWithRealDb()
  const db = await openSqliteDb({
    createDriver: () => driver,
    path: ":memory:",
    foreignKeys: false,
    writeAheadLog: false,
  })

  assertEquals(issued, [])
  await db.close()
})

Deno.test("openSqliteDb turns on foreign key enforcement on the engine", async () => {
  const { driver } = await recordingDriverWithRealDb({ "PRAGMA journal_mode": "wal" })
  const db = await openSqliteDb({ createDriver: () => driver, path: ":memory:" })
  assertEquals(await db.foreignKeysEnabled(), true)
  await db.close()
})

Deno.test("openSqliteDb fails when the engine does not enable WAL", async () => {
  const { driver, issued } = await recordingDriverWithRealDb({
    "PRAGMA foreign_keys": 1,
    "PRAGMA journal_mode": "delete",
  })
  let closed = false
  const closing: SqliteDriver = {
    ...driver,
    close: () => {
      closed = true
      return Promise.resolve()
    },
  }

  await assertRejects(
    () => openSqliteDb({ createDriver: () => closing, path: ":memory:" }),
    Error,
    "SQLite did not enable WAL, journal_mode is delete",
  )
  assertEquals(issued, ["PRAGMA foreign_keys = ON", "PRAGMA journal_mode = WAL"])
  assertEquals(closed, true)
})

Deno.test("openSqliteDb fails when foreign key enforcement is not on", async () => {
  const { driver } = await recordingDriverWithRealDb({ "PRAGMA foreign_keys": 0 })
  await assertRejects(
    () =>
      openSqliteDb({
        createDriver: () => driver,
        path: ":memory:",
        writeAheadLog: false,
      }),
    Error,
    "SQLite did not enable foreign key enforcement",
  )
})

Deno.test("openSqliteDb creates a parent directory only for a file-backed database", async () => {
  const created: string[] = []
  const first = await recordingDriverWithRealDb({
    "PRAGMA foreign_keys": 1,
    "PRAGMA journal_mode": "wal",
  })
  const fileBacked = await openSqliteDb({
    createDriver: () => first.driver,
    path: "/var/lib/app/data/app.sqlite",
    createDirectory: (directory) => created.push(directory),
  })
  assertEquals(created, ["/var/lib/app/data"])
  assertEquals(fileBacked.databasePath, "/var/lib/app/data/app.sqlite")
  await fileBacked.close()

  const second = await recordingDriverWithRealDb({
    "PRAGMA foreign_keys": 1,
    "PRAGMA journal_mode": "wal",
  })
  const memory = await openSqliteDb({
    createDriver: () => second.driver,
    path: ":memory:",
    createDirectory: (directory) => created.push(directory),
  })
  assertEquals(created, ["/var/lib/app/data"])
  await memory.close()
})

Deno.test("resolveSqlitePath prefers an explicit path over the environment", () => {
  assertEquals(
    resolveSqlitePath({
      path: "custom/data.sqlite",
      environment: { [SqliteEnvName.Path]: "environment.sqlite" },
      root: "/srv/app",
    }),
    "/srv/app/custom/data.sqlite",
  )
})

Deno.test("resolveSqlitePath reads the environment when no path is given", () => {
  assertEquals(
    resolveSqlitePath({ environment: { [SqliteEnvName.Path]: "db/app.sqlite" }, root: "/srv/app" }),
    "/srv/app/db/app.sqlite",
  )
})

Deno.test("resolveSqlitePath keeps an absolute path and :memory: as they are", () => {
  assertEquals(
    resolveSqlitePath({ path: "/data/app.sqlite", root: "/srv/app" }),
    "/data/app.sqlite",
  )
  assertEquals(resolveSqlitePath({ path: ":memory:", root: "/srv/app" }), ":memory:")
})

Deno.test("resolveSqlitePath falls back to db.sqlite under the root", () => {
  assertEquals(resolveSqlitePath({ root: "/srv/app" }), "/srv/app/db.sqlite")
  assertEquals(
    resolveSqlitePath({ environment: { [SqliteEnvName.Path]: "" }, root: "/srv/app" }),
    "/srv/app/db.sqlite",
  )
})

Deno.test("resolveSqlitePath defaults the root to the working directory", () => {
  assertEquals(resolveSqlitePath(), `${Deno.cwd()}/db.sqlite`)
})

Deno.test("applying a schema twice is a no-op on the second run", async () => {
  const db = await openMemory()
  await applySqliteSchema(db, { table: "entries", sql: SCHEMA })
  await db.execute("INSERT INTO entries (label, amount) VALUES (?, ?)", "first", 1)

  await applySqliteSchema(db, { table: "entries", sql: SCHEMA })

  assertEquals(await db.queryAll<{ label: string }>("SELECT label FROM entries"), [
    { label: "first" },
  ])
  assertEquals(await db.pragma("user_version"), 0)
  await db.close()
})

Deno.test("applying a schema creates a STRICT table the pragma reports as strict", async () => {
  const db = await openMemory()
  await applySqliteSchema(db, { table: "entries", sql: SCHEMA })
  const row = await db.queryOne<{ strict: number }>(
    "SELECT strict FROM pragma_table_list WHERE name = ?",
    "entries",
  )
  assertEquals(row?.strict, 1)
  await db.close()
})

Deno.test("applying a schema to a legacy table runs the upgrade inside a transaction", async () => {
  const db = await openMemory()
  await db.exec(
    "CREATE TABLE entries (id INTEGER PRIMARY KEY, label TEXT NOT NULL, amount INTEGER NOT NULL)",
  )
  await db.execute("INSERT INTO entries (id, label, amount) VALUES (?, ?, ?)", 7, "legacy", 3)
  const issued: string[] = []
  const logging = new SqliteDb(
    {
      exec: (sql: string) => {
        issued.push(sql)
        return db.exec(sql)
      },
      prepare: (sql: string) => db.prepare(sql),
      close: () => Promise.resolve(),
    },
    ":memory:",
  )

  await applySqliteSchema(logging, {
    table: "entries",
    sql: SCHEMA,
    upgrade: async (transaction) => {
      await transaction.exec("ALTER TABLE entries RENAME TO entries_old")
      await transaction.exec(
        "CREATE TABLE entries (id INTEGER PRIMARY KEY, label TEXT NOT NULL, amount INTEGER NOT NULL) STRICT",
      )
      await transaction.exec(
        "INSERT INTO entries (id, label, amount) SELECT id, label, amount FROM entries_old",
      )
      await transaction.exec("DROP TABLE entries_old")
    },
  })

  assertEquals(issued[0], "BEGIN")
  assertEquals(issued[issued.length - 1], "COMMIT")
  assertEquals(await logging.queryAll<{ label: string }>("SELECT label FROM entries"), [
    { label: "legacy" },
  ])
  await db.close()
})

Deno.test("an apply that leaves no table fails and rolls the upgrade back", async () => {
  const db = await openMemory()
  await db.exec(
    "CREATE TABLE entries (id INTEGER PRIMARY KEY, label TEXT NOT NULL, amount INTEGER NOT NULL)",
  )
  await assertRejects(
    () =>
      applySqliteSchema(db, {
        table: "entries",
        sql: "SELECT 1",
        upgrade: async (transaction) => {
          await transaction.exec("DROP TABLE entries")
        },
      }),
    Error,
    "schema apply left no table named entries",
  )
  // The rollback is the point: a failed apply must leave the legacy table in place.
  assertEquals(
    await db.queryOne<{ strict: number }>(
      "SELECT strict FROM pragma_table_list WHERE name = ?",
      "entries",
    ),
    { strict: 0 },
  )
  await db.close()
})

Deno.test("a foreign key violation is rejected by the engine", async () => {
  const db = await openMemory()
  await db.exec(`
    CREATE TABLE parents (id INTEGER PRIMARY KEY);
    CREATE TABLE children (id INTEGER PRIMARY KEY, parent_id INTEGER REFERENCES parents(id));
  `)
  const error = await assertRejects(
    () => db.execute("INSERT INTO children (parent_id) VALUES (?)", 4242),
    Error,
  )
  assertEquals(error.message, "FOREIGN KEY constraint failed")
  await db.close()
})

Deno.test("a transaction that throws is rolled back and leaves no row", async () => {
  const db = await openMemory()
  await db.exec("CREATE TABLE rows (id INTEGER PRIMARY KEY, label TEXT NOT NULL)")
  await assertRejects(
    () =>
      db.transaction(async (transaction) => {
        await transaction.execute("INSERT INTO rows (id, label) VALUES (?, ?)", 1, "kept")
        throw new Error("boom")
      }),
    Error,
    "boom",
  )
  assertEquals(await db.queryOne<{ id: number }>("SELECT id FROM rows WHERE id = ?", 1), undefined)
  await db.close()
})

Deno.test("a nested transaction is rejected instead of silently joining the outer one", async () => {
  const db = await openMemory()
  await assertRejects(
    () => db.transaction(() => db.transaction(() => Promise.resolve(undefined))),
    Error,
    "sqlite transaction is already open",
  )
  await db.close()
})

Deno.test("close is idempotent and closes the driver once", async () => {
  let closes = 0
  const db = new SqliteDb({
    exec: () => Promise.resolve(),
    prepare: () => Promise.reject(new Error("no prepare in this double")),
    close: () => {
      closes += 1
      return Promise.resolve()
    },
  }, ":memory:")

  await db.close()
  await db.close()
  assertEquals(closes, 1)
  assertStrictEquals(db.isOpen, false)
})

Deno.test("pragma rejects a name that is not a bare identifier", async () => {
  const db = await openMemory()
  await assertRejects(
    () => db.pragma("journal_mode; DROP TABLE users"),
    RangeError,
    "pragma name must be a bare identifier",
  )
  await db.close()
})

Deno.test("queryOne returns undefined where queryAll returns no rows", async () => {
  const db = await openMemory()
  await db.exec("CREATE TABLE empty (id INTEGER PRIMARY KEY)")
  assertEquals(await db.queryOne("SELECT id FROM empty"), undefined)
  assertEquals(await db.queryAll("SELECT id FROM empty"), [])
  await db.close()
})
