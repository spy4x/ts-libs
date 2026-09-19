import { expect } from "@std/expect"
import { describe, it } from "@std/testing/bdd"
import {
  basicAuthHeader,
  emailHash,
  MailchimpClient,
  mailchimpConfigFromEnv,
  MailchimpStatus,
  md5Hex,
  normalizeEmail,
} from "./mailchimp.ts"
import type { Clock, Sleeper } from "./retry.ts"

const CONFIG = {
  apiKey: "test-key-not-real",
  username: "test-user-not-real",
  listId: "test-list-not-real",
  serverPrefix: "example",
}
// The client builds `https://<prefix>.api.mailchimp.com/3.0`. The suite uses an
// RFC 2606 prefix so every URL asserted or recorded here is under
// `api.mailchimp.com`-shaped but example-owned territory, and no request is
// ever made.
const API_ROOT = "https://example.api.mailchimp.com/3.0"

interface RecordedRequest {
  url: string
  method: string | undefined
  body: string | undefined
  authorization: string | null
}

interface FakeResponse {
  status: number
  json?: unknown
  text?: string
  headers?: Record<string, string>
}

/**
 * A `fetch` that replays queued responses and records what it was asked to
 * send. The last response repeats, so an unexpected extra call is visible in
 * `requests` rather than throwing a hard-to-read error.
 */
