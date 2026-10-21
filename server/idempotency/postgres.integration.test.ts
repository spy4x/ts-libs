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
import { IDEMPOTENCY_LEASE_SECONDS } from "./idempotency.ts"
import {
  IDEMPOTENCY_POSTGRES_CLAIM_TOKEN_TEXT,
  IDEMPOTENCY_POSTGRES_SCHEMA,
  IDEMPOTENCY_POSTGRES_USER_ID_TEXT,
  PostgresIdempotencyStore,
} from "./postgres.ts"
import { describeIdempotencyStoreContract, type StoreFixture } from "./store-contract.test.ts"

/** The two types an app's `claim_token` column can have: `uuid` always, `text` after 1.64.0. */
type ClaimTokenColumn = "uuid" | "text"
const COLUMN_TYPES: ClaimTokenColumn[] = ["uuid", "text"]

/** A fresh schema holding the table, a pool on it, and the cleanup. */
async function openSchema(
  options?: ConstructorParameters<typeof PostgresIdempotencyStore>[1],
  column: ClaimTokenColumn = "uuid",
  connections = 4,
  userIdText = false,
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
    ...buildPostgresOptions({ connection: settings.connection, max: connections }),
    connection: { application_name: schema, search_path: schema },
    onnotice: () => {},
  }) as unknown as Sql
  const close = async () => {
    await sql.end()
    await admin`DROP SCHEMA IF EXISTS ${admin(schema)} CASCADE`
    await admin.end()
  }
  try {
    await sql.unsafe(IDEMPOTENCY_POSTGRES_SCHEMA)
    // The `text` table is made the way an app on 1.64.0 got it: by the widening migration.
    if (column === "text") await sql.unsafe(IDEMPOTENCY_POSTGRES_CLAIM_TOKEN_TEXT)
    if (userIdText) await sql.unsafe(IDEMPOTENCY_POSTGRES_USER_ID_TEXT)
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

/** Type and default of `claim_token` in the fixture's own table. */
async function claimTokenColumn(sql: Sql): Promise<{ type: string; default: string | null }> {
  const rows = await sql<{ type: string; default: string | null }[]>`
    SELECT data_type AS type, column_default AS default
    FROM information_schema.columns
    WHERE table_schema = current_schema()
      AND table_name = 'idempotency_keys'
      AND column_name = 'claim_token'
  `
  return rows[0]
}

/** A token as the store of 1.63.0 made it: a version 4 UUID. */
const TOKEN_OF_1_63 = "3f2b8c1e-9d4a-4e6f-8a1b-2c3d4e5f6a7b"
/** A token as the store of 1.64.0 made it: 16 random bytes as base64url. Fits only `text`. */
const TOKEN_OF_1_64 = "Zm9vYmFyYmF6cXV4X18tLQ"

const claim = (key: string) => ({
  userId: 1,
  key,
  commandName: "RenameCommand",
  requestHash: "hash-a",
})

/** Claims `key` the way an older store did, with a token that store made itself. */
async function claimAsOlderStore(sql: Sql, key: string, token: string): Promise<void> {
  await sql`
    INSERT INTO idempotency_keys (user_id, key, command_name, request_hash, claim_token, status)
    VALUES (1, ${key}, 'RenameCommand', 'hash-a', ${token}, 1)
  `
}

describe("IDEMPOTENCY_POSTGRES_SCHEMA", () => {
  it("declares claim_token as a uuid column with no default", async () => {
    const fixture = await openSchema()
    try {
      expect(await claimTokenColumn(fixture.sql)).toEqual({ type: "uuid", default: null })
    } finally {
      await fixture.close()
    }
  })
})

describe("IDEMPOTENCY_POSTGRES_CLAIM_TOKEN_TEXT", () => {
  it("still widens claim_token to text and keeps the tokens, also when it runs twice", async () => {
    const fixture = await openSchema()
    try {
      await claimAsOlderStore(fixture.sql, "k", TOKEN_OF_1_63)
      await fixture.sql.unsafe(IDEMPOTENCY_POSTGRES_CLAIM_TOKEN_TEXT)
      await fixture.sql.unsafe(IDEMPOTENCY_POSTGRES_CLAIM_TOKEN_TEXT)
      expect(await claimTokenColumn(fixture.sql)).toEqual({ type: "text", default: null })
      const rows = await fixture.sql<{ token: string }[]>`
        SELECT claim_token AS token FROM idempotency_keys
      `
      expect(rows).toEqual([{ token: TOKEN_OF_1_63 }])
    } finally {
      await fixture.close()
    }
  })
})

for (const column of COLUMN_TYPES) {
  describeIdempotencyStoreContract(
    `PostgresIdempotencyStore on a ${column} claim_token`,
    () => openSchema(undefined, column),
  )

  describe(`PostgresIdempotencyStore on a ${column} claim_token, beside other versions`, () => {
    it(`runs on a table whose claim_token is ${column}`, async () => {
      const fixture = await openSchema(undefined, column)
      try {
        expect((await claimTokenColumn(fixture.sql)).type).toBe(column)
      } finally {
        await fixture.close()
      }
    })

    // A `uuid` column cannot hold a 1.64.0 token, so only 1.63.0 can have left a claim in it.
    const olderTokens = column === "text"
      ? [{ version: "1.63.0", token: TOKEN_OF_1_63 }, { version: "1.64.0", token: TOKEN_OF_1_64 }]
      : [{ version: "1.63.0", token: TOKEN_OF_1_63 }]

    for (const { version, token } of olderTokens) {
      it(`stores the result of a claim made by ${version} when its own token completes it`, async () => {
        const fixture = await openSchema(undefined, column)
        try {
          await claimAsOlderStore(fixture.sql, "k", token)
          expect(await fixture.store.begin(claim("k"))).toEqual({ status: "in_progress" })
          await fixture.store.complete(1, "k", token, "kept")
          expect(await fixture.store.begin(claim("k"))).toEqual({
            status: "replay",
            result: "kept",
          })
        } finally {
          await fixture.close()
        }
      })

      it(`frees a claim made by ${version} when its own token releases it`, async () => {
        const fixture = await openSchema(undefined, column)
        try {
          await claimAsOlderStore(fixture.sql, "k", token)
          await fixture.store.release(1, "k", token)
          expect(await fixture.store.begin(claim("k"))).toMatchObject({ status: "claimed" })
        } finally {
          await fixture.close()
        }
      })

      it(`takes over a claim made by ${version} after its lease, and the old token then changes nothing`, async () => {
        const fixture = await openSchema(undefined, column)
        try {
          await claimAsOlderStore(fixture.sql, "k", token)
          await fixture.advance((IDEMPOTENCY_LEASE_SECONDS + 5) * 1000)
          const takeover = await fixture.store.begin(claim("k"))
          if (takeover.status !== "claimed") {
            throw new Error(`expected a claim, got ${takeover.status}`)
          }
          expect(takeover.token).not.toBe(token)

          await fixture.store.complete(1, "k", token, "late")
          await fixture.store.release(1, "k", token)
          expect(await fixture.store.begin(claim("k"))).toEqual({ status: "in_progress" })
          await fixture.store.complete(1, "k", takeover.token, "stored")
          expect(await fixture.store.begin(claim("k"))).toEqual({
            status: "replay",
            result: "stored",
          })
        } finally {
          await fixture.close()
        }
      })
    }

    it("changes nothing and does not throw when a 1.64.0 token is given for its own claim", async () => {
      const fixture = await openSchema(undefined, column)
      try {
        const outcome = await fixture.store.begin(claim("k"))
        if (outcome.status !== "claimed") throw new Error(`expected a claim, got ${outcome.status}`)
        await fixture.store.complete(1, "k", TOKEN_OF_1_64, "wrong owner")
        await fixture.store.release(1, "k", TOKEN_OF_1_64)
        expect(await fixture.store.begin(claim("k"))).toEqual({ status: "in_progress" })
      } finally {
        await fixture.close()
      }
    })
  })
}

describe("PostgresIdempotencyStore while claim_token is widened under it", () => {
  it("still completes and releases a claim on a connection opened before the column became text", async () => {
    // One connection, so every statement below was prepared on it while the column was `uuid`.
    const fixture = await openSchema(undefined, "uuid", 1)
    try {
      const { store, sql } = fixture
      const tokenOf = async (key: string) => {
        const outcome = await store.begin(claim(key))
        if (outcome.status !== "claimed") throw new Error(`expected a claim, got ${outcome.status}`)
        return outcome.token
      }
      // `complete` and `release` each run once on the `uuid` column.
      await store.complete(1, "warm-done", await tokenOf("warm-done"), 1)
      await store.release(1, "warm-freed", await tokenOf("warm-freed"))
      const done = await tokenOf("done")
      const freed = await tokenOf("freed")

      await sql.unsafe(IDEMPOTENCY_POSTGRES_CLAIM_TOKEN_TEXT)

      await store.complete(1, "done", done, "kept")
      expect(await store.begin(claim("done"))).toEqual({ status: "replay", result: "kept" })
      await store.release(1, "freed", freed)
      expect(await store.begin(claim("freed"))).toMatchObject({ status: "claimed" })
    } finally {
      await fixture.close()
    }
  })
})

describeIdempotencyStoreContract(
  "PostgresIdempotencyStore on a text user_id",
  () => openSchema(undefined, "uuid", 4, true),
)

describe("IDEMPOTENCY_POSTGRES_USER_ID_TEXT", () => {
  it("keys UUID users apart, keeps a numeric user's earlier key, and runs twice", async () => {
    const fixture = await openSchema()
    try {
      const { sql, store } = fixture
      // Written by hand, so the store prepares no statement before the column changes type: an
      // app runs its migrations before it opens the pool the store uses.
      await sql`
        INSERT INTO idempotency_keys
          (user_id, key, command_name, request_hash, claim_token, status, result)
        VALUES (1, 'k', 'RenameCommand', 'hash-a', ${TOKEN_OF_1_63}, 2, '"numeric"'::jsonb)
      `
      await sql.unsafe(IDEMPOTENCY_POSTGRES_USER_ID_TEXT)
      await sql.unsafe(IDEMPOTENCY_POSTGRES_USER_ID_TEXT)

      expect(await store.begin(claim("k"))).toEqual({ status: "replay", result: "numeric" })
      const one = { ...claim("k"), userId: "01929b2c-6f00-7000-8000-000000000001" }
      const two = { ...claim("k"), userId: "01929b2c-6f00-7000-8000-000000000002" }
      const first = await store.begin(one)
      if (first.status !== "claimed") throw new Error("expected a claim")
      await store.complete(one.userId, "k", first.token, "uuid")
      expect(await store.begin(one)).toEqual({ status: "replay", result: "uuid" })
      expect(await store.begin(two)).toMatchObject({ status: "claimed" })
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
