/**
 * `PostgresOutboxRepository` against a real server.
 *
 * `processor.test.ts` covers `OutboxProcessor` against a fake `OutboxRepository`.
 * What only a real server answers: whether `FOR UPDATE SKIP LOCKED` plus the lease
 * actually keeps a claimed-but-unpublished row invisible until the lease expires and
 * never lets two concurrent connections claim the same row, whether the returned rows
 * really carry the field names `OutboxEvent` promises, and whether `attempt_count <
 * maxAttempts` really excludes an exhausted row, and whether `release` undoes only its
 * own claim.
 *
 * Isolation: every run creates its own schema and table, points one or two
 * single-connection `Sql` clients at it with `search_path`, and drops the schema in a
 * `finally`. Nothing shared is touched.
 */
import { assert, assertEquals, assertRejects } from "@std/assert"
import { describe, it } from "@std/testing/bdd"
import { createSql, type Sql } from "../db/index.ts"
import { postgresSettings, requireReachable, uniqueIdentifier } from "@integration-testing"
import { PostgresOutboxRepository } from "./postgres-repository.ts"
import { type OutboxAttemptFailure, OutboxProcessor } from "./processor.ts"
import {
  ensureScheduledOutboxEvent,
  type ReplacedOutboxEvent,
  scheduleOutboxEvent,
} from "./schedule.ts"
import { isUuid } from "@spy4x/platform/universal/uuid"

const OUTBOX_EVENTS_TABLE = `
  CREATE TABLE outbox_events (
    id                UUID PRIMARY KEY,
    event_kind        VARCHAR(64) NOT NULL,
    aggregate_type    VARCHAR(64) NOT NULL,
    aggregate_id      UUID NOT NULL,
    aggregate_version BIGINT NOT NULL,
    attempt_count     INT4 NOT NULL DEFAULT 0,
    available_at      TIMESTAMPTZ NOT NULL DEFAULT now(),
    claimed_at        TIMESTAMPTZ,
    processed_at      TIMESTAMPTZ,
    last_error_code   VARCHAR(64),
    created_at        TIMESTAMPTZ NOT NULL DEFAULT now()
  )
`

/** Open a client on a fresh schema holding an `outbox_events` table, dropped after. */
async function withOutboxSchema(
  body: (sql: Sql, schema: string) => Promise<void>,
): Promise<void> {
  const settings = postgresSettings()
  await requireReachable(settings.address)

  const schema = uniqueIdentifier("it_outbox")
  const sql = createSql({ connection: settings.connection, max: 1, applicationName: schema })

  try {
    await sql`SET client_min_messages = warning`
    await sql`CREATE SCHEMA ${sql(schema)}`
    await sql`SELECT set_config('search_path', ${schema}, false)`
    await sql.unsafe(OUTBOX_EVENTS_TABLE)
    await body(sql, schema)
  } finally {
    await sql`DROP SCHEMA IF EXISTS ${sql(schema)} CASCADE`
    await sql.end()
  }
}

/**
 * A second, independent client pointed at the same schema — a genuinely separate
 * Postgres connection, for tests that need two connections talking to the table at
 * once. The caller closes it with `sql.end()`.
 */
async function openSecondClient(schema: string): Promise<Sql> {
  const settings = postgresSettings()
  const sql = createSql({
    connection: settings.connection,
    max: 1,
    applicationName: `${schema}_b`,
  })
  await sql`SELECT set_config('search_path', ${schema}, false)`
  return sql
}

/** Inserts one row with the given id, kind and starting attempt count of 0. */
async function insertRow(
  sql: Sql,
  id: string,
  eventKind: string,
  aggregateId: string,
): Promise<void> {
  await sql`
    INSERT INTO outbox_events (id, event_kind, aggregate_type, aggregate_id, aggregate_version)
    VALUES (${id}, ${eventKind}, 'group', ${aggregateId}, 1)
  `
}

const ROW_A = "11111111-1111-4111-8111-111111111111"
const ROW_B = "22222222-2222-4222-8222-222222222222"

