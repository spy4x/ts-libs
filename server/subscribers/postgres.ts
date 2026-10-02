import type { Sql } from "../db/index.ts"
import type { SendLock, SendLog, SendLogEntry } from "./send-log.ts"
import type {
  AddSubscriberInput,
  AddSubscriberResult,
  RemoveSubscriberInput,
  Subscriber,
  SubscriberStore,
} from "./store.ts"

/**
 * The three tables, as SQL text the app runs as a migration.
 *
 * Every row carries a `list_id`, so one database can hold several lists; the stores below read and
 * write only the list they were created for.
 *
 * - `subscribers`: one row per address on a list. `(list_id, email)` is the primary key and
 *   `(list_id, key)` is unique: `key` is the address's `SubscriptionCrypto.subscriberKey`, the
 *   lookup id of a version 2 unsubscribe link.
 * - `subscriber_unsubscribes`: one row per unsubscribe mark (`SubscriptionCrypto.unsubscribeMark`),
 *   never an address, with when it was recorded. It is what turns a replayed confirm link away.
 * - `subscriber_sends`: one row per newsletter issue, the {@link SendLog} entry. `audience` and
 *   `recipients` hold `SubscriptionCrypto.sentMark` values, never addresses. They are NULL on an
 *   entry written before recipients or audiences were recorded, as the port describes.
 */
export const SUBSCRIBERS_POSTGRES_SCHEMA = `
CREATE TABLE subscribers (
  list_id text NOT NULL,
  email text NOT NULL,
  key text NOT NULL,
  subscribed_at timestamptz NOT NULL,
  PRIMARY KEY (list_id, email),
  CONSTRAINT subscribers_list_key_unique UNIQUE (list_id, key)
);

CREATE INDEX idx_subscribers_list_subscribed ON subscribers (list_id, subscribed_at);

CREATE TABLE subscriber_unsubscribes (
  list_id text NOT NULL,
  mark text NOT NULL,
  unsubscribed_at timestamptz NOT NULL,
  PRIMARY KEY (list_id, mark)
);

CREATE INDEX idx_subscriber_unsubscribes_at ON subscriber_unsubscribes (list_id, unsubscribed_at);

CREATE TABLE subscriber_sends (
  list_id text NOT NULL,
  issue text NOT NULL,
  subject text NOT NULL,
  started_at timestamptz NOT NULL,
  audience text[],
  recipients text[],
  sent integer,
  failed integer,
  completed_at timestamptz,
  PRIMARY KEY (list_id, issue)
);
`

/** What the Postgres subscriber store and send log are created for. */
export interface PostgresSubscribersOptions {
  /** Which list these stores serve. Every row carries it. Not empty. */
  listId: string
}

function checkListId(options: PostgresSubscribersOptions): string {
  const listId = (options as Partial<PostgresSubscribersOptions> | undefined)?.listId
  if (typeof listId !== `string` || listId === ``) {
    throw new TypeError(`subscribers: listId must be a non-empty string`)
  }
  return listId
}

/** The text hashed into an advisory lock key: length-prefixed, so two lists cannot share one. */
function lockText(listId: string, kind: string, name: string): string {
  return `${listId.length}:${listId}:${kind}:${name}`
}

interface SubscriberRow {
  email: string
  key: string
  subscribedAt: Date
}

/**
 * A {@link SubscriberStore} over the `subscribers` and `subscriber_unsubscribes` tables
 * ({@link SUBSCRIBERS_POSTGRES_SCHEMA}) for the list `listId`.
 *
 * `add` and `remove` each run in one transaction that first takes `pg_advisory_xact_lock` on the
 * list and address, so they never overlap for one address: a replayed confirm link cannot slip in
 * between a removal's mark and its row delete. Calls for other addresses do not wait for each
 * other.
 */
export function createPostgresSubscriberStore(
  sql: Sql,
  options: PostgresSubscribersOptions,
): SubscriberStore {
  const listId = checkListId(options)
  const toSubscriber = (row: SubscriberRow): Subscriber => ({
    email: row.email,
    key: row.key,
    subscribedAt: row.subscribedAt,
  })

  return {
    async list() {
      const rows = await sql<SubscriberRow[]>`
        SELECT email, key, subscribed_at AS "subscribedAt"
        FROM subscribers
        WHERE list_id = ${listId}
        ORDER BY subscribed_at, email
      `
      return rows.map(toSubscriber)
    },

    async findByKey(key) {
      const rows = await sql<SubscriberRow[]>`
        SELECT email, key, subscribed_at AS "subscribedAt"
        FROM subscribers
        WHERE list_id = ${listId} AND key = ${key}
      `
      return rows[0] && toSubscriber(rows[0])
    },

    add(input: AddSubscriberInput): Promise<AddSubscriberResult> {
      const address = lockText(listId, `address`, input.email)
      return sql.begin(async (tx) => {
        await tx`SELECT pg_advisory_xact_lock(hashtextextended(${address}::text, 0))`
        const known = await tx`
          SELECT 1 FROM subscribers WHERE list_id = ${listId} AND email = ${input.email}
        `
        if (known.length > 0) return `known` as const
        const marks = await tx<{ unsubscribedAt: Date }[]>`
          SELECT unsubscribed_at AS "unsubscribedAt"
          FROM subscriber_unsubscribes
          WHERE list_id = ${listId} AND mark = ${input.mark}
        `
        // Compared in milliseconds here: a Date holds exactly what the port wrote, while a
        // timestamp built in SQL from a float could land a hair above it.
        if (marks[0] && marks[0].unsubscribedAt.getTime() >= input.issuedAt) {
          return `replay` as const
        }
        await tx`
          INSERT INTO subscribers (list_id, email, key, subscribed_at)
          VALUES (${listId}, ${input.email}, ${input.key}, ${input.at})
        `
        return `added` as const
      })
    },

    remove(input: RemoveSubscriberInput): Promise<boolean> {
      const address = lockText(listId, `address`, input.email)
      return sql.begin(async (tx) => {
        await tx`SELECT pg_advisory_xact_lock(hashtextextended(${address}::text, 0))`
        const removed = await tx`
          DELETE FROM subscribers WHERE list_id = ${listId} AND email = ${input.email}
        `
        await tx`
          DELETE FROM subscriber_unsubscribes
          WHERE list_id = ${listId} AND unsubscribed_at < ${input.pruneBefore}
        `
        // The later of two unsubscribes of one address wins, so no link turns valid again.
        await tx`
          INSERT INTO subscriber_unsubscribes (list_id, mark, unsubscribed_at)
          VALUES (${listId}, ${input.mark}, ${input.at})
          ON CONFLICT (list_id, mark) DO UPDATE
          SET unsubscribed_at = GREATEST(subscriber_unsubscribes.unsubscribed_at, EXCLUDED.unsubscribed_at)
        `
        return removed.count > 0
      })
    },

    async count() {
      const rows = await sql<{ count: number }[]>`
        SELECT count(*)::int AS count FROM subscribers WHERE list_id = ${listId}
      `
      return rows[0].count
    },
  }
}

