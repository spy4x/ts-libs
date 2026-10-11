import { expect } from "@std/expect"
import { Hono } from "hono"
import type { ProbeTimer } from "../healthcheck.ts"
import { createHealthHandler, type HealthReport } from "./health.ts"

const NOW = 1_700_000_000_000

/** The status and the report of one call. */
async function ask(handler: () => Promise<Response>): Promise<[number, HealthReport]> {
  const response = await handler()
  return [response.status, await response.json()]
}

/** A timer that fires only when the test says so, so no test waits on a real deadline. */
function manualTimer(): ProbeTimer & { fire(): void; pending(): number } {
  const handlers = new Map<number, () => void>()
  let next = 1
  return {
    setTimer(handler) {
      handlers.set(next, handler)
      return next++
    },
    clearTimer: (handle) => void handlers.delete(handle),
    fire() {
      for (const [handle, handler] of [...handlers]) {
        handlers.delete(handle)
        handler()
      }
    },
    pending: () => handlers.size,
  }
}

Deno.test("answers 200 ok and names every check when all pass", async () => {
  const handler = createHealthHandler({
    required: { database: () => Promise.resolve(true) },
    optional: { cache: () => true },
    now: () => NOW,
  })

  const response = await handler()

  expect(response.status).toBe(200)
  expect(response.headers.get("content-type")).toBe("application/json")
  expect(response.headers.get("cache-control")).toBe("no-store")
  expect(await response.json()).toEqual({
    status: "ok",
    checks: { database: true, cache: true },
    date: NOW,
  })
})

Deno.test("answers 503 down when a required check fails, whatever the optional ones say", async () => {
  const handler = createHealthHandler({
    required: { database: () => false, queue: () => true },
    optional: { cache: () => true },
    now: () => NOW,
  })

  expect(await ask(handler)).toEqual([503, {
    status: "down",
    checks: { database: false, queue: true, cache: true },
    date: NOW,
  }])
})

Deno.test("stays 200 and says degraded when only an optional check fails", async () => {
  const handler = createHealthHandler({
    required: { database: () => true },
    optional: { cache: () => false },
    now: () => NOW,
  })

  expect(await ask(handler)).toEqual([200, {
    status: "degraded",
    checks: { database: true, cache: false },
    date: NOW,
  }])
})

Deno.test("a check that throws or rejects has failed, and its message stays out of the answer", async () => {
  const handler = createHealthHandler({
    required: {
      throws: () => {
        throw new Error("connect to db.internal:5432 refused")
      },
    },
    optional: { rejects: () => Promise.reject(new Error("redis password wrong")) },
    now: () => NOW,
  })

  const response = await handler()
  const text = await response.text()

  expect(response.status).toBe(503)
  expect(JSON.parse(text).checks).toEqual({ throws: false, rejects: false })
  expect(text).not.toContain("db.internal")
  expect(text).not.toContain("password")
})

Deno.test("a check passes only when it resolves exactly true", async () => {
  const answers: unknown[] = [1, "ok", {}, null, undefined]
  for (const answer of answers) {
    const handler = createHealthHandler({ required: { database: () => answer as boolean } })
    const [status, report] = await ask(handler)
    expect(status).toBe(503)
    expect(report.checks.database).toBe(false)
  }
})

Deno.test("a check that never answers fails at the deadline and the others still report", async () => {
  const timer = manualTimer()
  const handler = createHealthHandler({
    required: { database: () => new Promise<boolean>(() => {}) },
    optional: { cache: () => true },
    timeoutMs: 50,
    timer,
    now: () => NOW,
  })

  const answer = ask(handler)
  // Let the checks start, then let the deadline of the one that is still open pass.
  await new Promise<void>((resolve) => queueMicrotask(resolve))
  await Promise.resolve()
  timer.fire()

  expect(await answer).toEqual([503, {
    status: "down",
    checks: { database: false, cache: true },
    date: NOW,
  }])
  expect(timer.pending()).toBe(0)
})

Deno.test("runs the checks at the same time, and again on every call", async () => {
  let running = 0
  let most = 0
  let calls = 0
  const check = async () => {
    calls++
    most = Math.max(most, ++running)
    await Promise.resolve()
    running--
    return true
  }
  const handler = createHealthHandler({ required: { a: check, b: check }, optional: { c: check } })

  await handler()
  await handler()

  expect(most).toBe(3)
  expect(calls).toBe(6)
})

Deno.test("serves as a Hono route and as a plain request handler", async () => {
  const handler = createHealthHandler({ required: { database: () => true }, now: () => NOW })
  const app = new Hono().get("/health", () => handler())
  const plain: (request: Request) => Promise<Response> = handler

  const routed = await app.request("/health")
  const direct = await plain(new Request("http://example.test/health"))

  expect(routed.status).toBe(200)
  expect(await routed.json()).toEqual(await direct.json())
})

Deno.test("refuses a name that is both required and optional, a check that is no function and a bad deadline", () => {
  expect(() =>
    createHealthHandler({ required: { cache: () => true }, optional: { cache: () => true } })
  ).toThrow(RangeError)
  expect(() => createHealthHandler({ required: { database: true as unknown as () => boolean } }))
    .toThrow(TypeError)
  for (const timeoutMs of [0, -1, Number.NaN, Number.POSITIVE_INFINITY]) {
    expect(() => createHealthHandler({ timeoutMs })).toThrow(RangeError)
  }
})
