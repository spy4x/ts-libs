import type { Sql } from "../db/index.ts"
import {
  assertPositiveFinite,
  type BeginOutcome,
  IDEMPOTENCY_LEASE_SECONDS,
  IDEMPOTENCY_RETENTION_DAYS,
  type IdempotencyClaim,
  type IdempotencyStore,
} from "./idempotency.ts"

/**
 * The table and index, as SQL text the app runs as a migration.
 *
 * One row per command a client sent with an idempotency key. `status` is 1 while the first run is
 * in flight and 2 once its result is stored. `updated_at` is when the row was claimed or finished;
 * a claim that stays at 1 past its lease belongs to a run that died, and the next retry takes it
 * over with a new `claim_token`; `complete` and `release` change only the row whose token they hold, so a run that lost its claim changes nothing. The key is scoped to the user, so one user cannot replay or block another user's key.
 * `request_hash` fingerprints the command's input: the same key with different input is refused.
 *
 * `user_id` has no foreign key, because this library does not own your users table. Add
 * `REFERENCES users (id) ON DELETE CASCADE` in your migration if you want rows to go with the user.
 */
export const IDEMPOTENCY_POSTGRES_SCHEMA = `
CREATE TABLE idempotency_keys (
  user_id integer NOT NULL,
  key varchar(128) NOT NULL,
  command_name varchar(100) NOT NULL,
  request_hash varchar(64) NOT NULL,
  claim_token uuid NOT NULL,
  status smallint NOT NULL,
  result jsonb,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY (user_id, key),
  CONSTRAINT idempotency_keys_key_check CHECK (length(key) BETWEEN 1 AND 128),
  CONSTRAINT idempotency_keys_status_check CHECK (status IN (1, 2)),
  CONSTRAINT idempotency_keys_done_has_result_check CHECK (status = 1 OR result IS NOT NULL)
);

COMMENT ON COLUMN idempotency_keys.status IS '1=started, 2=done';

CREATE INDEX idx_idempotency_keys_created ON idempotency_keys (created_at);
`

/** What {@link PostgresIdempotencyStore} reads from outside. */
export interface PostgresIdempotencyStoreOptions {
  /** Seconds an unfinished claim holds before a retry may take it over. Default 30. */
  leaseSeconds?: number
  /** Days a key is kept. Default 7. */
  retentionDays?: number
}

const STARTED = 1
const DONE = 2

interface StoredKeyRow {
  commandName: string
  requestHash: string
  status: number
  result: unknown
  leaseExpired: boolean
}

/**
 * {@link IdempotencyStore} over the `idempotency_keys` table ({@link IDEMPOTENCY_POSTGRES_SCHEMA}).
 * Every comparison with time uses the database clock, so app servers need not agree on one.
 */
export class PostgresIdempotencyStore implements IdempotencyStore {
  private readonly leaseSeconds: number
  private readonly retentionDays: number

  constructor(private readonly sql: Sql, options: PostgresIdempotencyStoreOptions = {}) {
    this.leaseSeconds = options.leaseSeconds ?? IDEMPOTENCY_LEASE_SECONDS
    this.retentionDays = options.retentionDays ?? IDEMPOTENCY_RETENTION_DAYS
    assertPositiveFinite("leaseSeconds", this.leaseSeconds)
    assertPositiveFinite("retentionDays", this.retentionDays)
  }

  async begin(claim: IdempotencyClaim): Promise<BeginOutcome> {
    const { userId, key, commandName, requestHash } = claim
    // A key past its retention is forgotten here too, so the retention holds before any sweep.
    await this.sql`
      DELETE FROM idempotency_keys
      WHERE user_id = ${userId}
        AND key = ${key}
        AND created_at < now() - (${this.retentionDays}::double precision * INTERVAL '1 day')
    `
    const token = crypto.randomUUID()
    // A row released between the insert and the read is claimable again, so look twice.
    for (let attempt = 0; attempt < 3; attempt++) {
      const inserted = await this.sql`
        INSERT INTO idempotency_keys
          (user_id, key, command_name, request_hash, claim_token, status)
        VALUES (${userId}, ${key}, ${commandName}, ${requestHash}, ${token}, ${STARTED})
        ON CONFLICT (user_id, key) DO NOTHING
        RETURNING 1 AS claimed
      `
      if (inserted.length > 0) return { status: "claimed", token }

      const row = (
        await this.sql<StoredKeyRow[]>`
          SELECT
            command_name AS "commandName",
            request_hash AS "requestHash",
            status,
            result,
            updated_at < now() - (${this.leaseSeconds}::double precision * INTERVAL '1 second')
              AS "leaseExpired"
          FROM idempotency_keys
          WHERE user_id = ${userId} AND key = ${key}
        `
      )[0]
      if (!row) continue
      if (row.commandName !== commandName || row.requestHash !== requestHash) {
        return { status: "reused" }
      }
      if (row.status === DONE) return { status: "replay", result: row.result }
      if (!row.leaseExpired) return { status: "in_progress" }

      // The first run died. Only one retry may take its claim over.
      const taken = await this.sql`
        UPDATE idempotency_keys
        SET updated_at = now(), claim_token = ${token}
        WHERE user_id = ${userId}
          AND key = ${key}
          AND status = ${STARTED}
          AND updated_at < now() - (${this.leaseSeconds}::double precision * INTERVAL '1 second')
        RETURNING 1 AS claimed
      `
      return taken.length > 0 ? { status: "claimed", token } : { status: "in_progress" }
    }
    return { status: "in_progress" }
  }

  async complete(userId: number, key: string, token: string, result: unknown): Promise<void> {
    await this.sql`
      UPDATE idempotency_keys
      SET status = ${DONE},
          result = ${JSON.stringify(result ?? null)}::text::jsonb,
          updated_at = now()
      WHERE user_id = ${userId} AND key = ${key} AND status = ${STARTED}
        AND claim_token = ${token}
    `
  }

  async release(userId: number, key: string, token: string): Promise<void> {
    await this.sql`
      DELETE FROM idempotency_keys
      WHERE user_id = ${userId} AND key = ${key} AND status = ${STARTED}
        AND claim_token = ${token}
    `
  }

  async sweep(): Promise<number> {
    const removed = await this.sql`
      DELETE FROM idempotency_keys
      WHERE created_at < now() - (${this.retentionDays}::double precision * INTERVAL '1 day')
    `
    return removed.count
  }
}
