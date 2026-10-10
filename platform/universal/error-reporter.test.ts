import { expect } from "@std/expect"
import { describe, it } from "@std/testing/bdd"
import {
  createErrorReporter,
  type ErrorReporterOptions,
  parseDsn,
  scrubUrl,
} from "./error-reporter.ts"

const DSN = "https://abc123@errors.example.com/7"

interface Sent {
  url: string
  init: RequestInit
}

/** A reporter whose `fetch` records every call; `status` is what the tracker answers. */
function setup(options: Partial<ErrorReporterOptions> = {}, status = 200) {
  const sent: Sent[] = []
  const fetcher = ((url: string, init: RequestInit) => {
    sent.push({ url, init })
    return Promise.resolve(new Response("{}", { status }))
  }) as unknown as typeof fetch
  const reporter = createErrorReporter({ dsn: DSN, fetch: fetcher, ...options })
  return { sent, reporter }
}

/** The event of the single envelope sent: the third line of Sentry's envelope format. */
// deno-lint-ignore no-explicit-any
function eventOf(sent: Sent): Record<string, any> {
  return JSON.parse(String(sent.init.body).split("\n")[2])
}

describe("parseDsn", () => {
  it("builds the envelope endpoint and keeps the public key", () => {
    expect(parseDsn(DSN)).toEqual({
      endpoint: "https://errors.example.com/api/7/envelope/",
      publicKey: "abc123",
    })
  })

  it("keeps a path prefix of the DSN", () => {
    expect(parseDsn("https://k@example.com/glitch/3")?.endpoint).toBe(
      "https://example.com/glitch/api/3/envelope/",
    )
  })

  it("refuses an empty, keyless, projectless or malformed DSN", () => {
    for (const bad of [undefined, "", "not a url", "https://errors.example.com/7", "https://k@h"]) {
      expect(parseDsn(bad), String(bad)).toBeNull()
    }
  })
})

describe("an error reporter without a DSN", () => {
  it("makes no request when reporting or when an event fires", async () => {
    const calls: unknown[] = []
    const target = new EventTarget()
    for (const dsn of [undefined, "", "garbage"]) {
      const reporter = createErrorReporter({
        dsn,
        fetch: ((...args: unknown[]) => {
          calls.push(args)
          return Promise.resolve(new Response())
        }) as typeof fetch,
      })
      reporter.install(target)

      expect(reporter.enabled).toBe(false)
      expect(await reporter.report(new Error("boom"))).toBe(false)
    }
    target.dispatchEvent(Object.assign(new Event("error"), { error: new Error("boom") }))
    await Promise.resolve()

    expect(calls).toEqual([])
  })
})

