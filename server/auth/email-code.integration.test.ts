/**
 * The email-code provider against a real Postgres (#57 finding 3 and the takeover script).
 *
 * The unit tests run the same flows on `MemoryAuthStore`. Here they run on the Postgres store and
 * session store, where a deleted key would also delete its sessions (`ON DELETE CASCADE`), so the
 * first session surviving the second login shows the key was kept.
 *
 * Isolation: every test creates its own schema from `uniqueIdentifier`, applies
 * `AUTH_POSTGRES_SCHEMA` inside it, and drops it in a `finally`. The schema helper is a copy of the
 * one in `postgres.integration.test.ts`: importing that file would register its tests again.
 */

import { expect } from "@std/expect"
import { describe, it } from "@std/testing/bdd"
import postgres from "postgres"
import { buildPostgresOptions, type Sql } from "@ts-libs/server/db"
import { SessionManager } from "@ts-libs/server/sign-in"
import { postgresSettings, requireReachable, uniqueIdentifier } from "@integration-testing"
import {
  createEmailCodeSignIn,
  EMAIL_CODE_METHOD,
  EMAIL_CODE_PURPOSE,
  EmailCodeError,
  type EmailCodeSignIn,
} from "./email-code.ts"
import type { AuthSessionRecord } from "./model.ts"
import type { AuthStore } from "./store.ts"
import {
  AUTH_POSTGRES_SCHEMA,
  createPostgresAuthStore,
  createPostgresSessionStore,
} from "./postgres.ts"

const PEPPER = "test-pepper-not-a-real-secret-0123456789"
const ADDRESS = "victim@example.com"

interface Harness {
  sql: Sql
  store: AuthStore
  sessions: SessionManager<AuthSessionRecord>
  provider: EmailCodeSignIn
  codeFor(email?: string): Promise<string>
}

/** Runs `body` on a fresh schema holding the auth tables, and drops the schema afterwards. */
async function withProvider(body: (harness: Harness) => Promise<void>): Promise<void> {
  const settings = postgresSettings()
  await requireReachable(settings.address)

  const schema = uniqueIdentifier("it_email_code")
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
      const store = createPostgresAuthStore(sql)
      const sessions = new SessionManager<AuthSessionRecord>({
        store: createPostgresSessionStore(sql),
        pepper: PEPPER,
        durationMinutes: 60,
      })
      const sent: string[] = []
      const provider = createEmailCodeSignIn({
        store,
        sessions,
        sendCode: (_email, code) => {
          sent.push(code)
          return Promise.resolve()
        },
      })
      const codeFor = async (email = ADDRESS) => {
        await provider.requestCode(email)
        return sent[sent.length - 1]
      }
      await body({ sql, store, sessions, provider, codeFor })
    } finally {
      await sql.end()
    }
  } finally {
    try {
      await admin`DROP SCHEMA IF EXISTS ${admin(schema)} CASCADE`
    } finally {
      await admin.end()
    }
  }
}

async function refusalOf(promise: Promise<unknown>): Promise<string | null> {
  const error = await promise.then(() => null, (caught: unknown) => caught)
  expect(error).toBeInstanceOf(EmailCodeError)
  return (error as EmailCodeError).reason
}

