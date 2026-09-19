/**
 * Behaviour tests for the BYOK secret store (`server/user-secrets.ts`).
 *
 * Deterministic by construction: injected clock, in-memory port, fake cipher. Nothing here reads
 * the environment, the network or the filesystem.
 */

import {
  assertEquals,
  assertFalse,
  assertInstanceOf,
  assertNotEquals,
  assertStrictEquals,
} from "@std/assert"
import { describe, it } from "@std/testing/bdd"

import { CryptoService, maskKey } from "./crypto.ts"
import type { SecretCipher } from "./crypto.ts"
import {
  createUserSecretStore,
  MAX_API_KEY_LENGTH,
  MAX_PROVIDER_LENGTH,
  type StoredUserSecret,
  UserSecretError,
  UserSecretErrorCode,
  type UserSecretPort,
  type UserSecretStore,
} from "./user-secrets.ts"

// ── Fixtures ─────────────────────────────────────────────────────────────────────────────────

const USER_ID = "user-1"
const OTHER_USER_ID = "user-2"
const PROVIDER = "openai"
const OTHER_PROVIDER = "deepseek"
/** Obviously fake, and deliberately not an `sk-` format: this must never look like a real key. */
const FAKE_API_KEY = "test-secret-not-real-1234"
const OTHER_FAKE_API_KEY = "test-secret-not-real-5678"

// ── Test doubles ─────────────────────────────────────────────────────────────────────────────

/**
 * In-memory `UserSecretPort`.
 *
 * Implements the documented upsert contract — replace the payload, force `isActive`, take the
 * incoming `updatedAt`, preserve the stored `createdAt` — and records every call argument so a
 * test can assert what the store handed over. `listByUser` returns rows in insertion order, which
 * stands in for the port's own `ORDER BY created_at DESC` (`db/mod.ts:277`).
 */
class FakePort implements UserSecretPort {
  readonly rows: StoredUserSecret[] = []
  readonly upserted: StoredUserSecret[] = []
  readonly removals: Array<{ userId: string; provider: string }> = []
  readonly listCalls: string[] = []
  readonly findActiveCalls: Array<{ userId: string; provider: string }> = []

  /** Inserts a row the way the port would have loaded it, bypassing the store. */
  seed(row: StoredUserSecret): void {
    this.rows.push(row)
  }

  upsert(record: StoredUserSecret): Promise<void> {
    this.upserted.push({ ...record })
    const index = this.rows.findIndex(
      (row) => row.userId === record.userId && row.provider === record.provider,
    )
    if (index >= 0) {
      this.rows[index] = { ...record, createdAt: this.rows[index].createdAt }
    } else {
      this.rows.push({ ...record })
    }
    return Promise.resolve()
  }

  listByUser(userId: string): Promise<StoredUserSecret[]> {
    this.listCalls.push(userId)
    return Promise.resolve(
      this.rows.filter((row) => row.userId === userId).map((row) => ({ ...row })),
    )
  }

  findActive(userId: string, provider: string): Promise<StoredUserSecret | null> {
    this.findActiveCalls.push({ userId, provider })
    const row = this.rows.find(
      (candidate) =>
        candidate.userId === userId && candidate.provider === provider && candidate.isActive,
    )
    return Promise.resolve(row ? { ...row } : null)
  }

  remove(userId: string, provider: string): Promise<void> {
    this.removals.push({ userId, provider })
    const index = this.rows.findIndex(
      (row) => row.userId === userId && row.provider === provider,
    )
    if (index >= 0) this.rows.splice(index, 1)
    return Promise.resolve()
  }
}

/** Reversible stand-in: the ciphertext is visibly derivable, which makes a leak obvious. */
class FakeCipher implements SecretCipher {
  encrypt(plaintext: string): Promise<string> {
    return Promise.resolve(`enc:${plaintext}`)
  }

  decrypt(ciphertext: string): Promise<string> {
    if (!ciphertext.startsWith("enc:")) {
      return Promise.reject(new Error("not a fake ciphertext"))
    }
    return Promise.resolve(ciphertext.slice(4))
  }
}

/** Encrypts like {@link FakeCipher} but refuses to decrypt, with a caller-chosen error. */
class UndecryptableCipher implements SecretCipher {
  constructor(private readonly failure: Error) {}