describe("an error report", () => {
  it("posts a Sentry envelope with the exception, its type and a stack trace", async () => {
    const { sent, reporter } = setup({ environment: "prod", release: "r1", now: () => 5000 })

    const ok = await reporter.report(new TypeError("x is undefined"))

    expect(ok).toBe(true)
    expect(sent).toHaveLength(1)
    expect(sent[0].url).toBe(
      "https://errors.example.com/api/7/envelope/?sentry_version=7&sentry_key=abc123",
    )
    const [header, item] = String(sent[0].init.body).split("\n").map((l) => JSON.parse(l))
    const event = eventOf(sent[0])
    expect(header.event_id).toBe(event.event_id)
    expect(item).toEqual({ type: "event" })
    expect(event.event_id).toMatch(/^[0-9a-f]{32}$/)
    expect(event.timestamp).toBe(5)
    expect(event.environment).toBe("prod")
    expect(event.release).toBe("r1")
    expect(event.exception.values[0].type).toBe("TypeError")
    expect(event.exception.values[0].value).toBe("x is undefined")
    expect(event.exception.values[0].stacktrace.frames.length).toBeGreaterThan(0)
    expect(event.exception.values[0].stacktrace.frames[0].lineno).toBeGreaterThan(0)
  })

  it("reads V8 and Firefox stack lines, oldest call first", async () => {
    const { sent, reporter } = setup()
    const error = new Error("x")
    error.stack = "Error: x\n    at inner (https://app.example.com/a.js?v=secret:10:5)\n" +
      "    at https://app.example.com/b.js:20:7\nouter@https://app.example.com/c.js:30:9"

    await reporter.report(error)

    const frames = eventOf(sent[0]).exception.values[0].stacktrace.frames
    expect(frames.map((f: { lineno: number }) => f.lineno)).toEqual([30, 20, 10])
    expect(frames[2]).toEqual({
      filename: "https://app.example.com/a.js",
      function: "inner",
      lineno: 10,
      colno: 5,
    })
  })

  it("never carries a query string, a fragment, a cookie, a token or a password", async () => {
    const { sent, reporter } = setup({
      pageUrl: () => "https://app.example.com/reset-password?token=TOKEN123#frag",
      redactPathAfter: ["invite"],
    })
    const error = new Error(
      "failed GET https://app.example.com/api/x?session=SESS456&a=1 with password=hunter2, " +
        "Cookie: sid=COOKIE789 and Bearer BEARER000 token: 'TOK555'",
    )
    error.stack = "Error: x\n    at f (https://app.example.com/main.js?t=STACKQ:1:1)"

    await reporter.report(error, {
      tags: { request_id: "rid1", note: "api_key=KEY999" },
      request: { method: "POST", path: "/api/invite/INVITESECRET" },
    })

    const body = String(sent[0].init.body)
    for (
      const secret of [
        "TOKEN123",
        "frag",
        "SESS456",
        "hunter2",
        "COOKIE789",
        "BEARER000",
        "TOK555",
        "STACKQ",
        "KEY999",
        "INVITESECRET",
      ]
    ) {
      expect(body, secret).not.toContain(secret)
    }
    expect(eventOf(sent[0]).tags.request_id).toBe("rid1")
    expect(sent[0].init.credentials).toBe("omit")
    expect(sent[0].init.headers).toEqual({ "Content-Type": "text/plain;charset=UTF-8" })
  })

  it("carries the page address without its query, and a server request as method and path", async () => {
    const a = setup({ pageUrl: () => "https://app.example.com/notes/1?x=1" })
    await a.reporter.report(new Error("x"))
    expect(eventOf(a.sent[0]).request).toEqual({ url: "https://app.example.com/notes/1" })

    const b = setup()
    await b.reporter.report(new Error("x"), {
      request: { method: "GET", path: "/api/notes" },
      tags: { request_id: "r9" },
    })
    expect(eventOf(b.sent[0]).request).toEqual({ method: "GET", url: "/api/notes" })
  })

  it("turns a thrown string or object into a report", async () => {
    const { sent, reporter } = setup()

    await reporter.report("plain text")
    await reporter.report({ not: "an error" })

    expect(eventOf(sent[0]).exception.values[0].value).toBe("plain text")
    expect(eventOf(sent[1]).exception.values[0].value).toContain("Non-error thrown")
  })
})