describe("PostgresOutboxRepository against a real server", () => {
  it("claims unprocessed rows in order and returns the promised field names", async () => {
    await withOutboxSchema(async (sql) => {
      await insertRow(sql, ROW_A, "group.created", ROW_A)
      // A moment later, so ordering by (available_at, created_at) is unambiguous.
      await sql`SELECT pg_sleep(0.01)`
      await insertRow(sql, ROW_B, "group.renamed", ROW_A)

      const repository = new PostgresOutboxRepository(sql)
      const claimed = await repository.claimBatch(10, 5, 60)

      assertEquals(claimed.length, 2)
      assertEquals(claimed[0], {
        id: ROW_A,
        eventKind: "group.created",
        aggregateType: "group",
        aggregateId: ROW_A,
        aggregateVersion: "1",
        attemptCount: 1,
      })
      assertEquals(claimed[1].id, ROW_B)
    })
  })

  it("does not reclaim a row whose lease has not expired", async () => {
    await withOutboxSchema(async (sql) => {
      await insertRow(sql, ROW_A, "group.created", ROW_A)
      const repository = new PostgresOutboxRepository(sql)

      const first = await repository.claimBatch(10, 5, 60)
      assertEquals(first.length, 1)

      const second = await repository.claimBatch(10, 5, 60)
      assertEquals(second.length, 0)
    })
  })

  it("reclaims a row once its lease has expired, and bumps its attempt count again", async () => {
    await withOutboxSchema(async (sql) => {
      await insertRow(sql, ROW_A, "group.created", ROW_A)
      const repository = new PostgresOutboxRepository(sql)

      const first = await repository.claimBatch(10, 5, 60)
      assertEquals(first[0].attemptCount, 1)

      // Simulate the lease expiring: a worker that dies mid-publish leaves
      // available_at in the past instead of ever calling markProcessed/scheduleRetry.
      await sql`UPDATE outbox_events SET available_at = now() - INTERVAL '1 second'`

      const second = await repository.claimBatch(10, 5, 60)
      assertEquals(second.length, 1)
      assertEquals(second[0].attemptCount, 2)
    })
  })

  it("excludes a row that has reached the attempt ceiling", async () => {
    await withOutboxSchema(async (sql) => {
      await insertRow(sql, ROW_A, "group.created", ROW_A)
      await sql`UPDATE outbox_events SET attempt_count = 5`

      const repository = new PostgresOutboxRepository(sql)
      const claimed = await repository.claimBatch(10, 5, 60)

      assertEquals(claimed.length, 0)
    })
  })

  it("markProcessed stops a row from being claimed again", async () => {
    await withOutboxSchema(async (sql) => {
      await insertRow(sql, ROW_A, "group.created", ROW_A)
      const repository = new PostgresOutboxRepository(sql)

      const [claimedRow] = await repository.claimBatch(10, 5, 60)
      await repository.markProcessed(claimedRow.id)

      // Force the lease to have "expired" and try again: still nothing, because
      // processed_at IS NULL is the guard that actually keeps it out.
      await sql`UPDATE outbox_events SET available_at = now() - INTERVAL '1 second'`
      assertEquals((await repository.claimBatch(10, 5, 60)).length, 0)

      const rows = await sql<{ processedAt: Date | null; lastErrorCode: string | null }[]>`
        SELECT processed_at AS "processedAt", last_error_code AS "lastErrorCode"
        FROM outbox_events WHERE id = ${ROW_A}
      `
      assertEquals(rows[0].lastErrorCode, null)
      assertEquals(rows[0].processedAt !== null, true)
    })
  })

  it("scheduleRetry pushes available_at into the future and records the error code", async () => {
    await withOutboxSchema(async (sql) => {
      await insertRow(sql, ROW_A, "group.created", ROW_A)
      const repository = new PostgresOutboxRepository(sql)

      const [claimedRow] = await repository.claimBatch(10, 5, 60)
      await repository.scheduleRetry(claimedRow.id, 30, "TypeError")

      // Not available yet: scheduleRetry pushed it 30s into the future.
      assertEquals((await repository.claimBatch(10, 5, 60)).length, 0)

      const rows = await sql<{ lastErrorCode: string | null; availableAt: Date }[]>`
        SELECT last_error_code AS "lastErrorCode", available_at AS "availableAt"
        FROM outbox_events WHERE id = ${ROW_A}
      `
      assertEquals(rows[0].lastErrorCode, "TypeError")
      assertEquals(rows[0].availableAt.getTime() > Date.now(), true)
    })
  })

  it("never claims the same row from two connections at once", async () => {
    await withOutboxSchema(async (sql, schema) => {
      await insertRow(sql, ROW_A, "group.created", ROW_A)
      await insertRow(sql, ROW_B, "group.renamed", ROW_A)

      const sqlB = await openSecondClient(schema)
      try {
        // Connection A claims inside an open transaction and then holds it open with a
        // fixed server-side sleep — not by waiting on connection B — so this can never
        // deadlock: if FOR UPDATE SKIP LOCKED were ever removed and B's own claim then
        // blocked on A's row lock, A still commits on its own after the sleep, and B's
        // claim finally goes through, red for the reason this test exists to catch.
        const claimedAPromise = sql.begin(async (tx) => {
          const repositoryA = new PostgresOutboxRepository(tx)
          const claimed = await repositoryA.claimBatch(10, 5, 60)
          await tx`SELECT pg_sleep(0.2)`
          return claimed
        })

        // Give connection A's transaction time to acquire its row locks before B claims.
        await new Promise((resolve) => setTimeout(resolve, 50))

        const repositoryB = new PostgresOutboxRepository(sqlB)
        const claimedB = await repositoryB.claimBatch(10, 5, 60)
        const claimedA = await claimedAPromise

        const claimedIds = [...claimedA, ...claimedB].map((event) => event.id)
        // No row went to both connections...
        assertEquals(claimedIds.length, new Set(claimedIds).size)
        // ...and, since nothing else was competing for them, both rows went to exactly
        // one of the two.
        assertEquals(claimedIds.slice().sort(), [ROW_A, ROW_B].slice().sort())
      } finally {
        await sqlB.end()
      }
    })
  })

  it("release undoes the claim's attempt and makes the row claimable again at once", async () => {
    await withOutboxSchema(async (sql) => {
      await insertRow(sql, ROW_A, "group.created", ROW_A)
      const repository = new PostgresOutboxRepository(sql)

      const first = await repository.claimBatch(10, 5, 60)
      await repository.release(first)

      const second = await repository.claimBatch(10, 5, 60)
      assertEquals(second.map((row) => [row.id, row.attemptCount]), [[ROW_A, 1]])
    })
  })

  it("release puts a row back at its claim time, ahead of rows that became available later", async () => {
    await withOutboxSchema(async (sql) => {
      await insertRow(sql, ROW_A, "group.created", ROW_A)
      const repository = new PostgresOutboxRepository(sql)

      const claimed = await repository.claimBatch(10, 5, 60)
      await sql`SELECT pg_sleep(0.01)`
      // Becomes available after ROW_A was claimed, but before ROW_A is released.
      await insertRow(sql, ROW_B, "group.renamed", ROW_A)
      await sql`SELECT pg_sleep(0.01)`
      await repository.release(claimed)

      const next = await repository.claimBatch(1, 5, 60)
      assertEquals(next.map((row) => row.id), [ROW_A])
    })
  })

  it("release leaves a processed row alone even when its attempt count matches", async () => {
    await withOutboxSchema(async (sql) => {
      await insertRow(sql, ROW_A, "group.created", ROW_A)
      const repository = new PostgresOutboxRepository(sql)

      const claimed = await repository.claimBatch(10, 5, 60)
      await repository.markProcessed(ROW_A)
      await repository.release(claimed)

      const rows = await sql<{ attemptCount: number; processed: boolean }[]>`
        SELECT attempt_count AS "attemptCount", processed_at IS NOT NULL AS "processed"
        FROM outbox_events WHERE id = ${ROW_A}
      `
      assertEquals([...rows], [{ attemptCount: 1, processed: true }])
    })
  })

  it("release leaves a row alone once another claim has taken it", async () => {
    await withOutboxSchema(async (sql) => {
      await insertRow(sql, ROW_A, "group.created", ROW_A)
      const repository = new PostgresOutboxRepository(sql)

      const stale = await repository.claimBatch(10, 5, 60)
      // The lease expires and another worker claims the row.
      await sql`UPDATE outbox_events SET available_at = now() - INTERVAL '1 second'`
      assertEquals((await repository.claimBatch(10, 5, 60)).length, 1)

      await repository.release(stale)

      const rows = await sql<{ attemptCount: number; leased: boolean }[]>`
        SELECT attempt_count AS "attemptCount", available_at > now() AS "leased"
        FROM outbox_events WHERE id = ${ROW_A}
      `
      assertEquals([...rows], [{ attemptCount: 2, leased: true }])
      assertEquals((await repository.claimBatch(10, 5, 60)).length, 0)
    })
  })

  it("a drain that outlasts its lease publishes only the head and hands the tail back", async () => {
    await withOutboxSchema(async (sql) => {
      await insertRow(sql, ROW_A, "group.created", ROW_A)
      await sql`SELECT pg_sleep(0.01)`
      await insertRow(sql, ROW_B, "group.renamed", ROW_A)
      const repository = new PostgresOutboxRepository(sql)
      const clock = { now: 0 }
      const published: string[] = []
      const processor = new OutboxProcessor(repository, {
        publish: (event) => {
          published.push(event.id)
          // One publish uses 40 of the 60 lease seconds; a second would overrun it.
          clock.now += 40_000
          return Promise.resolve()
        },
      }, { now: () => clock.now })

      assertEquals(await processor.drainOnce(), { claimed: 2, published: 1, failed: 0 })
      assertEquals(published, [ROW_A])

      const rows = await sql<{ id: string; attemptCount: number; processed: boolean }[]>`
        SELECT id, attempt_count AS "attemptCount", processed_at IS NOT NULL AS "processed"
        FROM outbox_events ORDER BY created_at
      `
      assertEquals([...rows], [
        { id: ROW_A, attemptCount: 1, processed: true },
        { id: ROW_B, attemptCount: 0, processed: false },
      ])
      const next = await repository.claimBatch(10, 5, 60)
      assertEquals(next.map((row) => [row.id, row.attemptCount]), [[ROW_B, 1]])
    })
  })
})