  encrypt(plaintext: string): Promise<string> {
    return Promise.resolve(`enc:${plaintext}`)
  }

  decrypt(_ciphertext: string): Promise<string> {
    return Promise.reject(this.failure)
  }
}

/** Rejects on every call. */
class FailingCipher implements SecretCipher {
  constructor(private readonly failure: Error) {}

  encrypt(_plaintext: string): Promise<string> {
    return Promise.reject(this.failure)
  }

  decrypt(_ciphertext: string): Promise<string> {
    return Promise.reject(this.failure)
  }
}

/** Rejects on every call. */
class FailingPort implements UserSecretPort {
  constructor(private readonly failure: Error) {}

  upsert(_record: StoredUserSecret): Promise<void> {
    return Promise.reject(this.failure)
  }

  listByUser(_userId: string): Promise<StoredUserSecret[]> {
    return Promise.reject(this.failure)
  }

  findActive(_userId: string, _provider: string): Promise<StoredUserSecret | null> {
    return Promise.reject(this.failure)
  }

  remove(_userId: string, _provider: string): Promise<void> {
    return Promise.reject(this.failure)
  }
}

interface Harness {
  store: UserSecretStore
  port: FakePort
  cipher: SecretCipher
}

/** Wires a store over the fakes with a clock that advances one second per read. */
function createHarness(cipher: SecretCipher = new FakeCipher()): Harness {
  const port = new FakePort()
  const start = Date.parse("2026-01-01T00:00:00.000Z")
  let reads = 0
  const store = createUserSecretStore({
    port,
    cipher,
    now: () => new Date(start + reads++ * 1000),
  })
  return { store, port, cipher }
}

/** Runs `operation`, asserts it rejected with a {@link UserSecretError}, and returns that error. */
async function rejection(operation: () => Promise<unknown>): Promise<UserSecretError> {
  let caught: unknown
  try {
    await operation()
  } catch (error) {
    caught = error
  }
  assertInstanceOf(caught, UserSecretError)
  return caught
}

/** Asserts the operation rejects with the given code and returns the error. */
async function rejectionWith(
  operation: () => Promise<unknown>,
  code: UserSecretErrorCode,
): Promise<UserSecretError> {
  const error = await rejection(operation)
  assertEquals(error.code, code)
  return error
}

/**
 * No fragment of the fixture key may survive in a message. The full value is the real check; the
 * two substrings are the "any part of it" check for the parts a template would most likely echo.
 */
function assertNoKeyMaterial(message: string): void {
  assertFalse(message.includes(FAKE_API_KEY))
  assertFalse(message.includes("test-secret"))
  assertFalse(message.includes("1234"))
}

// ── Save: encryption at rest and the masked hint ─────────────────────────────────────────────

