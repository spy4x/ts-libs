import { expect } from "@std/expect"
import { describe, it } from "@std/testing/bdd"
import { NotificationSeverity, NtfyClient, ntfyConfigFromEnv, NtfyPriority } from "./ntfy.ts"
import { createAsciiHeaders } from "./header-safety.ts"
import type { Clock, Sleeper } from "./retry.ts"

const BASE_URL = "https://ntfy.example.invalid"
const TOPIC = "test-topic-not-real"
const TOKEN = "test-token-not-real"
const ENDPOINT = `${BASE_URL}/${TOPIC}`

interface RecordedRequest {
  url: string
  method: string | undefined
  body: string | undefined
  contentType: string | null
  headers: Headers
}

interface FakeResponse {
  status: number
  headers?: Record<string, string>
}

const fakeTransport = (responses: FakeResponse[]) => {
  const requests: RecordedRequest[] = []
  let index = 0
  const fetcher: typeof fetch = (input, init) => {
    requests.push({
      url: String(input),
      method: init?.method,
      body: typeof init?.body === "string" ? init.body : undefined,
      contentType: new Headers(init?.headers).get("Content-Type"),
      headers: new Headers(init?.headers),
    })
    const response = responses[Math.min(index, responses.length - 1)]
    index++
    return Promise.resolve(new Response("", { status: response.status, headers: response.headers }))
  }
  return { fetcher, requests }
}

const recordingTimer = () => {
  const delays: number[] = []
  let now = 0
  const clock: Clock = () => now
  const sleep: Sleeper = (ms) => {
    delays.push(ms)
    now += ms
    return Promise.resolve()
  }
  return { delays, clock, sleep }
}

const clientFor = (
  responses: FakeResponse[],
  overrides: { noToken?: boolean; gate?: NotificationSeverity } = {},
) => {
  const transport = fakeTransport(responses)
  const timer = recordingTimer()
  const client = new NtfyClient(
    {
      baseUrl: BASE_URL,
      topic: TOPIC,
      ...(overrides.noToken ? {} : { token: TOKEN }),
    },
    {
      fetcher: transport.fetcher,
      sleep: timer.sleep,
      clock: timer.clock,
      gate: overrides.gate,
    },
  )
  return { client, transport, timer }
}

describe("ntfyConfigFromEnv", () => {
  it("reads URL, topic and token", () => {
    const env: Record<string, string> = { NTFY_URL: BASE_URL, NTFY_TOPIC: TOPIC, NTFY_TOKEN: TOKEN }
    expect(ntfyConfigFromEnv((name) => env[name])).toEqual({
      baseUrl: BASE_URL,
      topic: TOPIC,
      token: TOKEN,
    })
  })

  it("treats the token as optional for an unauthenticated self-hosted ntfy", () => {
    const env: Record<string, string> = { NTFY_URL: BASE_URL, NTFY_TOPIC: TOPIC }
    expect(ntfyConfigFromEnv((name) => env[name])).toEqual({ baseUrl: BASE_URL, topic: TOPIC })
  })

  it("returns null when the URL or topic is missing", () => {
    expect(ntfyConfigFromEnv(() => undefined)).toBeNull()
    expect(ntfyConfigFromEnv((name) => (name === "NTFY_URL" ? BASE_URL : undefined))).toBeNull()
  })
})

describe("NtfyClient construction", () => {
  it("refuses an empty base URL", () => {
    expect(() => new NtfyClient({ baseUrl: "", topic: TOPIC })).toThrow("baseUrl is empty")
  })

  it("refuses an empty topic", () => {
    expect(() => new NtfyClient({ baseUrl: BASE_URL, topic: "  " })).toThrow("topic is empty")
  })

  it("refuses a base URL the platform cannot parse, rather than pushing into nothing", () => {
    // Before the guard all four of these constructed, reached fetch with the
    // malformed URL, and reported `network_error` — a misconfiguration
    // indistinguishable from a provider outage.
    for (const baseUrl of ["ntfy.example.invalid", "not a url at all", "https://", "//x"]) {
      expect({
        baseUrl,
        throws: (() => {
          try {
            new NtfyClient({ baseUrl, topic: TOPIC })
            return false
          } catch {
            return true
          }
        })(),
      }).toEqual({ baseUrl, throws: true })
      // The platform agrees it is unparseable, so the guard is not generous.
      expect({ baseUrl, parseable: URL.canParse(baseUrl) }).toEqual({ baseUrl, parseable: false })
    }
  })

  it("does not echo the base URL into the rejection it throws", () => {
    // The path is a credential position, so the message names the shape problem.
    for (const bad of [`ntfy.example.invalid/${"REALTOKENISH"}`, `://${"REALTOKENISH"}`]) {
      let message = "did not throw"
      try {
        new NtfyClient({ baseUrl: bad, topic: TOPIC })
      } catch (cause) {
        message = cause instanceof Error ? cause.message : String(cause)
      }
      expect({ bad, leaks: message.includes("REALTOKENISH") }).toEqual({ bad, leaks: false })
      expect({ bad, useful: message.includes("not a valid absolute URL") }).toEqual({
        bad,
        useful: true,
      })
    }
  })

  it("still accepts a well-formed base URL, so the guard is not unconditional", () => {
    expect(() => new NtfyClient({ baseUrl: BASE_URL, topic: TOPIC })).not.toThrow()
    expect(() => new NtfyClient({ baseUrl: `${BASE_URL}/`, topic: TOPIC })).not.toThrow()
    expect(() => new NtfyClient({ baseUrl: "http://127.0.0.1:2586", topic: TOPIC })).not.toThrow()
  })

  it("normalises the endpoint and encodes the topic", () => {
    const client = new NtfyClient({ baseUrl: `${BASE_URL}/`, topic: "my topic" })
    expect(client.endpoint).toBe(`${BASE_URL}/my%20topic`)
  })
})

