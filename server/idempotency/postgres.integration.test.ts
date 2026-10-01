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
import { IDEMPOTENCY_POSTGRES_SCHEMA, PostgresIdempotencyStore } from "./postgres.ts"
import { describeIdempotencyStoreContract, type StoreFixture } from "./store-contract.test.ts"

/** A fresh schema holding the table, a pool on it, and the cleanup. */
async function openSchema(
  options?: ConstructorParameters<typeof PostgresIdempotencyStore>[1],
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
    await sql.unsafe(IDEMPOTENCY_POSTGRES_SCHEMA)
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