interface SendRow {
  issue: string
  subject: string
  startedAt: Date
  audience: string[] | null
  recipients: string[] | null
  sent: number | null
  failed: number | null
  completedAt: Date | null
}

/**
 * A {@link SendLog} over the `subscriber_sends` table ({@link SUBSCRIBERS_POSTGRES_SCHEMA}) for the
 * list `listId`. Every method but `lock` is one statement or one short transaction.
 *
 * `lock` takes a session-scoped `pg_try_advisory_lock` on a connection it reserves from the pool
 * for as long as the lock is held. One connection per lock matters: advisory locks are re-entrant
 * within a session, so two locks on one connection would both succeed. A crashed holder loses its
 * connection and with it the lock. Because the connection is held for the whole send, the pool
 * needs at least two connections, or the send's own queries wait for it forever.
 */
export function createPostgresSendLog(
  sql: Sql,
  options: PostgresSubscribersOptions,
): SendLog {
  const listId = checkListId(options)
  const neverStarted = (issue: string) => new Error(`send log: issue ${issue} was never started`)
  const toEntry = (row: SendRow): SendLogEntry => ({
    issue: row.issue,
    subject: row.subject,
    startedAt: row.startedAt,
    ...(row.audience !== null && { audience: row.audience }),
    ...(row.recipients !== null && { recipients: row.recipients }),
    ...(row.sent !== null && { sent: row.sent }),
    ...(row.failed !== null && { failed: row.failed }),
    ...(row.completedAt !== null && { completedAt: row.completedAt }),
  })
  const select = (db: Sql, issue: string) =>
    db<SendRow[]>`
      SELECT issue, subject, started_at AS "startedAt", audience, recipients, sent, failed,
             completed_at AS "completedAt"
      FROM subscriber_sends
      WHERE list_id = ${listId} AND issue = ${issue}
    `

  return {
    async lock(issue): Promise<SendLock | undefined> {
      const key = lockText(listId, `send`, issue)
      const connection = await sql.reserve()
      try {
        const [row] = await connection<{ locked: boolean }[]>`
          SELECT pg_try_advisory_lock(hashtextextended(${key}::text, 0)) AS locked
        `
        if (!row.locked) {
          connection.release()
          return undefined
        }
      } catch (error) {
        connection.release()
        throw error
      }
      let held = true
      return {
        async release() {
          if (!held) return
          held = false
          try {
            await connection`SELECT pg_advisory_unlock(hashtextextended(${key}::text, 0))`
          } finally {
            connection.release()
          }
        },
      }
    },

    async find(issue) {
      const rows = await select(sql, issue)
      return rows[0] && toEntry(rows[0])
    },

    async start({ issue, subject, audience, at }) {
      const rows = await sql.begin(async (tx) => {
        await tx`
          INSERT INTO subscriber_sends (list_id, issue, subject, started_at, audience, recipients)
          VALUES (${listId}, ${issue}, ${subject}, ${at}, ${audience as string[]}, ${[]}::text[])
          ON CONFLICT (list_id, issue) DO NOTHING
        `
        // An entry written before audiences were recorded gets this one; a legacy entry with no
        // recipients stays as it is.
        await tx`
          UPDATE subscriber_sends
          SET audience = ${audience as string[]}
          WHERE list_id = ${listId} AND issue = ${issue}
            AND audience IS NULL AND recipients IS NOT NULL
        `
        return await select(tx as unknown as Sql, issue)
      })
      return toEntry(rows[0])
    },

    async record(issue, mark) {
      const updated = await sql`
        UPDATE subscriber_sends
        SET recipients = CASE
          WHEN ${mark}::text = ANY (COALESCE(recipients, '{}')) THEN COALESCE(recipients, '{}')
          ELSE array_append(COALESCE(recipients, '{}'), ${mark}::text)
        END
        WHERE list_id = ${listId} AND issue = ${issue}
      `
      if (updated.count === 0) throw neverStarted(issue)
    },

    async finish({ issue, failed, at }) {
      const updated = await sql`
        UPDATE subscriber_sends
        SET sent = COALESCE(cardinality(recipients), 0),
            failed = ${failed},
            completed_at = CASE WHEN ${failed} = 0 THEN ${at}::timestamptz ELSE completed_at END
        WHERE list_id = ${listId} AND issue = ${issue}
      `
      if (updated.count === 0) throw neverStarted(issue)
    },
  }
}
