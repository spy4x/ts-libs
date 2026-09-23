/**
 * The Postgres `AuthStore` and `SessionStore` against a real server (#57 finding 5, #74).
 *
 * The same contract suite the memory store passes runs here, so every rule a provider's unit tests
 * rely on is shown to hold in Postgres too. The tests after it need a real database: the stored
 * guess counter, the constraints the tables enforce on their own, and `SessionManager` from
 * `@spy4x/server/sign-in` driven end to end over `auth_sessions`.
 *
 * Isolation: every test creates its own schema from `uniqueIdentifier`, applies
 * `AUTH_POSTGRES_SCHEMA` inside it, and drops it in a `finally`. The pool has ten connections, each
 * with `search_path` set to that schema at connection start, so parallel guesses really do arrive on
 * separate connections.
 */

import { expect } from "@std/expect"
import { describe, it } from "@std/testing/bdd"
import postgres from "postgres"
import { buildPostgresOptions, type Sql } from "../db/index.ts"
import { SecondFactorStatus, SessionManager, SessionStatus } from "../sign-in/mod.ts"
import { postgresSettings, requireReachable, uniqueIdentifier } from "@integration-testing"
import type { AuthSessionRecord } from "./model.ts"
import {
  AUTH_POSTGRES_SCHEMA,
  createPostgresAuthStore,
  createPostgresSessionStore,
} from "./postgres.ts"
import {
  describeAuthStoreContract,
  emailKey,
  NOW,
  type StoreFixture,
} from "./store-contract.test.ts"

const POOL_SIZE = 10
const MINUTE = 60_000
const PEPPER = "test-pepper-not-a-real-secret-0123456789"

interface Database {
  sql: Sql
  schema: string
  close(): Promise<void>
}

/** A pool on a fresh schema holding the auth tables. `close` drops the schema and ends the pool. */
async function openDatabase(): Promise<Database> {
  const settings = postgresSettings()
  await requireReachable(settings.address)

  const schema = uniqueIdentifier("it_auth")
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
  return { sql, schema, close }
}

async function withDatabase(body: (database: Database) => Promise<void>): Promise<void> {
  const database = await openDatabase()
  try {
    await body(database)
  } finally {
    await database.close()
  }
}

describeAuthStoreContract("createPostgresAuthStore", async (): Promise<StoreFixture> => {
  const database = await openDatabase()
  return { store: createPostgresAuthStore(database.sql), close: database.close }
})

describe("createPostgresAuthStore: what only the database shows", () => {
  it("stores exactly 5 guesses after 50 parallel wrong guesses against maxAttempts 5", () =>
    withDatabase(async ({ sql }) => {
      const store = createPostgresAuthStore(sql)
      const challenge = { purpose: "email-code", subject: "ann@example.com" }
      await store.issueChallenge({
        ...challenge,
        secretHash: "right",
        expiresAt: new Date(NOW.getTime() + 10 * MINUTE),
        now: NOW,
      })
      await Promise.all(
        Array.from(
          { length: 50 },
          () =>
            store.attemptChallenge({ ...challenge, secretHash: "wrong", maxAttempts: 5, now: NOW }),
        ),
      )
      const [row] = await sql<{ attempts: number }[]>`
        SELECT attempts FROM auth_challenges WHERE purpose = 'email-code'
      `
      expect(row.attempts).toBe(5)
    }))

  it("refuses a second (method, subject) row written around the store", () =>
    withDatabase(async ({ sql }) => {
      const [user] = await sql<{ id: number }[]>`INSERT INTO auth_users DEFAULT VALUES RETURNING id`
      await sql`INSERT INTO auth_keys (user_id, method, subject) VALUES (${user.id}, 'password', 'a')`
      const error = await sql`
        INSERT INTO auth_keys (user_id, method, subject) VALUES (${user.id}, 'password', 'a')
      `.then(() => null, (caught: unknown) => caught)
      expect((error as { code?: string } | null)?.code).toBe("23505")
    }))

  it("refuses a proven key whose address its user does not own, written around the store", () =>
    withDatabase(async ({ sql }) => {
      const [user] = await sql<{ id: number }[]>`INSERT INTO auth_users DEFAULT VALUES RETURNING id`
      const error = await sql`
        INSERT INTO auth_keys (user_id, method, subject, email, proven_at)
        VALUES (${user.id}, 'email-code', 'a@x.com', 'a@x.com', now())
      `.then(() => null, (caught: unknown) => caught)
      // 23503: foreign key violation.
      expect((error as { code?: string } | null)?.code).toBe("23503")
    }))

  it("refuses a key for a user that does not exist, written around the store", () =>
    withDatabase(async ({ sql }) => {
      const error = await sql`
        INSERT INTO auth_keys (user_id, method, subject) VALUES (999, 'password', 'a')
      `.then(() => null, (caught: unknown) => caught)
      expect((error as { code?: string } | null)?.code).toBe("23503")
    }))

  it("reads keys through a client that transforms column names to camel case", () =>
    withDatabase(async ({ schema }) => {
      const settings = postgresSettings()
      const camel = postgres({
        ...buildPostgresOptions({ connection: settings.connection, max: 1 }),
        connection: { search_path: schema },
        transform: postgres.camel,
      }) as unknown as Sql
      try {
        const store = createPostgresAuthStore(camel)
        const { key } = await store.createUserWithKey(emailKey("password", "ann@example.com", NOW))
        expect(await store.findKeyById(key.id)).toEqual(key)
        expect(key.userId).toBeGreaterThan(0)
        expect(key.provenAt?.getTime()).toBe(NOW.getTime())
      } finally {
        await camel.end()
      }
    }))
})

