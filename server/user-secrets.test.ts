/**
 * Behaviour tests for the BYOK secret store (`server/user-secrets.ts`).
 *
 * Deterministic by construction: injected clock, in-memory port, fake cipher. Nothing here reads
 * the environment, the network or the filesystem.
 */

import { assertEquals, assertFalse, assertInstanceOf, assertNotEquals } from "@std/assert"
import { describe, it } from "@std/testing/bdd"

import type { DnsResolver } from "@ts-libs/net/url-policy"

import { CryptoError, CryptoErrorCode, CryptoService, maskKey } from "./crypto.ts"
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

  /**
   * The row for the pair, **including an inactive one**.
   *
   * The port deliberately does not filter on `isActive`, although the real contract says it only
   * returns active rows: a fake that filters here hides whether the store checks `isActive` itself,
   * and the inactive-row test then passes with that check deleted from the library. A fake that
   * hands over everything it has is what makes the store's own refusal observable.
   */
  findActive(userId: string, provider: string): Promise<StoredUserSecret | null> {
    this.findActiveCalls.push({ userId, provider })
    const row = this.rows.find(
      (candidate) => candidate.userId === userId && candidate.provider === provider,
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

/**
 * A rejection that quotes everything it was handed, with its class name set to the plaintext.
 *
 * This is the shape of a real leak in the wild: a driver or HTTP client builds its failure message
 * from the values it was working on, and `name` is attacker-influenced too (a subclass, a proxy, a
 * deserialised error). Everything here must stop at the boundary.
 */
function hostileRejection(context: string, name: string = FAKE_API_KEY): Error {
  const failure = new Error(
    `${context} failed for ${FAKE_API_KEY} (ciphertext enc:${FAKE_API_KEY})`,
  )
  failure.name = name
  return failure
}

/** Adversarial port: its rejection echoes the ciphertext it was handed on every method. */
class EchoingPort implements UserSecretPort {
  constructor(private readonly context: string) {}

  upsert(record: StoredUserSecret): Promise<void> {
    return Promise.reject(hostileRejection(`${this.context} upsert ${record.secretEncrypted}`))
  }

  listByUser(_userId: string): Promise<StoredUserSecret[]> {
    return Promise.reject(hostileRejection(`${this.context} list`))
  }

  findActive(userId: string, provider: string): Promise<StoredUserSecret | null> {
    return Promise.reject(hostileRejection(`${this.context} findActive ${userId} ${provider}`))
  }

  remove(_userId: string, _provider: string): Promise<void> {
    return Promise.reject(hostileRejection(`${this.context} remove`))
  }
}

/** Adversarial cipher: refuses to decrypt, quoting the plaintext and the ciphertext it was handed. */
class EchoingCipher implements SecretCipher {
  encrypt(_plaintext: string): Promise<string> {
    return Promise.reject(hostileRejection("echoing encrypt"))
  }

  decrypt(ciphertext: string): Promise<string> {
    return Promise.reject(hostileRejection(`echoing decrypt ${ciphertext}`))
  }
}

/** Adversarial port that rejects with whatever `make` builds, so a test controls the shape. */
class HostilePort implements UserSecretPort {
  constructor(private readonly make: (context: string) => unknown) {}

  upsert(record: StoredUserSecret): Promise<void> {
    return Promise.reject(this.make(`hostile upsert ${record.secretEncrypted}`))
  }

  listByUser(_userId: string): Promise<StoredUserSecret[]> {
    return Promise.reject(this.make("hostile list"))
  }

  findActive(userId: string, provider: string): Promise<StoredUserSecret | null> {
    return Promise.reject(this.make(`hostile findActive ${userId} ${provider}`))
  }

  remove(_userId: string, _provider: string): Promise<void> {
    return Promise.reject(this.make("hostile remove"))
  }
}

/** Adversarial cipher that rejects with whatever `make` builds. */
class HostileCipher implements SecretCipher {
  constructor(private readonly make: (context: string) => unknown) {}

  encrypt(plaintext: string): Promise<string> {
    return Promise.reject(this.make(`hostile encrypt ${plaintext}`))
  }

  decrypt(ciphertext: string): Promise<string> {
    return Promise.reject(this.make(`hostile decrypt ${ciphertext}`))
  }
}

/** A stored, active row for {@link USER_ID}/{@link PROVIDER}, seeded straight into the fake port. */
function seedActiveRow(port: FakePort): void {
  port.seed({
    userId: USER_ID,
    provider: PROVIDER,
    secretEncrypted: `enc:${FAKE_API_KEY}`,
    keyHint: maskKey(FAKE_API_KEY, 4),
    baseUrl: "",
    model: "",
    isActive: true,
    createdAt: "2026-01-01T00:00:00.000Z",
    updatedAt: "2026-01-01T00:00:00.000Z",
  })
}

interface Harness {
  store: UserSecretStore
  port: FakePort
  cipher: SecretCipher
}

/**
 * The resolver every test injects.
 *
 * The unit tier has no network permission, so a store that fell back to the system resolver would
 * fail every test that saves a host name — which is also the point: the fallback is real, and a
 * test must not hide it. `93.184.216.34` is a routable address; the documentation ranges of
 * RFC 5737 cannot be used here, because the policy guard refuses them as non-public.
 */
const TEST_RESOLVER: DnsResolver = {
  resolve: (hostname: string) => {
    if (hostname === "api.example.com" || hostname === "api.provider.example") {
      return Promise.resolve(["93.184.216.34"])
    }
    if (hostname === "internal.example.com") return Promise.resolve(["10.0.0.5"])
    return Promise.reject(new Error(`no such host: ${hostname}`))
  },
}

/** Wires a store over the fakes with a clock that advances one second per read. */
function createHarness(
  cipher: SecretCipher = new FakeCipher(),
  overrides: { allowInternalBaseUrl?: boolean; resolver?: DnsResolver } = {},
): Harness {
  const port = new FakePort()
  const start = Date.parse("2026-01-01T00:00:00.000Z")
  let reads = 0
  const store = createUserSecretStore({
    port,
    cipher,
    now: () => new Date(start + reads++ * 1000),
    resolver: overrides.resolver ?? TEST_RESOLVER,
    allowInternalBaseUrl: overrides.allowInternalBaseUrl,
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

/**
 * Everything a caller, a logger or a serialiser can reach from a thrown value, in one string.
 *
 * Deliberately broader than `error.message`: own enumerable properties (`code`, `rejectionName`),
 * `name`, `message` — including when `message` is non-enumerable — and a walk of the whole `cause`
 * chain, which must be `undefined` at every link. A `cause`-carrying error that looks clean at
 * `.message` is exactly the leak this pins down.
 */
function reachableText(thrown: unknown): string {
  const parts: string[] = []
  const seen = new Set<unknown>()
  let current: unknown = thrown
  while (current !== null && current !== undefined && !seen.has(current)) {
    seen.add(current)
    if (current instanceof Error) {
      parts.push(`name=${current.name}`, `message=${current.message}`)
      for (const [key, value] of Object.entries(current)) {
        parts.push(`${key}=${String(value)}`)
      }
      current = current.cause
    } else {
      parts.push(`non-error=${String(current)}`)
      break
    }
  }
  return parts.join("\n")
}

/** Asserts no probe string is reachable from the thrown error, and that no `cause` is attached. */
function assertNothingReachable(error: UserSecretError, probes: string[]): void {
  assertEquals(error.cause, undefined)
  const reachable = reachableText(error)
  for (const probe of probes) {
    assertFalse(
      reachable.includes(probe),
      `rejection detail reached the thrown error: ${probe}`,
    )
  }
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
    failure.name = "CryptoError"
    const { store } = createHarness(new FailingCipher(failure))

    const error = await rejectionWith(
      () => store.save(USER_ID, { provider: PROVIDER, apiKey: FAKE_API_KEY }),
      UserSecretErrorCode.PortFailure,
    )

    assertNoKeyMaterial(error.message)
    // The name is a string the rejection chose, so it is ignored: this is a plain `Error`.
    assertEquals(error.rejectionName, "Error")
    assertNothingReachable(error, [FAKE_API_KEY, `enc:${FAKE_API_KEY}`, failure.message])
  })

  it("reports our own CryptoError by identity, not by its name", async () => {
    const failure = new CryptoError(CryptoErrorCode.EncryptionFailed, "cipher rejected the input")
    const { store } = createHarness(new FailingCipher(failure))

    const error = await rejectionWith(
      () => store.save(USER_ID, { provider: PROVIDER, apiKey: FAKE_API_KEY }),
      UserSecretErrorCode.PortFailure,
    )

    assertEquals(error.rejectionName, "CryptoError")
    assertNothingReachable(error, [FAKE_API_KEY, `enc:${FAKE_API_KEY}`, failure.message])
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
    assertNothingReachable(error, [FAKE_API_KEY, `enc:${FAKE_API_KEY}`, "connection refused"])
  })

  it("keeps the plaintext, the ciphertext and the rejection out of a hostile PortFailure", async () => {
    const store = createUserSecretStore({
      port: new EchoingPort("hostile"),
      cipher: new FakeCipher(),
    })

    const error = await rejectionWith(
      () => store.save(USER_ID, { provider: PROVIDER, apiKey: FAKE_API_KEY }),
      UserSecretErrorCode.PortFailure,
    )

    // The hostile port's rejection names the plaintext, the ciphertext and the key again; the
    // identity of a known error type is the only survivor — never a string the rejection chose.
    assertNothingReachable(error, [
      FAKE_API_KEY,
      `enc:${FAKE_API_KEY}`,
      "hostile upsert failed",
      "ciphertext",
    ])
    assertEquals(error.rejectionName, "Error")
    assertEquals(error.message, "the user secret port failed")
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

    assertNothingReachable(error, ["connection refused"])
    assertEquals(error.rejectionName, "Error")
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
    assertEquals(error.rejectionName, "Error")
    assertNothingReachable(error, [FAKE_API_KEY, ciphertext, "something else entirely"])
  })

  it("keeps the plaintext, the ciphertext and the rejection out of a hostile DecryptionFailed", async () => {
    const { store, port } = createHarness(new EchoingCipher())
    seedActiveRow(port)

    const error = await rejectionWith(
      () => store.openSecret(USER_ID, PROVIDER),
      UserSecretErrorCode.DecryptionFailed,
    )

    // The hostile cipher's rejection quotes the plaintext, the ciphertext it was handed, and sets
    // its own `name` to the plaintext. Only a known type identity survives; nothing reachable from
    // the thrown error — message, own properties, `cause` chain — carries any of it.
    assertNothingReachable(error, [
      FAKE_API_KEY,
      `enc:${FAKE_API_KEY}`,
      "echoing decrypt failed",
      "ciphertext",
    ])
    assertEquals(error.rejectionName, "Error")
    assertEquals(error.message, "the stored secret could not be decrypted")
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

    assertNothingReachable(error, ["connection refused"])
    assertEquals(error.rejectionName, "Error")
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

    assertNothingReachable(error, ["connection refused"])
    assertEquals(error.rejectionName, "Error")
  })
})

// ── Provider normalisation: one provider, one row ────────────────────────────────────────────

describe("provider normalisation", () => {
  it("stores a provider lower-cased and finds it with any casing", async () => {
    const { store, port } = createHarness()

    await store.save(USER_ID, { provider: "OpenAI", apiKey: FAKE_API_KEY })

    assertEquals(port.rows[0].provider, "openai")
    assertEquals(await store.openSecret(USER_ID, "openai"), FAKE_API_KEY)
    assertEquals(await store.openSecret(USER_ID, "OpenAI"), FAKE_API_KEY)
    assertEquals(await store.openSecret(USER_ID, "OPENAI"), FAKE_API_KEY)
    // One read-back from `save`, then one per `openSecret` — every one of them normalised.
    assertEquals(port.findActiveCalls.map((call) => call.provider), [
      "openai",
      "openai",
      "openai",
      "openai",
    ])
  })

  it("replaces the same row when the same provider is saved in a different casing", async () => {
    const { store, port } = createHarness()

    await store.save(USER_ID, { provider: "openai", apiKey: FAKE_API_KEY })
    await store.save(USER_ID, { provider: "OpenAI", apiKey: OTHER_FAKE_API_KEY })

    assertEquals(port.upserted.length, 2)
    assertEquals(port.rows.length, 1)
    assertEquals(port.rows[0].secretEncrypted, `enc:${OTHER_FAKE_API_KEY}`)
    assertEquals((await store.list(USER_ID)).length, 1)
    assertEquals(await store.openSecret(USER_ID, "openai"), OTHER_FAKE_API_KEY)
  })

  it("removes a row stored under a different casing", async () => {
    const { store, port } = createHarness()
    await store.save(USER_ID, { provider: "openai", apiKey: FAKE_API_KEY })

    await store.remove(USER_ID, "OPENAI")

    assertEquals(port.removals, [{ userId: USER_ID, provider: "openai" }])
    assertEquals(port.rows.length, 0)
  })

  it("still rejects a provider whose shape is invalid in any casing", async () => {
    const { store } = createHarness()

    await rejectionWith(
      () => store.save(USER_ID, { provider: "OpenAI Inc", apiKey: FAKE_API_KEY }),
      UserSecretErrorCode.InvalidProvider,
    )
    await rejectionWith(
      () => store.openSecret(USER_ID, "OpenAI Inc"),
      UserSecretErrorCode.InvalidProvider,
    )
    await rejectionWith(
      () => store.remove(USER_ID, "OpenAI Inc"),
      UserSecretErrorCode.InvalidProvider,
    )
  })
})

// ── Rejection classification: identity only, never an implementation-supplied string ─────────

describe("rejection classification", () => {
  /** The plaintext key with its separators removed — the shape the old name filter let through. */
  const ALPHANUMERIC_SECRET = FAKE_API_KEY.replace(/-/g, "")
  /** 64 hex characters: a plausible key length, and alphanumeric-only. */
  const HEX_SECRET = "0123456789abcdef".repeat(4)

  /**
   * Drives the same hostile rejection through both paths the store wraps: a port rejection
   * (`PortFailure`) and a cipher rejection (`DecryptionFailed`), and returns both errors.
   */
  async function bothPaths(
    make: (context: string) => unknown,
  ): Promise<{ portError: UserSecretError; cipherError: UserSecretError }> {
    const portError = await rejectionWith(
      () =>
        createUserSecretStore({ port: new HostilePort(make), cipher: new FakeCipher() })
          .save(USER_ID, { provider: PROVIDER, apiKey: FAKE_API_KEY }),
      UserSecretErrorCode.PortFailure,
    )
    const { store, port } = createHarness(new HostileCipher(make))
    seedActiveRow(port)
    const cipherError = await rejectionWith(
      () => store.openSecret(USER_ID, PROVIDER),
      UserSecretErrorCode.DecryptionFailed,
    )
    return { portError, cipherError }
  }

  it("classifies a rejection whose name is an alphanumeric secret by type, not by name", async () => {
    const { portError, cipherError } = await bothPaths((context) =>
      hostileRejection(context, ALPHANUMERIC_SECRET)
    )

    assertEquals(portError.rejectionName, "Error")
    assertEquals(cipherError.rejectionName, "Error")
    assertNothingReachable(portError, [
      ALPHANUMERIC_SECRET,
      FAKE_API_KEY,
      `enc:${FAKE_API_KEY}`,
    ])
    assertNothingReachable(cipherError, [
      ALPHANUMERIC_SECRET,
      FAKE_API_KEY,
      `enc:${FAKE_API_KEY}`,
    ])
  })

  it("classifies a rejection whose name is a 64-character hex string by type, not by name", async () => {
    const { portError, cipherError } = await bothPaths((context) =>
      hostileRejection(context, HEX_SECRET)
    )

    assertEquals(portError.rejectionName, "Error")
    assertEquals(cipherError.rejectionName, "Error")
    assertNothingReachable(portError, [HEX_SECRET, FAKE_API_KEY, `enc:${FAKE_API_KEY}`])
    assertNothingReachable(cipherError, [HEX_SECRET, FAKE_API_KEY, `enc:${FAKE_API_KEY}`])
  })

  it("classifies a thrown non-Error by typeof and never its value", async () => {
    const stringFailure = `thrown ${FAKE_API_KEY}`
    const objectFailure = { name: FAKE_API_KEY, secret: FAKE_API_KEY }

    const stringThrown = await bothPaths(() => stringFailure)
    assertEquals(stringThrown.portError.rejectionName, "string")
    assertEquals(stringThrown.cipherError.rejectionName, "string")
    assertNothingReachable(stringThrown.portError, [FAKE_API_KEY, `enc:${FAKE_API_KEY}`])
    assertNothingReachable(stringThrown.cipherError, [FAKE_API_KEY, `enc:${FAKE_API_KEY}`])

    const objectThrown = await bothPaths(() => objectFailure)
    assertEquals(objectThrown.portError.rejectionName, "object")
    assertEquals(objectThrown.cipherError.rejectionName, "object")
    assertNothingReachable(objectThrown.portError, [FAKE_API_KEY, `enc:${FAKE_API_KEY}`])
    assertNothingReachable(objectThrown.cipherError, [FAKE_API_KEY, `enc:${FAKE_API_KEY}`])
    // Both of the thrown object's properties hold the key, so the probes above already cover it;
    // the object itself is never reachable, only its `typeof`.
    assertFalse(reachableText(objectThrown.portError).includes(FAKE_API_KEY))
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

// ── baseUrl: the outbound endpoint a user chooses ────────────────────────────────────────────

describe("baseUrl policy", () => {
  /** The destinations a caller must not be able to make the server talk to. */
  const INTERNAL_BASE_URLS = [
    "http://169.254.169.254/latest/meta-data/", // cloud metadata
    "http://127.0.0.1:6379", // a local Redis
    "http://[::1]/",
    "http://10.0.0.5/",
    "http://localhost:11434/v1", // a self-hosted model server
    "https://internal.example.com/v1", // resolves to a private address
  ]

  it("refuses an internal base URL by default", async () => {
    for (const baseUrl of INTERNAL_BASE_URLS) {
      const { store, port } = createHarness()
      const error = await rejectionWith(
        () => store.save(USER_ID, { provider: PROVIDER, apiKey: FAKE_API_KEY, baseUrl }),
        UserSecretErrorCode.InvalidBaseUrl,
      )
      // The store's own constant message, never the guard's — which names the resolver's failure
      // and the address family, and so describes this installation's network.
      assertEquals(error.message, "baseUrl is invalid")
      assertFalse(error.message.includes(baseUrl))
      assertEquals(port.rows.length, 0)
      assertEquals(port.upserted.length, 0)
    }
  })

  it("refuses credentials in a base URL, with or without the internal opt-in", async () => {
    for (const allowInternalBaseUrl of [false, true]) {
      const { store } = createHarness(new FakeCipher(), { allowInternalBaseUrl })
      for (
        const baseUrl of ["https://user:pw@api.example.com/v1", "https://user:pw@localhost/v1"]
      ) {
        await rejectionWith(
          () => store.save(USER_ID, { provider: PROVIDER, apiKey: FAKE_API_KEY, baseUrl }),
          UserSecretErrorCode.InvalidBaseUrl,
        )
      }
    }
  })

  it("refuses a base URL with no scheme, which the guard would have completed", async () => {
    // `validatePublicUrl` prepends `https://` to a scheme-less input and would accept this; the
    // store's own absolute-URL check runs first, so a caller's half-written value is not repaired.
    const { store } = createHarness()
    await rejectionWith(
      () =>
        store.save(USER_ID, {
          provider: PROVIDER,
          apiKey: FAKE_API_KEY,
          baseUrl: "api.example.com/v1",
        }),
      UserSecretErrorCode.InvalidBaseUrl,
    )
  })

  it("refuses a base URL carrying a control character", async () => {
    const { store } = createHarness()
    const withNul = `https://api.example.com/v1${String.fromCodePoint(0)}`
    const withEscape = `https://api.example.com/${String.fromCodePoint(27)}[0m`
    for (const baseUrl of [withNul, withEscape]) {
      await rejectionWith(
        () => store.save(USER_ID, { provider: PROVIDER, apiKey: FAKE_API_KEY, baseUrl }),
        UserSecretErrorCode.InvalidBaseUrl,
      )
    }
  })

  it("refuses a host the injected resolver cannot resolve", async () => {
    const { store } = createHarness()
    await rejectionWith(
      () =>
        store.save(USER_ID, {
          provider: PROVIDER,
          apiKey: FAKE_API_KEY,
          baseUrl: "https://nowhere.example/v1",
        }),
      UserSecretErrorCode.InvalidBaseUrl,
    )
  })

  it("stores a public base URL exactly as it was written", async () => {
    const { store, port } = createHarness()
    const baseUrl = "https://api.provider.example:8443/v1/"

    const summary = await store.save(USER_ID, {
      provider: PROVIDER,
      apiKey: FAKE_API_KEY,
      baseUrl,
    })

    assertEquals(summary.baseUrl, baseUrl)
    assertEquals(port.rows[0].baseUrl, baseUrl)
  })

  it("accepts an internal base URL only when the store was opted in", async () => {
    const opted = createHarness(new FakeCipher(), { allowInternalBaseUrl: true })
    const summary = await opted.store.save(USER_ID, {
      provider: PROVIDER,
      apiKey: FAKE_API_KEY,
      baseUrl: "http://localhost:11434/v1",
    })
    assertEquals(summary.baseUrl, "http://localhost:11434/v1")

    // The same value, with the option left at its default, is refused.
    const strict = createHarness()
    await rejectionWith(
      () =>
        strict.store.save(USER_ID, {
          provider: PROVIDER,
          apiKey: FAKE_API_KEY,
          baseUrl: "http://localhost:11434/v1",
        }),
      UserSecretErrorCode.InvalidBaseUrl,
    )
  })

  it("keeps refusing internal addresses when the opt-in arrives undefined", async () => {
    // A configuration value that is read but never set must not turn the guard off.
    const port = new FakePort()
    const store = createUserSecretStore({
      port,
      cipher: new FakeCipher(),
      resolver: TEST_RESOLVER,
      allowInternalBaseUrl: undefined,
    })
    await rejectionWith(
      () =>
        store.save(USER_ID, {
          provider: PROVIDER,
          apiKey: FAKE_API_KEY,
          baseUrl: "http://127.0.0.1:6379",
        }),
      UserSecretErrorCode.InvalidBaseUrl,
    )
  })

  it("still refuses a non-http scheme with the internal opt-in on", async () => {
    const { store } = createHarness(new FakeCipher(), { allowInternalBaseUrl: true })
    for (const baseUrl of ["ftp://localhost/v1", "file:///etc/passwd", "not a url"]) {
      await rejectionWith(
        () => store.save(USER_ID, { provider: PROVIDER, apiKey: FAKE_API_KEY, baseUrl }),
        UserSecretErrorCode.InvalidBaseUrl,
      )
    }
  })
})

// ── Row ownership: the port is not trusted to have filtered ──────────────────────────────────

/** A stored row for a user who is not the one asking. */
function victimRow(): StoredUserSecret {
  return {
    userId: OTHER_USER_ID,
    provider: PROVIDER,
    secretEncrypted: `enc:${OTHER_FAKE_API_KEY}`,
    keyHint: maskKey(OTHER_FAKE_API_KEY, 4),
    baseUrl: "",
    model: "",
    isActive: true,
    createdAt: "2026-01-01T00:00:00.000Z",
    updatedAt: "2026-01-01T00:00:00.000Z",
  }
}

/** A port that answers every read with one row, whatever it was asked for. */
class IndifferentPort implements UserSecretPort {
  constructor(private readonly row: StoredUserSecret) {}

  upsert(_record: StoredUserSecret): Promise<void> {
    return Promise.resolve()
  }

  listByUser(_userId: string): Promise<StoredUserSecret[]> {
    return Promise.resolve([{ ...this.row }])
  }

  findActive(_userId: string, _provider: string): Promise<StoredUserSecret | null> {
    return Promise.resolve({ ...this.row })
  }

  remove(_userId: string, _provider: string): Promise<void> {
    return Promise.resolve()
  }
}

describe("row ownership", () => {
  it("refuses to open a row that belongs to another user", async () => {
    const store = createUserSecretStore({
      port: new IndifferentPort(victimRow()),
      cipher: new FakeCipher(),
      resolver: TEST_RESOLVER,
    })

    const error = await rejectionWith(
      () => store.openSecret(USER_ID, PROVIDER),
      UserSecretErrorCode.RowMismatch,
    )

    assertEquals(error.message, "the port returned a row for a different user or provider")
    assertNothingReachable(error, [OTHER_FAKE_API_KEY, `enc:${OTHER_FAKE_API_KEY}`])
  })

  it("refuses to open a row stored under another provider", async () => {
    const row = { ...victimRow(), userId: USER_ID, provider: OTHER_PROVIDER }
    const store = createUserSecretStore({
      port: new IndifferentPort(row),
      cipher: new FakeCipher(),
      resolver: TEST_RESOLVER,
    })

    await rejectionWith(
      () => store.openSecret(USER_ID, PROVIDER),
      UserSecretErrorCode.RowMismatch,
    )
  })

  it("refuses a listing that contains another user's row", async () => {
    const store = createUserSecretStore({
      port: new IndifferentPort(victimRow()),
      cipher: new FakeCipher(),
      resolver: TEST_RESOLVER,
    })

    await rejectionWith(() => store.list(USER_ID), UserSecretErrorCode.RowMismatch)
  })

  it("refuses a save whose re-read comes back as another user's row", async () => {
    const store = createUserSecretStore({
      port: new IndifferentPort(victimRow()),
      cipher: new FakeCipher(),
      resolver: TEST_RESOLVER,
    })

    await rejectionWith(
      () => store.save(USER_ID, { provider: PROVIDER, apiKey: FAKE_API_KEY }),
      UserSecretErrorCode.RowMismatch,
    )
  })

  it("passes a matching row through untouched", async () => {
    const { store } = createHarness()
    await store.save(USER_ID, { provider: PROVIDER, apiKey: FAKE_API_KEY })
    assertEquals(await store.openSecret(USER_ID, PROVIDER), FAKE_API_KEY)
    assertEquals((await store.list(USER_ID)).length, 1)
  })
})

// ── The ciphertext is bound to its row ───────────────────────────────────────────────────────

/** Records the context the store binds each call to; otherwise it is {@link FakeCipher}. */
class ContextRecordingCipher implements SecretCipher {
  readonly encryptContexts: Array<string | undefined> = []
  readonly decryptContexts: Array<string | undefined> = []

  encrypt(plaintext: string, context?: string): Promise<string> {
    this.encryptContexts.push(context)
    return Promise.resolve(`enc:${plaintext}`)
  }

  decrypt(ciphertext: string, context?: string): Promise<string> {
    this.decryptContexts.push(context)
    return Promise.resolve(ciphertext.slice(4))
  }
}

describe("row binding", () => {
  it("binds every secret to its user and provider, on both paths", async () => {
    const cipher = new ContextRecordingCipher()
    const { store } = createHarness(cipher)

    await store.save(USER_ID, { provider: "OpenAI", apiKey: FAKE_API_KEY })
    await store.openSecret(USER_ID, PROVIDER)

    // Length-prefixed, and the provider is the normalised row key rather than what was typed.
    const expected = `user-secret:v1:${USER_ID.length}:${USER_ID}:${PROVIDER.length}:${PROVIDER}`
    assertEquals(cipher.encryptContexts, [expected])
    assertEquals(cipher.decryptContexts, [expected])
  })

  it("does not open a real ciphertext that was copied into another row", async () => {
    const cipher = new CryptoService("test-secret-not-real-0123456789abcdef")
    const victimPort = new FakePort()
    const victimStore = createUserSecretStore({ port: victimPort, cipher, resolver: TEST_RESOLVER })
    await victimStore.save(OTHER_USER_ID, { provider: PROVIDER, apiKey: FAKE_API_KEY })
    const stolen = victimPort.rows[0].secretEncrypted

    // The same blob, filed under a different user and provider — the shape of a copied row or a
    // mixed-up restore.
    const attackerPort = new FakePort()
    attackerPort.seed({
      ...victimPort.rows[0],
      userId: USER_ID,
      provider: OTHER_PROVIDER,
      secretEncrypted: stolen,
    })
    const attackerStore = createUserSecretStore({
      port: attackerPort,
      cipher,
      resolver: TEST_RESOLVER,
    })

    const error = await rejectionWith(
      () => attackerStore.openSecret(USER_ID, OTHER_PROVIDER),
      UserSecretErrorCode.DecryptionFailed,
    )
    assertEquals(error.rejectionName, "CryptoError")
    assertNothingReachable(error, [FAKE_API_KEY, stolen])

    // The row it was written for still opens.
    assertEquals(await victimStore.openSecret(OTHER_USER_ID, PROVIDER), FAKE_API_KEY)
  })
})