describe("createEmailCodeSignIn on Postgres", () => {
  it("signs the same user in with a second and a third code and keeps one key and one user", () =>
    withProvider(async ({ sql, store, sessions, provider, codeFor }) => {
      const first = await provider.verifyCode(ADDRESS, await codeFor())
      const second = await provider.verifyCode("Victim@Example.com", await codeFor())
      const third = await provider.verifyCode(ADDRESS, await codeFor())

      expect(second.user.id).toBe(first.user.id)
      expect(third.user.id).toBe(first.user.id)
      expect(third.key.id).toBe(first.key.id)
      expect(third.key.email).toBe(ADDRESS)
      expect(third.key.provenAt).not.toBeNull()
      const keys = await store.listKeys(first.user.id)
      expect(keys.map((key) => [key.method, key.subject, key.email])).toEqual([
        [EMAIL_CODE_METHOD, ADDRESS, ADDRESS],
      ])
      const [{ users }] = await sql<
        { users: number }[]
      >`SELECT count(*)::int AS users FROM auth_users`
      expect(users).toBe(1)
      expect(await sessions.validate(first.session.cookieValue)).not.toBeNull()
    }))

  it("stores a hash of the code, never the code", () =>
    withProvider(async ({ sql, codeFor }) => {
      const code = await codeFor()
      const rows = await sql<{ secretHash: string }[]>`
        SELECT secret_hash AS "secretHash" FROM auth_challenges
        WHERE purpose = ${EMAIL_CODE_PURPOSE} AND subject = ${ADDRESS}
      `
      expect(rows.length).toBe(1)
      expect(rows[0].secretHash).toMatch(/^[0-9a-f]{64}$/)
      expect(rows[0].secretHash.includes(code)).toBe(false)
    }))

  it("ends the takeover script with the victim in their own account", () =>
    withProvider(async ({ store, provider, codeFor }) => {
      const squatter = await store.createUserWithKey({
        method: "password",
        subject: ADDRESS,
        email: ADDRESS,
        secret: "squatter-hash",
        provenAt: null,
      })
      await store.addKey(squatter.user.id, {
        method: EMAIL_CODE_METHOD,
        subject: ADDRESS,
        email: ADDRESS,
        secret: null,
        provenAt: null,
      })

      const victim = await provider.verifyCode(ADDRESS, await codeFor())
      const again = await provider.verifyCode(ADDRESS, await codeFor())

      expect(victim.user.id).not.toBe(squatter.user.id)
      expect(again.user.id).toBe(victim.user.id)
      expect(await store.listKeys(squatter.user.id)).toEqual([])
      expect(await store.findKey("password", ADDRESS)).toBeNull()
      expect(await store.findUserIdByProvenEmail(ADDRESS)).toBe(victim.user.id)
    }))

  it("keeps the guess counter when a new code is asked for", () =>
    withProvider(async ({ provider, codeFor }) => {
      await codeFor()
      for (let guess = 0; guess < 4; guess++) {
        expect(await refusalOf(provider.verifyCode(ADDRESS, "wrong-00"))).toBe("wrong-code")
      }
      const fresh = await codeFor()
      expect(await refusalOf(provider.verifyCode(ADDRESS, "wrong-00"))).toBe("wrong-code")
      expect(await refusalOf(provider.verifyCode(ADDRESS, fresh))).toBe("locked-out")
    }))

  it("refuses a code for a deleted account and adds no key", () =>
    withProvider(async ({ sql, store, provider, codeFor }) => {
      const first = await provider.verifyCode(ADDRESS, await codeFor())
      await sql`UPDATE auth_users SET deleted_at = now() WHERE id = ${first.user.id}`

      expect(await refusalOf(provider.verifyCode(ADDRESS, await codeFor()))).toBe(
        "account-deleted",
      )
      expect((await store.listKeys(first.user.id)).length).toBe(1)
    }))

  it("refuses a code for a deleted owner who has only a password key, and adds no key", () =>
    withProvider(async ({ sql, store, provider, codeFor }) => {
      const owner = await store.createUserWithKey({
        method: "password",
        subject: ADDRESS,
        email: ADDRESS,
        secret: "owner-hash",
        provenAt: new Date(),
      })
      await sql`UPDATE auth_users SET deleted_at = now() WHERE id = ${owner.user.id}`

      expect(await refusalOf(provider.verifyCode(ADDRESS, await codeFor()))).toBe(
        "account-deleted",
      )
      const keys = await store.listKeys(owner.user.id)
      expect(keys.map((key) => [key.id, key.method, key.subject])).toEqual([
        [owner.key.id, "password", ADDRESS],
      ])
      expect(await store.findKey(EMAIL_CODE_METHOD, ADDRESS)).toBeNull()
    }))
})