describe("createPostgresSessionStore driven by SessionManager", () => {
  async function setup(sql: Sql) {
    let now = NOW.getTime()
    const clock = { now: () => now, advance: (ms: number) => void (now += ms) }
    const authStore = createPostgresAuthStore(sql)
    const store = createPostgresSessionStore(sql)
    const sessions = new SessionManager<AuthSessionRecord>({
      store,
      pepper: PEPPER,
      durationMinutes: 60,
      clock,
    })
    const ann = await authStore.createUserWithKey(emailKey("password", "ann@example.com"))
    return { clock, authStore, store, sessions, ann }
  }

  it("creates a session that validates, carrying its key", () =>
    withDatabase(async ({ sql }) => {
      const { sessions, ann, store } = await setup(sql)
      const { session, cookieValue } = await sessions.create({
        userId: ann.user.id,
        keyId: ann.key.id,
        secondFactor: SecondFactorStatus.NotRequired,
      })
      expect(session).toMatchObject({
        userId: ann.user.id,
        keyId: ann.key.id,
        status: SessionStatus.Active,
        secondFactor: SecondFactorStatus.NotRequired,
      })
      expect(await store.findById(session.id)).toEqual(session)
      const valid = await sessions.validate(cookieValue)
      expect(valid?.session).toEqual(session)
      expect(valid?.extended).toBe(false)
    }))

  it("extends a session with less than a quarter of its lifetime left", () =>
    withDatabase(async ({ sql }) => {
      const { sessions, ann, store, clock } = await setup(sql)
      const { session, cookieValue } = await sessions.create({
        userId: ann.user.id,
        keyId: ann.key.id,
        secondFactor: SecondFactorStatus.NotRequired,
      })
      clock.advance(50 * MINUTE)
      const valid = await sessions.validate(cookieValue)
      expect(valid?.extended).toBe(true)
      const stored = await store.findById(session.id)
      expect(stored?.expiresAt.getTime()).toBe(NOW.getTime() + 110 * MINUTE)
    }))

  it("completes the second factor only on an active session", () =>
    withDatabase(async ({ sql }) => {
      const { sessions, ann, store } = await setup(sql)
      const { session, cookieValue } = await sessions.create({
        userId: ann.user.id,
        keyId: ann.key.id,
        secondFactor: SecondFactorStatus.Pending,
      })
      expect(await sessions.completeSecondFactor(session.id)).toBe(true)
      expect((await store.findById(session.id))?.secondFactor).toBe(SecondFactorStatus.Completed)

      const other = await sessions.create({
        userId: ann.user.id,
        keyId: ann.key.id,
        secondFactor: SecondFactorStatus.Pending,
      })
      expect(await sessions.signOut(other.cookieValue)).toBe(true)
      expect(await sessions.completeSecondFactor(other.session.id)).toBe(false)
      expect((await store.findById(other.session.id))?.secondFactor).toBe(
        SecondFactorStatus.Pending,
      )
      expect(await sessions.validate(cookieValue)).not.toBeNull()
    }))

  it("signs out one session, then every session of the user but one", () =>
    withDatabase(async ({ sql }) => {
      const { sessions, ann, store, authStore } = await setup(sql)
      const fields = {
        userId: ann.user.id,
        keyId: ann.key.id,
        secondFactor: SecondFactorStatus.NotRequired,
      }
      const first = await sessions.create(fields)
      const second = await sessions.create(fields)
      const third = await sessions.create(fields)
      const bob = await authStore.createUserWithKey(emailKey("password", "bob@example.com"))
      const bobs = await sessions.create({ ...fields, userId: bob.user.id, keyId: bob.key.id })

      expect(await sessions.signOut(first.cookieValue)).toBe(true)
      expect(await sessions.validate(first.cookieValue)).toBeNull()
      expect((await store.findById(first.session.id))?.status).toBe(SessionStatus.SignedOut)
      expect(await sessions.signOut(first.cookieValue)).toBe(false)

      await sessions.signOutUser(ann.user.id, { except: third.session.id })
      expect(await sessions.validate(second.cookieValue)).toBeNull()
      expect(await sessions.validate(third.cookieValue)).not.toBeNull()
      expect(await sessions.validate(bobs.cookieValue)).not.toBeNull()

      await sessions.signOutUser(ann.user.id)
      expect(await sessions.validate(third.cookieValue)).toBeNull()
      expect(await sessions.validate(bobs.cookieValue)).not.toBeNull()
    }))

  it("marks run-out sessions expired and leaves the others alone", () =>
    withDatabase(async ({ sql }) => {
      const { sessions, ann, store, clock } = await setup(sql)
      const fields = {
        userId: ann.user.id,
        keyId: ann.key.id,
        secondFactor: SecondFactorStatus.NotRequired,
      }
      const old = await sessions.create(fields)
      clock.advance(30 * MINUTE)
      const fresh = await sessions.create(fields)
      clock.advance(30 * MINUTE)

      await sessions.expireStale()

      expect((await store.findById(old.session.id))?.status).toBe(SessionStatus.Expired)
      expect((await store.findById(fresh.session.id))?.status).toBe(SessionStatus.Active)
      expect(await store.extend(old.session.id, new Date(NOW.getTime() + 999 * MINUTE))).toBe(
        false,
      )
    }))

  it("ends the sessions a key created when the key is deleted, and only those", () =>
    withDatabase(async ({ sql }) => {
      const { sessions, ann, store, authStore } = await setup(sql)
      const code = await authStore.addKey(ann.user.id, emailKey("email-code", "ann@example.com"))
      const byPassword = await sessions.create({
        userId: ann.user.id,
        keyId: ann.key.id,
        secondFactor: SecondFactorStatus.NotRequired,
      })
      const byCode = await sessions.create({
        userId: ann.user.id,
        keyId: code.id,
        secondFactor: SecondFactorStatus.NotRequired,
      })

      expect(await authStore.deleteKey(ann.user.id, ann.key.id)).toBe(true)

      expect(await store.findById(byPassword.session.id)).toBeNull()
      expect(await sessions.validate(byPassword.cookieValue)).toBeNull()
      expect(await sessions.validate(byCode.cookieValue)).not.toBeNull()
    }))

  it("refuses a session whose ids no store could assign, without asking Postgres", () =>
    withDatabase(async ({ sql }) => {
      const { store, ann } = await setup(sql)
      const base = {
        userId: ann.user.id,
        keyId: ann.key.id,
        tokenHash: "hash",
        status: SessionStatus.Active,
        secondFactor: SecondFactorStatus.NotRequired,
        expiresAt: new Date(NOW.getTime() + MINUTE),
      }
      for (const bad of [{ keyId: 2 ** 31 }, { userId: 2 ** 31 }, { keyId: 1.5 }]) {
        const error = await store.create({ ...base, ...bad }).then(
          () => null,
          (caught: unknown) => caught,
        )
        expect(error).toBeInstanceOf(TypeError)
      }
      const invalidDate = await store.create({ ...base, expiresAt: new Date(Number.NaN) }).then(
        () => null,
        (caught: unknown) => caught,
      )
      expect(invalidDate).toBeInstanceOf(TypeError)
    }))

  it("keeps no session when the one to keep has an id no store could assign", () =>
    withDatabase(async ({ sql }) => {
      const { sessions, ann } = await setup(sql)
      const { cookieValue } = await sessions.create({
        userId: ann.user.id,
        keyId: ann.key.id,
        secondFactor: SecondFactorStatus.NotRequired,
      })
      await sessions.signOutUser(ann.user.id, { except: 2 ** 31 })
      expect(await sessions.validate(cookieValue)).toBeNull()
    }))

  it("refuses a session whose key belongs to another user", () =>
    withDatabase(async ({ sql }) => {
      const { sessions, ann, authStore } = await setup(sql)
      const bob = await authStore.createUserWithKey(emailKey("password", "bob@example.com"))
      const error = await sessions.create({
        userId: bob.user.id,
        keyId: ann.key.id,
        secondFactor: SecondFactorStatus.NotRequired,
      }).then(() => null, (caught: unknown) => caught)
      expect((error as { code?: string } | null)?.code).toBe("23503")
    }))
})