const JOB_SUBJECT = "33333333-3333-4333-8333-333333333333"

describe("delayed and repeating jobs against a real server", () => {
  it("does not claim a job scheduled for later until its time has come", async () => {
    await withOutboxSchema(async (sql) => {
      await scheduleOutboxEvent(
        sql,
        { eventKind: "account.delete", aggregateType: "user", aggregateId: JOB_SUBJECT },
        { inMs: 60 * 60_000 },
      )
      const repository = new PostgresOutboxRepository(sql)

      assertEquals((await repository.claimBatch(10, 5, 60)).length, 0)

      // Moves the stored times an hour back, which is what the clock reaching them looks like.
      await sql`UPDATE outbox_events SET available_at = available_at - INTERVAL '61 minutes'`
      const claimed = await repository.claimBatch(10, 5, 60)
      assertEquals(claimed.map((row) => row.eventKind), ["account.delete"])
    })
  })

  it("leaves no scheduled job when the transaction that scheduled it rolls back", async () => {
    await withOutboxSchema(async (sql) => {
      await assertRejects(
        () =>
          sql.begin(async (tx) => {
            await scheduleOutboxEvent(
              tx,
              { eventKind: "account.delete", aggregateType: "user", aggregateId: JOB_SUBJECT },
              { inMs: 0 },
            )
            throw new Error("the change around the job failed")
          }),
        Error,
        "the change around the job failed",
      )
      const [{ count }] = await sql<{ count: number }[]>`
        SELECT count(*)::int AS count FROM outbox_events
      `
      assertEquals(count, 0)
    })
  })

  it("leaves exactly one scheduled job when the transaction that scheduled it commits", async () => {
    await withOutboxSchema(async (sql) => {
      const id = await sql.begin((tx) =>
        scheduleOutboxEvent(
          tx,
          { eventKind: "account.delete", aggregateType: "user", aggregateId: JOB_SUBJECT },
          { inMs: 0 },
        )
      )
      const rows = await sql<{ id: string; eventKind: string }[]>`
        SELECT id, event_kind AS "eventKind" FROM outbox_events
      `
      assertEquals([...rows], [{ id, eventKind: "account.delete" }])
    })
  })

  it("writes the next run of a repeating job when its run succeeds, once", async () => {
    await withOutboxSchema(async (sql) => {
      await scheduleOutboxEvent(
        sql,
        { eventKind: "nightly.cleanup", aggregateType: "job", aggregateId: JOB_SUBJECT },
        { inMs: 0 },
      )
      const repository = new PostgresOutboxRepository(sql)
      const processor = new OutboxProcessor(repository, { publish: () => Promise.resolve() }, {
        repeatEveryMs: { "nightly.cleanup": 24 * 60 * 60_000 },
      })

      assertEquals((await processor.drainOnce()).published, 1)
      // The second drain finds nothing: the successor is a day away.
      assertEquals((await processor.drainOnce()).claimed, 0)

      const rows = await sql<{ processed: boolean; hours: number }[]>`
        SELECT processed_at IS NOT NULL AS processed,
          round(extract(epoch FROM available_at - now()) / 3600)::int AS hours
        FROM outbox_events ORDER BY processed_at NULLS LAST
      `
      assertEquals(rows.map((row) => row.processed), [true, false])
      assertEquals(rows[1].hours, 24)

      // A redelivery of the finished run must not start a second chain.
      const [done] = await sql<{ id: string }[]>`
        SELECT id FROM outbox_events WHERE processed_at IS NOT NULL
      `
      await repository.markProcessed(done.id, 86_400)
      const [{ count }] = await sql<{ count: number }[]>`
        SELECT count(*)::int AS count FROM outbox_events
      `
      assertEquals(count, 2)
    })
  })

  it("retries a failing job with backoff, then stops with its error stored", async () => {
    await withOutboxSchema(async (sql) => {
      await scheduleOutboxEvent(
        sql,
        { eventKind: "nightly.cleanup", aggregateType: "job", aggregateId: JOB_SUBJECT },
        { inMs: 0 },
      )
      const processor = new OutboxProcessor(
        new PostgresOutboxRepository(sql),
        { publish: () => Promise.reject(new TypeError("boom")) },
        { maxAttempts: 3, baseRetryDelayMs: 1_000 },
      )

      const delays: number[] = []
      for (let attempt = 1; attempt <= 3; attempt++) {
        assertEquals((await processor.drainOnce()).failed, 1)
        const [row] = await sql<{ seconds: number }[]>`
          SELECT round(extract(epoch FROM available_at - now()))::int AS seconds FROM outbox_events
        `
        delays.push(row.seconds)
        // Lets the retry time pass.
        await sql`UPDATE outbox_events SET available_at = now() - INTERVAL '1 second'`
      }
      assertEquals(delays, [1, 2, 4])

      assertEquals((await processor.drainOnce()).claimed, 0)
      const [row] = await sql<{ error: string; attempts: number; done: boolean }[]>`
        SELECT last_error_code AS error, attempt_count AS attempts,
          processed_at IS NOT NULL AS done
        FROM outbox_events
      `
      assertEquals(row, { error: "TypeError", attempts: 3, done: false })
    })
  })

  it("starts a repeating job once however often it is asked", async () => {
    await withOutboxSchema(async (sql) => {
      const job = { eventKind: "nightly.cleanup", aggregateType: "job", aggregateId: JOB_SUBJECT }
      assertEquals(typeof await ensureScheduledOutboxEvent(sql, job, { inMs: 1000 }), "string")
      assertEquals(await ensureScheduledOutboxEvent(sql, job, { inMs: 1000 }), null)
    })
  })

  it("gives every job it writes a version 7 UUID: scheduled, started once, and repeated", async () => {
    await withOutboxSchema(async (sql) => {
      const scheduled = await scheduleOutboxEvent(
        sql,
        { eventKind: "account.delete", aggregateType: "user", aggregateId: JOB_SUBJECT },
        { inMs: 60 * 60_000 },
      )
      const started = await ensureScheduledOutboxEvent(
        sql,
        { eventKind: "nightly.cleanup", aggregateType: "job", aggregateId: JOB_SUBJECT },
        { inMs: 0 },
      )
      assert(isUuid(scheduled, 7), `scheduleOutboxEvent returned ${scheduled}`)
      assert(isUuid(started, 7), `ensureScheduledOutboxEvent returned ${started}`)

      // Finishing the repeating job writes its next run; that row's id is made by the library too.
      await new PostgresOutboxRepository(sql).markProcessed(started, 86_400)
      const rows = await sql<{ id: string }[]>`SELECT id FROM outbox_events`
      assertEquals(rows.length, 3)
      for (const row of rows) assert(isUuid(row.id, 7), `row id ${row.id}`)
      assertEquals(rows.map((row) => row.id).includes(scheduled), true)
    })
  })

  it("leaves one chain when two workers start the same job at once", async () => {
    await withOutboxSchema(async (sql, schema) => {
      const other = await openSecondClient(schema)
      try {
        const job = {
          eventKind: "nightly.cleanup",
          aggregateType: "job",
          aggregateId: JOB_SUBJECT,
        }
        for (let round = 0; round < 10; round++) {
          await sql`DELETE FROM outbox_events`
          const results = await Promise.all([
            ensureScheduledOutboxEvent(sql, job, { inMs: 1000 }),
            ensureScheduledOutboxEvent(other, job, { inMs: 1000 }),
          ])
          assertEquals(results.filter((id) => id !== null).length, 1)
          const [{ count }] = await sql<{ count: number }[]>`
            SELECT count(*)::int AS count FROM outbox_events WHERE processed_at IS NULL
          `
          assertEquals(count, 1)
        }
      } finally {
        await other.end()
      }
    })
  })

  it("starts the same kind of job for another aggregate", async () => {
    await withOutboxSchema(async (sql) => {
      const job = { eventKind: "nightly.cleanup", aggregateType: "job", aggregateId: JOB_SUBJECT }
      await ensureScheduledOutboxEvent(sql, job, { inMs: 1000 })
      const other = { ...job, aggregateId: ROW_A }
      assertEquals(typeof await ensureScheduledOutboxEvent(sql, other, { inMs: 1000 }), "string")
      const another = { ...job, aggregateType: "report" }
      assertEquals(typeof await ensureScheduledOutboxEvent(sql, another, { inMs: 1000 }), "string")
    })
  })

  it("does not restart a chain that gave up, so its stored error stays visible", async () => {
    await withOutboxSchema(async (sql) => {
      const job = { eventKind: "nightly.cleanup", aggregateType: "job", aggregateId: JOB_SUBJECT }
      await ensureScheduledOutboxEvent(sql, job, { inMs: 0 })
      await sql`UPDATE outbox_events SET attempt_count = 5, last_error_code = 'TypeError'`

      assertEquals(await ensureScheduledOutboxEvent(sql, job, { inMs: 0 }), null)
      const [{ count }] = await sql<{ count: number }[]>`
        SELECT count(*)::int AS count FROM outbox_events
      `
      assertEquals(count, 1)
    })
  })

  it("counts a delay on the database clock", async () => {
    await withOutboxSchema(async (sql) => {
      await sql.begin(async (tx) => {
        // now() is fixed at the start of a transaction; the app clock moves on during the sleep.
        await tx`SELECT pg_sleep(1.5)`
        await scheduleOutboxEvent(
          tx,
          { eventKind: "x", aggregateType: "job", aggregateId: JOB_SUBJECT },
          { inMs: 90_000 },
        )
        const [row] = await tx<{ ms: number }[]>`
          SELECT round(extract(epoch FROM available_at - now()) * 1000)::int AS ms FROM outbox_events
        `
        // The delay is read back through a JS Date, which keeps milliseconds, while now() and the
        // timestamptz column keep microseconds: the stored time can sit up to a millisecond early.
        // The app clock would be 1500 ms off here.
        assert(Math.abs(row.ms - 90_000) <= 1, `expected 90000 ms, got ${row.ms}`)
      })
    })
  })

  it("refuses a negative delay", async () => {
    await withOutboxSchema(async (sql) => {
      let error: unknown
      try {
        await scheduleOutboxEvent(
          sql,
          { eventKind: "x", aggregateType: "job", aggregateId: JOB_SUBJECT },
          { inMs: -1 },
        )
      } catch (caught) {
        error = caught
      }
      assertEquals(error instanceof RangeError, true)
    })
  })
})

