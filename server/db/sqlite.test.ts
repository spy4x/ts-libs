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

import {
  assertEquals,
  assertMatch,
  assertRejects,
  assertStrictEquals,
  assertThrows,
} from "@std/assert"
import type {
  SqliteDbOptions,
  SqliteDelay,
  SqliteDriver,
  SqliteDriverFactory,
  SqliteStatement,
} from "./sqlite.ts"
import {
  applySqliteSchema,
  DEFAULT_MIGRATIONS_TABLE,
  DEFAULT_TRANSACTION_STATEMENTS,
  openSqliteDb,
  resolveSqlitePath,
  SqliteDb,
  SqliteEnvName,
  SqliteMigrationDriver,
  SqliteScopeEndedError,
  SqliteTransactionWaitError,
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
async function openMemory(options: SqliteDbOptions = {}): Promise<SqliteDb> {
  const driver = await createNodeSqliteDriver({ path: ":memory:" })
  return new SqliteDb(driver, ":memory:", DEFAULT_TRANSACTION_STATEMENTS, options)
}

/**
 * A delay that has already expired, so the bounded wait is proven without sleeping.
 *
 * Every test that expects {@link SqliteTransactionWaitError} injects this. A test that
 * expects a wait to *succeed* must not: with this delay the first check of a held gate
 * is also the last.
 */
const instantDelay: SqliteDelay = () => ({ expired: Promise.resolve(), cancel: () => {} })

/** A pair of resolvers, so two overlapping callers meet at a known point. */
function signal(): { reached: Promise<void>; arrive: () => void } {
  let arrive = (): void => {}
  const reached = new Promise<void>((resolve) => {
    arrive = resolve
  })
  return { reached, arrive }
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

Deno.test("a second apply does not run the upgrade again", async () => {
  const db = await openMemory()
  await db.exec("CREATE TABLE entries (id INTEGER PRIMARY KEY, label TEXT NOT NULL)")
  await db.execute("INSERT INTO entries (id, label) VALUES (?, ?)", 7, "legacy")
  let upgrades = 0
  const schema = {
    table: "entries",
    sql: SCHEMA,
    upgrade: async (transaction: SqliteDb) => {
      upgrades += 1
      // A one-shot rename: this throws if it runs a second time, which is what the strict
      // check in `applySqliteSchema` exists to prevent. The source's own upgrade moved data
      // between a legacy and a current table the same way.
      await transaction.exec("ALTER TABLE entries RENAME TO entries_old")
      await transaction.exec(
        "CREATE TABLE entries (id INTEGER PRIMARY KEY, label TEXT NOT NULL) STRICT",
      )
      await transaction.exec("INSERT INTO entries (id, label) SELECT id, label FROM entries_old")
      await transaction.exec("DROP TABLE entries_old")
    },
  }

  await applySqliteSchema(db, schema)
  await applySqliteSchema(db, schema)

  assertEquals(upgrades, 1)
  assertEquals(await db.queryAll<{ id: number; label: string }>("SELECT id, label FROM entries"), [
    { id: 7, label: "legacy" },
  ])
  assertEquals(
    await db.queryOne<{ strict: number }>(
      "SELECT strict FROM pragma_table_list WHERE name = ?",
      "entries",
    ),
    { strict: 1 },
  )
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

Deno.test("a nested transaction on the handle the callback was given is rejected at once", async () => {
  const db = await openMemory({ transactionWaitMs: 25, delay: instantDelay })
  await db.transaction(async (transaction) => {
    await assertRejects(
      () => transaction.transaction(() => Promise.resolve(undefined)),
      Error,
      "sqlite transaction is already open",
    )
  })
  await db.close()
})

Deno.test("a transaction opened on the root handle inside a callback gives up rather than hanging", async () => {
  // This used to be the "nested transaction is rejected" test, and it nested through the
  // root handle. The handle cannot tell this caller from a second, genuine one — it is
  // waiting for its own transaction — so it waits and then names the mistake. With a
  // plain queue and no bound it would hang, and a Deno test has no timeout of its own.
  const db = await openMemory({ transactionWaitMs: 25, delay: instantDelay })
  await assertRejects(
    () => db.transaction(() => db.transaction(() => Promise.resolve(undefined))),
    SqliteTransactionWaitError,
    "sqlite connection is held by an open transaction",
  )
  await db.close()
})

Deno.test("a statement on the root handle inside a callback gives up rather than joining", async () => {
  const db = await openMemory({ transactionWaitMs: 25, delay: instantDelay })
  await db.exec("CREATE TABLE rows (id INTEGER PRIMARY KEY, label TEXT NOT NULL)")
  await db.transaction(async (transaction) => {
    await transaction.execute("INSERT INTO rows (id, label) VALUES (?, ?)", 1, "through the handle")
    await assertRejects(
      () => db.execute("INSERT INTO rows (id, label) VALUES (?, ?)", 2, "through the connection"),
      SqliteTransactionWaitError,
    )
  })
  assertEquals(await db.queryAll<{ id: number }>("SELECT id FROM rows ORDER BY id"), [{ id: 1 }])
  await db.close()
})

Deno.test("a statement prepared before a transaction cannot run inside it", async () => {
  const db = await openMemory({ transactionWaitMs: 25, delay: instantDelay })
  await db.exec("CREATE TABLE rows (id INTEGER PRIMARY KEY, label TEXT NOT NULL)")
  // Prepared while the connection was free, which is the way around the gate that a
  // handle-level check alone would leave open.
  const prepared = await db.prepare("INSERT INTO rows (id, label) VALUES (?, ?)")

  await db.transaction(async (transaction) => {
    await transaction.execute("INSERT INTO rows (id, label) VALUES (?, ?)", 1, "through the handle")
    await assertRejects(
      () => prepared.run(2, "prepared earlier") as Promise<unknown>,
      SqliteTransactionWaitError,
    )
  })

  assertEquals(await db.queryAll<{ id: number }>("SELECT id FROM rows ORDER BY id"), [{ id: 1 }])
  await db.close()
})

Deno.test("a second caller's write survives a rollback in the transaction it overlapped", async () => {
  // The data loss this gate exists for. Before it, the second caller wrote through the
  // same connection, so its INSERT landed inside the first caller's open transaction and
  // the first caller's rollback took it away — or, when the second caller opened a
  // transaction of its own, it was refused as "already open" although nothing of its own
  // was open. The default delay is used deliberately: an expired one would fail the
  // legitimate wait this test depends on.
  const db = await openMemory()
  await db.exec("CREATE TABLE rows (id INTEGER PRIMARY KEY, label TEXT NOT NULL)")
  const opened = signal()
  const mayFinish = signal()

  const first = assertRejects(
    () =>
      db.transaction(async (transaction) => {
        await transaction.execute("INSERT INTO rows (id, label) VALUES (?, ?)", 1, "rolled back")
        opened.arrive()
        await mayFinish.reached
        throw new Error("the first caller fails")
      }),
    Error,
    "the first caller fails",
  )
  await opened.reached

  const second = db.transaction(async (transaction) => {
    await transaction.execute("INSERT INTO rows (id, label) VALUES (?, ?)", 2, "kept")
  })
  mayFinish.arrive()
  await first
  await second

  assertEquals(await db.queryAll<{ id: number; label: string }>("SELECT id, label FROM rows"), [
    { id: 2, label: "kept" },
  ])
  await db.close()
})

Deno.test("a handle kept past its own transaction refuses every later statement", async () => {
  // The leak a gate alone does not close. A service that stores the handle the callback
  // was given — `this.db = db`, which is the shape the Postgres half of this package
  // uses — keeps a way past the gate for the rest of the process, and the write it makes
  // later lands inside whatever transaction is open then and goes with that rollback.
  const db = await openMemory()
  await db.exec("CREATE TABLE rows (id INTEGER PRIMARY KEY, label TEXT NOT NULL)")
  let kept: SqliteDb | undefined
  let keptStatement: SqliteStatement | undefined
  await db.transaction(async (transaction) => {
    kept = transaction
    keptStatement = await transaction.prepare("INSERT INTO rows (id, label) VALUES (?, ?)")
    await transaction.execute("INSERT INTO rows (id, label) VALUES (?, ?)", 1, "committed")
  })

  await assertRejects(
    () => kept!.execute("INSERT INTO rows (id, label) VALUES (?, ?)", 2, "leaked"),
    SqliteScopeEndedError,
    "belonged to a transaction that has already committed or rolled back",
  )
  await assertRejects(() => kept!.exec("DELETE FROM rows"), SqliteScopeEndedError)
  await assertRejects(() => kept!.prepare("SELECT 1"), SqliteScopeEndedError)
  await assertRejects(
    () => kept!.transaction(() => Promise.resolve(undefined)),
    SqliteScopeEndedError,
  )
  // A statement prepared inside the callback is the same door, so it closes too.
  await assertRejects(
    () => keptStatement!.run(3, "leaked through a statement") as Promise<unknown>,
    SqliteScopeEndedError,
  )

  assertEquals(await db.queryAll<{ id: number }>("SELECT id FROM rows ORDER BY id"), [{ id: 1 }])
  await db.close()
})

Deno.test("a handle kept past a rolled-back transaction refuses too", async () => {
  const db = await openMemory()
  await db.exec("CREATE TABLE rows (id INTEGER PRIMARY KEY)")
  let kept: SqliteDb | undefined

  await assertRejects(
    () =>
      db.transaction((transaction) => {
        kept = transaction
        return Promise.reject(new Error("the callback failed"))
      }),
    Error,
    "the callback failed",
  )

  await assertRejects(
    () => kept!.execute("INSERT INTO rows (id) VALUES (?)", 1),
    SqliteScopeEndedError,
  )
  assertEquals(await db.queryAll<{ id: number }>("SELECT id FROM rows"), [])
  await db.close()
})

/**
 * A driver whose every call settles a tick after it was made.
 *
 * `node:sqlite` is synchronous, so on it a gate check and the `BEGIN` that follows
 * happen in one run of the event loop and nothing can interleave between them. That
 * hides the ordering the gate depends on. Here each call yields first, so a second
 * caller gets a turn in exactly the gap the real port allows for — the port admits a
 * driver that answers with a promise, and this is that driver.
 *
 * Statements are recorded when they reach the engine, not when they were asked for.
 */
async function laterDriver(): Promise<{ driver: SqliteDriver; issued: string[] }> {
  const real = await createNodeSqliteDriver({ path: ":memory:" })
  const issued: string[] = []
  const nextTick = (): Promise<void> =>
    new Promise((resolve) => {
      setTimeout(resolve, 0)
    })
  return {
    issued,
    driver: {
      exec: async (sql: string) => {
        await nextTick()
        issued.push(sql)
        return real.exec(sql)
      },
      prepare: async (sql: string) => {
        await nextTick()
        const statement = await real.prepare(sql)
        const wrapped: SqliteStatement = {
          get: async (...parameters: unknown[]) => {
            await nextTick()
            return await statement.get(...parameters)
          },
          all: async (...parameters: unknown[]) => {
            await nextTick()
            return await statement.all(...parameters)
          },
          run: async (...parameters: unknown[]) => {
            await nextTick()
            return await statement.run(...parameters)
          },
        }
        return wrapped
      },
      close: () => real.close(),
    },
  }
}

Deno.test("the connection is claimed before BEGIN, so two callers never both send one", async () => {
  // The ordering this pins is invisible on a synchronous driver: there, the gate check
  // and the BEGIN that follows it run without interruption whichever way round they are
  // written. On a driver that answers a tick later, claiming the connection only after
  // BEGIN succeeded lets the second caller through the check while the first caller's
  // BEGIN is still in flight, and both send one.
  const { driver, issued } = await laterDriver()
  const db = new SqliteDb(driver, ":memory:")
  await db.exec("CREATE TABLE rows (id INTEGER PRIMARY KEY)")

  await Promise.all([
    db.transaction((transaction) => transaction.execute("INSERT INTO rows (id) VALUES (?)", 1)),
    db.transaction((transaction) => transaction.execute("INSERT INTO rows (id) VALUES (?)", 2)),
  ])

  const boundaries = issued.filter((sql) =>
    sql === "BEGIN" || sql === "COMMIT" || sql === "ROLLBACK"
  )
  assertEquals(boundaries, ["BEGIN", "COMMIT", "BEGIN", "COMMIT"])
  assertEquals(await db.queryAll<{ id: number }>("SELECT id FROM rows ORDER BY id"), [
    { id: 1 },
    { id: 2 },
  ])
  await db.close()
})

Deno.test("a transaction whose BEGIN fails leaves the connection open for the next one", async () => {
  const real = await createNodeSqliteDriver({ path: ":memory:" })
  let failNextBegin = true
  const db = new SqliteDb({
    exec: (sql: string) => {
      if (sql === "BEGIN" && failNextBegin) {
        failNextBegin = false
        throw new Error(`near "BOGUS": syntax error`)
      }
      return real.exec(sql)
    },
    prepare: (sql: string) => real.prepare(sql),
    close: () => real.close(),
  }, ":memory:")
  await db.exec("CREATE TABLE rows (id INTEGER PRIMARY KEY)")

  await assertRejects(() => db.transaction(() => Promise.resolve(undefined)), Error, "syntax error")
  // The connection is not stuck. The flag used to be set before `BEGIN` and outside the
  // `try`, so one failed `BEGIN` made every later transaction on the handle report
  // "already open" for the rest of the process.
  await db.transaction(async (transaction) => {
    await transaction.execute("INSERT INTO rows (id) VALUES (?)", 1)
  })

  assertEquals(await db.queryAll<{ id: number }>("SELECT id FROM rows"), [{ id: 1 }])
  await db.close()
})

Deno.test("a rollback that fails does not replace the error the callback threw", async () => {
  const real = await createNodeSqliteDriver({ path: ":memory:" })
  const db = new SqliteDb({
    exec: (sql: string) => {
      if (sql === "ROLLBACK") throw new Error("the rollback itself failed")
      return real.exec(sql)
    },
    prepare: (sql: string) => real.prepare(sql),
    close: () => real.close(),
  }, ":memory:")

  await assertRejects(
    () => db.transaction(() => Promise.reject(new Error("the callback failed"))),
    Error,
    "the callback failed",
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

Deno.test("close waits for an open transaction instead of closing under it", async () => {
  // `close` used to go straight to the driver, so a caller closing the root handle while
  // somebody else's transaction was open pulled the connection out from under it and
  // that transaction rejected with "database is not open". It now waits like every other
  // operation. The default delay is used deliberately: an expired one would fail the
  // legitimate wait this test depends on.
  const db = await openMemory()
  await db.exec("CREATE TABLE rows (id INTEGER PRIMARY KEY)")
  const opened = signal()
  const mayFinish = signal()

  const open = db.transaction(async (transaction) => {
    await transaction.execute("INSERT INTO rows (id) VALUES (?)", 1)
    opened.arrive()
    await mayFinish.reached
    return "committed"
  })
  await opened.reached

  const closing = db.close()
  // The close has not landed: the transaction is still open and still reports a change.
  assertStrictEquals(db.isOpen, true)
  mayFinish.arrive()

  assertStrictEquals(await open, "committed")
  await closing
  assertStrictEquals(db.isOpen, false)
})

Deno.test("close from inside a transaction callback gives up rather than hanging", async () => {
  const db = await openMemory({ transactionWaitMs: 25, delay: instantDelay })
  await db.exec("CREATE TABLE rows (id INTEGER PRIMARY KEY)")

  await assertRejects(
    () => db.transaction(() => db.close()),
    SqliteTransactionWaitError,
    "did not become free within 25ms",
  )

  // The connection is still there, which is the point: the transaction that was waiting
  // for itself failed rather than closing the connection it was running on.
  assertStrictEquals(db.isOpen, true)
  assertEquals(await db.queryAll<{ id: number }>("SELECT id FROM rows"), [])
  await db.close()
})

Deno.test("a scoped handle cannot close the connection it does not own", async () => {
  // A scoped handle used to reach `driver.close()` directly, so a callback that kept its
  // handle could close the root's connection: `close()` returned, the root still reported
  // `isOpen: true`, and its next read threw "database is not open".
  const db = await openMemory()
  await db.exec("CREATE TABLE rows (id INTEGER PRIMARY KEY)")
  let kept: SqliteDb | undefined

  await db.transaction(async (transaction) => {
    await assertRejects(
      () => transaction.close(),
      Error,
      "scoped to a transaction and does not own the connection",
    )
    kept = transaction
  })

  await assertRejects(() => kept!.close(), Error, "does not own the connection")
  assertStrictEquals(db.isOpen, true)
  assertEquals(await db.queryAll<{ id: number }>("SELECT id FROM rows"), [])
  await db.close()
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

/**
 * Opens an in-memory database whose driver records every statement it receives.
 *
 * `exec` reaches the real engine, so a multi-statement payload is genuinely executed:
 * that is the behaviour the injection tests below assert is unreachable, and it is
 * worth recording rather than assuming. `issued` and `prepared` are separate because
 * they are separate paths — `exec` runs text, `prepare` compiles a single statement —
 * and a driver double that merged them could not tell a spliced identifier from a
 * bound one. A `:memory:` database cannot verify "the `DROP` did not run" by looking
 * for a dropped table unless the table was planted on the same handle, which is what
 * the injection test does.
 */
async function recordingMemory(): Promise<{
  db: SqliteDb
  issued: string[]
  prepared: string[]
}> {
  const real = await createNodeSqliteDriver({ path: ":memory:" })
  const issued: string[] = []
  const prepared: string[] = []
  return {
    issued,
    prepared,
    db: new SqliteDb(
      {
        exec: (sql: string) => {
          issued.push(sql)
          return real.exec(sql)
        },
        prepare: (sql: string) => {
          prepared.push(sql)
          return real.prepare(sql)
        },
        close: () => real.close(),
      },
      ":memory:",
    ),
  }
}

/**
 * The payloads a caller must not be able to get through `table`.
 *
 * The first two are the ones the PR #56 review probed; both are malformed enough that
 * SQLite rejects the *first* statement, which is why they appeared safe. The third is
 * the well-formed one the coordinator measured data loss with: SQLite admits
 * `CREATE TABLE IF NOT EXISTS migrations (name TEXT)`, the `;` then separates a real
 * `DROP TABLE victims`, and the trailing `--` comments the rest of the template out.
 */
const REJECTED_TABLE_NAMES = [
  `t"; DROP TABLE victims; --`,
  "t; DROP TABLE victims",
  "migrations (name TEXT); DROP TABLE victims; --",
  "",
  `t"x`,
  "t\0x",
  "my-migrations",
  "my migrations",
  "migrations\uFF1B",
]

Deno.test("every malformed history table name is rejected at construction", async () => {
  const { db } = await recordingMemory()
  for (const table of REJECTED_TABLE_NAMES) {
    const error = assertThrows(
      () => new SqliteMigrationDriver({ db, table }),
      RangeError,
      "table name must be a bare identifier, got ",
    )
    assertEquals(error.message.includes(JSON.stringify(table)), true)
  }
  await db.close()
})

Deno.test("a rejected history table name never reaches the driver", async () => {
  const { db, issued } = await recordingMemory()
  await db.exec("CREATE TABLE victims (id INTEGER)")

  for (const table of REJECTED_TABLE_NAMES) {
    assertThrows(() => new SqliteMigrationDriver({ db, table }), RangeError)
  }

  assertEquals(issued, ["CREATE TABLE victims (id INTEGER)"])
  await db.close()
})

Deno.test("an injected history table name cannot drop a table", async () => {
  const { db, issued } = await recordingMemory()
  // Planted on the same handle the driver would run through, which is the arrangement
  // the coordinator's probe measured the loss in.
  await db.exec("CREATE TABLE victims (id INTEGER)")
  await db.execute("INSERT INTO victims (id) VALUES (?)", 1)
  const injected = "migrations (name TEXT); DROP TABLE victims; --"

  assertThrows(() => new SqliteMigrationDriver({ db, table: injected }), RangeError)

  // One statement was issued in this test's whole lifetime: the plant. The injected
  // text appears nowhere in it.
  assertEquals(issued.length, 1)
  assertEquals(issued[0].includes("DROP TABLE victims"), false)
  assertEquals(await db.queryOne<{ id: number }>("SELECT id FROM victims"), { id: 1 })
  await db.close()
})

Deno.test("a legitimate history table name is quoted in every statement", async () => {
  const { db, issued, prepared } = await recordingMemory()
  const driver = new SqliteMigrationDriver({ db, table: "migrations_v2" })

  await driver.createHistoryTable()
  await driver.applyInTransaction({
    fileName: "0001_one.sql",
    name: "0001_one",
    sqlText: "CREATE TABLE one (id INTEGER)",
    checksum: "a".repeat(64),
    withoutTransaction: false,
  })
  assertEquals((await driver.appliedMigrations()).map((row) => row.name), ["0001_one"])
  await driver.applyWithoutTransaction({
    fileName: "0002_two.no_transaction.sql",
    name: "0002_two",
    sqlText: "SELECT 1",
    checksum: "b".repeat(64),
    withoutTransaction: true,
  })
  assertEquals((await driver.appliedMigrations()).map((row) => row.name), [
    "0001_one",
    "0002_two",
  ])

  // The `exec` path: the history table, then the `BEGIN`/`COMMIT` around the first
  // migration. The second migration runs bare, which is the `.no_transaction` contract.
  assertMatch(issued[0], /^\s*CREATE TABLE IF NOT EXISTS "migrations_v2"/)
  assertEquals(issued.slice(1), [
    "BEGIN",
    "CREATE TABLE one (id INTEGER)",
    "COMMIT",
    "SELECT 1",
  ])
  // The `prepare` path: the two history inserts and the two history reads, every one of
  // them spelling the identifier in its quoted form.
  const inserts = prepared.filter((sql) => sql.startsWith("INSERT INTO"))
  assertEquals(inserts, [
    'INSERT INTO "migrations_v2" (name, checksum) VALUES (?, ?)',
    'INSERT INTO "migrations_v2" (name, checksum) VALUES (?, ?)',
  ])
  const reads = prepared.filter((sql) => sql.startsWith("SELECT name, checksum FROM"))
  assertEquals(reads, [
    'SELECT name, checksum FROM "migrations_v2" ORDER BY id',
    'SELECT name, checksum FROM "migrations_v2" ORDER BY id',
  ])
  await db.close()
})

Deno.test("the default history table name is accepted and quoted", async () => {
  const { db, issued, prepared } = await recordingMemory()
  await new SqliteMigrationDriver({ db }).createHistoryTable()
  assertMatch(issued[0], new RegExp(`CREATE TABLE IF NOT EXISTS "${DEFAULT_MIGRATIONS_TABLE}"`))
  // The column probe is the one statement `createHistoryTable` prepares, and the table
  // name reaches it as a bound value rather than as SQL text.
  assertEquals(prepared, ["SELECT name FROM pragma_table_info(?)"])
  await db.close()
})

Deno.test("two runners on one connection do not both hold the migration lock", async () => {
  // The in-process half of the lock, measured directly rather than through the runner:
  // the second `withLock` must not enter until the first has returned.
  const { db } = await recordingMemory()
  const order: string[] = []
  const driver = () => new SqliteMigrationDriver({ db })
  let release = (): void => {}
  const held = new Promise<void>((resolve) => {
    release = resolve
  })

  const first = driver().withLock(async () => {
    order.push("first in")
    await held
    order.push("first out")
  })
  const second = driver().withLock(() => {
    order.push("second in")
    return Promise.resolve()
  })

  release()
  await Promise.all([first, second])

  assertEquals(order, ["first in", "first out", "second in"])
  await db.close()
})

Deno.test("a run that threw still hands the migration lock on", async () => {
  const { db } = await recordingMemory()
  const driver = () => new SqliteMigrationDriver({ db })

  await assertRejects(
    () => driver().withLock(() => Promise.reject(new Error("the run failed"))),
    Error,
    "the run failed",
  )
  assertStrictEquals(await driver().withLock(() => Promise.resolve("second ran")), "second ran")
  await db.close()
})

Deno.test("a history table name is rejected before the database is asked anything", async () => {
  const { db, issued } = await recordingMemory()
  const before = issued.length
  assertThrows(
    () => new SqliteMigrationDriver({ db, table: "migrations\uFF1B" }),
    RangeError,
    "table name must be a bare identifier",
  )
  assertEquals(issued.slice(before), [])
  await db.close()
})

Deno.test("a schema table that is not a bare identifier is rejected", async () => {
  const { db, issued } = await recordingMemory()
  await assertRejects(
    () => applySqliteSchema(db, { table: "entries; DROP TABLE victims", sql: SCHEMA }),
    RangeError,
    "schema table must be a bare identifier",
  )
  assertEquals(issued, [])
  await db.close()
})

/**
 * `node:sqlite`'s `DatabaseSync`, declared here rather than imported.
 *
 * The claim under test is that the documented wiring —
 * `createDriver: ({ path }) => new DatabaseSync(path)` — type-checks. Importing
 * `node:sqlite` with a literal specifier to prove it would break the repository's own
 * type check: it pulls Node's typings into the workspace compilation and
 * `server/healthcheck.ts:109` then fails on `Timeout` versus `number`. See the header
 * of `testing/node-sqlite-driver.ts`. So the signatures are written out, and what this
 * proves is exactly that: the shape is accepted, not that the driver works.
 */
class DatabaseSyncShape {
  readonly path: string

  constructor(path: string) {
    this.path = path
  }

  exec(_sql: string): void {}

  prepare(_sql: string): StatementSyncShape {
    return new StatementSyncShape()
  }

  close(): void {}
}

/** `node:sqlite`'s `StatementSync`: synchronous, and `changes` may be a `bigint`. */
class StatementSyncShape {
  get(..._parameters: unknown[]): unknown {
    return undefined
  }

  all(..._parameters: unknown[]): unknown[] {
    return []
  }

  run(..._parameters: unknown[]): { changes: number | bigint; lastInsertRowid: number | bigint } {
    return { changes: 0, lastInsertRowid: 0 }
  }
}

/**
 * `better-sqlite3`'s `Database`, declared here for the same reason.
 *
 * It differs from `node:sqlite` in the one way that matters to the port: `exec` and
 * `close` return the database itself, for chaining. A port that typed them `void` or
 * `Promise<void>` rejected this class, which is why they are `unknown`.
 *
 * No test loads `better-sqlite3`. It is a native npm binary and would land in
 * `deno.lock`; this is a claim about the types and nothing more.
 */
class BetterSqliteShape {
  readonly path: string

  constructor(path: string) {
    this.path = path
  }

  exec(_sql: string): this {
    return this
  }

  prepare(_sql: string): BetterStatementShape {
    return new BetterStatementShape()
  }

  close(): this {
    return this
  }
}

/** `better-sqlite3`'s `Statement`, as far as the port reads it. */
class BetterStatementShape {
  get(..._parameters: unknown[]): unknown {
    return undefined
  }

  all(..._parameters: unknown[]): unknown[] {
    return []
  }

  run(..._parameters: unknown[]): { changes: number; lastInsertRowid: number | bigint } {
    return { changes: 0, lastInsertRowid: 0 }
  }
}

Deno.test("the documented synchronous wiring is accepted as a driver factory", async () => {
  // The exact line `sqlite.ts` tells a consumer to write. It did not compile before the
  // port was widened: `exec` returned `void` where the port demanded `Promise<void>`.
  const nodeSqlite: SqliteDriverFactory = ({ path }) => new DatabaseSyncShape(path)
  const betterSqlite: SqliteDriverFactory = ({ path }) => new BetterSqliteShape(path)

  for (const createDriver of [nodeSqlite, betterSqlite]) {
    const db = await openSqliteDb({
      createDriver,
      path: ":memory:",
      foreignKeys: false,
      writeAheadLog: false,
    })
    assertEquals(db.databasePath, ":memory:")
    await db.close()
  }
})

Deno.test("a synchronous driver's rows and change counts reach the caller unwrapped", async () => {
  // `testing/node-sqlite-driver.ts` hands `DatabaseSync` over as it is, with no promise
  // wrapper on any method, so this exercises the synchronous path against the engine.
  const db = await openMemory()
  await db.exec("CREATE TABLE rows (id INTEGER PRIMARY KEY, label TEXT NOT NULL)")

  const written = await db.execute("INSERT INTO rows (id, label) VALUES (?, ?)", 1, "written")

  assertEquals(Number(written.changes), 1)
  assertEquals(await db.queryOne<{ label: string }>("SELECT label FROM rows"), { label: "written" })
  await db.close()
})