describe("save", () => {
  it("stores a ciphertext and a hint, never the plaintext", async () => {
    const { store, port } = createHarness()

    await store.save(USER_ID, { provider: PROVIDER, apiKey: FAKE_API_KEY })

    assertEquals(port.rows.length, 1)
    const row = port.rows[0]
    assertEquals(row.secretEncrypted, `enc:${FAKE_API_KEY}`)
    assertNotEquals(row.secretEncrypted, FAKE_API_KEY)
    assertEquals(row.keyHint, maskKey(FAKE_API_KEY, 4))
    assertEquals(row.isActive, true)
    assertEquals(row.baseUrl, "")
    assertEquals(row.model, "")
    // Every field but the ciphertext: a hint, a baseUrl or a model carrying the key would be just
    // as bad as a plaintext column. `secretEncrypted` is excluded here only because this fake
    // cipher embeds its input by construction — the whole-record assertion runs against the real
    // cipher in "round-trips a key through CryptoService", where that is a meaningful check.
    const { secretEncrypted: _ciphertext, ...metadata } = row
    assertFalse(JSON.stringify(metadata).includes(FAKE_API_KEY))
    assertFalse(row.keyHint.includes("test-secret"))
    assertEquals(row.createdAt, row.updatedAt)
  })

  it("returns a summary with the hint and no secret-bearing field", async () => {
    const { store } = createHarness()

    const summary = await store.save(USER_ID, { provider: PROVIDER, apiKey: FAKE_API_KEY })

    assertEquals(Object.keys(summary).sort(), [
      "baseUrl",
      "createdAt",
      "isActive",
      "keyHint",
      "model",
      "provider",
      "updatedAt",
    ])
    assertEquals(summary.keyHint, maskKey(FAKE_API_KEY, 4))
    assertFalse(JSON.stringify(summary).includes(FAKE_API_KEY))
    assertFalse(JSON.stringify(summary).includes("enc:"))
  })

  it("replaces the secret for the same user and provider, keeping the stored createdAt", async () => {
    const { store, port } = createHarness()

    const first = await store.save(USER_ID, { provider: PROVIDER, apiKey: FAKE_API_KEY })
    const second = await store.save(USER_ID, { provider: PROVIDER, apiKey: OTHER_FAKE_API_KEY })

    assertEquals(port.rows.length, 1)
    const row = port.rows[0]
    assertEquals(row.secretEncrypted, `enc:${OTHER_FAKE_API_KEY}`)
    assertEquals(row.keyHint, maskKey(OTHER_FAKE_API_KEY, 4))
    assertEquals(row.isActive, true)
    assertEquals(row.createdAt, first.createdAt)
    assertNotEquals(row.updatedAt, first.updatedAt)
    // The summary reports what the port stored, not the timestamp this process just minted.
    assertEquals(second.createdAt, first.createdAt)
    assertEquals(second.updatedAt, row.updatedAt)
  })

  it("keeps two providers of one user as separate rows", async () => {
    const { store, port } = createHarness()

    await store.save(USER_ID, { provider: PROVIDER, apiKey: FAKE_API_KEY })
    await store.save(USER_ID, { provider: OTHER_PROVIDER, apiKey: OTHER_FAKE_API_KEY })
    await store.save(OTHER_USER_ID, { provider: PROVIDER, apiKey: FAKE_API_KEY })

    assertEquals(port.rows.length, 3)
    assertEquals(
      port.rows.map((row) => `${row.userId}/${row.provider}`),
      [`${USER_ID}/${PROVIDER}`, `${USER_ID}/${OTHER_PROVIDER}`, `${OTHER_USER_ID}/${PROVIDER}`],
    )
  })

  it("stores a valid https baseUrl and model", async () => {
    const { store, port } = createHarness()

    const summary = await store.save(USER_ID, {
      provider: PROVIDER,
      apiKey: FAKE_API_KEY,
      baseUrl: "https://api.example.com/v1",
      model: "test-model-not-real",
    })

    assertEquals(port.rows[0].baseUrl, "https://api.example.com/v1")
    assertEquals(summary.model, "test-model-not-real")
  })

  it("stores an empty baseUrl when none is given", async () => {
    const { store, port } = createHarness()

    const summary = await store.save(USER_ID, { provider: PROVIDER, apiKey: FAKE_API_KEY })

    assertEquals(port.rows[0].baseUrl, "")
    assertEquals(summary.baseUrl, "")
  })
})

// ── Save: validation rejects with typed, constant messages ───────────────────────────────────

