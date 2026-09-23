/**
 * The password provider against a real Postgres (#57): the takeover cases and the sign-in timing
 * structure the unit tier shows on `MemoryAuthStore`, run here on `createPostgresAuthStore` and
 * `createPostgresSessionStore`, so they hold where the database enforces the rules itself.
 *
 * Isolation: every test creates its own schema from `uniqueIdentifier`, applies
 * `AUTH_POSTGRES_SCHEMA` inside it, and drops it in a `finally`.
 */

import { expect } from "@std/expect"
import { describe, it } from "@std/testing/bdd"
import postgres from "postgres"
import { buildPostgresOptions, type Sql } from "../db/index.ts"
import { createPasswordHasher, type PasswordHasher, SessionManager } from "../sign-in/mod.ts"
import { postgresSettings, requireReachable, uniqueIdentifier } from "@integration-testing"
import type { AuthSessionRecord } from "./model.ts"
import {
  AUTH_POSTGRES_SCHEMA,
  createPostgresAuthStore,
  createPostgresSessionStore,
} from "./postgres.ts"
import { createPasswordSignIn, PASSWORD_METHOD, type PasswordSignInError } from "./password.ts"

const PEPPER = "test-pepper-not-a-real-secret-0123456789"
const ITERATIONS = 100_000
const NOW = Date.UTC(2001, 0, 1)
const ANN = "ann@example.com"
const MALLORY_PASSWORD = "mallory-secret-1"

/** Runs `body` with a pool on a fresh schema holding the auth tables, and drops the schema after. */
async function withDatabase(body: (sql: Sql) => Promise<void>): Promise<void> {
  const settings = postgresSettings()
  await requireReachable(settings.address)

  const schema = uniqueIdentifier("it_auth_pw")
  const admin = postgres({
    ...buildPostgresOptions({ connection: settings.connection, max: 1 }),
    onnotice: () => {},
  }) as unknown as Sql
  try {
    await admin`CREATE SCHEMA ${admin(schema)}`
    const sql = postgres({
      ...buildPostgresOptions({ connection: settings.connection, max: 4 }),
      connection: { application_name: schema, search_path: schema },
      onnotice: () => {},
    }) as unknown as Sql
    try {
      await sql.unsafe(AUTH_POSTGRES_SCHEMA)
      await body(sql)
    } finally {
      await sql.end()
      await admin`DROP SCHEMA IF EXISTS ${admin(schema)} CASCADE`
    }
  } finally {
    await admin.end()
  }
}

interface VerifyCall {
  stored: string
}

function setup(sql: Sql) {
  const clock = { now: () => NOW }
  const store = createPostgresAuthStore(sql)
  const sessionStore = createPostgresSessionStore(sql)
  const sessionCalls: string[] = []
  const sessions = new SessionManager<AuthSessionRecord>({
    // The Postgres store with `create` and `signOutUser` recorded; every other key is its own.
    store: {
      ...sessionStore,
      create(session) {
        sessionCalls.push("create")
        return sessionStore.create(session)
      },
      signOutUser(userId, exceptId) {
        sessionCalls.push("signOutUser")
        return sessionStore.signOutUser(userId, exceptId)
      },
    },
    pepper: PEPPER,
    durationMinutes: 60,
    clock,
  })
  const inner = createPasswordHasher({ pepper: PEPPER, iterations: ITERATIONS })
  const verifies: VerifyCall[] = []
  // Same own keys as `PasswordHasher`, ordinary functions; it only records `verify`.
  const hasher = {
    hash(password: string) {
      return inner.hash(password)
    },
    verify(password: string, stored: string) {
      verifies.push({ stored })
      return inner.verify(password, stored)
    },
  } satisfies PasswordHasher
  const provider = createPasswordSignIn({ store, sessions, clock, hasher })
  return { store, sessions, sessionCalls, provider, verifies }
}

async function refusal(promise: Promise<unknown>): Promise<PasswordSignInError> {
  const error = await promise.then(() => null, (caught: unknown) => caught)
  expect(error).toBeInstanceOf(Error)
  expect((error as Error).name).toBe("PasswordSignInError")
  return error as PasswordSignInError
}

async function passwordKeyRows(sql: Sql) {
  return await sql<{ userId: number; subject: string; email: string | null }[]>`
    SELECT user_id AS "userId", subject, email FROM auth_keys WHERE method = ${PASSWORD_METHOD}
    ORDER BY id
  `
}