describe("a report's free text", () => {
  it("masks what a header line, a relative path, a websocket URL or a bare token carries", async () => {
    const { sent, reporter } = setup()
    const error = new Error(
      [
        "Authorization: Basic BASICX",
        "Cookie: a=1; b=COOKIEX",
        "Set-Cookie: sid=SETX; Path=/",
        "GET /reset?code=RELX",
        "url=/next?code=EQX next:/next?code=COLONX [/next?code=BRACKETX]",
        "request to /api/auth/magic?key=RELKEYX failed",
        "wss://app.example.com/socket?ticket=WSSX",
        "ws://h/s#FRAGX",
        "jwt eyJhbGciOiJIUzI1NiJ9.eyJzdWIiOiJKV1RYIn0.SIGX",
      ].join("\n"),
    )
    error.stack = "Error: x\n    at handle token=FNSECRETX (https://app.example.com/a.js:1:1)"

    await reporter.report(error)

    const event = eventOf(sent[0])
    const body = String(sent[0].init.body)
    for (
      const secret of [
        "BASICX",
        "COOKIEX",
        "SETX",
        "RELX",
        "EQX",
        "COLONX",
        "BRACKETX",
        "RELKEYX",
        "WSSX",
        "FRAGX",
        "SIGX",
      ]
    ) {
      expect(body, secret).not.toContain(secret)
    }
    expect(body).not.toContain("FNSECRETX")
    expect(event.exception.values[0].value).toContain("GET /reset")
    expect(event.exception.values[0].value).toContain("wss://app.example.com/socket")
  })

  it("masks a lone Bearer value, a URL's credentials and a secret path segment", async () => {
    const { sent, reporter } = setup({ redactPathAfter: ["invite"] })
    const error = new Error(
      [
        "Bearer BEARERX",
        "GET https://user:PASSX@app.example.com/x failed",
        "open https://app.example.com/invite/INVX failed",
        "connect postgres://app:PGX@db:5432/app failed",
      ].join("\n"),
    )

    await reporter.report(error)

    const body = String(sent[0].init.body)
    for (const secret of ["BEARERX", "PASSX", "INVX", "PGX"]) {
      expect(body, secret).not.toContain(secret)
    }
    expect(eventOf(sent[0]).exception.values[0].value).toContain("postgres://db:5432/app")
  })

  it("keeps the scheme of a server's stack frame", async () => {
    const { sent, reporter } = setup()
    const error = new Error("x")
    error.stack = "Error: x\n    at f (file:///app/main.ts:3:5)\n" +
      "    at node:internal/process/task_queues:95:5"

    await reporter.report(error)

    const frames = eventOf(sent[0]).exception.values[0].stacktrace.frames
    expect(frames.map((f: { filename: string }) => f.filename)).toEqual([
      "node:internal/process/task_queues",
      "file:///app/main.ts",
    ])
  })

  it("masks a secret in the name of the thrown error type", async () => {
    const { sent, reporter } = setup()
    const error = new Error("x")
    error.name = "Failed token=TYPEX"

    await reporter.report(error)

    expect(String(sent[0].init.body)).not.toContain("TYPEX")
  })

  it("masks a 100,000-character message in under a second, cut to a fixed length", async () => {
    const { sent, reporter } = setup()
    const error = new Error("a-".repeat(50_000))
    error.stack = `Error: x\n    at ${"b-".repeat(400)} (https://app.example.com/a.js:1:1)`

    const started = performance.now()
    await reporter.report(error)
    const elapsed = performance.now() - started

    expect(elapsed).toBeLessThan(1000)
    const value = eventOf(sent[0]).exception.values[0]
    expect(value.value.length).toBeLessThanOrEqual(4000)
    expect(value.stacktrace.frames[0].function.length).toBeLessThanOrEqual(200)
  })

  it("reads a 400,000-character stack in under a second, keeping at most 50 frames", async () => {
    const { sent, reporter } = setup()
    const slow = new Error("x")
    slow.stack = "@:".repeat(200_000)
    const deep = new Error("y")
    deep.stack = `Error: y\n${"    at f (https://app.example.com/a.js:1:1)\n".repeat(80)}`

    const started = performance.now()
    await reporter.report(slow)
    expect(performance.now() - started).toBeLessThan(1000)
    await reporter.report(deep)

    expect(eventOf(sent[1]).exception.values[0].stacktrace.frames.length).toBe(50)
  })
})

