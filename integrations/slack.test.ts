import { expect } from "@std/expect"
import { describe, it } from "@std/testing/bdd"
import { SlackClient, slackConfigFromEnv } from "./slack.ts"
import type { Clock, Sleeper } from "./retry.ts"

const WEBHOOK = "https://hooks.slack.invalid/services/T000/B000/fake-not-a-token"

interface RecordedRequest {
  url: string
  method: string | undefined
  body: string | undefined
}

interface FakeTransport {
  fetcher: typeof fetch
  requests: RecordedRequest[]
}

interface FakeResponse {
  status: number
  body?: string
  headers?: Record<string, string>
}

/** A `fetch` that replays queued responses and records what it was asked to send. */
const fakeTransport = (responses: FakeResponse[]): FakeTransport => {
  const requests: RecordedRequest[] = []
  let index = 0
  const fetcher: typeof fetch = (input, init) => {
    requests.push({
      url: String(input),
      method: init?.method,
      body: typeof init?.body === "string" ? init.body : undefined,
    })
    const response = responses[Math.min(index, responses.length - 1)]
    index++
    return Promise.resolve(
      new Response(response.body ?? "", {
        status: response.status,
        headers: response.headers,
      }),
    )
  }
  return { fetcher, requests }
}

interface Timer {
  sleep: Sleeper
  delays: number[]
}

/** Records the requested delays and moves a manual clock so budgets are measured. */
const recordingTimer = (): Timer & { clock: Clock; advanceBy: (ms: number) => void } => {
  const delays: number[] = []
  let now = 0
  return {
    delays,
    clock: () => now,
    advanceBy: (ms: number) => {
      now += ms
    },
    sleep: (ms: number): Promise<void> => {
      delays.push(ms)
      now += ms
      return Promise.resolve()
    },
  }
}

const clientFor = (responses: FakeResponse[], extra: { maxAttempts?: number } = {}) => {
  const transport = fakeTransport(responses)
  const timer = recordingTimer()
  const client = new SlackClient({ webhookUrl: WEBHOOK }, {
    fetcher: transport.fetcher,
    sleep: timer.sleep,
    clock: timer.clock,
    retry: {
      maxAttempts: extra.maxAttempts ?? 3,
      baseDelayMs: 500,
      maxDelayMs: 4000,
      jitterRatio: 0,
    },
  })
  return { client, transport, timer }
}

describe("slackConfigFromEnv", () => {
  it("returns a config when the webhook variable is set", () => {
    expect(slackConfigFromEnv((name) => (name === "SLACK_WEBHOOK_URL" ? WEBHOOK : undefined)))
      .toEqual({ webhookUrl: WEBHOOK })
  })

  it("returns null when the variable is absent or blank, without throwing", () => {
    expect(slackConfigFromEnv(() => undefined)).toBeNull()
    expect(slackConfigFromEnv(() => "   ")).toBeNull()
  })
})

describe("SlackClient construction", () => {
  it("refuses an empty webhook URL instead of failing silently on first send", () => {
    expect(() => new SlackClient({ webhookUrl: "" })).toThrow("webhookUrl is empty")
  })
})

