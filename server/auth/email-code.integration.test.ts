/**
 * The email-code provider against a real Postgres (#57 finding 3 and the takeover script).
 *
 * The unit tests run the same flows on `MemoryAuthStore`. Here they run on the Postgres store and
 * session store, where a deleted key would also delete its sessions (`ON DELETE CASCADE`), so the
 * first session surviving the second login shows the key was kept.
 *
 * Isolation: every test creates its own schema from `uniqueIdentifier`, applies
 * `AUTH_POSTGRES_SCHEMA` inside it (`openAuthSchema`), and drops it in a `finally`.
 */

import { expect } from "@std/expect"
import { describe, it } from "@std/testing/bdd"
import type { Sql } from "../db/index.ts"
import { createPasswordHasher, SessionManager } from "../sign-in/mod.ts"
import { postgresSettings, requireReachable } from "@integration-testing"
import {
  createEmailCodeSignIn,
  createEmailProof,
  EMAIL_CODE_METHOD,
  EMAIL_CODE_PURPOSE,
  EMAIL_PROOF_PURPOSE,
  EmailCodeError,
  type EmailCodeSignIn,
} from "./email-code.ts"
import { AuthConflictError, type AuthSessionRecord } from "./model.ts"
import { createPasswordSignIn, PASSWORD_METHOD, type PasswordSignIn } from "./password.ts"
import type { AuthStore } from "./store.ts"
import { openAuthSchema } from "./postgres-schema-fixture.test.ts"
import { createPostgresAuthStore, createPostgresSessionStore } from "./postgres.ts"

const PEPPER = "test-pepper-not-a-real-secret-0123456789"
const ADDRESS = "victim@example.com"
const PASSWORD = "victim-password-1"

interface Harness {
  sql: Sql
  store: AuthStore
  sessions: SessionManager<AuthSessionRecord>
  provider: EmailCodeSignIn
  /** A password provider over the same store and sessions. */
  passwords: PasswordSignIn
  codeFor(email?: string): Promise<string>
}

/** Runs `body` on a fresh schema holding the auth tables, and drops the schema afterwards. */
async function withProvider(body: (harness: Harness) => Promise<void>): Promise<void> {
  const settings = postgresSettings()
  await requireReachable(settings.address)

  const { sql, close } = await openAuthSchema({
    prefix: "it_email_code",
    connection: settings.connection,
    poolSize: 4,
  })
  try {
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
    const passwords = createPasswordSignIn({
      store,
      sessions,
      hasher: createPasswordHasher({ pepper: PEPPER, iterations: 100_000 }),
    })
    await body({ sql, store, sessions, provider, passwords, codeFor })
  } finally {
    await close()
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

  it("proves a password sign-up's address and keeps one user across both providers", () =>
    withProvider(async ({ sql, store, provider, passwords, codeFor }) => {
      const signedUp = await passwords.signUp({ email: ADDRESS, password: PASSWORD })

      const proven = await provider.proveAddress(signedUp.user.id, ADDRESS, await codeFor())
      const byPassword = await passwords.signIn({ email: ADDRESS, password: PASSWORD })
      const byCode = await provider.verifyCode(ADDRESS, await codeFor())

      expect(proven.map((key) => [key.id, key.method])).toEqual([
        [signedUp.key.id, PASSWORD_METHOD],
      ])
      expect(proven[0].provenAt).not.toBeNull()
      expect(byPassword.user.id).toBe(signedUp.user.id)
      expect(byCode.user.id).toBe(signedUp.user.id)
      expect(await store.findUserIdByProvenEmail(ADDRESS)).toBe(signedUp.user.id)
      const [{ users }] = await sql<
        { users: number }[]
      >`SELECT count(*)::int AS users FROM auth_users`
      expect(users).toBe(1)
    }))

  it("refuses to prove an address another user owns", () =>
    withProvider(async ({ store, provider, passwords, codeFor }) => {
      const owner = await provider.verifyCode(ADDRESS, await codeFor())
      const other = await passwords.signUp({ email: "other@example.com", password: PASSWORD })

      const error = await provider.proveAddress(other.user.id, ADDRESS, await codeFor()).then(
        () => null,
        (caught: unknown) => caught,
      )

      expect(error).toBeInstanceOf(AuthConflictError)
      expect((error as AuthConflictError).reason).toBe("email-owned")
      expect(await store.findUserIdByProvenEmail(ADDRESS)).toBe(owner.user.id)
      expect((await store.listKeys(other.user.id)).length).toBe(1)
    }))

  it("evicts a squatter's unproven password key when a user proves the address", () =>
    withProvider(async ({ store, provider, passwords, codeFor }) => {
      const squatter = await passwords.signUp({ email: ADDRESS, password: "squatter-pw-1" })
      const victim = await passwords.signUp({ email: "victim@work.example", password: PASSWORD })

      const proven = await provider.proveAddress(victim.user.id, ADDRESS, await codeFor())

      expect(proven.map((key) => [key.userId, key.method])).toEqual([
        [victim.user.id, EMAIL_CODE_METHOD],
      ])
      expect(await store.listKeys(squatter.user.id)).toEqual([])
      expect(await store.findKey(PASSWORD_METHOD, ADDRESS)).toBeNull()
      expect(await store.findUserIdByProvenEmail(ADDRESS)).toBe(victim.user.id)
    }))

  it("refuses a wrong code, counts it, and refuses a code sent to another address", () =>
    withProvider(async ({ store, provider, passwords, codeFor }) => {
      const signedUp = await passwords.signUp({ email: ADDRESS, password: PASSWORD })
      const otherCode = await codeFor("other@example.com")
      const code = await codeFor()

      expect(await refusalOf(provider.proveAddress(signedUp.user.id, ADDRESS, otherCode))).toBe(
        "wrong-code",
      )
      for (let guess = 0; guess < 4; guess++) {
        expect(await refusalOf(provider.proveAddress(signedUp.user.id, ADDRESS, "wrong-00")))
          .toBe("wrong-code")
      }
      expect(await refusalOf(provider.proveAddress(signedUp.user.id, ADDRESS, code))).toBe(
        "locked-out",
      )
      expect(await store.findUserIdByProvenEmail(ADDRESS)).toBeNull()
    }))

  it("refuses a deleted user without spending the code", () =>
    withProvider(async ({ sql, provider, passwords, codeFor }) => {
      const signedUp = await passwords.signUp({ email: ADDRESS, password: PASSWORD })
      await sql`UPDATE auth_users SET deleted_at = now() WHERE id = ${signedUp.user.id}`
      const code = await codeFor()

      expect(await refusalOf(provider.proveAddress(signedUp.user.id, ADDRESS, code))).toBe(
        "account-deleted",
      )
      const other = await passwords.signUp({ email: "other@example.com", password: PASSWORD })
      const proven = await provider.proveAddress(other.user.id, ADDRESS, code)
      expect(proven[0].userId).toBe(other.user.id)
    }))
})

