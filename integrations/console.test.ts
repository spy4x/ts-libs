/**
 * The negation test: **no client writes to the console, on any path.**
 *
 * Every other suite checks console silence locally, inside a single test, which
 * leaves a blind spot: a `console.error` restored in a branch that test does
 * not drive stays green. That is exactly how a restored 4xx `console.error` in
 * `mailchimp.ts` survived a green suite — no test exercised that branch while
 * capturing the console. (Mailchimp and Slack are gone, #68; this file now
 * drives the two clients that took their place.)
 *
 * This file drives every path of both clients under one capture:
 * `NtfyClient.push` (delivered, below-gate skip, 4xx, 5xx-then-retry, transport
 * throw) and `HealthchecksClient.ping` (delivered, 4xx, 5xx-then-retry,
 * transport throw).
 *
 * The retry core is covered by `retry.test.ts`, which is pure and logs nothing
 * by construction.
 */

import type { HealthchecksClient as HealthchecksClientType } from "./healthchecks.ts"
import type { NtfyClient as NtfyClientType } from "./ntfy.ts"

/**
 * Installed before the modules are imported.
 *
 * A static `import` is hoisted above any code in this file, so an import-time
 * hook is impossible with one; `await import()` is the only way. Afterwards the
 * hook stays installed for the lifetime of this file, which is what makes the
 * call-time capture below work — and it means this file must be its own
 * process, which `deno test` guarantees per module.
 */
const captured: string[] = []
const record = (kind: string) => (...args: unknown[]) => {
  captured.push(`${kind}: ${args.map((arg) => String(arg)).join(" ")}`)
}

console.log = record("log")
console.error = record("error")
console.warn = record("warn")
console.info = record("info")
console.debug = record("debug")

/** Proves the hook is live rather than inert, before anything else is measured. */
const SENTINEL = "console.test.ts liveness sentinel"
console.error(SENTINEL)
const hookWasLive = captured.includes(`error: ${SENTINEL}`)

const { NtfyClient: NtfyClientValue, NotificationSeverity } = await import("./ntfy.ts")
const { HealthchecksClient: HealthchecksClientValue, HealthchecksOutcome } = await import(
  "./healthchecks.ts"
)

const NtfyClient = NtfyClientValue as typeof NtfyClientType
const HealthchecksClient = HealthchecksClientValue as typeof HealthchecksClientType

const { describe, it } = await import("@std/testing/bdd")
const { expect } = await import("@std/expect")

const NTFY_BASE_URL = "https://ntfy.invalid"
const NTFY_TOPIC = "test-topic-not-real"
const HEALTHCHECKS_PING_URL = "https://hc-ping.invalid/test-check-not-real"

/** A fetch that replays a queue and repeats the last entry. */
const replay = (queue: Array<[number, string]>) => {
  let index = 0
  return (() => {
    const [status, body] = queue[Math.min(index, queue.length - 1)]
    index++
    return Promise.resolve(new Response(body, { status }))
  }) as typeof fetch
}

/** Runs `body` and returns everything it logged. */
const logged = async (body: () => Promise<void>): Promise<string[]> => {
  captured.length = 0
  await body()
  return [...captured]
}

describe("console silence on every client path", () => {
  it("proves the capture hook is installed and live", () => {
    // Without this, an inert hook would make every assertion below pass by
    // capturing nothing at all.
    expect(hookWasLive).toBe(true)
  })

  it("logs nothing for an ntfy push: delivered, below-gate, 4xx and a transport throw", async () => {
    const messages = await logged(async () => {
      const delivered = new NtfyClient(
        { baseUrl: NTFY_BASE_URL, topic: NTFY_TOPIC, token: "test-token-not-real" },
        { fetcher: replay([[200, ""]]) },
      )
      await delivered.push({
        title: "backup failed",
        message: "detail",
        severity: NotificationSeverity.Failure,
      })

      const belowGate = new NtfyClient(
        { baseUrl: NTFY_BASE_URL, topic: NTFY_TOPIC },
        { fetcher: replay([[200, ""]]) },
      )
      await belowGate.push({
        title: "backup finished",
        message: "detail",
        severity: NotificationSeverity.Info,
      })

      // The branch that hid a restored console.error in the removed clients: a
      // permanent 4xx from the provider.
      const rejected = new NtfyClient(
        { baseUrl: NTFY_BASE_URL, topic: NTFY_TOPIC },
        { fetcher: replay([[400, ""]]), retry: { maxAttempts: 1 } },
      )
      await rejected.push({
        title: "backup failed",
        message: "detail",
        severity: NotificationSeverity.Failure,
      })

      const thrown = new NtfyClient(
        { baseUrl: NTFY_BASE_URL, topic: NTFY_TOPIC },
        {
          fetcher: (() =>
            Promise.reject(new TypeError("Invalid URL: 'https://x/'"))) as typeof fetch,
          retry: { maxAttempts: 1 },
        },
      )
      await thrown.notifyFailure("backup failed", "detail")
    })
    expect(messages).toEqual([])
  })

  it("logs nothing for an ntfy push retried past a transient 5xx", async () => {
    const messages = await logged(async () => {
      const retried = new NtfyClient(
        { baseUrl: NTFY_BASE_URL, topic: NTFY_TOPIC },
        {
          fetcher: replay([[503, ""], [200, ""]]),
          retry: { maxAttempts: 2, baseDelayMs: 1, maxDelayMs: 1 },
          sleep: () => Promise.resolve(),
        },
      )
      await retried.push({
        title: "backup failed",
        message: "detail",
        severity: NotificationSeverity.Failure,
      })
    })
    expect(messages).toEqual([])
  })

  it("logs nothing for a healthchecks ping: delivered, 4xx and a transport throw", async () => {
    const messages = await logged(async () => {
      const delivered = new HealthchecksClient(
        { pingUrl: HEALTHCHECKS_PING_URL },
        { fetcher: replay([[200, ""]]) },
      )
      await delivered.ping({ outcome: HealthchecksOutcome.Success })

      const rejected = new HealthchecksClient(
        { pingUrl: HEALTHCHECKS_PING_URL },
        { fetcher: replay([[400, ""]]), retry: { maxAttempts: 1 } },
      )
      await rejected.ping({ outcome: HealthchecksOutcome.Fail })

      const thrown = new HealthchecksClient(
        { pingUrl: HEALTHCHECKS_PING_URL },
        {
          fetcher: (() =>
            Promise.reject(new TypeError("Invalid URL: 'https://x/'"))) as typeof fetch,
          retry: { maxAttempts: 1 },
        },
      )
      await thrown.ping({ outcome: HealthchecksOutcome.Start })
    })
    expect(messages).toEqual([])
  })

  it("logs nothing for a healthchecks ping retried past a transient 5xx", async () => {
    const messages = await logged(async () => {
      const retried = new HealthchecksClient(
        { pingUrl: HEALTHCHECKS_PING_URL },
        {
          fetcher: replay([[500, ""], [200, ""]]),
          retry: { maxAttempts: 2, baseDelayMs: 1, maxDelayMs: 1 },
          sleep: () => Promise.resolve(),
        },
      )
      await retried.ping({ outcome: HealthchecksOutcome.Success })
    })
    expect(messages).toEqual([])
  })
})
