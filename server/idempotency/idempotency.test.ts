import { expect } from "@std/expect"
import { describe, it } from "@std/testing/bdd"
import type { Command } from "@spy4x/platform/cqrs"
import { MemoryIdempotencyStore } from "./memory.ts"
import {
  type BeginOutcome,
  createIdempotencyMiddleware,
  fingerprint,
  type IdempotencyClaim,
  IdempotencyError,
  isIdempotencyKey,
} from "./idempotency.ts"

interface RenamePayload {
  actor: { userId: number }
  name: string
  requestId?: string
  idempotencyKey?: string
}

class RenameCommand implements Command<RenamePayload, { name: string; at: Date }> {
  constructor(public data: RenamePayload) {}
}

/** A memory store that records the calls the middleware makes, so a test can see them. */
class SpyStore extends MemoryIdempotencyStore {
  begun: string[] = []
  released: string[] = []

  override begin(claim: IdempotencyClaim): Promise<BeginOutcome> {
    this.begun.push(`${claim.userId}:${claim.key}`)
    return super.begin(claim)
  }

  override release(userId: number, key: string): Promise<void> {
    this.released.push(`${userId}:${key}`)
    return super.release(userId, key)
  }
}

function deferred<T>() {
  let resolve!: (value: T) => void
  const promise = new Promise<T>((done) => {
    resolve = done
  })
  return { promise, resolve }
}

/** The error a call is refused with; fails the test when the call succeeds. */
async function refusal(call: Promise<unknown>): Promise<IdempotencyError> {
  try {
    await call
  } catch (error) {
    if (error instanceof IdempotencyError) return error
    throw error
  }
  throw new Error("the call was expected to be refused")
}

function command(overrides: Partial<RenamePayload> = {}): RenameCommand {
  return new RenameCommand({
    actor: { userId: 7 },
    name: "Team",
    idempotencyKey: "k1",
    ...overrides,
  })
}

describe("idempotency middleware", () => {
  it("runs a command once per key and returns the first result on a repeat", async () => {
    const store = new SpyStore()
    const run = createIdempotencyMiddleware({ store })
    let runs = 0
    const next = () =>
      Promise.resolve({ name: "Team", at: new Date(`2026-10-0${++runs}T00:00:00Z`) })

    const first = await run(command(), next)
    const second = await run(command({ requestId: "another-request" }), next)

    expect(runs).toBe(1)
    expect(second).toEqual(JSON.parse(JSON.stringify(first)))
  })

  it("passes a command without a key straight through", async () => {
    const store = new SpyStore()
    const run = createIdempotencyMiddleware({ store })
    let runs = 0
    const next = () => Promise.resolve(++runs)

    await run(command({ idempotencyKey: undefined }), next)
    await run(command({ idempotencyKey: undefined }), next)

    expect(runs).toBe(2)
    expect(store.begun.length).toBe(0)
  })

  it("keeps two users' identical keys apart", async () => {
    const run = createIdempotencyMiddleware({ store: new SpyStore() })
    let runs = 0
    const next = () => Promise.resolve(++runs)

    await run(command({ actor: { userId: 1 } }), next)
    await run(command({ actor: { userId: 2 } }), next)

    expect(runs).toBe(2)
  })

  it("refuses a key reused for different input", async () => {
    const run = createIdempotencyMiddleware({ store: new SpyStore() })
    await run(command(), () => Promise.resolve("first"))

    const error = await refusal(run(command({ name: "Other" }), () => Promise.resolve("second")))

    expect(error).toBeInstanceOf(IdempotencyError)
    expect(error.code).toBe("KEY_REUSED")
  })

  it("makes a repeat that arrives mid-run wait for the first result instead of running twice", async () => {
    const store = new SpyStore()
    const finishFirst = deferred<string>()
    let polls = 0
    const run = createIdempotencyMiddleware({
      store,
      sleep: () => {
        polls++
        if (polls === 2) finishFirst.resolve("first result")
        return Promise.resolve()
      },
    })
    let runs = 0

    const first = run(command(), () => {
      runs++
      return finishFirst.promise
    })
    const repeat = run(command(), () => {
      runs++
      return Promise.resolve("second result")
    })

    expect(await repeat).toBe("first result")
    expect(await first).toBe("first result")
    expect(runs).toBe(1)
  })

  it("fails a repeat with IN_PROGRESS when the first run outlives the wait", async () => {
    const store = new SpyStore()
    const never = deferred<string>()
    const run = createIdempotencyMiddleware({
      store,
      waitMs: 300,
      pollMs: 100,
      sleep: () => Promise.resolve(),
    })
    const first = run(command(), () => never.promise)

    const error = await refusal(run(command(), () => Promise.resolve("second")))

    expect(error).toBeInstanceOf(IdempotencyError)
    expect(error.code).toBe("IN_PROGRESS")
    never.resolve("done")
    await first
  })

  it("releases the key when the command throws so a retry runs it again", async () => {
    const store = new SpyStore()
    const run = createIdempotencyMiddleware({ store })

    await expect(run(command(), () => Promise.reject(new Error("db down")))).rejects.toThrow(
      "db down",
    )
    const retried = await run(command(), () => Promise.resolve("recovered"))

    expect(retried).toBe("recovered")
    expect(store.released).toEqual(["7:k1"])
  })

  it("refuses a malformed key before it reaches the store", async () => {
    const store = new SpyStore()
    const run = createIdempotencyMiddleware({ store })

    const error = await refusal(
      run(command({ idempotencyKey: "has space" }), () => Promise.resolve(1)),
    )

    expect(error).toBeInstanceOf(IdempotencyError)
    expect(error.code).toBe("INVALID_KEY")
    expect(store.begun.length).toBe(0)
  })

  it("refuses a key from a caller who is not signed in", async () => {
    const store = new SpyStore()
    const run = createIdempotencyMiddleware({ store })
    const anonymous = new RenameCommand({ name: "Team", idempotencyKey: "k1" } as RenamePayload)

    const error = await refusal(run(anonymous, () => Promise.resolve(1)))

    expect(error.code).toBe("INVALID_KEY")
    expect(store.begun.length).toBe(0)
  })
})

describe("fingerprint", () => {
  it("ignores who asked and how, and the order of the input's keys", async () => {
    const one = await fingerprint("RenameCommand", {
      actor: { userId: 1 },
      requestId: "a",
      idempotencyKey: "k",
      name: "Team",
      tags: { b: 1, a: 2 },
    })
    const two = await fingerprint("RenameCommand", {
      tags: { a: 2, b: 1 },
      name: "Team",
      requestId: "b",
      idempotencyKey: "other",
      actor: { userId: 2 },
    })
    expect(one).toBe(two)
  })

  it("differs when the input or the command differs", async () => {
    const base = await fingerprint("RenameCommand", { name: "Team" })
    expect(await fingerprint("RenameCommand", { name: "Other" })).not.toBe(base)
    expect(await fingerprint("DeleteCommand", { name: "Team" })).not.toBe(base)
  })
})

describe("isIdempotencyKey", () => {
  it("accepts 1 to 128 printable characters and nothing else", () => {
    expect(isIdempotencyKey("a".repeat(128))).toBe(true)
    expect(isIdempotencyKey("a".repeat(129))).toBe(false)
    expect(isIdempotencyKey("")).toBe(false)
    expect(isIdempotencyKey("a b")).toBe(false)
    expect(isIdempotencyKey(42)).toBe(false)
  })
})
