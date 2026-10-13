import { expect } from "@std/expect"
import { describe, it } from "@std/testing/bdd"
import {
  createErrorReporter,
  type ErrorReporterOptions,
  parseDsn,
  scrubText,
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
    // A UUID version 7 without its hyphens: 32 hex digits, version digit 7, standard variant.
    expect(event.event_id).toMatch(/^[0-9a-f]{12}7[0-9a-f]{3}[89ab][0-9a-f]{15}$/)
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

describe("scrubText", () => {
  // Every password here is made up. Before the character comes a valid port number, so that the
  // platform reads the text up to a `/`, `?` or `#` as a host and its port (`postgres://app:12`).
  const unsure: [string, string][] = [
    ["a slash", "12/REST"],
    ["a question mark", "12?REST"],
    ["a hash", "12#REST"],
    ["an ampersand", "12&REST"],
    ["an equals sign", "12=REST"],
    ["a comma", "12,REST"],
    ["a semicolon", "12;REST"],
    ["a backslash", "12\\REST"],
    ["a double quote", '12"REST'],
    ["a single quote", "12'REST"],
    ["an opening angle bracket", "12<REST"],
    ["a closing angle bracket", "12>REST"],
    ["an opening parenthesis", "12(REST"],
    ["a closing parenthesis", "12)REST"],
    ["an opening square bracket", "12[REST"],
    ["a closing square bracket", "12]REST"],
    ["an opening brace", "12{REST"],
    ["a closing brace", "12}REST"],
    ["a raw at sign and a slash", "p@ss/W0RD"],
  ]

  for (const [name, password] of unsure) {
    it(`shows nothing of an address whose password holds ${name}`, () => {
      const text = `connect postgres://app:${password}@db.example.com:5432/app failed`

      expect(scrubText(text)).toBe("connect postgres://<REDACTED> failed")
    })
  }

  it("shows nothing of the address in the issue, with a slash in its password", () => {
    expect(scrubText("postgres://app:12/rest@db.example.com:5432/app")).toBe(
      "postgres://<REDACTED>",
    )
  })

  // In an `https` address the platform reads a backslash as a slash.
  it("shows nothing of an https address whose password holds a backslash", () => {
    expect(scrubText("connect https://app:12\\REST@db.example.com/app failed")).toBe(
      "connect https://<REDACTED> failed",
    )
  })

  const hosts: [string, string][] = [
    ["ends its word", "db"],
    ["has a path", "db/app"],
    ["has a query", "db?ssl=1"],
    ["has a fragment", "db#main"],
    ["has a port", "db:5432"],
    ["has a port and a path", "db:5432/app"],
    ["is an IPv6 address", "[::FFFF:10.0.0.1]:5432/app"],
    ["is not in ASCII", "бд.example.com/app"],
    ["holds a hyphen, an underscore, a tilde and an encoded character", "my-db_1~a%2Db/app"],
    ["is followed by a comma", "db,"],
    ["is followed by a semicolon", "db;"],
    ["is followed by a colon", "db:"],
    ["is followed by a full stop", "db."],
    ["is followed by a double quote", 'db"'],
    ["is followed by a single quote", "db'"],
    ["is followed by a tag", "db<br>"],
    ["is followed by a closing angle bracket", "db>"],
    ["is followed by a closing parenthesis", "db)"],
    ["is followed by a closing square bracket", "db]"],
    ["is followed by a closing brace", "db}"],
    ["is followed by an ampersand", "db&retries=3"],
    ["is followed by an exclamation mark", "db!"],
    ["is followed by an opening parenthesis", "db(primary)"],
    ["is followed by a vertical bar", "db|replica"],
    ["has a port and is followed by a colon", "db:5432:"],
    ["has a port and is followed by a full stop", "db:5432."],
  ]

  for (const [name, host] of hosts) {
    it(`shows nothing of a password with a slash when the host ${name}`, () => {
      expect(scrubText(`connect postgres://app:12/REST@${host} failed`)).toBe(
        "connect postgres://<REDACTED> failed",
      )
    })
  }

  const clean: [string, string][] = [
    ["a colon", "12:REST"],
    ["an encoded at sign", "12%40REST"],
    ["a raw at sign", "p@ssW0RD"],
  ]

  for (const [name, password] of clean) {
    it(`drops a password that holds ${name} and keeps the rest of the address`, () => {
      const text = `connect postgres://app:${password}@db.example.com:5432/app failed`

      expect(scrubText(text)).toBe("connect postgres://db.example.com:5432/app failed")
    })
  }

  it("leaves a URL without credentials as it was", () => {
    const text = "connect postgres://db.example.com:5432/app and https://example.com/a/b failed"

    expect(scrubText(text)).toBe(text)
  })

  it("leaves a URL as it was when e-mail addresses stand in other words", () => {
    const text = "mail a@example.com about https://example.com/a/b, then b@example.com"

    expect(scrubText(text)).toBe(text)
  })

  it("leaves a URL as it was when the only at sign of its word comes before it", () => {
    const text = "from=a@example.com&url=https://app.example.com/x"

    expect(scrubText(text)).toBe(text)
  })

  it("keeps the other words around an address it masks", () => {
    expect(scrubText("a@example.com saw redis://:12/REST@cache:6379/0, then b@example.com")).toBe(
      "a@example.com saw redis://<REDACTED> then b@example.com",
    )
  })

  it("shows nothing of a password with a slash when an e-mail address comes first in its word", () => {
    const text = "owner=ops@corp.example,dsn=postgres://app:12/REST@db.example.com:5432/app"

    expect(scrubText(text)).toBe("owner=ops@corp.example,dsn=postgres://<REDACTED>")
  })

  it("shows nothing of a password with a slash when the query holds an at sign too", () => {
    const text = "postgres://app:12/REST@db.example.com:5432/app?sslkey=a@b&code=77"

    expect(scrubText(text)).toBe("postgres://<REDACTED>")
  })

  it("shows nothing of a password with a question mark when a comma follows the host", () => {
    expect(scrubText("postgres://app:12?REST@db, retrying")).toBe("postgres://<REDACTED> retrying")
  })

  // The field after the address holds an `@`, so the platform reads the text before it as the
  // address's credentials and the rest of the field's value as its host.
  it("shows nothing of a secret field that follows an address in a JSON body", () => {
    expect(scrubText('{"url":"https://db.example.com/","password":"p@ssw0rd"}')).toBe(
      '{"url":"https://<REDACTED>',
    )
    expect(
      scrubText(
        '{"callbackUrl":"https://app.example.com/cb","user":"app","password":"S3cr@tTAIL"}',
      ),
    ).toBe('{"callbackUrl":"https://<REDACTED>')
    expect(scrubText('{"host":"https://api.example.com","api_key":"ab@cdEFG"}')).toBe(
      '{"host":"https://<REDACTED>',
    )
  })

  for (const separator of ["&", ";", ","]) {
    it(`shows nothing of a password field that follows an address after "${separator}"`, () => {
      expect(scrubText(`url=https://a.example/x${separator}password=p@ssTAIL`)).toBe(
        "url=https://<REDACTED>",
      )
      expect(scrubText(`url=https://a.example${separator}password=p@ssTAIL`)).toBe(
        "url=https://<REDACTED>",
      )
    })
  }

  it("shows nothing of a key that follows an address in braces", () => {
    expect(scrubText("{host:https://api.example.com}{api_key:ab@cdEFG}")).toBe(
      "{host:https://<REDACTED>",
    )
  })

  // One character alone stands between the host and a value that holds an `@`.
  for (const separator of ["&", "=", ",", ";", "(", "[", "]", "{", "}"]) {
    it(`shows nothing of a value with an at sign that follows a host after "${separator}"`, () => {
      expect(scrubText(`see https://a.example${separator}ab@cdEFG now`)).toBe(
        "see https://<REDACTED> now",
      )
    })
  }

  // The mask comes after every other pattern: the name of the secret sits in the masked text, and
  // its value in the next word.
  it("masks a secret whose name sits in the text that an address mask covers", () => {
    expect(scrubText("see https://a.example/x@b.example/password: VALUE")).toBe(
      "see https://<REDACTED> <REDACTED>",
    )
    expect(
      scrubText('connect postgres://app:12/REST@db.example.com,"password": "p@ssTAIL" failed'),
    ).toBe("connect postgres://<REDACTED> <REDACTED> failed")
    expect(scrubText("GET https://a.example/x@h.example/,Bearer abc123def failed")).toBe(
      "GET https://<REDACTED> <REDACTED> failed",
    )
  })

  // An e-mail address in a link reads like the end of a password, so nothing of the link is kept.
  const links: [string, string][] = [
    ["a query that holds an at sign before a code", "/reset?email=user@example.com&code=123456"],
    ["a fragment that holds an at sign before a code", "/reset#email=user@example.com&code=123456"],
    [
      "a query with an encoded parameter that holds an at sign before a code",
      "/reset?email=user@example.com&next=%2Fhome&code=123456",
    ],
    ["a query that ends in an e-mail address", "/reset?code=123456&email=user@example.com"],
    [
      "no path and a query that holds an at sign before a code",
      "?email=user@example.com&code=123456",
    ],
  ]

  for (const [name, link] of links) {
    it(`shows nothing of a link with ${name}`, () => {
      expect(scrubText(`GET https://app.example.com${link} failed`)).toBe(
        "GET https://<REDACTED> failed",
      )
    })
  }

  it("shows nothing of a reset code when its link shares a word with another address", () => {
    expect(
      scrubText(
        '{"a":"https://a.example/x","link":"https://b.example/reset?email=u@e.com&code=123456"}',
      ),
    ).toBe('{"a":"https://<REDACTED>')
    expect(
      scrubText(
        'config: {"a":"https://a.example/x","link":"https://b.example/reset?email=u@e.com&code=123456"}',
      ),
    ).toBe('config: {"a":"https://<REDACTED>')
    expect(
      scrubText(
        '<a href="https://a.example/reset?email=u@e.com&code=123456">https://a.example/reset?email=u@e.com&code=123456</a>',
      ),
    ).toBe('<a href="https://<REDACTED>')
    expect(scrubText('["https://a.example/x","/reset?email=u@e.com&code=123456"]')).toBe(
      '["https://<REDACTED>',
    )
  })

  // Either a password with a slash and a question mark, or a query with an at sign in it: the two
  // cannot be told apart, so nothing of the address is kept.
  it("masks the whole address when an at sign stands in its query", () => {
    expect(scrubText("connect postgres://app:12/RE?ST@db.example.com:5432/app failed")).toBe(
      "connect postgres://<REDACTED> failed",
    )
    expect(scrubText("https://app.example.com?next=a@b.example/SECRET")).toBe("https://<REDACTED>")
  })

  it("masks the whole address when a secret path segment holds an at sign", () => {
    expect(scrubText("https://app.example.com/invite/abc@def", ["invite"])).toBe(
      "https://<REDACTED>",
    )
    expect(scrubText("(https://a.example/x)(https://b.example/invite/abc@def)", ["invite"])).toBe(
      "(https://<REDACTED>",
    )
  })

  // The price of the rule: such an address reads like one with a slash in its password.
  it("masks the whole address of a module with an at sign after a slash", () => {
    expect(scrubText("import https://jsr.io/@std/expect/1.0.0/mod.ts failed")).toBe(
      "import https://<REDACTED> failed",
    )
  })
})

describe("scrubText on generated messages", () => {
  /** Path names whose next segment is a secret in the generated messages. */
  const REDACT_AFTER = ["invite"]
  /** One word per secret position, in lower case: the platform lower-cases a host name. */
  const MARKERS = [
    "40917",
    "zqpwhead",
    "zqpwtail",
    "zqpwplain",
    "zqinva",
    "zqinvb",
    "zqcode",
    "zqmail",
    "zqdom",
    "zqtoken",
    "zqfa",
    "zqfb",
  ]
  const SCHEMES = ["postgres://", "https://"]
  /** What a password may hold without being encoded. */
  const IN_PASSWORD = [
    "/",
    "?",
    "#",
    "&",
    "=",
    ",",
    ";",
    "@",
    " ",
    ":",
    "%40",
    "\\",
    "(",
    ")",
    "[",
    '"',
    "'",
    "<",
  ]
  const CREDENTIALS = [
    "",
    "app:zqpwplain@",
    // Digits first: before a `/`, `?` or `#` the platform reads `app:40917` as a host and its port.
    ...IN_PASSWORD.map((c) => `app:40917${c}zqpwtail@`),
    ...["/", "?", "#"].map((c) => `app:zqpwhead${c}zqpwtail@`),
  ]
  const HOSTS = ["db.example.com", "db.example.com:5432"]
  const PATHS = ["", "/app", "/invite/zqinva@zqinvb"]
  const QUERIES = [
    "",
    "?email=zqmail@zqdom.example&code=zqcode",
    "?code=zqcode&email=zqmail@zqdom.example",
    "?token=zqtoken",
    "#email=zqmail@zqdom.example&code=zqcode",
  ]
  /** A field after the address, as in a logged body, a form or a `key: value` line. */
  const FOLLOWING = [
    "",
    ',"password":"zqfa@zqfb"',
    ',"password": "zqfa@zqfb"',
    "&password=zqfa@zqfb",
    ", password: zqfa@zqfb",
    "&retries=3",
  ]
  const AROUND = [
    ["", ""],
    ['"', '"'],
    ["'", "'"],
    ["(", ")"],
    ["[", "]"],
    ["<", ">"],
    ['{"url":"', '"'],
    ["{url:", "}"],
    ["", ":"],
  ]
  /** What may stand between two addresses. */
  const BETWEEN = [" ", "\n", " and ", ",", ";", "&", "=", "|", '","', ")(", "][", "><"]
  /** The addresses put side by side, each with each. */
  const PAIRED = [
    "postgres://db.example.com",
    "postgres://app:zqpwplain@db.example.com:5432/app",
    "postgres://app:40917/zqpwtail@db.example.com:5432/app",
    "postgres://app:40917?zqpwtail@db.example.com",
    'https://app:40917"zqpwtail@db.example.com/app',
    "https://db.example.com/reset?email=zqmail@zqdom.example&code=zqcode",
    "https://db.example.com/invite/zqinva@zqinvb",
    "https://db.example.com:5432/app?token=zqtoken",
  ]

  /** Every generated message: each address alone, in each surrounding, and each pair. */
  function generatedMessages(): string[] {
    const messages: string[] = []
    for (const scheme of SCHEMES) {
      for (const credentials of CREDENTIALS) {
        const start = `${scheme}${credentials}`
        for (const host of HOSTS) {
          for (const path of PATHS) {
            for (const query of QUERIES) {
              messages.push(`connect ${start}${host}${path}${query} failed`)
            }
          }
        }
        const tails = [HOSTS[0], `${HOSTS[1]}${PATHS[1]}`, `${HOSTS[0]}${PATHS[2]}${QUERIES[1]}`]
        for (const tail of tails) {
          for (const following of FOLLOWING) {
            for (const [open, close] of AROUND) {
              messages.push(`connect ${open}${start}${tail}${close}${following} failed`)
            }
          }
        }
      }
    }
    for (const first of PAIRED) {
      for (const second of PAIRED) {
        for (const between of BETWEEN) messages.push(`${first}${between}${second}`)
      }
    }
    return messages
  }

  /**
   * The shapes in which a marker is shown, on `main` as well as here. `shape` is matched against
   * the message, and `shows` lists the markers that message may show.
   */
  const STILL_SHOWN: { why: string; shape: RegExp; shows: string[] }[] = [
    {
      why: "a space in the password ends the address, and no pattern takes the next word for one",
      shape: /app:40917 zqpwtail@/,
      shows: ["40917", "zqpwtail", "zqinva", "zqinvb", "zqcode", "zqmail", "zqdom"],
    },
  ]

  it("shows no marker of a secret position, but in the shapes listed as still shown", () => {
    const messages = generatedMessages()
    const shown: string[] = []
    const used = new Set<string>()
    for (const message of messages) {
      const output = scrubText(message, REDACT_AFTER).toLowerCase()
      for (const marker of MARKERS) {
        if (!message.includes(marker) || !output.includes(marker)) continue
        const known = STILL_SHOWN.find((s) => s.shape.test(message) && s.shows.includes(marker))
        if (known) used.add(known.why)
        else shown.push(`${marker} in ${JSON.stringify(output)} from ${JSON.stringify(message)}`)
      }
    }

    expect(messages.length).toBe(9600)
    expect({ count: shown.length, first: shown.slice(0, 5) }).toEqual({ count: 0, first: [] })
    expect(STILL_SHOWN.filter((s) => !used.has(s.why)).map((s) => s.why)).toEqual([])
  })
})
