/**
 * Tests for the shared migration runner.
 *
 * The runner is measured two ways:
 *
 *  - the sequence of calls it makes on its driver, because whether a migration was
 *    wrapped in a transaction and whether the history insert happened inside or after
 *    it is the behaviour a `CREATE INDEX CONCURRENTLY` depends on, and it is invisible
 *    in the returned report;
 *  - the statements the **real** SQLite driver receives, because a driver double
 *    cannot prove that the transaction path issues `BEGIN`/`COMMIT` at all.
 *
 * Files arrive through `MigrationReader` (`migrate.ts`), so nothing here writes to
 * disk and the repo's `test` task — `--allow-read --allow-env`, no write access —
 * runs every test in this file. That is not only a permission convenience: the port is
 * also what lets a consumer keep migrations in a bundled asset or a database.
 *
 * `denoMigrationReader`, the default reader, is exercised against a directory of real
 * `*.sql` files read from this repo — `server/db/testing/migrations/` — so the
 * filesystem path is covered without a write.
 */

import { assertEquals, assertMatch, assertNotMatch, assertStrictEquals } from "@std/assert"
import { fromFileUrl } from "@std/path"
import {
  denoMigrationReader,
  discoverMigrations,
  type Migration,
  type MigrationDriver,
  type MigrationReader,
  NO_TRANSACTION_SUFFIX,
  parseMigrationName,
  runMigrations,
} from "./migrate.ts"
import { SqliteDb, SqliteMigrationDriver } from "./sqlite.ts"
import { createNodeSqliteDriver } from "./testing/node-sqlite-driver.ts"

/** One call the runner made, in order. */
type Call = { method: string; name?: string; withoutTransaction?: boolean }

/** A {@link MigrationDriver} that records its calls and keeps a name set. */
function recordingDriver(alreadyApplied: string[] = []) {
  const calls: Call[] = []
  const applied = new Set(alreadyApplied)
  const record = (method: string, migration: Migration) => {
    calls.push({
      method,
      name: migration.name,
      withoutTransaction: migration.withoutTransaction,
    })
    applied.add(migration.name)
    return Promise.resolve()
  }
  return {
    calls,
    applied,
    driver: {
      createHistoryTable: () => {
        calls.push({ method: "createHistoryTable" })
        return Promise.resolve()
      },
      appliedNames: () => {
        calls.push({ method: "appliedNames" })
        return Promise.resolve([...applied])
      },
      applyInTransaction: (migration: Migration) => record("applyInTransaction", migration),
      applyWithoutTransaction: (migration: Migration) =>
        record("applyWithoutTransaction", migration),
    } satisfies MigrationDriver,
  }
}

/** A {@link MigrationReader} over a map of file name to SQL text. */
function memoryReader(files: Record<string, string>): MigrationReader {
  return {
    list: () => Promise.resolve(Object.keys(files)),
    readText: (_folder: string, fileName: string) => {
      const text = files[fileName]
      return text === undefined
        ? Promise.reject(new Error(`no such migration: ${fileName}`))
        : Promise.resolve(text)
    },
  }
}

/** The on-disk fixtures read by the `denoMigrationReader` test. */
const FIXTURE_FOLDER = fromFileUrl(new URL("./testing/migrations", import.meta.url))

Deno.test("runMigrations applies every pending migration in name order", async () => {
  const { driver, calls } = recordingDriver()
  const report = await runMigrations(driver, {
    folder: "/migrations",
    reader: memoryReader({
      "0002_two.sql": "CREATE TABLE two (id INTEGER)",
      "0001_one.sql": "CREATE TABLE one (id INTEGER)",
      "0003_three.sql": "CREATE TABLE three (id INTEGER)",
    }),
  })

  assertEquals(report, { applied: ["0001_one", "0002_two", "0003_three"], skipped: [] })
  assertEquals(calls, [
    { method: "createHistoryTable" },
    { method: "appliedNames" },
    { method: "applyInTransaction", name: "0001_one", withoutTransaction: false },
    { method: "applyInTransaction", name: "0002_two", withoutTransaction: false },
    { method: "applyInTransaction", name: "0003_three", withoutTransaction: false },
  ])
})

Deno.test("runMigrations routes a no_transaction migration around the transaction path", async () => {
  const { driver, calls } = recordingDriver()
  const report = await runMigrations(driver, {
    folder: "/migrations",
    reader: memoryReader({
      "0001_plain.sql": "CREATE TABLE plain (id INTEGER)",
      "0002_index.no_transaction.sql": "CREATE INDEX CONCURRENTLY idx_plain ON plain (id)",
    }),
  })

  assertEquals(report.applied, ["0001_plain", "0002_index"])
  assertEquals(calls, [
    { method: "createHistoryTable" },
    { method: "appliedNames" },
    { method: "applyInTransaction", name: "0001_plain", withoutTransaction: false },
    { method: "applyWithoutTransaction", name: "0002_index", withoutTransaction: true },
  ])
})

