/**
 * The negation test: **no client writes to the console, on any path.**
 *
 * Every other suite checks console silence locally, inside a single test, which
 * leaves a blind spot: a `console.error` restored in a branch that test does
 * not drive stays green. That is exactly how a restored 4xx `console.error` in
 * `mailchimp.ts` survived a green suite — no test exercised that branch while
 * capturing the console.
 *
 * This file drives every path of both clients under one capture:
 * `putContact` (upsert, API rejection, disabled skip, empty address),
 * `searchContact` (hit, 404 miss, unexpected 5xx, transport throw) and
 * `SlackClient.send` (2xx, 4xx, 5xx, transport throw, invalid payload).
 *
 * The retry core is covered by `retry.test.ts`, which is pure and logs nothing
 * by construction.
 */

import type { MailchimpClient as MailchimpClientType } from "./mailchimp.ts"
import type { SlackClient as SlackClientType } from "./slack.ts"

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

const { SlackClient: SlackClientValue } = await import("./slack.ts")
const { MailchimpClient: MailchimpClientValue } = await import("./mailchimp.ts")

const SlackClient = SlackClientValue as typeof SlackClientType
const MailchimpClient = MailchimpClientValue as typeof MailchimpClientType

const { describe, it } = await import("@std/testing/bdd")
const { expect } = await import("@std/expect")

const WEBHOOK = "https://hooks.slack.invalid/services/T000/B000/test-token-not-real"
const CONFIG = {
  apiKey: "test-key-not-real",
  username: "test-user-not-real",
  listId: "test-list-not-real",
  serverPrefix: "example",
}

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

  it("logs nothing for a Mailchimp upsert, a rejection, a skip and an empty address", async () => {
    const messages = await logged(async () => {
      const created = new MailchimpClient(CONFIG, {
        fetcher: replay([[404, '{"title":"Resource Not Found"}'], [200, '{"status":"pending"}']]),
      })
      await created.putContact({ email: "member@example.invalid", firstName: "A" })

      const updated = new MailchimpClient(CONFIG, {
        fetcher: replay([[200, '{"status":"subscribed"}'], [200, '{"status":"subscribed"}']]),
      })
      await updated.putContact({ email: "member@example.invalid" })

      // The branch that hid a restored console.error: a 4xx from the API.
      const rejected = new MailchimpClient(CONFIG, {
        fetcher: replay([[400, '{"title":"Invalid Resource"}']]),
        retry: { maxAttempts: 1 },
      })
      await rejected.putContact({ email: "member@example.invalid" })

      const racy = new MailchimpClient(CONFIG, {
        fetcher: replay([
          [404, '{"title":"Resource Not Found"}'],
          [400, '{"title":"Member Exists"}'],
          [200, '{"status":"subscribed"}'],
        ]),
      })
      await racy.putContact({ email: "member@example.invalid" })

      const disabled = new MailchimpClient(CONFIG, { fetcher: replay([[200, "{}"]]) })
      disabled.skipDisabled("missing_credentials")

      await disabled.putContact({ email: "   " })
    })
    expect(messages).toEqual([])
  })

  it("logs nothing for a Mailchimp lookup hit, miss, 5xx and transport throw", async () => {
    const messages = await logged(async () => {
      const hit = new MailchimpClient(CONFIG, {
        fetcher: replay([[200, '{"status":"subscribed"}']]),
      })
      await hit.searchContact("member@example.invalid")

      const miss = new MailchimpClient(CONFIG, {
        fetcher: replay([[404, '{"title":"Resource Not Found"}']]),
      })
      await miss.searchContact("member@example.invalid")

      const serverError = new MailchimpClient(CONFIG, {
        fetcher: replay([[500, '{"title":"Internal Server Error"}']]),
        retry: { maxAttempts: 2, baseDelayMs: 1, maxDelayMs: 1 },
        sleep: () => Promise.resolve(),
      })
      await serverError.searchContact("member@example.invalid")

      const thrown = new MailchimpClient(CONFIG, {
        fetcher: (() => Promise.reject(new TypeError("Invalid URL: 'https://x/'"))) as typeof fetch,
        retry: { maxAttempts: 1 },
      })
      await thrown.searchContact("member@example.invalid")

      const readOnly = new MailchimpClient(CONFIG, {
        fetcher: replay([[200, "{}"]]),
        readOnly: true,
      })
      await readOnly.putContact({ email: "member@example.invalid" })
    })
    expect(messages).toEqual([])
  })

  it("logs nothing for a Slack 2xx, 4xx, 5xx, transport throw or invalid payload", async () => {
    const messages = await logged(async () => {
      const accepted = new SlackClient({ webhookUrl: WEBHOOK }, {
        fetcher: replay([[200, "ok"]]),
      })
      await accepted.send({ text: "hello" })

      const rejected = new SlackClient({ webhookUrl: WEBHOOK }, {
        fetcher: replay([[404, "invalid_token"]]),
      })
      await rejected.send({ text: "hello" })

      const serverError = new SlackClient({ webhookUrl: WEBHOOK }, {
        fetcher: replay([[500, "server error"]]),
        sleep: () => Promise.resolve(),
        retry: { maxAttempts: 2, baseDelayMs: 1, maxDelayMs: 1 },
      })
      await serverError.send({ text: "hello" })

      const thrown = new SlackClient({ webhookUrl: WEBHOOK }, {
        fetcher: (() => Promise.reject(new TypeError("Invalid URL: 'https://x/'"))) as typeof fetch,
        retry: { maxAttempts: 1 },
      })
      await thrown.send({ text: "hello" })

      await accepted.send(undefined)
    })
    expect(messages).toEqual([])
  })
})
