import type { Sql, Transaction } from "../db/index.ts"

/** The row a job is: what it is called and what it is about. Nothing else is stored. */
export interface ScheduledOutboxEvent {
  /** What the publisher switches on, for example `account.delete`. At most 64 characters. */
  eventKind: string
  /** The kind of thing the job is about, for example `user`. */
  aggregateType: string
  /** The thing the job is about; the publisher reads its data from here, not from a payload. */
  aggregateId: string
}

/** When the job first runs: at a moment, or a number of milliseconds from now. */
export type OutboxSchedule = { at: Date } | { inMs: number }

/**
 * Writes one outbox row that becomes claimable at the given time and returns its id. Pass the
 * transaction of the change that needs the job, so both commit together or neither does.
 *
 * `aggregateVersion` is the run time in epoch milliseconds: the same job for the same thing at
 * the same moment is the unique-index conflict a caller who wants it once should expect.
 *
 * The row carries only the library's columns, so any extra column in the caller's table must be
 * nullable or have a default. `{ inMs }` is counted on the database clock, the one the claim reads.
 *
 * @throws RangeError when `inMs` is not a finite number of at least 0, or `at` is not a date.
 */
export async function scheduleOutboxEvent(
  sql: Sql,
  event: ScheduledOutboxEvent,
  when: OutboxSchedule,
): Promise<string> {
  const id = crypto.randomUUID()
  const runAt = await runTime(sql, when)
  await insertEvent(sql, id, event, runAt)
  return id
}

/**
 * Starts a repeating job, once. Writes the row only when no unprocessed row exists for the same
 * kind, aggregate type and aggregate id, so a worker may call it at every start-up, and two
 * workers starting together still leave one chain: the check runs in a transaction this function
 * opens, under an advisory lock on those three values. A row that gave up after `maxAttempts`
 * still counts as waiting: the chain stays stopped, with its error visible in `last_error_code`,
 * until someone deals with it. Returns the new id, or `null` when a row already existed.
 *
 * Any extra column in the caller's table must be nullable or have a default, as for
 * {@link scheduleOutboxEvent}. Pass the pool, not a transaction handle.
 */
export async function ensureScheduledOutboxEvent(
  sql: Sql,
  event: ScheduledOutboxEvent,
  when: OutboxSchedule,
): Promise<string | null> {
  const key = `${event.eventKind}/${event.aggregateType}/${event.aggregateId}`
  return await sql.begin(async (tx) => {
    await tx`SELECT pg_advisory_xact_lock(hashtextextended(${key}, 0))`
    const waiting = await tx`
      SELECT 1 FROM outbox_events
      WHERE event_kind = ${event.eventKind}
        AND aggregate_type = ${event.aggregateType}
        AND aggregate_id = ${event.aggregateId}
        AND processed_at IS NULL
      LIMIT 1
    `
    if (waiting.length > 0) return null
    const id = crypto.randomUUID()
    await insertEvent(tx, id, event, await runTime(tx, when))
    return id
  })
}

/** The moment a job first runs, read from the database clock for `{ inMs }`. */
async function runTime(sql: Sql | Transaction, when: OutboxSchedule): Promise<Date> {
  if ("at" in when) {
    if (!(when.at instanceof Date) || Number.isNaN(when.at.getTime())) {
      throw new RangeError(`at must be a valid Date`)
    }
    return when.at
  }
  if (!Number.isFinite(when.inMs) || when.inMs < 0) {
    throw new RangeError(`inMs must be a finite number of at least 0, got ${when.inMs}`)
  }
  const [row] = await sql<{ runAt: Date }[]>`
    SELECT now() + ${when.inMs}::double precision * INTERVAL '1 millisecond' AS "runAt"
  `
  return row.runAt
}

async function insertEvent(
  sql: Sql | Transaction,
  id: string,
  event: ScheduledOutboxEvent,
  runAt: Date,
): Promise<void> {
  await sql`
    INSERT INTO outbox_events (
      id, event_kind, aggregate_type, aggregate_id, aggregate_version, available_at
    ) VALUES (
      ${id}, ${event.eventKind}, ${event.aggregateType}, ${event.aggregateId},
      ${runAt.getTime()}, ${runAt}
    )
  `
}
