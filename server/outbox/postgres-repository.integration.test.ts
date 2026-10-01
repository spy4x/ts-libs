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
import { assertEquals } from "@std/assert"
import { describe, it } from "@std/testing/bdd"
import { createSql, type Sql } from "../db/index.ts"
import { postgresSettings, requireReachable, uniqueIdentifier } from "@integration-testing"
import { PostgresOutboxRepository } from "./postgres-repository.ts"
import { OutboxProcessor } from "./processor.ts"
import { ensureScheduledOutboxEvent, scheduleOutboxEvent } from "./schedule.ts"

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
        assertEquals(row.ms, 90_000)
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