describe("save validation", () => {
  it("rejects a blank userId", async () => {
    const { store } = createHarness()

    const error = await rejectionWith(
      () => store.save("   ", { provider: PROVIDER, apiKey: FAKE_API_KEY }),
      UserSecretErrorCode.InvalidUserId,
    )

    assertEquals(error.message, "userId is required")
  })

  it("rejects a blank provider", async () => {
    const { store } = createHarness()

    const error = await rejectionWith(
      () => store.save(USER_ID, { provider: "", apiKey: FAKE_API_KEY }),
      UserSecretErrorCode.InvalidProvider,
    )

    assertNoKeyMaterial(error.message)
  })

  it("rejects a provider with characters no adapter could match", async () => {
    const { store } = createHarness()

    await rejectionWith(
      () => store.save(USER_ID, { provider: "bad provider!", apiKey: FAKE_API_KEY }),
      UserSecretErrorCode.InvalidProvider,
    )
  })

  it("rejects an oversized provider", async () => {
    const { store } = createHarness()

    await rejectionWith(
      () =>
        store.save(USER_ID, {
          provider: "a".repeat(MAX_PROVIDER_LENGTH + 1),
          apiKey: FAKE_API_KEY,
        }),
      UserSecretErrorCode.InvalidProvider,
    )
  })

  it("rejects an apiKey shorter than the minimum", async () => {
    const { store } = createHarness()

    const error = await rejectionWith(
      () => store.save(USER_ID, { provider: PROVIDER, apiKey: "short-1" }),
      UserSecretErrorCode.InvalidApiKey,
    )

    assertFalse(error.message.includes("short-1"))
  })

  it("rejects an oversized apiKey", async () => {
    const { store } = createHarness()

    await rejectionWith(
      () =>
        store.save(USER_ID, {
          provider: PROVIDER,
          apiKey: "t".repeat(MAX_API_KEY_LENGTH + 1),
        }),
      UserSecretErrorCode.InvalidApiKey,
    )
  })

  it("rejects an apiKey containing a NUL character", async () => {
    const { store, port } = createHarness()

    await rejectionWith(
      () => store.save(USER_ID, { provider: PROVIDER, apiKey: `${FAKE_API_KEY}\u0000` }),
      UserSecretErrorCode.InvalidApiKey,
    )
    assertEquals(port.rows.length, 0)
  })

  it("rejects an apiKey containing a DEL character", async () => {
    const { store } = createHarness()

    await rejectionWith(
      () => store.save(USER_ID, { provider: PROVIDER, apiKey: `${FAKE_API_KEY}\u007f` }),
      UserSecretErrorCode.InvalidApiKey,
    )
  })

  it("rejects a baseUrl that is not a URL", async () => {
    const { store } = createHarness()

    await rejectionWith(
      () =>
        store.save(USER_ID, {
          provider: PROVIDER,
          apiKey: FAKE_API_KEY,
          baseUrl: "not a url",
        }),
      UserSecretErrorCode.InvalidBaseUrl,
    )
  })

  it("rejects a non-http(s) baseUrl", async () => {
    const { store } = createHarness()

    await rejectionWith(
      () =>
        store.save(USER_ID, {
          provider: PROVIDER,
          apiKey: FAKE_API_KEY,
          baseUrl: "ftp://example.com",
        }),
      UserSecretErrorCode.InvalidBaseUrl,
    )
  })

  it("never echoes the apiKey in a validation message", async () => {
    const { store } = createHarness()
    const cases: Array<() => Promise<unknown>> = [
      () => store.save(USER_ID, { provider: "", apiKey: FAKE_API_KEY }),
      () => store.save(USER_ID, { provider: "bad provider!", apiKey: FAKE_API_KEY }),
      () => store.save(USER_ID, { provider: PROVIDER, apiKey: `${FAKE_API_KEY}\u0000` }),
      () =>
        store.save(USER_ID, {
          provider: PROVIDER,
          apiKey: FAKE_API_KEY,
          baseUrl: "not a url",
        }),
    ]

    for (const run of cases) {
      const error = await rejection(run)
      assertNoKeyMaterial(error.message)
      assertEquals(error.name, "UserSecretError")
    }
  })

  it("uses the same constant message for different rejected apiKeys", async () => {
    const { store } = createHarness()

    const first = await rejectionWith(
      () => store.save(USER_ID, { provider: PROVIDER, apiKey: "short-1" }),
      UserSecretErrorCode.InvalidApiKey,
    )
    const second = await rejectionWith(
      () => store.save(USER_ID, { provider: PROVIDER, apiKey: "tiny-2" }),
      UserSecretErrorCode.InvalidApiKey,
    )

    assertEquals(first.message, second.message)
    assertFalse(first.message.includes("short-1"))
    assertFalse(second.message.includes("tiny-2"))
  })
})

// ── Save: port and cipher failures carry no secret ───────────────────────────────────────────

