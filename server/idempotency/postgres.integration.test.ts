/**
 * `PostgresIdempotencyStore` against a real server, held to the same contract as the memory store,
 * plus the options only a database can show.
 *
 * Isolation: every test creates its own schema and table, points a two-connection pool at it with
 * `search_path`, and drops the schema in a `finally`. Nothing shared is touched. Time moves by
 * rewriting the rows' timestamps, so no test sleeps.
 */
import { expect } from "@std/expect"
import { describe, it } from "@std/testing/bdd"
import postgres from "postgres"
import { buildPostgresOptions, type Sql } from "../db/index.ts"
import { postgresSettings, requireReachable, uniqueIdentifier } from "@integration-testing"
import {
  IDEMPOTENCY_POSTGRES_CLAIM_TOKEN_TEXT,
  IDEMPOTENCY_POSTGRES_SCHEMA,
  PostgresIdempotencyStore,
} from "./postgres.ts"
import { describeIdempotencyStoreContract, type StoreFixture } from "./store-contract.test.ts"

/** The table as 1.63.0 and earlier created it: `claim_token` is a `uuid` column. */
const SCHEMA_BEFORE_1_64 = IDEMPOTENCY_POSTGRES_SCHEMA.replace(
  "claim_token text NOT NULL",
  "claim_token uuid NOT NULL",
)

/** A fresh schema holding the table, a pool on it, and the cleanup. */
async function openSchema(
  options?: ConstructorParameters<typeof PostgresIdempotencyStore>[1],
  schemaSql: string = IDEMPOTENCY_POSTGRES_SCHEMA,
): Promise<StoreFixture & { sql: Sql }> {
  const settings = postgresSettings()
  await requireReachable(settings.address)

  const schema = uniqueIdentifier("it_idem")
  const admin = postgres({
    ...buildPostgresOptions({ connection: settings.connection, max: 1 }),
    onnotice: () => {},
  }) as unknown as Sql
  await admin`CREATE SCHEMA ${admin(schema)}`
  const sql = postgres({
    ...buildPostgresOptions({ connection: settings.connection, max: 4 }),
    connection: { application_name: schema, search_path: schema },
    onnotice: () => {},
  }) as unknown as Sql
  const close = async () => {
    await sql.end()
    await admin`DROP SCHEMA IF EXISTS ${admin(schema)} CASCADE`
    await admin.end()
  }
  try {
    await sql.unsafe(schemaSql)
  } catch (error) {
    await close()
    throw error
  }
  return {
    sql,
    store: new PostgresIdempotencyStore(sql, options),
    advance: async (ms) => {
      await sql`
        UPDATE idempotency_keys
        SET created_at = created_at - (${ms}::double precision * INTERVAL '1 millisecond'),
            updated_at = updated_at - (${ms}::double precision * INTERVAL '1 millisecond')
      `
    },
    close,
  }
}

describeIdempotencyStoreContract("PostgresIdempotencyStore", () => openSchema())