describe("NtfyClient.push", () => {
  it("pushes a failure with the bearer token and reports the headers as sent", async () => {
    const { client, transport } = clientFor([{ status: 200 }])
    const result = await client.push({
      title: "backup failed",
      message: "3 of 5 repositories failed",
      severity: NotificationSeverity.Failure,
      priority: NtfyPriority.High,
      tags: ["warning", "backup"],
    })
    expect(result.ok).toBe(true)
    expect(result.status).toBe("pushed")
    expect(result.ok && result.status === "pushed" && result.httpStatus).toBe(200)
    // The result carries the two fields a caller may need, not the whole header
    // map. Returning the map also returned `authorization: "Bearer <token>"`,
    // which put the credential into any log line that printed a result.
    expect(result.ok && result.status === "pushed" && result.title).toBe("backup failed")
    expect(result.ok && result.status === "pushed" && result.tags).toBe("warning,backup")
    expect(transport.requests[0].url).toBe(ENDPOINT)
    expect(transport.requests[0].method).toBe("POST")
    expect(transport.requests[0].body).toBe("3 of 5 repositories failed")
  })

  it("never puts the bearer token in a result, while still sending it", async () => {
    const { client, transport } = clientFor([{ status: 200 }])
    const result = await client.push({
      title: "backup failed",
      message: "detail",
      severity: NotificationSeverity.Failure,
    })
    const serialised = JSON.stringify(result)
    expect(serialised).not.toContain(TOKEN)
    expect(serialised).not.toContain("Bearer")
    expect(serialised.toLowerCase()).not.toContain("authorization")
    // ...and the credential still reaches the wire, so this is not a test that
    // passes by the auth header never being set.
    expect(transport.requests[0].headers.get("Authorization")).toBe(`Bearer ${TOKEN}`)
  })

  it("omits the Authorization header when no token is configured", async () => {
    const { client, transport } = clientFor([{ status: 200 }], { noToken: true })
    const result = await client.push({
      title: "backup failed",
      message: "detail",
      severity: NotificationSeverity.Failure,
    })
    expect(result.ok).toBe(true)
    expect(transport.requests[0].headers.get("Authorization")).toBeNull()
  })

  it("skips an informational push under the default failure gate, without a request", async () => {
    const { client, transport } = clientFor([{ status: 200 }])
    const result = await client.push({
      title: "all good",
      message: "backup finished",
      severity: NotificationSeverity.Info,
    })
    expect(result).toEqual({ ok: true, status: "skipped", reason: "below-gate", attempts: 0 })
    expect(transport.requests).toEqual([])
  })

  it("pushes an informational message when the caller opts in", async () => {
    const { client } = clientFor([{ status: 200 }], { gate: NotificationSeverity.Info })
    const result = await client.push({
      title: "all good",
      message: "backup finished",
      severity: NotificationSeverity.Info,
    })
    expect(result.ok).toBe(true)
    expect(result.status).toBe("pushed")
  })

  it("retries a 500 and reports how many attempts it took", async () => {
    const { client, transport, timer } = clientFor([{ status: 500 }, { status: 200 }])
    const result = await client.push({
      title: "backup failed",
      message: "detail",
      severity: NotificationSeverity.Failure,
    })
    expect(result.ok).toBe(true)
    expect(result.ok && result.status === "pushed" && result.attempts).toBe(2)
    expect(transport.requests.length).toBe(2)
    expect(timer.delays).toEqual([3000])
  })

  it("gives up after the attempt cap on a persistent 500", async () => {
    const { client, transport } = clientFor([{ status: 500 }])
    const result = await client.push({
      title: "backup failed",
      message: "detail",
      severity: NotificationSeverity.Failure,
    })
    expect(result.ok).toBe(false)
    expect(result.ok === false && result.status).toBe(500)
    expect(result.ok === false && result.attempts).toBe(5)
    expect(transport.requests.length).toBe(5)
  })

  it("asks the injected timer for Retry-After seconds, not the 3s default", async () => {
    const { client, timer } = clientFor([
      { status: 429, headers: { "Retry-After": "2" } },
      { status: 200 },
    ])
    const result = await client.push({
      title: "backup failed",
      message: "detail",
      severity: NotificationSeverity.Failure,
    })
    expect(result.ok).toBe(true)
    expect(timer.delays).toEqual([2000])
  })

  it("does not retry a 403 that a retry cannot fix", async () => {
    const { client, transport } = clientFor([{ status: 403 }])
    const result = await client.push({
      title: "backup failed",
      message: "detail",
      severity: NotificationSeverity.Failure,
    })
    expect(result.ok).toBe(false)
    expect(result.ok === false && result.attempts).toBe(1)
    expect(transport.requests.length).toBe(1)
  })

  it("reports a transport throw as a network_error without echoing the URL", async () => {
    const timer = recordingTimer()
    // The platform's real shape: `fetch` puts the whole URL — whose path can
    // carry the token — into the error text.
    const client = new NtfyClient({ baseUrl: BASE_URL, topic: TOPIC }, {
      fetcher: () => Promise.reject(new TypeError(`Invalid URL: '${ENDPOINT}'`)),
      sleep: timer.sleep,
      clock: timer.clock,
      retry: { maxAttempts: 2, baseDelayMs: 10, maxDelayMs: 10, totalBudgetMs: 1000 },
    })
    const result = await client.push({
      title: "backup failed",
      message: "detail",
      severity: NotificationSeverity.Failure,
    })
    expect(result).toEqual({
      ok: false,
      code: "network_error",
      message: "TypeError: transport failure (url withheld)",
      attempts: 2,
    })
  })

  it("writes nothing to the console on success, skip or failure", async () => {
    const messages: unknown[] = []
    const originalError = console.error
    const originalLog = console.log
    console.error = (...args: unknown[]) => void messages.push(args)
    console.log = (...args: unknown[]) => void messages.push(args)
    try {
      const push = {
        title: "backup failed",
        message: "Detail: ok",
        severity: NotificationSeverity.Failure,
      }
      await clientFor([{ status: 200 }]).client.push(push)
      await clientFor([{ status: 200 }]).client.push({
        ...push,
        severity: NotificationSeverity.Info,
      })
      await clientFor([{ status: 500 }]).client.push(push)
    } finally {
      console.error = originalError
      console.log = originalLog
    }
    expect(messages).toEqual([])
  })
})