const fakeTransport = (responses: FakeResponse[], label = "mailchimp") => {
  const requests: RecordedRequest[] = []
  let index = 0
  const fetcher: typeof fetch = (input, init) => {
    requests.push({
      url: String(input),
      method: init?.method,
      body: typeof init?.body === "string" ? init.body : undefined,
      authorization: new Headers(init?.headers).get("Authorization"),
    })
    const response = responses[Math.min(index, responses.length - 1)]
    index++
    if (response === undefined) {
      throw new Error(`${label}: no queued response`)
    }
    return Promise.resolve(
      new Response(
        response.json === undefined ? response.text ?? "" : JSON.stringify(response.json),
        { status: response.status, headers: response.headers },
      ),
    )
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

const clientFor = (responses: FakeResponse[], overrides: { maxAttempts?: number } = {}) => {
  const transport = fakeTransport(responses, "mailchimp")
  const timer = recordingTimer()
  const client = new MailchimpClient(CONFIG, {
    fetcher: transport.fetcher,
    sleep: timer.sleep,
    clock: timer.clock,
    retry: {
      maxAttempts: overrides.maxAttempts ?? 3,
      baseDelayMs: 500,
      maxDelayMs: 4000,
      jitterRatio: 0,
    },
  })
  return { client, transport, timer }
}

/** Runs `body` with `console.error` and `console.log` captured. */
const captureConsole = async (body: () => Promise<void>): Promise<unknown[]> => {
  const messages: unknown[] = []
  const originalError = console.error
  const originalLog = console.log
  console.error = (...args: unknown[]) => void messages.push(args)
  console.log = (...args: unknown[]) => void messages.push(args)
  try {
    await body()
  } finally {
    console.error = originalError
    console.log = originalLog
  }
  return messages
}

describe("normalizeEmail", () => {
  it("trims and lowercases, so a padded address finds the member it created", () => {
    expect(normalizeEmail("  Example@Example.COM ")).toBe("example@example.com")
  })
})

describe("md5Hex", () => {
  // RFC 1321, appendix A.5 — the vectors every MD5 implementation is checked
  // against. Deno's WebCrypto has no MD5 at all (`crypto.subtle.digest("MD5")`
  // throws `NotSupportedError`), so there is no platform implementation to
  // compare against and these vectors are the only pin.
  it("matches the RFC 1321 test vector for an empty message", () => {
    expect(md5Hex("")).toBe("d41d8cd98f00b204e9800998ecf8427e")
  })

  it("matches the RFC 1321 test vectors", () => {
    expect(md5Hex("a")).toBe("0cc175b9c0f1b6a831c399e269772661")
    expect(md5Hex("abc")).toBe("900150983cd24fb0d6963f7d28e17f72")
    expect(md5Hex("message digest")).toBe("f96b697d7cb7938d525a2f31aaf161d0")
    expect(md5Hex("abcdefghijklmnopqrstuvwxyz")).toBe("c3fcd3d76192e4007dfb496cca67e13b")
  })

  it("matches the RFC 1321 vector for the 80-digit message", () => {
    expect(
      md5Hex("12345678901234567890123456789012345678901234567890123456789012345678901234567890"),
    ).toBe("57edf4a22be3c955ac49da2e2107b67a")
  })

  it("hashes a message that fills a whole block and one that spills into a second", () => {
    expect(md5Hex("a".repeat(55))).toBe("ef1772b6dff9a122358552954ad0df65")
    expect(md5Hex("a".repeat(56))).toBe("3b0c8ac703f828b04c6c197006d17218")
    expect(md5Hex("a".repeat(64))).toBe("014842d480b571495a4a0363793f7367")
    expect(md5Hex("a".repeat(65))).toBe("c743a45e0d2e6a95cb859adae0248435")
  })
})

describe("emailHash", () => {
  it("returns Mailchimp's 32-character md5 subscriber hash", () => {
    expect(emailHash("example@example.com")).toMatch(/^[0-9a-f]{32}$/)
    expect(emailHash("example@example.com")).toBe("23463b99b62a72f26ed677cc556c44e8")
  })

  it("hashes the case-folded address, so members do not duplicate on casing", () => {
    expect(emailHash("Example@Example.COM")).toBe(emailHash("example@example.com"))
  })

  it("ignores surrounding whitespace, matching the hash a clean address produces", () => {
    expect(emailHash(" Example@Example.com ")).toBe(emailHash("example@example.com"))
  })
})

describe("basicAuthHeader", () => {
  it("base64-encodes username and key", () => {
    expect(basicAuthHeader("user", "key")).toBe(`Basic ${btoa("user:key")}`)
  })

  it("encodes a non-ASCII username as UTF-8 instead of throwing", () => {
    const header = basicAuthHeader("usér", "k")
    expect(header.startsWith("Basic ")).toBe(true)
    expect(() => atob(header.slice(6))).not.toThrow()
  })
})

describe("mailchimpConfigFromEnv", () => {
  it("reads every required variable", () => {
    const env: Record<string, string> = {
      MAILCHIMP_API_KEY: CONFIG.apiKey,
      MAILCHIMP_API_USERNAME: CONFIG.username,
      MAILCHIMP_LIST_ID: CONFIG.listId,
      MAILCHIMP_SERVER_PREFIX: CONFIG.serverPrefix,
    }
    expect(mailchimpConfigFromEnv((name) => env[name])).toEqual(CONFIG)
  })

  it("returns null when any variable is missing or blank", () => {
    expect(mailchimpConfigFromEnv(() => undefined)).toBeNull()
    expect(
      mailchimpConfigFromEnv((name) => (name === "MAILCHIMP_LIST_ID" ? "  " : "value")),
    ).toBeNull()
  })
})

describe("MailchimpClient construction", () => {
  it("throws on blank credentials rather than degrading to a disabled no-op", () => {
    expect(() => new MailchimpClient({ ...CONFIG, apiKey: "" })).toThrow("missing apiKey")
  })

  it("builds the datacenter-scoped API root", () => {
    const { client } = clientFor([{ status: 200, json: {} }])
    expect(client.apiUrl).toBe(API_ROOT)
  })
})

describe("MailchimpClient.putContact", () => {
  it("creates a new member with POST and reports the change", async () => {
    const { client, transport } = clientFor([
      { status: 404, json: { title: "Resource Not Found" } },
      { status: 200, json: { status: "pending" } },
    ])
    const result = await client.putContact({
      email: "new@example.invalid",
      firstName: "New",
      lastName: "Person",
    })
    expect(result).toEqual({
      ok: true,
      status: "upserted",
      method: "POST",
      httpStatus: 200,
      change: "created",
      attempts: 2,
    })
    expect(transport.requests[1].method).toBe("POST")
    expect(transport.requests[1].url).toBe(`${API_ROOT}/lists/${CONFIG.listId}/members`)
    expect(JSON.parse(transport.requests[1].body ?? "")).toEqual({
      email_address: "new@example.invalid",
      status_if_new: "pending",
      status: "pending",
      merge_fields: { FNAME: "New", LNAME: "Person" },
    })
    expect(transport.requests[1].authorization).toBe(
      basicAuthHeader(CONFIG.username, CONFIG.apiKey),
    )
  })

  it("updates an existing member with PATCH on the hashed address", async () => {
    const { client, transport } = clientFor([
      { status: 200, json: { status: "subscribed" } },
      { status: 200, json: { status: "subscribed" } },
    ])
    const result = await client.putContact({ email: "member@example.invalid" })
    expect(result).toEqual({
      ok: true,
      status: "upserted",
      method: "PATCH",
      httpStatus: 200,
      change: "updated",
      attempts: 2,
    })
    expect(transport.requests[1].method).toBe("PATCH")
    expect(transport.requests[1].url).toBe(
      `${API_ROOT}/lists/${CONFIG.listId}/members/${emailHash("member@example.invalid")}`,
    )
    expect(JSON.parse(transport.requests[1].body ?? "")).toMatchObject({ status: "subscribed" })
  })

  it("prefers emailBefore, so a rename updates instead of duplicating", async () => {
    const { client, transport } = clientFor([
      { status: 200, json: { status: "unsubscribed" } },
      { status: 200, json: { status: "unsubscribed" } },
    ])
    const result = await client.putContact({
      email: "after@example.invalid",
      emailBefore: "before@example.invalid",
    })
    expect(result.ok).toBe(true)
    expect(transport.requests[0].url).toBe(
      `${API_ROOT}/lists/${CONFIG.listId}/members/${emailHash("before@example.invalid")}`,
    )
    expect(transport.requests[1].url).toBe(
      `${API_ROOT}/lists/${CONFIG.listId}/members/${emailHash("before@example.invalid")}`,
    )
    expect(JSON.parse(transport.requests[1].body ?? "")).toMatchObject({
      email_address: "after@example.invalid",
      status: "unsubscribed",
    })
  })

  it("writes nothing to the console on the success path", async () => {
    const { client } = clientFor([
      { status: 404, json: { title: "Resource Not Found" } },
      { status: 200, json: { status: "pending" } },
    ])
    const messages = await captureConsole(async () => {
      const result = await client.putContact({ email: "quiet@example.invalid" })
      expect(result.ok).toBe(true)
    })
    expect(messages).toEqual([])
  })

  it("distinguishes a disabled skip from a real upsert", () => {
    const { client, transport } = clientFor([{ status: 200, json: {} }])
    const skipped = client.skipDisabled("missing_credentials")
    expect(skipped).toEqual({
      ok: true,
      status: "skipped-disabled",
      reason: "missing_credentials",
      attempts: 0,
    })
    expect(skipped.status).not.toBe("upserted")
    expect(transport.requests).toEqual([])
  })

  it("writes nothing to the console when the disable is recorded", async () => {
    const { client } = clientFor([{ status: 200, json: {} }])
    const messages = await captureConsole(() => {
      client.skipDisabled("server_disabled")
      return Promise.resolve()
    })
    expect(messages).toEqual([])
  })

  it("refuses an empty address without calling the network", async () => {
    const { client, transport } = clientFor([{ status: 200, json: {} }])
    expect(await client.putContact({ email: "   " })).toEqual({
      ok: false,
      code: "missing_email",
      message: "contact.email is empty",
      attempts: 0,
    })
    expect(transport.requests).toEqual([])
  })

  it("reconciles a Member Exists 400 into a PATCH instead of reporting success", async () => {
    const { client, transport } = clientFor([
      { status: 404, json: { title: "Resource Not Found" } },
      { status: 400, json: { title: "Member Exists" } },
      { status: 200, json: { status: "subscribed" } },
    ])
    const result = await client.putContact({ email: "race@example.invalid" })
    expect(result).toEqual({
      ok: true,
      status: "upserted",
      method: "PATCH",
      httpStatus: 200,
      change: "updated",
      attempts: 3,
    })
    expect(transport.requests[2].method).toBe("PATCH")
  })

  it("returns a typed http_error when the API rejects the key", async () => {
    const { client } = clientFor([{ status: 401, json: { title: "API Key Invalid" } }])
    const result = await client.putContact({ email: "member@example.invalid" })
    expect(result.ok).toBe(false)
    expect(result.ok === false && result.code).toBe("http_error")
    expect(result.ok === false && result.message).toBe("401")
    expect(result.ok === false && result.status).toBe(401)
    expect(result.ok === false && result.attempts).toBe(1)
  })

  it("retries a 500 and reports how many attempts it took", async () => {
    const { client, transport, timer } = clientFor([
      { status: 500, json: { title: "Internal Server Error" } },
      { status: 200, json: { status: "pending" } },
    ])
    const result = await client.putContact({ email: "flaky@example.invalid" })
    expect(result.ok).toBe(true)
    expect(result.ok === true && result.attempts).toBe(3)
    expect(transport.requests.length).toBe(3)
    expect(timer.delays).toEqual([500])
  })

  it("honours Retry-After on a 429", async () => {
    const { client, timer } = clientFor([
      { status: 429, json: { title: "Too Many Requests" }, headers: { "Retry-After": "1" } },
      { status: 200, json: { status: "pending" } },
    ])
    const result = await client.putContact({ email: "throttled@example.invalid" })
    expect(result.ok).toBe(true)
    expect(timer.delays).toEqual([1000])
  })

  it("does not retry a permanent 400", async () => {
    const { client, transport } = clientFor([{ status: 400, json: { title: "Invalid Resource" } }])
    const result = await client.putContact({ email: "member@example.invalid" })
    expect(result.ok).toBe(false)
    expect(transport.requests.length).toBe(1)
  })

  it("gives up after the attempt cap on a persistent 500", async () => {
    const { client, transport } = clientFor(
      [{ status: 500, json: { title: "Internal Server Error" } }],
      { maxAttempts: 3 },
    )
    const result = await client.putContact({ email: "down@example.invalid" })
    expect(result.ok).toBe(false)
    expect(result.ok === false && result.status).toBe(500)
    expect(result.ok === false && result.attempts).toBe(3)
    expect(transport.requests.length).toBe(3)
  })

  it("refuses to write in read-only mode", async () => {
    const transport = fakeTransport([{ status: 200, json: {} }], "readonly")
    const client = new MailchimpClient(CONFIG, { fetcher: transport.fetcher, readOnly: true })
    expect(await client.putContact({ email: "member@example.invalid" })).toEqual({
      ok: false,
      code: "method_not_allowed",
      message: "client is read-only",
      attempts: 0,
    })
    expect(transport.requests).toEqual([])
  })
})

describe("MailchimpClient.searchContact", () => {
  it("reports an existing member with its status", async () => {
    const { client, transport } = clientFor([{ status: 200, json: { status: "subscribed" } }])
    expect(await client.searchContact("member@example.invalid")).toEqual({
      ok: true,
      exists: true,
      status: MailchimpStatus.Subscribed,
      statusIfNew: undefined,
      attempts: 1,
    })
    expect(transport.requests[0].method).toBe("GET")
    expect(transport.requests[0].url).toBe(
      `${API_ROOT}/lists/${CONFIG.listId}/members/${emailHash("member@example.invalid")}`,
    )
  })

  it("treats a 404 as a clean miss, not an error", async () => {
    const { client } = clientFor([{ status: 404, json: { title: "Resource Not Found" } }])
    expect(await client.searchContact("nobody@example.invalid")).toEqual({
      ok: true,
      exists: false,
      httpStatus: 404,
      attempts: 1,
    })
  })

  it("ignores an unrecognised status instead of naming the member with a bogus one", async () => {
    const { client } = clientFor([{ status: 200, json: { status: "archived" } }])
    const lookup = await client.searchContact("member@example.invalid")
    expect(lookup).toEqual({
      ok: true,
      exists: true,
      status: MailchimpStatus.Pending,
      statusIfNew: undefined,
      attempts: 1,
    })
  })

  it("returns a typed network_error without echoing the request URL", async () => {
    const timer = recordingTimer()
    const client = new MailchimpClient(CONFIG, {
      // What `fetch` actually throws: the URL, which for this client carries no
      // credential, but the same code path serves a caller-supplied host.
      fetcher: () =>
        Promise.reject(new TypeError(`Invalid URL: '${API_ROOT}/lists/l/members/abc'`)),
      sleep: timer.sleep,
      clock: timer.clock,
      retry: { maxAttempts: 2, baseDelayMs: 10, maxDelayMs: 10, jitterRatio: 0 },
    })
    const result = await client.searchContact("member@example.invalid")
    expect(result.ok).toBe(false)
    expect(result.ok === false && result.code).toBe("network_error")
    expect(result.ok === false && result.message).toBe(
      "TypeError: transport failure (url withheld)",
    )
    expect(JSON.stringify(result)).not.toContain("api.example.com")
  })

  it("refuses an empty address without calling the network", async () => {
    const { client, transport } = clientFor([{ status: 200, json: {} }])
    expect(await client.searchContact("")).toEqual({
      ok: false,
      code: "missing_email",
      message: "email is empty",
      attempts: 0,
    })
    expect(transport.requests).toEqual([])
  })
})

describe("MailchimpClient read-only mode", () => {
  it("refuses putContact with a typed method_not_allowed and sends nothing", async () => {
    const transport = fakeTransport([{ status: 200, json: { status: "subscribed" } }])
    const client = new MailchimpClient(CONFIG, { fetcher: transport.fetcher, readOnly: true })
    expect(await client.putContact({ email: "member@example.invalid" })).toEqual({
      ok: false,
      code: "method_not_allowed",
      message: "client is read-only",
      attempts: 0,
    })
    expect(transport.requests).toEqual([])
  })

  it("still allows searchContact, which cannot mutate the list", async () => {
    const transport = fakeTransport([{ status: 200, json: { status: "subscribed" } }])
    const client = new MailchimpClient(CONFIG, { fetcher: transport.fetcher, readOnly: true })
    expect(await client.searchContact("member@example.invalid")).toEqual({
      ok: true,
      exists: true,
      status: MailchimpStatus.Subscribed,
      statusIfNew: undefined,
      attempts: 1,
    })
    expect(transport.requests.length).toBe(1)
    expect(transport.requests[0].method).toBe("GET")
    expect(transport.requests[0].url).toContain(emailHash("member@example.invalid"))
  })

  it("is off by default, so a normal client writes", async () => {
    const transport = fakeTransport([
      { status: 404, json: { title: "Resource Not Found" } },
      { status: 200, json: { status: "pending" } },
    ])
    const client = new MailchimpClient(CONFIG, { fetcher: transport.fetcher })
    const result = await client.putContact({ email: "new@example.invalid" })
    expect(result.ok).toBe(true)
    expect(result.ok && result.status === "upserted" && result.method).toBe("POST")
  })
})
