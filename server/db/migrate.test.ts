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

import {
  assertEquals,
  assertMatch,
  assertNotMatch,
  assertRejects,
  assertStrictEquals,
} from "@std/assert"
import { fromFileUrl } from "@std/path"
import {
  type AppliedMigration,
  checksumOf,
  denoMigrationReader,
  discoverMigrations,
  type Migration,
  type MigrationDriver,
  MigrationEditedError,
  type MigrationReader,
  MigrationRenamedError,
  NO_TRANSACTION_SUFFIX,
  parseMigrationName,
  runMigrations,
} from "./migrate.ts"
import { SqliteDb, SqliteMigrationDriver } from "./sqlite.ts"
import { migrationRace } from "./testing/migration-race.ts"
import { createNodeSqliteDriver } from "./testing/node-sqlite-driver.ts"

/** One call the runner made, in order. */
type Call = { method: string; name?: string; withoutTransaction?: boolean }

/**
 * A {@link MigrationDriver} that records its calls and keeps a history.
 *
 * `alreadyApplied` seeds the history. A bare string is a row written before checksums
 * existed, which the runner must treat as unknown rather than as a match.
 */
function recordingDriver(alreadyApplied: Array<string | AppliedMigration> = []) {
  const calls: Call[] = []
  const applied = new Map<string, string | null>(
    alreadyApplied.map((entry) =>
      typeof entry === "string" ? [entry, null] : [entry.name, entry.checksum]
    ),
  )
  const record = (method: string, migration: Migration) => {
    calls.push({
      method,
      name: migration.name,
      withoutTransaction: migration.withoutTransaction,
    })
    applied.set(migration.name, migration.checksum)
    return Promise.resolve()
  }
  return {
    calls,
    applied,
    driver: {
      withLock: <T>(run: () => Promise<T>): Promise<T> => {
        calls.push({ method: "withLock" })
        return run()
      },
      createHistoryTable: () => {
        calls.push({ method: "createHistoryTable" })
        return Promise.resolve()
      },
      appliedMigrations: () => {
        calls.push({ method: "appliedMigrations" })
        return Promise.resolve(
          [...applied].map(([name, checksum]) => ({ name, checksum })),
        )
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

/** The recorded names of a driver's history, for the assertions that only need those. */
async function appliedNames(driver: MigrationDriver): Promise<string[]> {
  return (await driver.appliedMigrations()).map((row) => row.name)
}

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

  assertEquals(report, {
    applied: ["0001_one", "0002_two", "0003_three"],
    skipped: [],
    missing: [],
  })
  assertEquals(calls, [
    { method: "withLock" },
    { method: "createHistoryTable" },
    { method: "appliedMigrations" },
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
    { method: "withLock" },
    { method: "createHistoryTable" },
    { method: "appliedMigrations" },
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
  assertEquals(report, { applied: [], skipped: ["0001_one", "0002_two"], missing: [] })
  assertEquals(second.calls, [
    { method: "withLock" },
    { method: "createHistoryTable" },
    { method: "appliedMigrations" },
  ])
})

Deno.test("runMigrations recognises a history row recorded with the file extension", async () => {
  const { driver } = recordingDriver(["0001_one.sql"])
  const report = await runMigrations(driver, {
    folder: "/migrations",
    reader: memoryReader({ "0001_one.sql": "CREATE TABLE one (id INTEGER)" }),
  })

  assertEquals(report, { applied: [], skipped: ["0001_one"], missing: [] })
})

Deno.test("runMigrations ignores a file that is not a migration", async () => {
  const { driver, calls } = recordingDriver()
  const report = await runMigrations(driver, {
    folder: "/migrations",
    reader: memoryReader({ "README.md": "not a migration" }),
  })

  assertEquals(report, { applied: [], skipped: [], missing: [] })
  assertEquals(calls, [
    { method: "withLock" },
    { method: "createHistoryTable" },
    { method: "appliedMigrations" },
  ])
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

Deno.test("the whole run happens inside the lock, history read included", async () => {
  // The order is the whole point. The race #59 measured is two runners each reading an
  // empty history before either applies anything, so a lock taken after the read — or
  // around one migration at a time — would not see it.
  const { driver, calls } = recordingDriver()
  await runMigrations(driver, {
    folder: "/migrations",
    reader: memoryReader({ "0001_one.sql": "CREATE TABLE one (id INTEGER)" }),
  })

  assertStrictEquals(calls[0].method, "withLock")
  assertEquals(calls.map((call) => call.method).slice(1), [
    "createHistoryTable",
    "appliedMigrations",
    "applyInTransaction",
  ])
})

Deno.test("the lock is released when a migration fails", async () => {
  const { driver } = recordingDriver()
  let held = 0
  let highWater = 0
  driver.withLock = async <T>(run: () => Promise<T>): Promise<T> => {
    held += 1
    highWater = Math.max(highWater, held)
    try {
      return await run()
    } finally {
      held -= 1
    }
  }
  driver.applyInTransaction = () => Promise.reject(new Error("driver refused"))

  await assertRejects(
    () =>
      runMigrations(driver, {
        folder: "/migrations",
        reader: memoryReader({ "0001_one.sql": "CREATE TABLE one (id INTEGER)" }),
      }),
    Error,
    "driver refused",
  )

  assertStrictEquals(highWater, 1)
  assertStrictEquals(held, 0)
})

Deno.test("a migration recorded with a checksum is skipped when the file is unchanged", async () => {
  const body = "CREATE TABLE one (id INTEGER)"
  const { driver } = recordingDriver([{ name: "0001_one", checksum: await checksumOf(body) }])

  const report = await runMigrations(driver, {
    folder: "/migrations",
    reader: memoryReader({ "0001_one.sql": body }),
  })

  assertEquals(report, { applied: [], skipped: ["0001_one"], missing: [] })
})

Deno.test("an applied migration that was edited afterwards stops the run", async () => {
  // It used to be skipped in silence: the runner compared names only, so the edit was
  // never applied anywhere and no database matched the file.
  const applied = "CREATE TABLE one (id INTEGER)"
  const edited = "CREATE TABLE one (id INTEGER, extra TEXT)"
  const recorded = await checksumOf(applied)
  const { driver, calls } = recordingDriver([{ name: "0001_one", checksum: recorded }])

  const error = await assertRejects(
    () =>
      runMigrations(driver, {
        folder: "/migrations",
        reader: memoryReader({
          "0001_one.sql": edited,
          "0002_two.sql": "CREATE TABLE two (id INTEGER)",
        }),
      }),
    MigrationEditedError,
    "was applied from a different body than the file now holds",
  )

  assertStrictEquals(error.migration, "0001_one")
  assertStrictEquals(error.recordedChecksum, recorded)
  assertStrictEquals(error.fileChecksum, await checksumOf(edited))
  // The run stops there: the migration after the edited one is not applied either,
  // because the history the edit calls into question is the history it would be
  // applied against.
  assertEquals(calls.filter((call) => call.method.startsWith("apply")), [])
})

Deno.test("a run that is going to be refused applies nothing first", async () => {
  // Issue #110's ordering half. The checks used to run file by file as the run went, so a
  // pending file that sorted *before* an edited one was applied and only then did the run
  // stop — "the run was refused" did not mean "nothing was applied". Measured on 6bfa1e8:
  // `0000_early` was in the history although the run ended in MigrationEditedError.
  const applied = "CREATE TABLE one (id INTEGER)"
  const { driver, calls } = recordingDriver([
    { name: "0001_a", checksum: await checksumOf(applied) },
  ])

  await assertRejects(
    () =>
      runMigrations(driver, {
        folder: "/migrations",
        reader: memoryReader({
          // Sorts first, and is new: it used to be applied on the way to the error.
          "0000_early.sql": "CREATE TABLE early (id INTEGER)",
          "0001_a.sql": `${applied}, extra TEXT`,
        }),
      }),
    MigrationEditedError,
  )

  assertEquals(calls.filter((call) => call.method.startsWith("apply")), [])
  assertEquals(await appliedNames(driver), ["0001_a"])
})

Deno.test("a history row with no file on disk is reported as missing", async () => {
  // Issue #110. An applied migration whose file was deleted used to be ignored, so the
  // history and the folder disagreed with nobody told. It is reported rather than
  // refused: squashing old migrations away is legitimate and there is no opt-out yet.
  const first = "CREATE TABLE one (id INTEGER)"
  const { driver } = recordingDriver([
    { name: "0001_gone", checksum: await checksumOf(first) },
    { name: "0002_kept", checksum: await checksumOf("CREATE TABLE two (id INTEGER)") },
  ])

  const report = await runMigrations(driver, {
    folder: "/migrations",
    reader: memoryReader({
      "0002_kept.sql": "CREATE TABLE two (id INTEGER)",
      "0003_new.sql": "CREATE TABLE three (id INTEGER)",
    }),
  })

  assertEquals(report, {
    applied: ["0003_new"],
    skipped: ["0002_kept"],
    missing: ["0001_gone"],
  })
})

Deno.test("a renamed applied migration is refused instead of applied a second time", async () => {
  // Issue #110's damaging case. The renamed file looked new, so its body ran again
  // against a database that already had it — measured: `INSERT INTO counter VALUES (1)`
  // ran twice and the history held both names.
  const body = "INSERT INTO counter VALUES (1)"
  const checksum = await checksumOf(body)
  const { driver, calls } = recordingDriver([{ name: "0001_a", checksum }])

  const error = await assertRejects(
    () =>
      runMigrations(driver, {
        folder: "/migrations",
        reader: memoryReader({ "0001_renamed.sql": body }),
      }),
    MigrationRenamedError,
    "has the body of 0001_a",
  )

  assertStrictEquals(error.recordedName, "0001_a")
  assertStrictEquals(error.pendingName, "0001_renamed")
  assertStrictEquals(error.checksum, checksum)
  assertEquals(calls.filter((call) => call.method.startsWith("apply")), [])
})

Deno.test("a new migration that repeats a still-present migration's body is applied", async () => {
  // The limit of the rename check, written down rather than implied. A body shared with a
  // migration whose file is still on disk is a copy, not a rename — two `ANALYZE` files
  // are a legitimate thing to have — so only a history row with no file triggers it.
  const body = "ANALYZE"
  const { driver } = recordingDriver([{ name: "0001_a", checksum: await checksumOf(body) }])

  const report = await runMigrations(driver, {
    folder: "/migrations",
    reader: memoryReader({ "0001_a.sql": body, "0002_b.sql": body }),
  })

  assertEquals(report, { applied: ["0002_b"], skipped: ["0001_a"], missing: [] })
})

Deno.test("renaming only the transaction mode is not read as a rename", async () => {
  // `parseMigrationName` strips `.no_transaction` before the history name, so switching a
  // migration's transaction mode keeps its row. The rename check must not undo that.
  const body = "CREATE INDEX CONCURRENTLY idx ON one (id)"
  const { driver } = recordingDriver([{ name: "0001_one", checksum: await checksumOf(body) }])

  const report = await runMigrations(driver, {
    folder: "/migrations",
    reader: memoryReader({ "0001_one.no_transaction.sql": body }),
  })

  assertEquals(report, { applied: [], skipped: ["0001_one"], missing: [] })
})

Deno.test("whitespace alone is enough to count as an edit", async () => {
  const applied = "CREATE TABLE one (id INTEGER)"
  const { driver } = recordingDriver([{ name: "0001_one", checksum: await checksumOf(applied) }])

  await assertRejects(
    () =>
      runMigrations(driver, {
        folder: "/migrations",
        reader: memoryReader({ "0001_one.sql": `${applied}\n` }),
      }),
    MigrationEditedError,
  )
})

Deno.test("a history row written before checksums existed is not checked", async () => {
  // `null` is unknown, not "matches". The alternative — back-filling the row from the
  // file in front of the runner — would record the current file as the one that ran,
  // which is the assumption the check exists to stop making.
  const { driver } = recordingDriver([{ name: "0001_one", checksum: null }])

  const report = await runMigrations(driver, {
    folder: "/migrations",
    reader: memoryReader({ "0001_one.sql": "CREATE TABLE one (id INTEGER, changed TEXT)" }),
  })

  assertEquals(report, { applied: [], skipped: ["0001_one"], missing: [] })
})

Deno.test("the checksum a driver records is the SHA-256 of the body it was given", async () => {
  const body = "CREATE TABLE one (id INTEGER)"
  const seen: Migration[] = []
  const { driver } = recordingDriver()
  driver.applyInTransaction = (migration: Migration) => {
    seen.push(migration)
    return Promise.resolve()
  }

  await runMigrations(driver, {
    folder: "/migrations",
    reader: memoryReader({ "0001_one.sql": body }),
  })

  assertStrictEquals(seen.length, 1)
  assertStrictEquals(seen[0].checksum, await checksumOf(body))
  // A known vector, so the hash cannot drift to another algorithm unnoticed.
  assertStrictEquals(
    await checksumOf(""),
    "e3b0c44298fc1c149afbf4c8996fb92427ae41e4649b934ca495991b7852b855",
  )
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
  assertEquals(await appliedNames(migrations()), ["0001_one"])
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
  assertEquals(await appliedNames(migrations()), ["0002_vacuum"])
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
  assertEquals(await appliedNames(migrations()), [])
  await db.close()
})

Deno.test("two SQLite runners started together apply each migration once", async () => {
  // Measured on `5c7a40f`: the body ran twice — `INSERT INTO counter` inserted two rows
  // — and the second runner then failed on `UNIQUE constraint failed: migrations.name`.
  // Both runners had read an empty history before either wrote to it, which is what the
  // barrier below makes certain rather than likely.
  const { db, migrations } = await recordingSqlite()
  await db.exec("CREATE TABLE counter (id INTEGER PRIMARY KEY AUTOINCREMENT)")
  const race = migrationRace({
    // A `.no_transaction` migration on purpose: its body and its history row are separate
    // statements, so the `UNIQUE` constraint on the name cannot undo a doubled body.
    "0001_bump.no_transaction.sql": "INSERT INTO counter DEFAULT VALUES",
  }, 2)
  const options = { folder: "/migrations", reader: race.reader }

  const outcomes = await Promise.all([
    runMigrations(race.gate(migrations()), options),
    runMigrations(race.gate(migrations()), options),
  ])

  assertEquals(outcomes.map((report) => report.applied).flat(), ["0001_bump"])
  assertEquals(outcomes.map((report) => report.skipped).flat(), ["0001_bump"])
  assertEquals(await db.queryAll<{ id: number }>("SELECT id FROM counter"), [{ id: 1 }])
  assertEquals(await appliedNames(migrations()), ["0001_bump"])
  await db.close()
})

Deno.test("the SQLite migrator refuses a migration whose file changed after it ran", async () => {
  const { db, migrations } = await recordingSqlite()
  const options = {
    folder: "/migrations",
    reader: memoryReader({ "0001_one.sql": "CREATE TABLE one (id INTEGER)" }),
  }
  await runMigrations(migrations(), options)

  await assertRejects(
    () =>
      runMigrations(migrations(), {
        folder: "/migrations",
        reader: memoryReader({ "0001_one.sql": "CREATE TABLE one (id INTEGER, extra TEXT)" }),
      }),
    MigrationEditedError,
    "0001_one",
  )
  await db.close()
})

Deno.test("the SQLite migrator refuses a renamed migration instead of running it again", async () => {
  // Issue #110's measured case, against the real driver: `INSERT INTO counter VALUES (1)`
  // ran a second time under the new name and the history held both, so the table ended up
  // with rows [1, 2, 1].
  const { db, migrations } = await recordingSqlite()
  await db.exec("CREATE TABLE counter (n INTEGER)")
  const body = "INSERT INTO counter VALUES (1)"
  await runMigrations(migrations(), {
    folder: "/migrations",
    reader: memoryReader({ "0001_a.sql": body }),
  })

  const error = await assertRejects(
    () =>
      runMigrations(migrations(), {
        folder: "/migrations",
        reader: memoryReader({ "0001_renamed.sql": body }),
      }),
    MigrationRenamedError,
    "0001_a",
  )

  assertStrictEquals(error.pendingName, "0001_renamed")
  // The body ran once, and the history still holds only the name it ran under.
  assertEquals((await db.queryAll<{ n: number }>("SELECT n FROM counter")).map((row) => row.n), [1])
  assertEquals(await appliedNames(migrations()), ["0001_a"])
  await db.close()
})

Deno.test("the SQLite migrator reports an applied migration whose file was deleted", async () => {
  const { db, migrations } = await recordingSqlite()
  await runMigrations(migrations(), {
    folder: "/migrations",
    reader: memoryReader({ "0001_gone.sql": "CREATE TABLE one (id INTEGER)" }),
  })

  const report = await runMigrations(migrations(), {
    folder: "/migrations",
    reader: memoryReader({ "0002_new.sql": "CREATE TABLE two (id INTEGER)" }),
  })

  assertEquals(report, { applied: ["0002_new"], skipped: [], missing: ["0001_gone"] })
  await db.close()
})

Deno.test("the SQLite migrator adds the checksum column to a table that predates it", async () => {
  // The upgrade path a deployment that already ran migrations takes. Without it the
  // drift check would never see a checksum on the databases that most need it.
  const { db, migrations } = await recordingSqlite()
  await db.exec(`
    CREATE TABLE "migrations" (
      id         INTEGER PRIMARY KEY AUTOINCREMENT,
      name       TEXT NOT NULL UNIQUE,
      created_at TEXT NOT NULL DEFAULT (datetime('now'))
    )
  `)
  await db.execute(`INSERT INTO "migrations" (name) VALUES (?)`, "0001_one")

  const report = await runMigrations(migrations(), {
    folder: "/migrations",
    reader: memoryReader({
      "0001_one.sql": "CREATE TABLE one (id INTEGER)",
      "0002_two.sql": "CREATE TABLE two (id INTEGER)",
    }),
  })

  // The old row is unknown, so it is skipped without a comparison; the new one is
  // recorded with its checksum.
  assertEquals(report, { applied: ["0002_two"], skipped: ["0001_one"], missing: [] })
  assertEquals(await migrations().appliedMigrations(), [
    { name: "0001_one", checksum: null },
    { name: "0002_two", checksum: await checksumOf("CREATE TABLE two (id INTEGER)") },
  ])
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

  assertEquals(second, { applied: [], skipped: ["0001_one"], missing: [] })
  // `createHistoryTable` runs every time and is idempotent by `IF NOT EXISTS`; the
  // migration itself and its `BEGIN`/`COMMIT` are what must not run again. The table
  // name is quoted, which is what the statement's own text shows.
  assertEquals(statements.slice(before), [
    "\n" +
    '      CREATE TABLE IF NOT EXISTS "migrations"\n' +
    "      (\n" +
    "        id         INTEGER PRIMARY KEY AUTOINCREMENT,\n" +
    "        name       TEXT NOT NULL UNIQUE,\n" +
    "        checksum   TEXT,\n" +
    "        created_at TEXT NOT NULL DEFAULT (datetime('now'))\n" +
    "      )\n" +
    "    ",
  ])
  assertEquals(statements.includes("BEGIN"), true)
  assertEquals(await appliedNames(migrations()), ["0001_one"])
  await db.close()
})