describe("NtfyClient.notifyFailure", () => {
  it("pushes with the failure severity", async () => {
    const { client, transport } = clientFor([{ status: 200 }])
    const result = await client.notifyFailure("backup failed", "detail")
    expect(result.ok).toBe(true)
    expect(transport.requests[0].headers.get("Title")).toBe("backup failed")
    expect(transport.requests[0].body).toBe("detail")
  })
})

describe("NtfyClient non-ASCII handling", () => {
  const hostileTitle =
    "Backup Caf\u00e9 \u0411\u0430\u043A\u0430\u043F \u30d0\u30c3\u30af\u30a2\u30c3\u30d7 \u2705 \u2014 done\u2026"

  it("sends a Latin-1, Cyrillic, CJK and emoji title without a ByteString error", async () => {
    const { client, transport } = clientFor([{ status: 200 }])
    const result = await client.push({
      title: hostileTitle,
      message: "body",
      severity: NotificationSeverity.Failure,
    })
    expect(result.ok).toBe(true)
    expect(transport.requests.length).toBe(1)
  })

  it("emits an ASCII-safe title header", async () => {
    const { client, transport } = clientFor([{ status: 200 }])
    await client.push({
      title: hostileTitle,
      message: "body",
      severity: NotificationSeverity.Failure,
    })
    const title = transport.requests[0].headers.get("Title") ?? ""
    // deno-lint-ignore no-control-regex
    expect(/^[\x09\x0A\x0D\x20-\x7E]*$/.test(title)).toBe(true)
    expect(title).toBe("Backup Caf? ????? ?????? ? - done...")
  })

  it("leaves the message body as UTF-8, transliterating only the header", async () => {
    const { client, transport } = clientFor([{ status: 200 }])
    const message =
      "Caf\u00e9 \u0411\u0430\u043A\u0430\u043F \u30d0\u30c3\u30af\u30a2\u30c3\u30d7 \u2705 \u2014 fine\u2026"
    await client.push({ title: "ascii", message, severity: NotificationSeverity.Failure })
    expect(transport.requests[0].body).toBe(message)
    expect(transport.requests[0].body).not.toContain("?")
  })

  it("transliterates non-ASCII tags, which are also a header", async () => {
    const { client, transport } = clientFor([{ status: 200 }])
    await client.push({
      title: "ascii",
      message: "body",
      severity: NotificationSeverity.Failure,
      tags: ["warn\u00efng", "\u2705"],
    })
    expect(transport.requests[0].headers.get("Tags")).toBe("warn?ng,?")
  })

  it("leaves no header above U+007F, which is what the platform rejects", () => {
    const headers = createAsciiHeaders({ Title: "Caf\u00e9 \u2705 \u0411\u0430\u043A\u0430\u043F" })
    const title = headers.get("Title") ?? ""
    // deno-lint-ignore no-control-regex
    expect(/^[\x09\x0A\x0D\x20-\x7E]*$/.test(title)).toBe(true)
  })
})
