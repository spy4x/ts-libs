/**
 * `PostgresOutboxRepository` against a real server.
 *
 * `processor.test.ts` covers `OutboxProcessor` against a fake `OutboxRepository`.
 * What only a real server answers: whether `FOR UPDATE SKIP LOCKED` plus the lease
 * actually keeps a claimed-but-unpublished row invisible until the lease expires and
 * never lets two concurrent connections claim the same row, whether the returned rows
 * really carry the field names `OutboxEvent` promises, and whether `attempt_count <
 * maxAttempts` really excludes an exhausted row.
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
})