/** What the tests below read back of every row, oldest first. */
interface RowState {
  kind: string
  attempts: number
  done: boolean
  error: string | null
  hours: number
}

async function rowStates(sql: Sql): Promise<RowState[]> {
  return await sql<RowState[]>`
    SELECT event_kind AS kind, attempt_count AS attempts, processed_at IS NOT NULL AS done,
      last_error_code AS error,
      round(extract(epoch FROM available_at - now()) / 3600)::int AS hours
    FROM outbox_events ORDER BY available_at, created_at
  `
}

/**
 * Moves every unprocessed row an hour into the past, claim and lease together: what an hour of
 * waiting would do, without the wait.
 */
async function letAnHourPass(sql: Sql): Promise<void> {
  await sql`
    UPDATE outbox_events
    SET available_at = available_at - INTERVAL '1 hour',
        claimed_at = claimed_at - INTERVAL '1 hour'
    WHERE processed_at IS NULL
  `
}

/**
 * A publisher that records every event it is given and holds the first one until `finish` is
 * called: a worker that is alive and slow. `started` resolves once the first publish is running.
 */
function slowPublisher() {
  const started = Promise.withResolvers<void>()
  const held = Promise.withResolvers<void>()
  const published: string[] = []
  return {
    published,
    started: started.promise,
    /** Lets the held publish succeed, or fail with `error`. */
    finish: (error?: Error) => error === undefined ? held.resolve() : held.reject(error),
    publish: async (event: { id: string }) => {
      published.push(event.id)
      if (published.length > 1) return
      started.resolve()
      await held.promise
    },
  }
}

const NIGHTLY = { eventKind: "nightly.cleanup", aggregateType: "job", aggregateId: JOB_SUBJECT }
const DAY_MS = 24 * 60 * 60_000