describe("sampling and the session cap", () => {
  it("sends nothing at sample rate 0 and everything at 1", async () => {
    const off = setup({ sampleRate: 0, random: () => 0 })
    const on = setup({ sampleRate: 1, random: () => 0.999 })

    expect(await off.reporter.report(new Error("x"))).toBe(false)
    expect(await on.reporter.report(new Error("x"))).toBe(true)
    expect(off.sent).toHaveLength(0)
    expect(on.sent).toHaveLength(1)
  })

  it("keeps an error when the dice roll below the rate and drops it above", async () => {
    const roll = [0.1, 0.9]
    const { sent, reporter } = setup({ sampleRate: 0.5, random: () => roll.shift()! })

    await reporter.report(new Error("kept"))
    await reporter.report(new Error("dropped"))

    expect(sent).toHaveLength(1)
    expect(eventOf(sent[0]).exception.values[0].value).toBe("kept")
  })

  it("stops after the cap", async () => {
    const { sent, reporter } = setup({ maxPerSession: 2 })

    const results = [
      await reporter.report(new Error("1")),
      await reporter.report(new Error("2")),
      await reporter.report(new Error("3")),
    ]

    expect(results).toEqual([true, true, false])
    expect(sent).toHaveLength(2)
  })
})

describe("a cap with a window", () => {
  it("counts again when the window has passed, so a long-running process keeps reporting", async () => {
    let clock = 0
    const { sent, reporter } = setup({ maxPerSession: 2, windowMs: 1000, now: () => clock })

    const first = [
      await reporter.report(new Error("1")),
      await reporter.report(new Error("2")),
      await reporter.report(new Error("3")),
    ]
    clock = 999
    const stillCapped = await reporter.report(new Error("4"))
    clock = 1000
    const later = [await reporter.report(new Error("5")), await reporter.report(new Error("6"))]
    const cappedAgain = await reporter.report(new Error("7"))

    expect(first).toEqual([true, true, false])
    expect(stillCapped).toBe(false)
    expect(later).toEqual([true, true])
    expect(cappedAgain).toBe(false)
    expect(sent).toHaveLength(4)
  })
})

describe("a tracker that is down", () => {
  it("never throws or rejects when fetch fails", async () => {
    const reporter = createErrorReporter({
      dsn: DSN,
      fetch: (() => Promise.reject(new TypeError("Failed to fetch"))) as typeof fetch,
    })

    expect(await reporter.report(new Error("x"))).toBe(false)
  })

  it("never throws when fetch throws at once, and reports false for a 500", async () => {
    const throwing = createErrorReporter({
      dsn: DSN,
      fetch: (() => {
        throw new Error("sync")
      }) as typeof fetch,
    })
    const { reporter } = setup({}, 500)

    expect(await throwing.report(new Error("x"))).toBe(false)
    expect(await reporter.report(new Error("x"))).toBe(false)
  })
})

describe("install", () => {
  it("reports an error event and an unhandled rejection", async () => {
    const { sent, reporter } = setup()
    const target = new EventTarget()
    reporter.install(target)

    target.dispatchEvent(Object.assign(new Event("error"), { error: new Error("from error") }))
    target.dispatchEvent(
      Object.assign(new Event("unhandledrejection"), { reason: new Error("from promise") }),
    )
    await new Promise((resolve) => setTimeout(resolve, 0))

    expect(sent.map((s) => eventOf(s).exception.values[0].value).sort()).toEqual([
      "from error",
      "from promise",
    ])
  })
})

describe("scrubUrl", () => {
  it("drops the credentials of an address that does not parse", () => {
    expect(scrubUrl("postgres://user:PASSX@host:port/db")).toBe("postgres://host:port/db")
    expect(scrubUrl("postgres://user:pa/SSX@host/db")).toBe("postgres://host/db")
    expect(scrubUrl("https://user:p#HASHX@host/x")).toBe("https://host/x")
  })

  it("cuts a relative address at its query or fragment", () => {
    expect(scrubUrl("/assets/a.js?v=SECRETX")).toBe("/assets/a.js")
    expect(scrubUrl("a.js#SECRETX")).toBe("a.js")
  })
})
