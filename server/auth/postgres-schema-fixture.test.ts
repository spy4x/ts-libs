/**
 * Test-only: a pool on a fresh Postgres schema holding the auth tables (#347).
 *
 * The three integration files that need one share this. The `.test.ts` name keeps it out of the
 * published package (root `publish.exclude`). `postgres-schema-fixture-leak.test.ts` covers the
 * failure paths with a fake driver.
 */

import postgres from "postgres"
import { uniqueIdentifier } from "@integration-testing"
import { buildPostgresOptions, type CreateSqlOptions, type Sql } from "../db/index.ts"
import { AUTH_POSTGRES_SCHEMA } from "./postgres.ts"

/** Builds a pool from `postgres` options; the default is the real driver. */
export type ConnectPostgres = (options: Record<string, unknown>) => Sql

export interface AuthSchemaOptions {
  /** `uniqueIdentifier` prefix for the schema name. */
  prefix: string
  /** Connection fields of the test Postgres (`postgresSettings().connection`). */
  connection: CreateSqlOptions["connection"]
  /** Size of the returned pool. */
  poolSize: number
  /** Replaces the driver; only the fixture's own unit test passes it. */
  connect?: ConnectPostgres
}

export interface AuthSchema {
  sql: Sql
  schema: string
  /** Ends the pool, drops the schema and ends the admin connection. */
  close(): Promise<void>
}

/**
 * Creates a unique schema, applies `AUTH_POSTGRES_SCHEMA` inside it and returns a pool whose
 * `search_path` is that schema. The admin connection is ended on every path, including a failed
 * `CREATE SCHEMA`; a failed setup drops what it created before it throws.
 */
export async function openAuthSchema(options: AuthSchemaOptions): Promise<AuthSchema> {
  const connect: ConnectPostgres = options.connect ??
    ((o) =>
      postgres(o as postgres.Options<Record<string, postgres.PostgresType>>) as unknown as Sql)
  const schema = uniqueIdentifier(options.prefix)
  const admin = connect({
    ...buildPostgresOptions({ connection: options.connection, max: 1 }),
    onnotice: () => {},
  })
  let sql: Sql | undefined
  try {
    await admin`CREATE SCHEMA ${admin(schema)}`
    sql = connect({
      ...buildPostgresOptions({ connection: options.connection, max: options.poolSize }),
      connection: { application_name: schema, search_path: schema },
      onnotice: () => {},
    })
    await sql.unsafe(AUTH_POSTGRES_SCHEMA)
  } catch (error) {
    try {
      await sql?.end()
      await admin`DROP SCHEMA IF EXISTS ${admin(schema)} CASCADE`
    } finally {
      await admin.end()
    }
    throw error
  }
  const pool = sql
  const close = async () => {
    try {
      await pool.end()
      await admin`DROP SCHEMA IF EXISTS ${admin(schema)} CASCADE`
    } finally {
      await admin.end()
    }
  }
  return { sql: pool, schema, close }
}
