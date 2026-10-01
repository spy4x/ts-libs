/**
 * The `SessionStore` contract against `createPostgresSessionStore` on a real Postgres (#74).
 *
 * `session-store.test.ts` runs the same suite against the fake that the sign-in and auth unit tests
 * use, so every rule the fake claims is checked against the store it stands in for. The store
 * lives in `server/auth`, which owns the tables; it is imported here, not changed.
 *
 * Isolation: every test creates its own schema from `uniqueIdentifier`, applies
 * `AUTH_POSTGRES_SCHEMA` inside it, and drops it in `close`, which the contract calls in a
 * `finally`.
 */

import postgres from "postgres"
import { postgresSettings, requireReachable, uniqueIdentifier } from "@integration-testing"
import {
  AUTH_POSTGRES_SCHEMA,
  createPostgresAuthStore,
  createPostgresSessionStore,
} from "../auth/postgres.ts"
import type { AuthSessionRecord } from "../auth/model.ts"
import { buildPostgresOptions, type Sql } from "../db/index.ts"
import {
  describeSessionStoreContract,
  type SessionStoreFixture,
} from "./session-store-contract.test.ts"

describeSessionStoreContract(
  "createPostgresSessionStore",
  async (): Promise<SessionStoreFixture<AuthSessionRecord>> => {
    const settings = postgresSettings()
    await requireReachable(settings.address)

    const schema = uniqueIdentifier("it_sessions")
    const admin = postgres({
      ...buildPostgresOptions({ connection: settings.connection, max: 1 }),
      onnotice: () => {},
    }) as unknown as Sql
    await admin`CREATE SCHEMA ${admin(schema)}`
    const sql = postgres({
      ...buildPostgresOptions({ connection: settings.connection, max: 2 }),
      connection: { application_name: schema, search_path: schema },
      onnotice: () => {},
    }) as unknown as Sql

    const close = async () => {
      try {
        await sql.end()
        await admin`DROP SCHEMA IF EXISTS ${admin(schema)} CASCADE`
      } finally {
        await admin.end()
      }
    }

    try {
      await sql.unsafe(AUTH_POSTGRES_SCHEMA)
    } catch (error) {
      await close()
      throw error
    }

    // A session row references a key of its own user, so each user comes with one.
    const authStore = createPostgresAuthStore(sql)
    let users = 0
    return {
      store: createPostgresSessionStore(sql),
      addUser: async () => {
        users += 1
        const email = `user${users}@example.com`
        const { user, key } = await authStore.createUserWithKey({
          method: "password",
          subject: email,
          email,
          secret: null,
          provenAt: null,
        })
        return { userId: user.id, columns: { keyId: key.id } }
      },
      close,
    }
  },
)