Deno.test("runMigrations hands the whole SQL body to the driver", async () => {
  const body = "CREATE TABLE a (id INTEGER);\nCREATE TABLE b (id INTEGER);\n"
  const seen: string[] = []
  const { driver } = recordingDriver()
  driver.applyInTransaction = (migration: Migration) => {
    seen.push(migration.sqlText)
    return Promise.resolve()
  }

  await runMigrations(driver, {
    folder: "/migrations",
    reader: memoryReader({ "0001_two_statements.sql": body }),
  })

  assertEquals(seen, [body])
})

Deno.test("runMigrations skips what the history table already records", async () => {
  const files = {
    "0001_one.sql": "CREATE TABLE one (id INTEGER)",
    "0002_two.no_transaction.sql": "CREATE TABLE two (id INTEGER)",
  }
  const first = recordingDriver()
  await runMigrations(first.driver, { folder: "/migrations", reader: memoryReader(files) })
  const applied = first.calls.flatMap((call) => (call.name === undefined ? [] : [call.name]))

  const second = recordingDriver(applied)
  const report = await runMigrations(second.driver, {
    folder: "/migrations",
    reader: memoryReader(files),
  })

  assertEquals(applied, ["0001_one", "0002_two"])
  assertEquals(report, { applied: [], skipped: ["0001_one", "0002_two"] })
  assertEquals(second.calls, [{ method: "createHistoryTable" }, { method: "appliedNames" }])
})

Deno.test("runMigrations recognises a history row recorded with the file extension", async () => {
  const { driver } = recordingDriver(["0001_one.sql"])
  const report = await runMigrations(driver, {
    folder: "/migrations",
    reader: memoryReader({ "0001_one.sql": "CREATE TABLE one (id INTEGER)" }),
  })

  assertEquals(report, { applied: [], skipped: ["0001_one"] })
})

Deno.test("runMigrations ignores a file that is not a migration", async () => {
  const { driver, calls } = recordingDriver()
  const report = await runMigrations(driver, {
    folder: "/migrations",
    reader: memoryReader({ "README.md": "not a migration" }),
  })

  assertEquals(report, { applied: [], skipped: [] })
  assertEquals(calls, [{ method: "createHistoryTable" }, { method: "appliedNames" }])
})

Deno.test("discoverMigrations filters by extension and sorts by name", async () => {
  const reader = memoryReader({
    "0002_b.sql": "SELECT 1",
    "0001_a.sql": "SELECT 1",
    "notes.txt": "SELECT 1",
  })
  assertEquals(await discoverMigrations({ folder: "/migrations", reader }), [
    "0001_a.sql",
    "0002_b.sql",
  ])
  assertEquals(await discoverMigrations({ folder: "/migrations", reader, extension: ".txt" }), [
    "notes.txt",
  ])
  assertEquals(await discoverMigrations({ folder: FIXTURE_FOLDER }), [
    "0001_fixture.sql",
    "0002_fixture.no_transaction.sql",
  ])
})

Deno.test("denoMigrationReader reads a real migrations directory", async () => {
  assertEquals(await discoverMigrations({ folder: FIXTURE_FOLDER }), [
    "0001_fixture.sql",
    "0002_fixture.no_transaction.sql",
  ])
  assertEquals(
    await denoMigrationReader.readText(FIXTURE_FOLDER, "0001_fixture.sql"),
    "CREATE TABLE IF NOT EXISTS fixture (id INTEGER PRIMARY KEY) STRICT;\n",
  )
})

Deno.test("denoMigrationReader skips a directory entry", async () => {
  const entries = await denoMigrationReader.list(FIXTURE_FOLDER)
  assertEquals(entries.includes("nested"), false)
})

Deno.test("parseMigrationName strips the extension and the no_transaction suffix", () => {
  assertEquals(parseMigrationName("0001_init.sql"), "0001_init")
  assertEquals(parseMigrationName(`0002_index${NO_TRANSACTION_SUFFIX}.sql`), "0002_index")
  assertEquals(parseMigrationName("0003_other.txt", ".txt"), "0003_other")
  assertEquals(parseMigrationName("0004_bare"), "0004_bare")
  assertNotMatch(parseMigrationName(`0005_mention${NO_TRANSACTION_SUFFIX}.sql`), /no_transaction/)
})