describe("given-up events against a real server", () => {
  it("giveUp closes a row once, keeps its error code, and the row is never claimed again", async () => {
    await withOutboxSchema(async (sql) => {
      await insertRow(sql, ROW_A, "group.created", ROW_A)
      const repository = new PostgresOutboxRepository(sql)
      await repository.claimBatch(10, 1, 0)

      assertEquals(await repository.giveUp(ROW_A, "TypeError"), true)
      assertEquals(await repository.giveUp(ROW_A, "RangeError"), false)

      const rows = await rowStates(sql)
      assertEquals(rows.map((row) => [row.done, row.error]), [[true, "TypeError"]])
      // Not even with a higher ceiling, which would bring back a row that only ran out.
      assertEquals((await repository.claimBatch(10, 99, 0)).length, 0)
    })
  })

  it("giveUp without a next run leaves a processed row and its cleared error alone", async () => {
    await withOutboxSchema(async (sql) => {
      await insertRow(sql, ROW_A, "group.created", ROW_A)
      const repository = new PostgresOutboxRepository(sql)
      await repository.claimBatch(10, 1, 0)
      await repository.markProcessed(ROW_A)

      assertEquals(await repository.giveUp(ROW_A, "TypeError"), false)

      assertEquals((await rowStates(sql)).map((row) => [row.done, row.error]), [[true, null]])
    })
  })

  it("giveUp writes the next run as it closes the row, and no second one when asked again", async () => {
    await withOutboxSchema(async (sql) => {
      const first = await scheduleOutboxEvent(sql, NIGHTLY, { inMs: 0 })
      const repository = new PostgresOutboxRepository(sql)
      await repository.claimBatch(10, 1, 60)

      assertEquals(await repository.giveUp(first, "TypeError", 86_400), true)
      assertEquals(await repository.giveUp(first, "TypeError", 86_400), false)

      const rows = await sql<{ id: string; attempts: number; hours: number }[]>`
        SELECT id, attempt_count AS attempts,
          round(extract(epoch FROM available_at - now()) / 3600)::int AS hours
        FROM outbox_events WHERE id <> ${first}
      `
      assertEquals(rows.length, 1)
      assertEquals({ attempts: rows[0].attempts, hours: rows[0].hours }, { attempts: 0, hours: 24 })
      assert(isUuid(rows[0].id, 7), `next run id ${rows[0].id}`)
    })
  })

  it("giveUp after the run succeeded changes nothing: the success already wrote the one next run", async () => {
    await withOutboxSchema(async (sql) => {
      const first = await scheduleOutboxEvent(sql, NIGHTLY, { inMs: 0 })
      const repository = new PostgresOutboxRepository(sql)
      await repository.claimBatch(10, 1, 60)
      await repository.markProcessed(first, 86_400)

      assertEquals(await repository.giveUp(first, "TypeError", 86_400), false)

      const rows = await rowStates(sql)
      assertEquals(
        rows.map((row) => [row.done, row.error, row.hours]),
        [[true, null, 0], [false, null, 24]],
      )
    })
  })

  it("leaves one next run when a success and a give-up of the same run land together", async () => {
    await withOutboxSchema(async (sql, schema) => {
      const other = await openSecondClient(schema)
      try {
        const succeeding = new PostgresOutboxRepository(sql)
        const givingUp = new PostgresOutboxRepository(other)
        for (let round = 0; round < 20; round++) {
          const job = {
            ...NIGHTLY,
            aggregateId: `00000000-0000-4000-8000-${String(round).padStart(12, "0")}`,
          }
          const id = await scheduleOutboxEvent(sql, job, { inMs: 0 })
          await succeeding.claimBatch(10, 1, 60)

          await Promise.all([
            succeeding.markProcessed(id, 86_400),
            givingUp.giveUp(id, "OutboxLeaseExpired", 86_400),
          ])

          const [{ runs, waiting }] = await sql<{ runs: number; waiting: number }[]>`
            SELECT count(*)::int AS runs, count(*) FILTER (WHERE processed_at IS NULL)::int AS waiting
            FROM outbox_events WHERE aggregate_id = ${job.aggregateId}
          `
          assertEquals({ round, runs, waiting }, { round, runs: 2, waiting: 1 })
        }
      } finally {
        await other.end()
      }
    })
  })

  it("giveUp writes no next run while another run of the same job already waits", async () => {
    await withOutboxSchema(async (sql) => {
      const first = await scheduleOutboxEvent(sql, NIGHTLY, { inMs: 0 })
      const repository = new PostgresOutboxRepository(sql)
      await repository.claimBatch(10, 1, 60)
      await scheduleOutboxEvent(sql, NIGHTLY, { inMs: DAY_MS })

      assertEquals(await repository.giveUp(first, "TypeError", 86_400), true)

      const rows = await rowStates(sql)
      assertEquals(rows.map((row) => [row.done, row.hours]), [[true, 0], [false, 24]])
    })
  })

  for (
    const [what, waiting] of [
      ["of another kind", { ...NIGHTLY, eventKind: "nightly.report" }],
      ["of another aggregate type", { ...NIGHTLY, aggregateType: "report" }],
      ["of another aggregate", { ...NIGHTLY, aggregateId: ROW_A }],
      ["that is already processed", null],
    ] as const
  ) {
    it(`giveUp still writes the next run when the only other run is one ${what}`, async () => {
      await withOutboxSchema(async (sql) => {
        const first = await scheduleOutboxEvent(sql, NIGHTLY, { inMs: 0 })
        const repository = new PostgresOutboxRepository(sql)
        await repository.claimBatch(10, 1, 60)
        if (waiting === null) {
          const earlier = await scheduleOutboxEvent(sql, NIGHTLY, { inMs: DAY_MS })
          await repository.markProcessed(earlier)
        } else {
          await scheduleOutboxEvent(sql, waiting, { inMs: DAY_MS })
        }

        await repository.giveUp(first, "TypeError", 86_400)

        const next = await sql`
          SELECT 1 FROM outbox_events
          WHERE event_kind = ${NIGHTLY.eventKind} AND aggregate_type = ${NIGHTLY.aggregateType}
            AND aggregate_id = ${NIGHTLY.aggregateId} AND processed_at IS NULL
        `
        assertEquals(next.length, 1)
      })
    })
  }

  it("findLost returns only an unprocessed row out of attempts whose lease ran out", async () => {
    await withOutboxSchema(async (sql) => {
      const ids = {
        lost: "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa",
        attemptsLeft: "bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb",
        leaseRunning: "cccccccc-cccc-4ccc-8ccc-cccccccccccc",
        processed: "dddddddd-dddd-4ddd-8ddd-dddddddddddd",
        givenUp: "eeeeeeee-eeee-4eee-8eee-eeeeeeeeeeee",
      }
      for (const id of Object.values(ids)) await insertRow(sql, id, "group.created", ROW_A)
      const repository = new PostgresOutboxRepository(sql)
      // Every row is claimed for the second time, with a lease that is over at once.
      await repository.claimBatch(10, 2, 0)
      await repository.claimBatch(10, 2, 0)
      await sql`UPDATE outbox_events SET attempt_count = 1 WHERE id = ${ids.attemptsLeft}`
      await sql`
        UPDATE outbox_events SET available_at = now() + INTERVAL '1 minute'
        WHERE id = ${ids.leaseRunning}
      `
      await repository.markProcessed(ids.processed)
      await repository.giveUp(ids.givenUp, "TypeError")

      const lost = await repository.findLost(2, 10)

      assertEquals([...lost], [{
        id: ids.lost,
        eventKind: "group.created",
        aggregateType: "group",
        aggregateId: ROW_A,
        aggregateVersion: "1",
        attemptCount: 2,
        lastErrorCode: null,
      }])
      assertEquals((await repository.findLost(2, 0)).length, 0)
    })
  })

  it("findLost waits one more lease length after the lease ran out", async () => {
    await withOutboxSchema(async (sql) => {
      await insertRow(sql, ROW_A, "group.created", ROW_A)
      const repository = new PostgresOutboxRepository(sql)
      await repository.claimBatch(10, 1, 60)

      // The 60 second lease ran out 59 seconds ago: its worker may only be slow.
      await sql`
        UPDATE outbox_events
        SET claimed_at = now() - INTERVAL '119 seconds', available_at = now() - INTERVAL '59 seconds'
      `
      assertEquals((await repository.findLost(1, 10)).length, 0)

      await sql`
        UPDATE outbox_events
        SET claimed_at = now() - INTERVAL '121 seconds', available_at = now() - INTERVAL '61 seconds'
      `
      assertEquals((await repository.findLost(1, 10)).map((event) => event.id), [ROW_A])
    })
  })

  it("tells each failed attempt of a job, the last one as last, and never again as lost", async () => {
    await withOutboxSchema(async (sql) => {
      await scheduleOutboxEvent(sql, NIGHTLY, { inMs: 0 })
      const failures: OutboxAttemptFailure[] = []
      const processor = new OutboxProcessor(
        new PostgresOutboxRepository(sql),
        { publish: () => Promise.reject(new TypeError("boom")) },
        { maxAttempts: 3, onAttemptFailed: (failure) => void failures.push(failure) },
      )

      for (let drain = 0; drain < 5; drain++) {
        await processor.drainOnce()
        // Lets every retry time, lease and the margin after it pass.
        await letAnHourPass(sql)
        await sql`UPDATE outbox_events SET available_at = now() - INTERVAL '1 hour'`
      }

      assertEquals(
        failures.map((failure) => [failure.attempt, failure.lastAttempt, failure.stage]),
        [[1, false, "publish"], [2, false, "publish"], [3, true, "publish"]],
      )
      const rows = await rowStates(sql)
      assertEquals(
        rows.map((row) => [row.attempts, row.done, row.error]),
        [[3, true, "TypeError"]],
      )
    })
  })

  it("tells a row whose worker died on its last attempt, once, and closes it with the reason", async () => {
    await withOutboxSchema(async (sql) => {
      await insertRow(sql, ROW_A, "group.created", ROW_A)
      const repository = new PostgresOutboxRepository(sql)
      // The worker that claimed the last attempt never reported back.
      await repository.claimBatch(10, 1, 60)
      await letAnHourPass(sql)
      const failures: OutboxAttemptFailure[] = []
      const processor = new OutboxProcessor(repository, { publish: () => Promise.resolve() }, {
        maxAttempts: 1,
        onAttemptFailed: (failure) => void failures.push(failure),
      })

      assertEquals(await processor.drainOnce(), { claimed: 0, published: 0, failed: 0 })
      await processor.drainOnce()

      assertEquals(
        failures.map((
          failure,
        ) => [failure.event.id, failure.stage, failure.lastAttempt, failure.storedErrorCode]),
        [[ROW_A, "lease", true, null]],
      )
      const rows = await rowStates(sql)
      assertEquals(rows.map((row) => [row.error, row.done]), [["OutboxLeaseExpired", true]])
    })
  })

  it("does not give up a row whose worker is late by less than one more lease length", async () => {
    await withOutboxSchema(async (sql) => {
      await insertRow(sql, ROW_A, "group.created", ROW_A)
      const repository = new PostgresOutboxRepository(sql)
      await repository.claimBatch(10, 1, 60)
      await sql`
        UPDATE outbox_events
        SET claimed_at = now() - INTERVAL '119 seconds', available_at = now() - INTERVAL '59 seconds'
      `
      const failures: OutboxAttemptFailure[] = []
      const processor = new OutboxProcessor(repository, { publish: () => Promise.resolve() }, {
        maxAttempts: 1,
        onAttemptFailed: (failure) => void failures.push(failure),
      })

      await processor.drainOnce()

      assertEquals(failures, [])
      assertEquals((await rowStates(sql)).map((row) => [row.done, row.error]), [[false, null]])
    })
  })

  it("keeps the stored error of a row given up before the callback was set, and passes it on", async () => {
    await withOutboxSchema(async (sql) => {
      await insertRow(sql, ROW_A, "group.created", ROW_A)
      const repository = new PostgresOutboxRepository(sql)
      const failing = { publish: () => Promise.reject(new TypeError("boom")) }
      // Yesterday's deployment, without the callback: the last attempt fails and the row stays.
      await new OutboxProcessor(repository, failing, { maxAttempts: 1 }).drainOnce()
      assertEquals((await rowStates(sql)).map((row) => [row.done, row.error]), [[
        false,
        "TypeError",
      ]])
      await letAnHourPass(sql)

      const failures: OutboxAttemptFailure[] = []
      await new OutboxProcessor(repository, failing, {
        maxAttempts: 1,
        onAttemptFailed: (failure) => void failures.push(failure),
      }).drainOnce()

      assertEquals(
        failures.map((failure) => [failure.stage, failure.lastAttempt, failure.storedErrorCode]),
        [["lease", true, "TypeError"]],
      )
      assertEquals((await rowStates(sql)).map((row) => [row.done, row.error]), [[
        true,
        "TypeError",
      ]])
    })
  })

  it("leaves a lost row untold and untouched without the callback", async () => {
    await withOutboxSchema(async (sql) => {
      await insertRow(sql, ROW_A, "group.created", ROW_A)
      const repository = new PostgresOutboxRepository(sql)
      await repository.claimBatch(10, 1, 0)
      const before = await rowStates(sql)

      await new OutboxProcessor(repository, { publish: () => Promise.resolve() }, {
        maxAttempts: 1,
      })
        .drainOnce()

      const after = await rowStates(sql)
      assertEquals(after.map((row) => [row.done, row.error]), [[false, null]])
      assertEquals(after.length, before.length)
    })
  })

  it("ends the chain of a repeating job that fails its last attempt, by default", async () => {
    await withOutboxSchema(async (sql) => {
      await scheduleOutboxEvent(sql, NIGHTLY, { inMs: 0 })
      const processor = new OutboxProcessor(
        new PostgresOutboxRepository(sql),
        { publish: () => Promise.reject(new TypeError("boom")) },
        { maxAttempts: 1, repeatEveryMs: { "nightly.cleanup": DAY_MS }, onAttemptFailed: () => {} },
      )

      assertEquals((await processor.drainOnce()).failed, 1)

      assertEquals((await rowStates(sql)).map((row) => [row.done, row.error]), [[
        true,
        "TypeError",
      ]])
    })
  })

  it("with repeatAfterGiveUp, a repeating job that fails its last attempt runs again a day later", async () => {
    await withOutboxSchema(async (sql) => {
      await scheduleOutboxEvent(sql, NIGHTLY, { inMs: 0 })
      const processor = new OutboxProcessor(
        new PostgresOutboxRepository(sql),
        { publish: () => Promise.reject(new TypeError("boom")) },
        { maxAttempts: 2, repeatEveryMs: { "nightly.cleanup": DAY_MS }, repeatAfterGiveUp: true },
      )

      assertEquals((await processor.drainOnce()).failed, 1)
      // An attempt is left: no next run yet.
      assertEquals((await rowStates(sql)).length, 1)
      await sql`UPDATE outbox_events SET available_at = now() - INTERVAL '1 second'`
      assertEquals((await processor.drainOnce()).failed, 1)
      await processor.drainOnce()

      const rows = await rowStates(sql)
      assertEquals(
        rows.map((row) => [row.attempts, row.done, row.error, row.hours]),
        [[2, true, "TypeError", 0], [0, false, null, 24]],
      )
    })
  })

  it("with repeatAfterGiveUp, a repeating job whose worker died on its last attempt runs again, once", async () => {
    await withOutboxSchema(async (sql, schema) => {
      const other = await openSecondClient(schema)
      try {
        await scheduleOutboxEvent(sql, NIGHTLY, { inMs: 0 })
        await new PostgresOutboxRepository(sql).claimBatch(10, 1, 0)
        const told: string[] = []
        const options = {
          maxAttempts: 1,
          repeatEveryMs: { "nightly.cleanup": DAY_MS },
          repeatAfterGiveUp: true,
          onAttemptFailed: (failure: OutboxAttemptFailure) => void told.push(failure.stage),
        }
        const ok = { publish: () => Promise.resolve() }

        // Two workers find the lost row in the same moment.
        await Promise.all([
          new OutboxProcessor(new PostgresOutboxRepository(sql), ok, options).drainOnce(),
          new OutboxProcessor(new PostgresOutboxRepository(other), ok, options).drainOnce(),
        ])

        const rows = await rowStates(sql)
        assertEquals(
          rows.map((row) => [row.attempts, row.done, row.error, row.hours]),
          [[1, true, "OutboxLeaseExpired", 0], [0, false, null, 24]],
        )
        assertEquals(told, ["lease"])
      } finally {
        await other.end()
      }
    })
  })
})