describe("SlackClient.send", () => {
  it("reports the HTTP status of an accepted webhook", async () => {
    const { client, transport } = clientFor([{ status: 200, body: "ok" }])
    const result = await client.send({ text: "hello" })
    expect(result).toEqual({ ok: true, httpStatus: 200, attempts: 1 })
    expect(transport.requests[0].method).toBe("POST")
    expect(transport.requests[0].body).toBe('{"text":"hello"}')
  })

  it("returns a structured failure carrying the status for a non-2xx webhook", async () => {
    const { client } = clientFor([{ status: 404, body: "invalid_token" }])
    const result = await client.send({ text: "hello" })
    expect(result).toEqual({
      ok: false,
      code: "http_error",
      message: "404",
      status: 404,
      responseBody: "invalid_token",
      attempts: 1,
    })
  })

  it("keeps the reason Slack returned for a malformed payload", async () => {
    const { client } = clientFor([{ status: 400, body: "invalid_payload" }])
    const result = await client.send({ blocks: [] })
    expect(result.ok).toBe(false)
    expect(result.ok === false && result.responseBody).toBe("invalid_payload")
  })

  it("gives up after the attempt cap on a persistent 500", async () => {
    const { client, transport, timer } = clientFor([{ status: 500 }])
    const result = await client.send({ text: "hello" })
    expect(result.ok).toBe(false)
    expect(result.ok === false && result.status).toBe(500)
    expect(result.ok === false && result.attempts).toBe(3)
    expect(transport.requests.length).toBe(3)
    expect(timer.delays).toEqual([500, 1000])
  })

  it("recovers when the second attempt succeeds, in exactly two attempts", async () => {
    const { client, transport } = clientFor([{ status: 500 }, { status: 200, body: "ok" }])
    const result = await client.send({ text: "hello" })
    expect(result).toEqual({ ok: true, httpStatus: 200, attempts: 2 })
    expect(transport.requests.length).toBe(2)
  })

  it("asks the injected timer for Retry-After seconds, not the computed backoff", async () => {
    const { client, timer } = clientFor([
      { status: 429, headers: { "Retry-After": "2" } },
      { status: 200, body: "ok" },
    ])
    const result = await client.send({ text: "hello" })
    expect(result.ok).toBe(true)
    expect(timer.delays).toEqual([2000])
  })

  it("does not retry a 4xx that a retry cannot fix", async () => {
    const { client, transport } = clientFor([{ status: 403, body: "no_service" }])
    const result = await client.send({ text: "hello" })
    expect(result.ok).toBe(false)
    expect(result.ok === false && result.attempts).toBe(1)
    expect(transport.requests.length).toBe(1)
  })

  it("reports a transport throw as a network_error after retrying", async () => {
    let calls = 0
    const timer = recordingTimer()
    const client = new SlackClient({ webhookUrl: WEBHOOK }, {
      fetcher: () => {
        calls++
        return Promise.reject(new Error("connection refused"))
      },
      sleep: timer.sleep,
      clock: timer.clock,
      retry: { maxAttempts: 2, baseDelayMs: 10, maxDelayMs: 10, jitterRatio: 0 },
    })
    const result = await client.send({ text: "hello" })
    expect(calls).toBe(2)
    expect(result.ok).toBe(false)
    expect(result.ok === false && result.code).toBe("network_error")
    expect(result.ok === false && result.status).toBeUndefined()
  })

  it("never returns the webhook URL, so the token in it cannot leak", async () => {
    // What the platform actually throws for a malformed webhook: the whole URL,
    // whose path segment IS the credential. Returning `cause.message` returned
    // it, and the obvious things a caller does with a failure result — log it,
    // render it, paste it into an issue — then published the token.
    const tokenish = "REALTOKENISH"
    const timer = recordingTimer()
    const client = new SlackClient({
      webhookUrl: `https://hooks.slack.example.invalid/services/T000/B000/${tokenish}`,
    }, {
      fetcher: () =>
        Promise.reject(
          new TypeError(
            `Invalid URL: 'https://hooks.slack.example.invalid/services/T000/B000/${tokenish}'`,
          ),
        ),
      sleep: timer.sleep,
      clock: timer.clock,
      retry: { maxAttempts: 1 },
    })
    const result = await client.send({ text: "hello" })
    expect(result.ok).toBe(false)
    expect(result.ok === false && result.code).toBe("network_error")
    const serialised = JSON.stringify(result)
    expect(serialised).not.toContain(tokenish)
    expect(serialised).not.toContain("hooks.slack.example.invalid")
    // ...and the failure is still diagnosable.
    expect(result.ok === false && result.message).toBe(
      "TypeError: transport failure (url withheld)",
    )
  })

  it("rejects an undefined payload without calling the network", async () => {
    const { client, transport } = clientFor([{ status: 200 }])
    const result = await client.send(undefined)
    expect(result).toEqual({
      ok: false,
      code: "invalid_payload",
      message: "payload is undefined",
      attempts: 0,
    })
    expect(transport.requests.length).toBe(0)
  })

  it("passes a domain payload through untouched", async () => {
    const { client, transport } = clientFor([{ status: 200, body: "ok" }])
    const blocks = { blocks: [{ type: "section", text: { type: "mrkdwn", text: "*new user*" } }] }
    await client.send(blocks)
    expect(JSON.parse(transport.requests[0].body ?? "")).toEqual(blocks)
  })

  it("writes nothing to the console on success or failure", async () => {
    const messages: unknown[] = []
    const originalError = console.error
    const originalLog = console.log
    console.error = (...args: unknown[]) => void messages.push(args)
    console.log = (...args: unknown[]) => void messages.push(args)
    try {
      const ok = clientFor([{ status: 200, body: "ok" }])
      await ok.client.send({ text: "hello" })
      const failed = clientFor([{ status: 404, body: "invalid_token" }])
      await failed.client.send({ text: "hello" })
    } finally {
      console.error = originalError
      console.log = originalLog
    }
    expect(messages).toEqual([])
  })
})