describe("save failures", () => {
  it("reports PortFailure without the plaintext when the cipher cannot encrypt", async () => {
    const failure = new Error(`cipher exploded on ${FAKE_API_KEY}`)
    const { store } = createHarness(new FailingCipher(failure))

    const error = await rejectionWith(
      () => store.save(USER_ID, { provider: PROVIDER, apiKey: FAKE_API_KEY }),
      UserSecretErrorCode.PortFailure,
    )

    assertNoKeyMaterial(error.message)
    assertStrictEquals(error.cause, failure)
  })

  it("reports PortFailure without the ciphertext when the port cannot upsert", async () => {
    const port = new FailingPort(new Error("connection refused"))
    const store = createUserSecretStore({ port, cipher: new FakeCipher() })

    const error = await rejectionWith(
      () => store.save(USER_ID, { provider: PROVIDER, apiKey: FAKE_API_KEY }),
      UserSecretErrorCode.PortFailure,
    )

    assertFalse(error.message.includes(`enc:${FAKE_API_KEY}`))
    assertNoKeyMaterial(error.message)
  })
})

// ── List: metadata only, port order preserved ────────────────────────────────────────────────

describe("list", () => {
  it("returns metadata plus a hint and no secret-bearing field", async () => {
    const { store } = createHarness()
    await store.save(USER_ID, {
      provider: PROVIDER,
      apiKey: FAKE_API_KEY,
      baseUrl: "https://api.example.com/v1",
      model: "test-model-not-real",
    })

    const summaries = await store.list(USER_ID)

    assertEquals(summaries.length, 1)
    assertEquals(Object.keys(summaries[0]).sort(), [
      "baseUrl",
      "createdAt",
      "isActive",
      "keyHint",
      "model",
      "provider",
      "updatedAt",
    ])
    assertEquals(summaries[0].keyHint, maskKey(FAKE_API_KEY, 4))
    assertFalse(JSON.stringify(summaries).includes("enc:"))
    assertFalse(JSON.stringify(summaries).includes(FAKE_API_KEY))
  })

  it("returns an empty array for a user with no rows", async () => {
    const { store, port } = createHarness()

    assertEquals(await store.list(OTHER_USER_ID), [])
    assertEquals(port.listCalls, [OTHER_USER_ID])
  })

  it("preserves the port's order", async () => {
    const { store, port } = createHarness()
    const row = (provider: string, createdAt: string): StoredUserSecret => ({
      userId: USER_ID,
      provider,
      secretEncrypted: `enc:${FAKE_API_KEY}`,
      keyHint: maskKey(FAKE_API_KEY, 4),
      baseUrl: "",
      model: "",
      isActive: true,
      createdAt,
      updatedAt: createdAt,
    })
    // Newest first, the order `db/mod.ts:277` produces.
    port.seed(row("newest-provider", "2026-01-03T00:00:00.000Z"))
    port.seed(row("middle-provider", "2026-01-02T00:00:00.000Z"))
    port.seed(row("oldest-provider", "2026-01-01T00:00:00.000Z"))

    const summaries = await store.list(USER_ID)

    assertEquals(summaries.map((summary) => summary.provider), [
      "newest-provider",
      "middle-provider",
      "oldest-provider",
    ])
  })

  it("reports PortFailure when the port cannot list", async () => {
    const failure = new Error("connection refused")
    const store = createUserSecretStore({
      port: new FailingPort(failure),
      cipher: new FakeCipher(),
    })

    const error = await rejectionWith(
      () => store.list(USER_ID),
      UserSecretErrorCode.PortFailure,
    )

    assertStrictEquals(error.cause, failure)
  })
})

// ── openSecret: the decrypted value or a typed failure ───────────────────────────────────────