describe("a worker that outlives its lease on a last attempt, against a real server", () => {
  /** What both workers run with; `told` collects what each one's callback hears. */
  function workerOptions(told: string[], name: string) {
    return {
      maxAttempts: 1,
      leaseSeconds: 60,
      repeatEveryMs: { "nightly.cleanup": DAY_MS },
      repeatAfterGiveUp: true,
      onAttemptFailed: (failure: OutboxAttemptFailure) =>
        void told.push(`${name}: ${failure.stage} ${failure.event.eventKind}`),
    }
  }

  it("writes one next run when the slow attempt succeeds after another worker gave the job up", async () => {
    await withOutboxSchema(async (sql, schema) => {
      const other = await openSecondClient(schema)
      try {
        await scheduleOutboxEvent(sql, NIGHTLY, { inMs: 0 })
        const told: string[] = []
        const slow = slowPublisher()
        const workerA = new OutboxProcessor(
          new PostgresOutboxRepository(sql),
          slow,
          workerOptions(told, "A"),
        )
        const workerB = new OutboxProcessor(
          new PostgresOutboxRepository(other),
          { publish: () => Promise.resolve() },
          workerOptions(told, "B"),
        )

        // A claims the last attempt and is still publishing an hour later.
        const draining = workerA.drainOnce()
        await slow.started
        await letAnHourPass(other)
        // B finds the attempt lost, gives the job up and writes its next run.
        await workerB.drainOnce()
        assertEquals((await rowStates(other)).map((row) => row.done), [true, false])
        // Only now does A's publish succeed, and A marks the job processed, repeating.
        slow.finish()
        assertEquals(await draining, { claimed: 1, published: 1, failed: 0 })

        const rows = await rowStates(sql)
        assertEquals(
          rows.map((row) => [row.attempts, row.done, row.error]),
          [[1, true, "OutboxLeaseExpired"], [0, false, null]],
        )
        assertEquals(told, ["B: lease nightly.cleanup"])
      } finally {
        await other.end()
      }
    })
  })

  it("tells the job once when the slow attempt fails after another worker gave it up", async () => {
    await withOutboxSchema(async (sql, schema) => {
      const other = await openSecondClient(schema)
      try {
        await scheduleOutboxEvent(sql, NIGHTLY, { inMs: 0 })
        const told: string[] = []
        const slow = slowPublisher()
        const workerA = new OutboxProcessor(
          new PostgresOutboxRepository(sql),
          slow,
          workerOptions(told, "A"),
        )
        const workerB = new OutboxProcessor(
          new PostgresOutboxRepository(other),
          { publish: () => Promise.resolve() },
          workerOptions(told, "B"),
        )

        const draining = workerA.drainOnce()
        await slow.started
        await letAnHourPass(other)
        await workerB.drainOnce()
        slow.finish(new TypeError("boom"))
        assertEquals(await draining, { claimed: 1, published: 0, failed: 1 })

        const rows = await rowStates(sql)
        assertEquals(
          rows.map((row) => [row.attempts, row.done, row.error]),
          [[1, true, "OutboxLeaseExpired"], [0, false, null]],
        )
        assertEquals(told, ["B: lease nightly.cleanup"])
      } finally {
        await other.end()
      }
    })
  })

  it("never publishes a row that was told as given up while the slow worker had not tried it yet", async () => {
    await withOutboxSchema(async (sql, schema) => {
      const other = await openSecondClient(schema)
      try {
        await insertRow(sql, ROW_A, "group.created", ROW_A)
        await insertRow(sql, ROW_B, "group.updated", ROW_B)
        const told: string[] = []
        const slow = slowPublisher()
        // A's own clock: the first publish takes longer than the whole lease.
        let clock = 0
        const workerA = new OutboxProcessor(new PostgresOutboxRepository(sql), slow, {
          ...workerOptions(told, "A"),
          now: () => clock,
        })
        const later: string[] = []
        const workerB = new OutboxProcessor(
          new PostgresOutboxRepository(other),
          { publish: (event) => Promise.resolve(void later.push(event.id)) },
          workerOptions(told, "B"),
        )

        // A claims both rows on their last attempt and gets stuck on the first.
        const draining = workerA.drainOnce()
        await slow.started
        await letAnHourPass(other)
        // B tells both as given up.
        await workerB.drainOnce()
        assertEquals(told, ["B: lease group.created", "B: lease group.updated"])
        // A's first publish ends; its lease is long over, so it hands the second row back.
        clock = 3_600_000
        slow.finish()
        assertEquals(await draining, { claimed: 2, published: 1, failed: 0 })

        // The handed-back row stays closed: no worker, with any ceiling, picks it up again.
        await letAnHourPass(other)
        await workerB.drainOnce()
        await new OutboxProcessor(new PostgresOutboxRepository(sql), slow, { maxAttempts: 99 })
          .drainOnce()
        assertEquals(slow.published, [ROW_A])
        assertEquals(later, [])
        const rows = await sql<{ id: string; attempts: number; done: boolean }[]>`
          SELECT id, attempt_count AS attempts, processed_at IS NOT NULL AS done
          FROM outbox_events ORDER BY created_at
        `
        assertEquals(rows.map((row) => [row.id, row.attempts, row.done]), [
          [ROW_A, 1, true],
          [ROW_B, 1, true],
        ])
        assertEquals(told.length, 2)
      } finally {
        await other.end()
      }
    })
  })
})