describe("widening claim_token from uuid to text", () => {
  /** A token as the store of 1.63.0 made it: a UUID version 4. */
  const OLD_TOKEN = "3f2b8c1e-9d4a-4e6f-8a1b-2c3d4e5f6a7b"
  const OTHER_OLD_TOKEN = "7c9e6679-7425-40de-944b-e07fc1f90ae7"

  /** Claims `key` the way the store of 1.63.0 did, with a UUID token it made itself. */
  async function claimAsOldStore(sql: Sql, key: string, token: string): Promise<void> {
    await sql`
      INSERT INTO idempotency_keys (user_id, key, command_name, request_hash, claim_token, status)
      VALUES (1, ${key}, 'RenameCommand', 'hash-a', ${token}, 1)
    `
  }

  const claim = (key: string) => ({
    userId: 1,
    key,
    commandName: "RenameCommand",
    requestHash: "hash-a",
  })

  it("starts from a table whose column the new token does not fit", async () => {
    const fixture = await openSchema(undefined, SCHEMA_BEFORE_1_64)
    try {
      expect(SCHEMA_BEFORE_1_64).not.toBe(IDEMPOTENCY_POSTGRES_SCHEMA)
      await expect(fixture.store.begin(claim("k"))).rejects.toThrow(/uuid/)
    } finally {
      await fixture.close()
    }
  })

  it("completes and releases a claim made with an old UUID token through the new store after the migration", async () => {
    const fixture = await openSchema(undefined, SCHEMA_BEFORE_1_64)
    try {
      await claimAsOldStore(fixture.sql, "done", OLD_TOKEN)
      await claimAsOldStore(fixture.sql, "given-up", OTHER_OLD_TOKEN)

      await fixture.sql.unsafe(IDEMPOTENCY_POSTGRES_CLAIM_TOKEN_TEXT)

      await fixture.store.complete(1, "done", OLD_TOKEN, "kept")
      await fixture.store.release(1, "given-up", OTHER_OLD_TOKEN)
      expect(await fixture.store.begin(claim("done"))).toEqual({ status: "replay", result: "kept" })
      expect(await fixture.store.begin(claim("given-up"))).toMatchObject({ status: "claimed" })
    } finally {
      await fixture.close()
    }
  })

  it("answers for a UUID claim written after the migration and still fences its own claims", async () => {
    const fixture = await openSchema(undefined, SCHEMA_BEFORE_1_64)
    try {
      await fixture.sql.unsafe(IDEMPOTENCY_POSTGRES_CLAIM_TOKEN_TEXT)

      // An API on 1.63.0 that started after the migration (a roll-back) claims with a UUID.
      await claimAsOldStore(fixture.sql, "old", OLD_TOKEN)
      expect(await fixture.store.begin(claim("old"))).toEqual({ status: "in_progress" })
      // The new store's own claim is stored and fenced as before.
      const outcome = await fixture.store.begin(claim("new"))
      if (outcome.status !== "claimed") throw new Error(`expected a claim, got ${outcome.status}`)
      await fixture.store.complete(1, "new", OLD_TOKEN, "wrong owner")
      expect(await fixture.store.begin(claim("new"))).toEqual({ status: "in_progress" })
      await fixture.store.complete(1, "new", outcome.token, "stored")
      expect(await fixture.store.begin(claim("new"))).toEqual({
        status: "replay",
        result: "stored",
      })
    } finally {
      await fixture.close()
    }
  })

  it("changes nothing when it runs a second time", async () => {
    const fixture = await openSchema(undefined, SCHEMA_BEFORE_1_64)
    try {
      await claimAsOldStore(fixture.sql, "k", OLD_TOKEN)
      await fixture.sql.unsafe(IDEMPOTENCY_POSTGRES_CLAIM_TOKEN_TEXT)
      await fixture.sql.unsafe(IDEMPOTENCY_POSTGRES_CLAIM_TOKEN_TEXT)
      const rows = await fixture.sql<{ token: string }[]>`
        SELECT claim_token AS token FROM idempotency_keys
      `
      expect(rows).toEqual([{ token: OLD_TOKEN }])
    } finally {
      await fixture.close()
    }
  })
})

describe("PostgresIdempotencyStore options", () => {
  const claim = { userId: 1, key: "k", commandName: "C", requestHash: "h" }

  it("takes over an unfinished claim after the configured lease", async () => {
    const fixture = await openSchema({ leaseSeconds: 2 })
    try {
      await fixture.store.begin(claim)
      await fixture.advance(1_000)
      expect((await fixture.store.begin(claim)).status).toBe("in_progress")
      await fixture.advance(2_000)
      expect((await fixture.store.begin(claim)).status).toBe("claimed")
    } finally {
      await fixture.close()
    }
  })

  it("forgets a key after the configured retention", async () => {
    const fixture = await openSchema({ retentionDays: 1 })
    try {
      const outcome = await fixture.store.begin(claim)
      if (outcome.status !== "claimed") throw new Error(`expected a claim`)
      await fixture.store.complete(1, "k", outcome.token, 1)
      await fixture.advance(2 * 86_400_000)
      expect((await fixture.store.begin(claim)).status).toBe("claimed")
    } finally {
      await fixture.close()
    }
  })

  it("refuses a lease or retention that is not a finite number above zero", async () => {
    const fixture = await openSchema()
    try {
      for (const bad of [0, -1, NaN, Infinity]) {
        expect(() => new PostgresIdempotencyStore(fixture.sql, { leaseSeconds: bad })).toThrow(
          RangeError,
        )
        expect(() => new PostgresIdempotencyStore(fixture.sql, { retentionDays: bad })).toThrow(
          RangeError,
        )
      }
    } finally {
      await fixture.close()
    }
  })
})
