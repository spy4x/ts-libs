import { expect } from "@std/expect"
import { describe, it } from "@std/testing/bdd"
import { SlackClient, slackConfigFromEnv } from "./slack.ts"
import type { Clock, Sleeper } from "./retry.ts"

const WEBHOOK = "https://hooks.slack.invalid/services/T000/B000/fake-not-a-token"

/**
 * An `Error` whose `name` getter throws the text the platform throws — URL and
 * all. `name` is a writable property on `Error`, so a caller's payload can hand
 * `JSON.stringify` an error like this one, and every unguarded read of
 * `cause.name` becomes an escape route for that text.
 */
const hostileError = (url: string): Error =>
  new (class extends Error {
    override get name(): string {
      throw new TypeError(`Invalid URL: '${url}'`)
    }
  })("boom")

/**
 * An `Error` whose `name` is not a string at all, which the `string`
 * declaration on `Error.name` does not prevent — the property is writable. A
 * `Symbol` throws inside a template literal and so does a `toString`.
 */
const errorWithRawName = (value: unknown): Error => {
  const error = new Error("boom")
  Object.defineProperty(error, "name", { value })
  return error
}

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

  it("returns a result, never a rejection, when the thrown error's name getter throws", async () => {
    // The verifier's reproduction. `describeErrorKind` read `cause.name` without
    // a guard, and `name` is not a data property: this error's getter throws,
    // so the read propagated out of `send` and the caller got a rejected
    // promise where the signature and the docstring promise a `SlackResult`.
    // `hostileError` reads the token out of the webhook URL and puts it in the
    // getter's message, so an unguarded read also forwards the credential.
    const client = new SlackClient({
      // The token sits in the path, which is where a webhook credential lives,
      // so an unguarded read has a real secret to forward.
      webhookUrl: `https://hooks.slack.example.invalid/services/T000/B000/${"REALTOKENISH"}`,
      // The webhook URL above is only a label here: `send` never reaches the
      // transport, so nothing is fetched and no request is recorded.
    }, {
      fetcher: () => Promise.reject(new Error("this test never sends a request")),
      retry: { maxAttempts: 1 },
    })
    const result = await client.send({
      toJSON: () => {
        throw hostileError(`https://hooks.slack.example.invalid/services/T000/B000/REALTOKENISH`)
      },
    })
    expect(result).toEqual({
      ok: false,
      code: "invalid_payload",
      message: "payload is not JSON-serialisable (Error)",
      attempts: 0,
    })
    expect(JSON.stringify(result)).not.toContain("REALTOKENISH")
    // The class is still named when the error is an ordinary one, so the guard
    // above is not "refuse everything".
    const ordinary = await client.send({
      toJSON: () => {
        throw new TypeError("boom")
      },
    })
    expect(ordinary.ok === false && ordinary.message).toBe(
      "payload is not JSON-serialisable (TypeError)",
    )
  })

  it("does not report a caller-set error name as the error class", async () => {
    // `name` is writable, so it is caller text, not a platform constant: a
    // payload that throws `e` after `name = "REALTOKENISH"` used to put those 12
    // caller-chosen characters into a returned, loggable result. A closed
    // allowlist of platform classes is what makes the reported kind safe.
    const client = new SlackClient({ webhookUrl: WEBHOOK }, {
      fetcher: () => Promise.reject(new Error("this test never sends a request")),
      retry: { maxAttempts: 1 },
    })
    const forgedName = () => {
      const error = new TypeError("boom")
      Object.defineProperty(error, "name", { value: "REALTOKENISH" })
      return error
    }
    // An enumerable getter, not `toJSON`: when `JSON.stringify` calls a `toJSON`
    // that throws, the spec says the result is `undefined` rather than a
    // propagation, and `send` reads that as a payload that serialised to
    // nothing. A getter's throw escapes `stringify` and reaches the catch.
    const spelled = await client.send({
      get boom() {
        throw forgedName()
      },
    })
    expect(spelled.ok === false && spelled.message).toBe(
      "payload is not JSON-serialisable (Error)",
    )
    // A URL-shaped name is refused too — it was before this change and still is.
    const urlShaped = () => {
      const error = new TypeError("boom")
      Object.defineProperty(error, "name", {
        value: "https://hooks.slack.invalid/T/B/REALTOKENISH",
      })
      return error
    }
    const shaped = await client.send({
      get boom() {
        throw urlShaped()
      },
    })
    expect(shaped.ok === false && shaped.message).toBe("payload is not JSON-serialisable (Error)")
    expect(JSON.stringify([spelled, shaped])).not.toContain("REALTOKENISH")
  })

  it("does not reject when a transport error's name getter throws", async () => {
    // The same unguarded read, on the transport path: `describeTransportError`
    // read `cause.name` too. A `fetch` that rejects with such an error used to
    // reject `send` instead of returning a `network_error` result.
    const timer = recordingTimer()
    const client = new SlackClient({
      webhookUrl: `https://hooks.slack.example.invalid/services/T000/B000/${"REALTOKENISH"}`,
    }, {
      fetcher: () =>
        Promise.reject(
          hostileError("https://hooks.slack.example.invalid/services/T000/B000/REALTOKENISH"),
        ),
      sleep: timer.sleep,
      clock: timer.clock,
      retry: { maxAttempts: 1 },
    })
    const result = await client.send({ text: "hello" })
    expect(result).toEqual({
      ok: false,
      code: "network_error",
      message: "transport failure (url withheld)",
      attempts: 1,
    })
    expect(JSON.stringify(result)).not.toContain("REALTOKENISH")
  })

  it("does not reject when a transport error's name is a Symbol", async () => {
    // The getter above cannot throw any more, but the *value* was still
    // unvalidated: `${name}` on a Symbol throws `TypeError: Cannot convert a
    // Symbol value to a string`, so `send` rejected from inside its own
    // description helper instead of returning a `network_error`.
    const timer = recordingTimer()
    const client = new SlackClient({ webhookUrl: WEBHOOK }, {
      fetcher: () => Promise.reject(errorWithRawName(Symbol("not a string"))),
      sleep: timer.sleep,
      clock: timer.clock,
      retry: { maxAttempts: 1 },
    })
    const result = await client.send({ text: "hello" })
    expect(result).toEqual({
      ok: false,
      code: "network_error",
      message: "transport failure (url withheld)",
      attempts: 1,
    })
  })

  it("does not reject when a transport error's name has a throwing toString", async () => {
    // Interpolating this name runs the caller's `toString`, whose text would
    // then have reached a returned, loggable result.
    const timer = recordingTimer()
    const client = new SlackClient({ webhookUrl: WEBHOOK }, {
      fetcher: () =>
        Promise.reject(
          errorWithRawName({
            toString() {
              throw new Error("caller text")
            },
          }),
        ),
      sleep: timer.sleep,
      clock: timer.clock,
      retry: { maxAttempts: 1 },
    })
    const result = await client.send({ text: "hello" })
    expect(result).toEqual({
      ok: false,
      code: "network_error",
      message: "transport failure (url withheld)",
      attempts: 1,
    })
    expect(JSON.stringify(result)).not.toContain("caller text")
  })

  it("keeps a stringifiable but non-string transport name out of the result", async () => {
    // `null` and `42` stringify, so an unvalidated read interpolated them into
    // the message. A non-string is refused instead of coerced.
    const timer = recordingTimer()
    for (const rawName of [null, 42]) {
      const client = new SlackClient({ webhookUrl: WEBHOOK }, {
        fetcher: () => Promise.reject(errorWithRawName(rawName)),
        sleep: timer.sleep,
        clock: timer.clock,
        retry: { maxAttempts: 1 },
      })
      const result = await client.send({ text: "hello" })
      expect(result.ok === false && result.message).toBe("transport failure (url withheld)")
    }
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