describe("createEmailProof on Postgres", () => {
  /** A proof over the harness's store and the codes it sent, in order. */
  function proofOver(store: AuthStore) {
    const sent: string[] = []
    const proof = createEmailProof({
      store,
      sendCode: (_email, code) => {
        sent.push(code)
        return Promise.resolve()
      },
    })
    const proofCode = async (userId: number, email: string) => {
      await proof.requestCode(userId, email)
      return sent[sent.length - 1]
    }
    return { proof, proofCode }
  }

  it("keeps another account's wrong guesses off this account's code, for the longest address", () =>
    withProvider(async ({ store, passwords }) => {
      const longest = `${"a".repeat(64)}@${"b".repeat(63)}.${"c".repeat(63)}.${"d".repeat(61)}`
      expect(longest).toHaveLength(254)
      const owner = await passwords.signUp({ email: longest, password: PASSWORD })
      const other = await passwords.signUp({ email: ADDRESS, password: PASSWORD })
      const { proof, proofCode } = proofOver(store)
      const code = await proofCode(owner.user.id, longest)

      await proofCode(other.user.id, longest)
      for (let guess = 0; guess < 5; guess++) {
        expect(await refusalOf(proof.proveAddress(other.user.id, longest, `wrong-${guess}`)))
          .toBe("wrong-code")
      }

      await proof.proveAddress(owner.user.id, longest, code)
      expect(await store.findUserIdByProvenEmail(longest)).toBe(owner.user.id)
    }))

  it("stores a hash of the code under the user, never the code or the address", () =>
    withProvider(async ({ sql, store, passwords }) => {
      const signedUp = await passwords.signUp({ email: ADDRESS, password: PASSWORD })
      const { proofCode } = proofOver(store)
      const code = await proofCode(signedUp.user.id, ADDRESS)

      const rows = await sql<{ subject: string; secretHash: string }[]>`
        SELECT subject, secret_hash AS "secretHash" FROM auth_challenges
        WHERE purpose = ${EMAIL_PROOF_PURPOSE}
      `
      expect(rows).toHaveLength(1)
      expect(rows[0].subject).toMatch(new RegExp(`^${signedUp.user.id}:[0-9a-f]{64}$`))
      expect(rows[0].secretHash).not.toContain(code)
      expect(JSON.stringify(rows)).not.toContain(ADDRESS)
    }))
})