describe("ensureScheduledOutboxEvent with replaceGivenUpAfter against a real server", () => {
  it("closes the row that used up its attempts and starts the chain again", async () => {
    await withOutboxSchema(async (sql) => {
      const old = await ensureScheduledOutboxEvent(sql, NIGHTLY, { inMs: 0 })
      await sql`UPDATE outbox_events SET attempt_count = 5, last_error_code = 'TypeError'`
      const replaced: ReplacedOutboxEvent[] = []

      const fresh = await ensureScheduledOutboxEvent(sql, NIGHTLY, { inMs: DAY_MS }, {
        replaceGivenUpAfter: 5,
        onReplaced: (row) => void replaced.push(row),
      })

      assert(isUuid(fresh, 7), `returned ${fresh}`)
      assertEquals(
        replaced.map((row) => [row.id, row.attemptCount, row.lastErrorCode]),
        [[old, 5, "TypeError"]],
      )
      const rows = await rowStates(sql)
      assertEquals(
        rows.map((row) => [row.attempts, row.done, row.error, row.hours]),
        [[5, true, "TypeError", 0], [0, false, null, 24]],
      )
      const [{ id }] = await sql<{ id: string }[]>`
        SELECT id FROM outbox_events WHERE processed_at IS NULL
      `
      assertEquals(id, fresh)
    })
  })

  it("leaves a row that still has attempts left, and starts nothing", async () => {
    await withOutboxSchema(async (sql) => {
      await ensureScheduledOutboxEvent(sql, NIGHTLY, { inMs: 0 })
      await sql`UPDATE outbox_events SET attempt_count = 4, last_error_code = 'TypeError'`
      const replaced: ReplacedOutboxEvent[] = []

      const result = await ensureScheduledOutboxEvent(sql, NIGHTLY, { inMs: 0 }, {
        replaceGivenUpAfter: 5,
        onReplaced: (row) => void replaced.push(row),
      })

      assertEquals(result, null)
      assertEquals(replaced, [])
      const rows = await rowStates(sql)
      assertEquals(rows.map((row) => [row.attempts, row.done]), [[4, false]])
    })
  })

  it("closes a given-up row but starts no second chain when a later run already waits", async () => {
    await withOutboxSchema(async (sql) => {
      await scheduleOutboxEvent(sql, NIGHTLY, { inMs: 0 })
      await sql`UPDATE outbox_events SET attempt_count = 5`
      await scheduleOutboxEvent(sql, NIGHTLY, { inMs: DAY_MS })

      const result = await ensureScheduledOutboxEvent(sql, NIGHTLY, { inMs: 0 }, {
        replaceGivenUpAfter: 5,
      })

      assertEquals(result, null)
      const rows = await rowStates(sql)
      assertEquals(rows.map((row) => [row.attempts, row.done]), [[5, true], [0, false]])
    })
  })

  for (
    const [what, other] of [
      ["of another aggregate", { ...NIGHTLY, aggregateId: ROW_A }],
      ["of another kind on the same aggregate", { ...NIGHTLY, eventKind: "nightly.report" }],
      ["of the same kind on another aggregate type", { ...NIGHTLY, aggregateType: "report" }],
    ] as const
  ) {
    it(`leaves the given-up row ${what} alone`, async () => {
      await withOutboxSchema(async (sql) => {
        const untouched = await ensureScheduledOutboxEvent(sql, other, { inMs: 0 })
        await sql`UPDATE outbox_events SET attempt_count = 5`
        const replaced: ReplacedOutboxEvent[] = []

        await ensureScheduledOutboxEvent(sql, NIGHTLY, { inMs: 0 }, {
          replaceGivenUpAfter: 5,
          onReplaced: (row) => void replaced.push(row),
        })

        const rows = await sql<{ id: string; done: boolean }[]>`
          SELECT id, processed_at IS NOT NULL AS done FROM outbox_events WHERE attempt_count = 5
        `
        assertEquals(rows.map((row) => [row.id, row.done]), [[untouched, false]])
        assertEquals(replaced, [])
      })
    })
  }

  it("starts the chain again by default once a processor with the callback closed the given-up run", async () => {
    await withOutboxSchema(async (sql) => {
      await ensureScheduledOutboxEvent(sql, NIGHTLY, { inMs: 0 })
      await new OutboxProcessor(
        new PostgresOutboxRepository(sql),
        { publish: () => Promise.reject(new TypeError("boom")) },
        { maxAttempts: 1, onAttemptFailed: () => {} },
      ).drainOnce()

      const fresh = await ensureScheduledOutboxEvent(sql, NIGHTLY, { inMs: DAY_MS })

      assert(isUuid(fresh, 7), `returned ${fresh}`)
      const rows = await rowStates(sql)
      assertEquals(
        rows.map((row) => [row.done, row.error, row.hours]),
        [[true, "TypeError", 0], [false, null, 24]],
      )
    })
  })

  it("leaves one chain when two workers replace the same given-up row at once", async () => {
    await withOutboxSchema(async (sql, schema) => {
      const other = await openSecondClient(schema)
      try {
        for (let round = 0; round < 10; round++) {
          await sql`DELETE FROM outbox_events`
          await scheduleOutboxEvent(sql, NIGHTLY, { inMs: 0 })
          await sql`UPDATE outbox_events SET attempt_count = 5`
          const replaced: ReplacedOutboxEvent[] = []
          const options = {
            replaceGivenUpAfter: 5,
            onReplaced: (row: ReplacedOutboxEvent) => void replaced.push(row),
          }

          const results = await Promise.all([
            ensureScheduledOutboxEvent(sql, NIGHTLY, { inMs: DAY_MS }, options),
            ensureScheduledOutboxEvent(other, NIGHTLY, { inMs: DAY_MS }, options),
          ])

          assertEquals(results.filter((id) => id !== null).length, 1)
          assertEquals(replaced.length, 1)
          const rows = await rowStates(sql)
          assertEquals(rows.map((row) => [row.attempts, row.done]), [[5, true], [0, false]])
        }
      } finally {
        await other.end()
      }
    })
  })

  it("a last attempt that succeeds after its row was replaced writes no second next run", async () => {
    await withOutboxSchema(async (sql) => {
      const old = await scheduleOutboxEvent(sql, NIGHTLY, { inMs: 0 })
      const repository = new PostgresOutboxRepository(sql)
      // The last attempt is running when another worker starts up and replaces the row.
      await repository.claimBatch(10, 1, 60)
      await ensureScheduledOutboxEvent(sql, NIGHTLY, { inMs: DAY_MS }, { replaceGivenUpAfter: 1 })

      await repository.markProcessed(old, 86_400)

      const rows = await rowStates(sql)
      assertEquals(rows.map((row) => [row.attempts, row.done]), [[1, true], [0, false]])
    })
  })

  it("refuses a ceiling that is not an integer of at least 1", async () => {
    await withOutboxSchema(async (sql) => {
      for (const replaceGivenUpAfter of [0, -1, 1.5, NaN]) {
        await assertRejects(
          () => ensureScheduledOutboxEvent(sql, NIGHTLY, { inMs: 0 }, { replaceGivenUpAfter }),
          RangeError,
        )
      }
      assertEquals((await rowStates(sql)).length, 0)
    })
  })
})