describe("openSecret", () => {
  it("returns the plaintext for a stored key", async () => {
    const { store } = createHarness()
    await store.save(USER_ID, { provider: PROVIDER, apiKey: FAKE_API_KEY })

    assertEquals(await store.openSecret(USER_ID, PROVIDER), FAKE_API_KEY)
  })

  it("rejects an unknown provider with NotFound", async () => {
    const { store } = createHarness()
    await store.save(USER_ID, { provider: PROVIDER, apiKey: FAKE_API_KEY })

    const error = await rejectionWith(
      () => store.openSecret(USER_ID, "unknown-provider"),
      UserSecretErrorCode.NotFound,
    )

    assertEquals(error.message, "no active secret is stored for that provider")
    assertNoKeyMaterial(error.message)
  })

  it("rejects a stored-but-inactive row with NotFound", async () => {
    const { store, port } = createHarness()
    port.seed({
      userId: USER_ID,
      provider: PROVIDER,
      secretEncrypted: `enc:${FAKE_API_KEY}`,
      keyHint: maskKey(FAKE_API_KEY, 4),
      baseUrl: "",
      model: "",
      isActive: false,
      createdAt: "2026-01-01T00:00:00.000Z",
      updatedAt: "2026-01-01T00:00:00.000Z",
    })

    await rejectionWith(
      () => store.openSecret(USER_ID, PROVIDER),
      UserSecretErrorCode.NotFound,
    )
  })

  it("rejects an invalid provider shape with InvalidProvider, not NotFound", async () => {
    const { store } = createHarness()

    await rejectionWith(
      () => store.openSecret(USER_ID, "bad provider!"),
      UserSecretErrorCode.InvalidProvider,
    )
  })

  it("reports DecryptionFailed for any cipher rejection, classified by type not message", async () => {
    const failure = new Error("something else entirely")
    const { store, port } = createHarness(new UndecryptableCipher(failure))
    await store.save(USER_ID, { provider: PROVIDER, apiKey: FAKE_API_KEY })
    const ciphertext = port.rows[0].secretEncrypted

    const error = await rejectionWith(
      () => store.openSecret(USER_ID, PROVIDER),
      UserSecretErrorCode.DecryptionFailed,
    )

    assertFalse(error.message.includes("something else entirely"))
    assertFalse(error.message.includes(ciphertext))
    assertNoKeyMaterial(error.message)
    assertStrictEquals(error.cause, failure)
  })

  it("reports PortFailure when the port cannot be read", async () => {
    const failure = new Error("connection refused")
    const store = createUserSecretStore({
      port: new FailingPort(failure),
      cipher: new FakeCipher(),
    })

    const error = await rejectionWith(
      () => store.openSecret(USER_ID, PROVIDER),
      UserSecretErrorCode.PortFailure,
    )

    assertStrictEquals(error.cause, failure)
  })
})

// ── remove: idempotent ───────────────────────────────────────────────────────────────────────

describe("remove", () => {
  it("is idempotent and passes exactly the user and provider to the port", async () => {
    const { store, port } = createHarness()

    await store.remove(USER_ID, PROVIDER)
    await store.remove(USER_ID, PROVIDER)

    assertEquals(port.removals, [
      { userId: USER_ID, provider: PROVIDER },
      { userId: USER_ID, provider: PROVIDER },
    ])
  })

  it("deletes a stored key", async () => {
    const { store, port } = createHarness()
    await store.save(USER_ID, { provider: PROVIDER, apiKey: FAKE_API_KEY })

    await store.remove(USER_ID, PROVIDER)

    assertEquals(port.rows.length, 0)
    await rejectionWith(
      () => store.openSecret(USER_ID, PROVIDER),
      UserSecretErrorCode.NotFound,
    )
  })

  it("reports PortFailure when the port cannot delete", async () => {
    const failure = new Error("connection refused")
    const store = createUserSecretStore({
      port: new FailingPort(failure),
      cipher: new FakeCipher(),
    })

    const error = await rejectionWith(
      () => store.remove(USER_ID, PROVIDER),
      UserSecretErrorCode.PortFailure,
    )

    assertStrictEquals(error.cause, failure)
  })
})

// ── Integration with the real cipher ─────────────────────────────────────────────────────────

describe("real cipher", () => {
  it("round-trips a key through CryptoService", async () => {
    const port = new FakePort()
    const store = createUserSecretStore({
      port,
      cipher: new CryptoService("test-secret-not-real-0123456789abcdef"),
    })

    const summary = await store.save(USER_ID, { provider: PROVIDER, apiKey: FAKE_API_KEY })

    assertEquals(summary.keyHint, maskKey(FAKE_API_KEY, 4))
    assertFalse(port.rows[0].secretEncrypted.includes(FAKE_API_KEY))
    assertFalse(JSON.stringify(port.rows[0]).includes(FAKE_API_KEY))
    assertEquals(await store.openSecret(USER_ID, PROVIDER), FAKE_API_KEY)
  })
})
