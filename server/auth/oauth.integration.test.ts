/**
 * OAuth sign-in against a real Postgres (#57 finding 2, #74).
 *
 * The same account scenarios the unit tier runs on `MemoryAuthStore` run here on the Postgres store
 * and session store: a new sub creates an account, a verified address links to its proven owner and
 * never duplicates it, an unverified address never attaches, a pre-registered address goes back to
 * the person the provider vouches for, and `disconnect` removes only its own key. The provider is
 * the in-process fake; only the database is real.
 *
 * Isolation: every test creates its own schema from `uniqueIdentifier`, applies
 * `AUTH_POSTGRES_SCHEMA` inside it, and drops it in a `finally`.
 */

import { expect } from "@std/expect"
import { describe, it } from "@std/testing/bdd"
import postgres from "postgres"
import { buildPostgresOptions, type Sql } from "@ts-libs/server/db"
import { SessionManager, SessionStatus } from "@ts-libs/server/sign-in"
import { postgresSettings, requireReachable, uniqueIdentifier } from "@integration-testing"

import type { AuthSessionRecord } from "./model.ts"
import { createOAuthSignIn } from "./oauth.ts"
import {
  createFakeProvider,
  describeOAuthScenarios,
  fakeOptions,
  type OAuthFixture,
  PEPPER,
  signInAs,
} from "./oauth-scenarios.test.ts"
import {
  AUTH_POSTGRES_SCHEMA,
  createPostgresAuthStore,
  createPostgresSessionStore,
} from "./postgres.ts"

const POOL_SIZE = 4

interface Database extends OAuthFixture {
  sql: Sql
}

/** A pool on a fresh schema holding the auth tables. `close` drops the schema and ends the pool. */
async function openDatabase(): Promise<Database> {
  const settings = postgresSettings()
  await requireReachable(settings.address)

  const schema = uniqueIdentifier("it_oauth")
  const admin = postgres({
    ...buildPostgresOptions({ connection: settings.connection, max: 1 }),
    onnotice: () => {},
  }) as unknown as Sql
  await admin`CREATE SCHEMA ${admin(schema)}`

  const sql = postgres({
    ...buildPostgresOptions({ connection: settings.connection, max: POOL_SIZE }),
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
  const sessions = new SessionManager<AuthSessionRecord>({
    store: createPostgresSessionStore(sql),
    pepper: PEPPER,
    durationMinutes: 60,
  })
  return { sql, store: createPostgresAuthStore(sql), sessions, close }
}

describeOAuthScenarios("createPostgresAuthStore", openDatabase)

describe("createOAuthSignIn on Postgres: what only the database shows", () => {
  it("stores the normalised address on every OAuth key the provider vouched for, and none otherwise", async () => {
    const database = await openDatabase()
    try {
      const provider = createFakeProvider()
      const oauth = createOAuthSignIn(fakeOptions(database, provider))
      await signInAs(oauth, provider, {
        sub: "a",
        email: " Ann@Example.COM ",
        email_verified: true,
      })
      await signInAs(oauth, provider, { sub: "b", email: "ANN@example.com", email_verified: true })
      await signInAs(oauth, provider, { sub: "c", email: "Cat@Example.com", email_verified: false })
      await signInAs(oauth, provider, { sub: "d" })
      const rows = await database.sql<{ subject: string; email: string | null; proven: boolean }[]>`
        SELECT subject, email, proven_at IS NOT NULL AS proven
        FROM auth_keys WHERE method = 'oauth:fake' ORDER BY subject
      `
      expect(rows.map((row) => [row.subject, row.email, row.proven])).toEqual([
        ["a", "ann@example.com", true],
        ["b", "ann@example.com", true],
        ["c", null, false],
        ["d", null, false],
      ])
    } finally {
      await database.close()
    }
  })

  it("ends the sessions of a disconnected key and keeps the other provider's session", async () => {
    const database = await openDatabase()
    try {
      const provider = createFakeProvider()
      const oauth = createOAuthSignIn(fakeOptions(database, provider))
      const other = createOAuthSignIn(fakeOptions(database, provider, "other"))
      const identity = { sub: "sub-1", email: "ann@example.com", email_verified: true }
      const mine = await signInAs(oauth, provider, identity)
      const theirs = await signInAs(other, provider, identity)

      expect(await oauth.disconnect(mine.user.id, mine.key.id)).toBe(true)

      expect(await database.sessions.validate(mine.session.cookieValue)).toBeNull()
      const kept = await database.sessions.validate(theirs.session.cookieValue)
      expect(kept?.session.status).toBe(SessionStatus.Active)
      expect(kept?.session.keyId).toBe(theirs.key.id)
    } finally {
      await database.close()
    }
  })
})