describe("createPasswordSignIn on Postgres", () => {
  it("gives the address to the person who resets it, not to whoever signed up first", () =>
    withDatabase(async (sql) => {
      const { provider, sessions } = setup(sql)
      const mallory = await provider.signUp({ email: ANN, password: MALLORY_PASSWORD })

      expect((await refusal(provider.signUp({ email: ANN, password: "ann-password" }))).reason)
        .toBe("email-taken")

      const { code } = await provider.requestReset({ email: ANN })
      const ann = await provider.completeReset({ email: ANN, code, newPassword: "ann-password" })

      expect(ann.user.id).not.toBe(mallory.user.id)
      expect(ann.key.provenAt).not.toBeNull()
      expect((await refusal(provider.signIn({ email: ANN, password: MALLORY_PASSWORD }))).reason)
        .toBe("invalid-credentials")
      expect((await provider.signIn({ email: ANN, password: "ann-password" })).user.id)
        .toBe(ann.user.id)
      // The evicted key's session went with it (ON DELETE CASCADE).
      expect(await sessions.validate(mallory.session.cookieValue)).toBeNull()
      expect(await passwordKeyRows(sql)).toEqual([
        { userId: ann.user.id, subject: ANN, email: ANN },
      ])
    }))

  it("refuses a password sign-up for an address another user owns proven", () =>
    withDatabase(async (sql) => {
      const { provider, store } = setup(sql)
      const owner = await store.createUserWithKey({
        method: "email-code",
        subject: ANN,
        email: ANN,
        secret: null,
        provenAt: new Date(NOW),
      })
      const error = await refusal(
        provider.signUp({ email: "Ann@Example.com", password: "x".repeat(8) }),
      )
      expect(error.reason).toBe("email-taken")
      expect(await passwordKeyRows(sql)).toEqual([])
      expect(await store.findUserIdByProvenEmail(ANN)).toBe(owner.user.id)
    }))

  it("puts the password on the owner's account when a stale claim holds the address", () =>
    withDatabase(async (sql) => {
      const { provider, store } = setup(sql)
      const owner = await store.createUserWithKey({
        method: "email-code",
        subject: ANN,
        email: ANN,
        secret: null,
        provenAt: new Date(NOW),
      })
      const mallory = await store.createUserWithKey({
        method: PASSWORD_METHOD,
        subject: ANN,
        email: ANN,
        secret: await createPasswordHasher({ pepper: PEPPER, iterations: ITERATIONS })
          .hash(MALLORY_PASSWORD),
        provenAt: null,
      })
      const { code } = await provider.requestReset({ email: ANN })
      const reset = await provider.completeReset({ email: ANN, code, newPassword: "ann-password" })
      expect(reset.user.id).toBe(owner.user.id)
      expect(await store.listKeys(mallory.user.id)).toEqual([])
      expect(await passwordKeyRows(sql)).toEqual([
        { userId: owner.user.id, subject: ANN, email: ANN },
      ])
    }))

  it("runs one verification and gives one answer whether or not the account exists", () =>
    withDatabase(async (sql) => {
      const { provider, verifies } = setup(sql)
      const signedUp = await provider.signUp({ email: ANN, password: "correct horse" })

      verifies.length = 0
      const wrong = await refusal(provider.signIn({ email: ANN, password: "wrong horse" }))
      expect(verifies).toEqual([{ stored: signedUp.key.secret! }])

      verifies.length = 0
      const missing = await refusal(
        provider.signIn({ email: "nobody@example.com", password: "wrong horse" }),
      )
      expect(verifies).toHaveLength(1)
      expect(verifies[0].stored).toMatch(/^pbkdf2-sha256\$100000\$[0-9a-f]{32}\$[0-9a-f]{64}$/)
      expect(verifies[0].stored).not.toBe(signedUp.key.secret)

      const again = await refusal(
        provider.signIn({ email: "else@example.com", password: "wrong horse" }),
      )
      expect(verifies).toHaveLength(2)
      expect(verifies[1].stored).toBe(verifies[0].stored)
      expect(again.message).toBe(missing.message)

      expect(missing.reason).toBe("invalid-credentials")
      expect(wrong.reason).toBe(missing.reason)
      expect(wrong.message).toBe(missing.message)
    }))

  it("writes every password key with its address as both subject and email", () =>
    withDatabase(async (sql) => {
      const { provider } = setup(sql)
      await provider.signUp({ email: " Ann@Example.com", password: MALLORY_PASSWORD })
      await provider.signUp({ email: "BOB@example.com ", password: "bob-password" })
      const { code } = await provider.requestReset({ email: ANN })
      await provider.completeReset({ email: ANN, code, newPassword: "ann-password" })
      const rows = await passwordKeyRows(sql)
      expect(rows.map((row) => row.subject).sort()).toEqual([ANN, "bob@example.com"])
      for (const row of rows) expect(row.email).toBe(row.subject)
    }))

  it("changes the password, creating the new session before revoking the others", () =>
    withDatabase(async (sql) => {
      const { provider, sessions, sessionCalls } = setup(sql)
      const first = await provider.signUp({ email: ANN, password: "correct horse" })
      sessionCalls.length = 0
      const changed = await provider.changePassword({
        userId: first.user.id,
        currentPassword: "correct horse",
        newPassword: "battery staple",
      })
      expect(sessionCalls).toEqual(["create", "signOutUser"])
      expect(await sessions.validate(first.session.cookieValue)).toBeNull()
      expect((await sessions.validate(changed.session.cookieValue))?.session.id)
        .toBe(changed.session.session.id)
      await provider.signIn({ email: ANN, password: "battery staple" })
    }))
})
