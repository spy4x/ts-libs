import { expect } from "@std/expect"
import { describe, it } from "@std/testing/bdd"
import {
  HealthchecksClient,
  healthchecksConfigFromEnv,
  HealthchecksOutcome,
} from "./healthchecks.ts"
import type { Clock, Sleeper } from "./retry.ts"

const PING_URL = "https://hc-ping.example.invalid/00000000-0000-0000-0000-000000000000"

interface RecordedRequest {
  url: string
  method: string | undefined
  body: string | undefined
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

const clientFor = (responses: FakeResponse[], overrides: { pingUrl?: string } = {}) => {
  const transport = fakeTransport(responses)
  const timer = recordingTimer()
  const client = new HealthchecksClient({ pingUrl: overrides.pingUrl ?? PING_URL }, {
    fetcher: transport.fetcher,
    sleep: timer.sleep,
    clock: timer.clock,
  })
  return { client, transport, timer }
}

describe("healthchecksConfigFromEnv", () => {
  it("reads the ping URL", () => {
    expect(
      healthchecksConfigFromEnv((
        name,
      ) => (name === "HEALTHCHECKS_PING_URL" ? PING_URL : undefined)),
    )
      .toEqual({ pingUrl: PING_URL })
  })

  it("returns null when the variable is absent or blank", () => {
    expect(healthchecksConfigFromEnv(() => undefined)).toBeNull()
    expect(healthchecksConfigFromEnv(() => "  ")).toBeNull()
  })
})

describe("HealthchecksClient construction", () => {
  it("refuses an empty ping URL instead of retrying into nothing", () => {
    expect(() => new HealthchecksClient({ pingUrl: "" })).toThrow("pingUrl is empty")
  })
})

describe("HealthchecksClient.urlFor", () => {
  it("pings the base URL for success and the documented suffixes otherwise", () => {
    const { client } = clientFor([{ status: 200 }])
    expect(client.urlFor(HealthchecksOutcome.Success)).toBe(PING_URL)
    expect(client.urlFor(HealthchecksOutcome.Fail)).toBe(`${PING_URL}/fail`)
    expect(client.urlFor(HealthchecksOutcome.Start)).toBe(`${PING_URL}/start`)
  })

  it("strips a trailing slash before building a suffix path", () => {
    const { client } = clientFor([{ status: 200 }], { pingUrl: `${PING_URL}/` })
    expect(client.urlFor(HealthchecksOutcome.Fail)).toBe(`${PING_URL}/fail`)
  })
})

describe("HealthchecksClient.ping", () => {
  it("posts a success ping without a suffix and reports the status", async () => {
    const { client, transport } = clientFor([{ status: 200 }])
    const result = await client.ping({ outcome: HealthchecksOutcome.Success, body: "job done" })
    expect(result).toEqual({
      ok: true,
      httpStatus: 200,
      attempts: 1,
      body: "job done",
      waitedMs: 0,
    })
    expect(transport.requests[0].url).toBe(PING_URL)
    expect(transport.requests[0].method).toBe("POST")
    expect(transport.requests[0].body).toBe("job done")
  })

  it("posts a failure ping to the /fail endpoint", async () => {
    const { client, transport } = clientFor([{ status: 200 }])
    await client.ping({ outcome: HealthchecksOutcome.Fail, body: "3 of 5 failed" })
    expect(transport.requests[0].url).toBe(`${PING_URL}/fail`)
  })

  it("posts a start ping to the /start endpoint", async () => {
    const { client, transport } = clientFor([{ status: 200 }])
    await client.ping({ outcome: HealthchecksOutcome.Start })
    expect(transport.requests[0].url).toBe(`${PING_URL}/start`)
    expect(transport.requests[0].body).toBe("")
  })

  it("retries a transient 500 ten times with 60s doubling, capped per wait", async () => {
    const { client, transport, timer } = clientFor([{ status: 500 }])
    const result = await client.ping({ outcome: HealthchecksOutcome.Success })
    expect(result.ok).toBe(false)
    expect(result.ok === false && result.status).toBe(500)
    expect(result.ok === false && result.message).toBe("500")
    expect(result.ok === false && result.attempts).toBe(10)
    expect(transport.requests.length).toBe(10)
    // The prose in ops/README.md quotes a total. Assert it from the schedule
    // itself so the two cannot drift apart again.
    const waitedMs = result.ok === false ? result.waitedMs : 0
    expect(waitedMs).toBe(2_220_000)
    expect(waitedMs / 60_000).toBe(37)
    expect(timer.delays).toEqual([
      60_000,
      120_000,
      240_000,
      300_000,
      300_000,
      300_000,
      300_000,
      300_000,
      300_000,
    ])
  })

  it("needs 65 minutes across 9 retries if the per-wait cap were 10 minutes", async () => {
    // The comparison figure quoted in `ops/README.md` and `policy.ts`. It was
    // prose only; asserting it is what makes "both figures are asserted" true
    // rather than an overclaim about this suite's own coverage.
    const transport = fakeTransport([{ status: 500 }])
    const timer = recordingTimer()
    const client = new HealthchecksClient({ pingUrl: PING_URL }, {
      fetcher: transport.fetcher,
      sleep: timer.sleep,
      clock: timer.clock,
      retry: {
        maxAttempts: 10,
        baseDelayMs: 60_000,
        maxDelayMs: 600_000,
        totalBudgetMs: 4_500_000,
      },
    })
    const result = await client.ping({ outcome: HealthchecksOutcome.Success })
    const waitedMs = result.ok === false ? result.waitedMs : 0
    expect(timer.delays).toEqual([
      60_000,
      120_000,
      240_000,
      480_000,
      600_000,
      600_000,
      600_000,
      600_000,
      600_000,
    ])
    expect(waitedMs).toBe(3_900_000)
    expect(waitedMs / 60_000).toBe(65)
    expect(result.ok === false && result.attempts).toBe(10)
  })

  it("recovers on the second attempt of a transient failure", async () => {
    const { client, transport, timer } = clientFor([{ status: 503 }, { status: 200 }])
    const result = await client.ping({ outcome: HealthchecksOutcome.Fail })
    expect(result).toEqual({ ok: true, httpStatus: 200, attempts: 2, body: "", waitedMs: 60_000 })
    expect(transport.requests.length).toBe(2)
    expect(timer.delays).toEqual([60_000])
  })

  it("honours Retry-After instead of the computed backoff", async () => {
    const { client, timer } = clientFor([
      { status: 429, headers: { "Retry-After": "30" } },
      { status: 200 },
    ])
    const result = await client.ping({ outcome: HealthchecksOutcome.Success })
    expect(result.ok).toBe(true)
    expect(timer.delays).toEqual([30_000])
  })

  it("stops at the total budget instead of retrying past it", async () => {
    const transport = fakeTransport([{ status: 500 }])
    const timer = recordingTimer()
    const client = new HealthchecksClient({ pingUrl: PING_URL }, {
      fetcher: transport.fetcher,
      sleep: timer.sleep,
      clock: timer.clock,
      retry: { maxAttempts: 10, baseDelayMs: 60_000, maxDelayMs: 600_000, totalBudgetMs: 100_000 },
    })
    const result = await client.ping({ outcome: HealthchecksOutcome.Success })
    expect(result.ok).toBe(false)
    expect(result.ok === false && result.attempts).toBe(2)
    expect(timer.delays).toEqual([60_000])
  })

  it("does not retry a 4xx that a retry cannot fix", async () => {
    const { client, transport } = clientFor([{ status: 404 }])
    const result = await client.ping({ outcome: HealthchecksOutcome.Success })
    expect(result.ok).toBe(false)
    expect(result.ok === false && result.attempts).toBe(1)
    expect(transport.requests.length).toBe(1)
  })

  it("reports a transport throw as a network_error rather than swallowing it", async () => {
    const timer = recordingTimer()
    let calls = 0
    const client = new HealthchecksClient({ pingUrl: PING_URL }, {
      fetcher: () => {
        calls++
        // What a real transport failure looks like: the URL carries the check's
        // capability key in its path.
        return Promise.reject(new Error(`Invalid URL: '${PING_URL}/fail'`))
      },
      sleep: timer.sleep,
      clock: timer.clock,
      retry: { maxAttempts: 2, baseDelayMs: 10, maxDelayMs: 10, totalBudgetMs: 1000 },
    })
    const result = await client.ping({ outcome: HealthchecksOutcome.Fail })
    expect(calls).toBe(2)
    expect(result).toEqual({
      ok: false,
      code: "network_error",
      message: "transport failure (url withheld)",
      attempts: 2,
      waitedMs: 10,
    })
  })

  it("writes nothing to the console on success or failure", async () => {
    const messages: unknown[] = []
    const originalError = console.error
    const originalLog = console.log
    console.error = (...args: unknown[]) => void messages.push(args)
    console.log = (...args: unknown[]) => void messages.push(args)
    try {
      await clientFor([{ status: 200 }]).client.ping({ outcome: HealthchecksOutcome.Success })
      await clientFor([{ status: 404 }]).client.ping({ outcome: HealthchecksOutcome.Success })
    } finally {
      console.error = originalError
      console.log = originalLog
    }
    expect(messages).toEqual([])
  })
})