Deno.test("a driver failure stops the run and propagates unchanged", async () => {
  const attempted: string[] = []
  const { driver } = recordingDriver()
  driver.applyInTransaction = (migration: Migration) => {
    attempted.push(migration.name)
    return migration.name === "0001_one"
      ? Promise.reject(new Error("driver refused"))
      : Promise.resolve()
  }

  let message = ""
  try {
    await runMigrations(driver, {
      folder: "/migrations",
      reader: memoryReader({
        "0001_one.sql": "CREATE TABLE one (id INTEGER)",
        "0002_two.sql": "CREATE TABLE two (id INTEGER)",
      }),
    })
  } catch (error) {
    message = (error as Error).message
  }

  assertStrictEquals(message, "driver refused")
  assertEquals(attempted, ["0001_one"])
})

/**
 * The real SQLite driver, with every statement it receives recorded.
 *
 * This is what makes the transaction claim falsifiable: a driver double reports which
 * *method* the runner called, while this reports the `BEGIN`/`COMMIT` the database
 * actually saw.
 */
async function recordingSqlite() {
  const real = await createNodeSqliteDriver({ path: ":memory:" })
  const statements: string[] = []
  const db = new SqliteDb({
    exec: (sql: string) => {
      statements.push(sql)
      return real.exec(sql)
    },
    prepare: (sql: string) => real.prepare(sql),
    close: () => real.close(),
  }, ":memory:")
  return {
    statements,
    db,
    migrations: (table = "migrations") => new SqliteMigrationDriver({ db, table }),
  }
}

Deno.test("the SQLite migrator wraps a transactional migration in BEGIN and COMMIT", async () => {
  const { db, migrations, statements } = await recordingSqlite()
  const report = await runMigrations(migrations(), {
    folder: "/migrations",
    reader: memoryReader({ "0001_one.sql": "CREATE TABLE one (id INTEGER)" }),
  })

  assertEquals(report.applied, ["0001_one"])
  // The history table is created first; everything after it is the transaction around the
  // migration and its history insert.
  assertEquals(statements.slice(1), [
    "BEGIN",
    "CREATE TABLE one (id INTEGER)",
    "COMMIT",
  ])
  assertEquals(await migrations().appliedNames(), ["0001_one"])
  await db.close()
})

Deno.test("the SQLite migrator runs a no_transaction migration with no BEGIN and no COMMIT", async () => {
  const { db, migrations, statements } = await recordingSqlite()
  const report = await runMigrations(migrations(), {
    folder: "/migrations",
    reader: memoryReader({
      "0002_vacuum.no_transaction.sql": "CREATE TABLE two (id INTEGER)",
    }),
  })

  assertEquals(report.applied, ["0002_vacuum"])
  assertEquals(statements.slice(1), ["CREATE TABLE two (id INTEGER)"])
  assertEquals(statements.filter((sql) => sql === "BEGIN" || sql === "COMMIT"), [])
  assertEquals(await migrations().appliedNames(), ["0002_vacuum"])
  await db.close()
})

Deno.test("the SQLite migrator rolls a failing migration back and records nothing", async () => {
  const { db, migrations, statements } = await recordingSqlite()
  const reader = memoryReader({
    "0001_broken.sql": "CREATE TABLE one (id INTEGER);\nCREATE TABLE one (id INTEGER);\n",
  })

  let message = ""
  try {
    await runMigrations(migrations(), { folder: "/migrations", reader })
  } catch (error) {
    message = (error as Error).message
  }

  assertMatch(message, /table one already exists/)
  assertEquals(statements.includes("ROLLBACK"), true)
  assertEquals(await migrations().appliedNames(), [])
  await db.close()
})

Deno.test("the SQLite migrator is idempotent across two runs", async () => {
  const { db, migrations, statements } = await recordingSqlite()
  const options = {
    folder: "/migrations",
    reader: memoryReader({ "0001_one.sql": "CREATE TABLE one (id INTEGER)" }),
  }

  await runMigrations(migrations(), options)
  const before = statements.length
  const second = await runMigrations(migrations(), options)

  assertEquals(second, { applied: [], skipped: ["0001_one"] })
  // `createHistoryTable` runs every time and is idempotent by `IF NOT EXISTS`; the
  // migration itself and its `BEGIN`/`COMMIT` are what must not run again.
  assertEquals(statements.slice(before), [
    "\n" +
    "      CREATE TABLE IF NOT EXISTS migrations\n" +
    "      (\n" +
    "        id         INTEGER PRIMARY KEY AUTOINCREMENT,\n" +
    "        name       TEXT NOT NULL UNIQUE,\n" +
    "        created_at TEXT NOT NULL DEFAULT (datetime('now'))\n" +
    "      )\n" +
    "    ",
  ])
  assertEquals(statements.includes("BEGIN"), true)
  assertEquals(await migrations().appliedNames(), ["0001_one"])
  await db.close()
})
