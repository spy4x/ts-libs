import type { Sql } from "../db/index.ts"
import {
  assertPositiveFinite,
  type BeginOutcome,
  IDEMPOTENCY_LEASE_SECONDS,
  IDEMPOTENCY_RETENTION_DAYS,
  type IdempotencyClaim,
  type IdempotencyStore,
} from "./idempotency.ts"
import { uuidV7 } from "@spy4x/platform/universal/uuid"

/**
 * The table and index, as SQL text the app runs as a migration.
 *
 * One row per command a client sent with an idempotency key. `status` is 1 while the first run is
 * in flight and 2 once its result is stored. `updated_at` is when the row was claimed or finished;
 * a claim that stays at 1 past its lease belongs to a run that died, and the next retry takes it
 * over with a new `claim_token`; `complete` and `release` change only the row whose token they hold, so a run that lost its claim changes nothing. The key is scoped to the user, so one user cannot replay or block another user's key.
 * `created_at` is when the key was claimed or last taken over. The retention counts from it, so a
 * retry that took over a dead run's claim keeps that claim, and its result, for the full retention.
 * `claim_token` is `uuid`: the store makes each token as a version 7 UUID. The store also works on
 * a table whose `claim_token` is `text`, which is what an app has after it ran
 * {@link IDEMPOTENCY_POSTGRES_CLAIM_TOKEN_TEXT} for 1.64.0.
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

/**
 * The migration release 1.64.0 needed, as SQL text: it widens `claim_token` from `uuid` to `text`.
 * No app needs it any more. In 1.64.0 the claim token was a random string that did not fit a `uuid`
 * column; since 1.64.1 it is a version 7 UUID, which fits both column types.
 *
 * An app that ran it keeps working: the store reads and writes a `text` column the same way, also
 * while it still holds claims made by 1.64.0. An app whose column is still `uuid` needs nothing.
 * The constant stays exported, and runs the same statement, so an app that lists it among its
 * migrations still builds and still migrates.
 *
 * @deprecated Not needed since 1.64.1: {@link PostgresIdempotencyStore} works on a `uuid` column
 * and on a `text` column. Leave it in a migration that already ran; do not add it to a new one.
 */
export const IDEMPOTENCY_POSTGRES_CLAIM_TOKEN_TEXT = `
ALTER TABLE idempotency_keys ALTER COLUMN claim_token TYPE text USING claim_token::text;
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
 *
 * `claim_token` may be a `uuid` or a `text` column. `complete` and `release` compare the token as
 * text on both sides, so the same statement runs on either type, keeps running on a connection that
 * was open while the column changed type, and matches nothing (instead of failing) when a token
 * that is not a UUID meets a `uuid` column.
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
    const token = uuidV7()
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

      // The first run died. Only one retry may take its claim over. The takeover restarts the
      // retention too: a retention counted from the dead run would delete the live claim, and the
      // stored result, while this retry's client may still retry.
      const taken = await this.sql`
        UPDATE idempotency_keys
        SET created_at = now(), updated_at = now(), claim_token = ${token}
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
        AND claim_token::text = ${token}::text
    `
  }

  async release(userId: number, key: string, token: string): Promise<void> {
    await this.sql`
      DELETE FROM idempotency_keys
      WHERE user_id = ${userId} AND key = ${key} AND status = ${STARTED}
        AND claim_token::text = ${token}::text
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
