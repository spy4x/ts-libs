/**
 * The generic-SQL `OutboxRepository`, over `postgres`.
 *
 * Ported from `template/libs/server/outbox/+index.ts`'s `PostgresOutboxRepository`.
 * The SQL is generic over any table shaped like the one below — nothing here
 * references the template's `groups`/`users` tables or its foreign keys, which is
 * what made this half of the extraction possible; see the {@link OutboxEvent} doc in
 * `processor.ts` for why those columns were dropped rather than kept.
 *
 * A caller wiring this up needs a table shaped like:
 *
 * ```sql
 * CREATE TABLE outbox_events (
 *   id                UUID PRIMARY KEY,
 *   event_kind        VARCHAR(64) NOT NULL,
 *   aggregate_type    VARCHAR(64) NOT NULL,
 *   aggregate_id      UUID NOT NULL,
 *   aggregate_version BIGINT NOT NULL,
 *   attempt_count     INT4 NOT NULL DEFAULT 0,
 *   available_at      TIMESTAMPTZ NOT NULL DEFAULT now(),
 *   claimed_at        TIMESTAMPTZ,
 *   processed_at      TIMESTAMPTZ,
 *   last_error_code   VARCHAR(64),
 *   created_at        TIMESTAMPTZ NOT NULL DEFAULT now()
 * );
 * CREATE INDEX ON outbox_events (available_at, created_at) WHERE processed_at IS NULL;
 * ```
 *
 * a name and a schema the caller's `Sql` already resolves to (`search_path` or a
 * qualified name), and a command that writes a row into it in the same transaction as
 * the state change it records — that command is the caller's own, not part of this
 * extraction, since it is one line embedded in application-specific write paths.
 *
 * `aggregate_id` only needs to be a type this driver returns as a string — `UUID`
 * fits the template's own aggregates, but nothing here assumes it. An app may keep
 * extra columns this repository neither reads nor returns, such as the template's own
 * `group_id` and `actor_user_id`: the app's own `INSERT` still fills them, in the same
 * transaction as the state change it records. Recommended but not required: a unique
 * index on `(aggregate_type, aggregate_id, aggregate_version, event_kind)`, which is
 * what makes a retried `INSERT` (after a crash between the state change and the
 * outbox row) idempotent instead of writing the event twice — the template had this
 * index; it is not enforced here because this repository reads and updates rows but
 * never creates or migrates the table.
 */
import type { Sql } from "../db/index.ts"
import type { OutboxEvent, OutboxRepository } from "./processor.ts"

export class PostgresOutboxRepository implements OutboxRepository {
  constructor(private readonly sql: Sql) {}

  /**
   * `FOR UPDATE SKIP LOCKED` stops two workers claiming the same row in the same
   * instant, but it only holds for the duration of this statement. Once the claim
   * commits, the row is unlocked and still unprocessed, so a second worker would
   * happily pick it up while the first is publishing.
   *
   * Pushing `available_at` forward by the lease is what actually makes a claimed row
   * invisible. A worker that dies mid-publish therefore releases its rows when the
   * lease expires, rather than stranding them — at the cost of a possible double
   * delivery if the first worker's publish was still in flight when the lease ran
   * out. That trade is inherent to a lease-based claim and is not something this
   * repository can close from the SQL side; a publisher that cannot tolerate a
   * duplicate needs its own idempotency key.
   *
   * `attemptCount` is incremented at claim time rather than on failure, so a row that
   * crashes the worker before it reports an outcome still burns an attempt and cannot
   * be retried forever.
   *
   * Every returned column is aliased to its `OutboxEvent` field name in the query
   * itself, rather than relying on the caller's `Sql` having been created with a
   * snake-to-camel row transform. `@spy4x/server/db`'s `createSql` does not default
   * to one (unlike the template's own client, which set `transform: postgres.camel`
   * globally) — aliasing here means this repository's row shape does not depend on
   * how the caller configured their pool.
   */
  async claimBatch(
    limit: number,
    maxAttempts: number,
    leaseSeconds: number,
  ): Promise<OutboxEvent[]> {
    return await this.sql<OutboxEvent[]>`
      WITH claimed AS (
        SELECT id
        FROM outbox_events
        WHERE processed_at IS NULL
          AND available_at <= now()
          AND attempt_count < ${maxAttempts}
        ORDER BY available_at, created_at
        FOR UPDATE SKIP LOCKED
        LIMIT ${limit}
      )
      UPDATE outbox_events AS events
      SET claimed_at = now(),
          attempt_count = events.attempt_count + 1,
          available_at = now() + (${leaseSeconds}::double precision * INTERVAL '1 second')
      FROM claimed
      WHERE events.id = claimed.id
      RETURNING
        events.id AS "id",
        events.event_kind AS "eventKind",
        events.aggregate_type AS "aggregateType",
        events.aggregate_id AS "aggregateId",
        events.aggregate_version::text AS "aggregateVersion",
        events.attempt_count AS "attemptCount"
    `
  }

  async markProcessed(id: string): Promise<void> {
    await this.sql`
      UPDATE outbox_events
      SET processed_at = now(),
          last_error_code = NULL
      WHERE id = ${id}
    `
  }

  async scheduleRetry(
    id: string,
    delaySeconds: number,
    errorCode: string,
  ): Promise<void> {
    await this.sql`
      UPDATE outbox_events
      SET available_at = now() + (${delaySeconds}::double precision * INTERVAL '1 second'),
          last_error_code = ${errorCode}
      WHERE id = ${id}
    `
  }

  /**
   * Undoes the claim on events the processor never tried. `attempt_count` goes back
   * down by one and `available_at` goes back to the claim time, so the event keeps its
   * place in the queue and is claimable at once.
   *
   * The `attempt_count` match is the ownership check: a later claim by another worker
   * raises it, so a release that arrives after the lease expired and the row was
   * reclaimed changes nothing. One statement per event keeps the `id` comparison typed
   * by the column itself, whatever type the caller's table uses for it.
   */
  async release(events: OutboxEvent[]): Promise<void> {
    for (const event of events) {
      await this.sql`
        UPDATE outbox_events
        SET attempt_count = attempt_count - 1,
            available_at = COALESCE(claimed_at, now())
        WHERE id = ${event.id}
          AND attempt_count = ${event.attemptCount}
          AND processed_at IS NULL
      `
    }
  }
}
