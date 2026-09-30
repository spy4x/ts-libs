import { assertEquals, assertRejects } from "@std/assert"
import { describe, it } from "@std/testing/bdd"
import {
  CONSUME_SCRIPT,
  createRedisRateLimitStore,
  type RateLimitRedisScriptStore,
  READ_SCRIPT,
  RELEASE_SCRIPT,
  WRITE_SCRIPT,
} from "./redis-rate-limit-store.ts"

interface EvalCall {
  script: string
  keys: string[]
  args: Array<string | number>
}

/** Fake that records what reaches Redis and answers every `eval` with `reply`. */
function fakeStore(reply: unknown): {
  store: RateLimitRedisScriptStore
  evals: EvalCall[]
  deleted: string[]
} {
  const evals: EvalCall[] = []
  const deleted: string[] = []
  const store: RateLimitRedisScriptStore = {
    eval: (script, keys, args = []) => {
      evals.push({ script, keys, args })
      return Promise.resolve(reply)
    },
    del: (key) => {
      deleted.push(key)
      return Promise.resolve()
    },
  }
  return { store, evals, deleted }
}

describe("createRedisRateLimitStore", () => {
  it("sends the cutoff, now, window, limit and a fresh id to the consume script", async () => {
    const { store, evals } = fakeStore([1, "a", "1000"])
    let n = 0
    const limiter = createRedisRateLimitStore(store, { newId: () => `id${++n}` })
    await limiter.consume!(`ip:1`, 5000, 2000, 3)
    await limiter.consume!(`ip:1`, 5000, 2000, 3)
    assertEquals(evals[0], {
      script: CONSUME_SCRIPT,
      keys: [`ratelimit-atomic:ip:1`],
      args: [3000, 5000, 2000, 3, `id1`],
    })
    assertEquals(evals[1].args[4], `id2`)
  })

  it("parses an allowed reply into the window, oldest first", async () => {
    const { store } = fakeStore([1, "x", "1000", "y", "1500", "z", "5000"])
    const result = await createRedisRateLimitStore(store).consume!(`k`, 5000, 9000, 3)
    assertEquals(result, { allowed: true, events: [1000, 1500, 5000] })
  })

  it("parses a rejected reply as not allowed with the current window", async () => {
    const { store } = fakeStore([0, "x", "4000", "y", "4500"])
    const result = await createRedisRateLimitStore(store).consume!(`k`, 5000, 9000, 2)
    assertEquals(result, { allowed: false, events: [4000, 4500] })
  })

  it("uses the key prefix option in every key", async () => {
    const { store, evals, deleted } = fakeStore([])
    const limiter = createRedisRateLimitStore(store, { keyPrefix: `login` })
    await limiter.read(`a`)
    await limiter.delete(`a`)
    assertEquals(evals[0].keys, [`login:a`])
    assertEquals(deleted, [`login:a`])
  })

  it("reads an empty reply as an absent key and a full reply as timestamps", async () => {
    assertEquals(await createRedisRateLimitStore(fakeStore([]).store).read(`k`), undefined)
    const { store, evals } = fakeStore([`a`, `10`, `b`, `20`])
    assertEquals(await createRedisRateLimitStore(store).read(`k`), [10, 20])
    assertEquals(evals[0].script, READ_SCRIPT)
  })

  it("writes the expiry first, then every timestamp, rounding a fractional expiry up", async () => {
    const { store, evals } = fakeStore(1)
    await createRedisRateLimitStore(store).write(`k`, [10, 20], 20, 1500.2)
    assertEquals(evals[0], {
      script: WRITE_SCRIPT,
      keys: [`ratelimit-atomic:k`],
      args: [1501, 10, 20],
    })
  })

  it("falls back to a 1 ms expiry when the ttl is not positive", async () => {
    const { store, evals } = fakeStore(1)
    await createRedisRateLimitStore(store).write(`k`, [10], 10, 0)
    assertEquals(evals[0].args, [1, 10])
  })

  it("refuses a non-finite argument before it reaches Redis", async () => {
    const { store, evals } = fakeStore([1])
    const limiter = createRedisRateLimitStore(store)
    await assertRejects(() => limiter.consume!(`k`, NaN, 1000, 1), RangeError)
    await assertRejects(() => limiter.consume!(`k`, 1, Infinity, 1), RangeError)
    await assertRejects(() => limiter.consume!(`k`, 1, 1000, NaN), RangeError)
    await assertRejects(() => limiter.write(`k`, [NaN], 1, 1000), RangeError)
    assertEquals(evals.length, 0)
  })

  it("throws TypeError on a reply that is not the script's shape", async () => {
    for (const reply of [null, 7, `OK`, [2], [`1`]]) {
      const limiter = createRedisRateLimitStore(fakeStore(reply).store)
      await assertRejects(() => limiter.consume!(`k`, 1, 1000, 1), TypeError)
    }
    await assertRejects(() => createRedisRateLimitStore(fakeStore(5).store).read(`k`), TypeError)
    await assertRejects(
      () => createRedisRateLimitStore(fakeStore([0, `m`, `abc`]).store).consume!(`k`, 1, 1000, 1),
      TypeError,
    )
  })

  it("passes a Redis error through unchanged", async () => {
    const boom = new Error(`WRONGTYPE`)
    const store: RateLimitRedisScriptStore = {
      eval: () => Promise.reject(boom),
      del: () => Promise.resolve(),
    }
    await assertRejects(
      () => createRedisRateLimitStore(store).consume!(`k`, 1, 1000, 1),
      Error,
      `WRONGTYPE`,
    )
  })

  it("releases with the timestamp when given and with no argument for the newest", async () => {
    const { store, evals } = fakeStore(1)
    const limiter = createRedisRateLimitStore(store)
    await limiter.release!(`k`, 4200)
    await limiter.release!(`k`)
    assertEquals(evals[0], { script: RELEASE_SCRIPT, keys: [`ratelimit-atomic:k`], args: [4200] })
    assertEquals(evals[1].args, [])
    await assertRejects(() => limiter.release!(`k`, NaN), RangeError)
  })
})
