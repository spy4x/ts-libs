/**
 * `chatCompletion` — the request, its guards, its time and its retries.
 *
 * Every case here is deterministic: a queued fake fetcher, a fake timer whose
 * clock only advances when something waits, and a recording logger. Nothing in
 * this file touches the network, sleeps, or reads a wall clock.
 */

import { assertEquals, assertExists, assertMatch, assertRejects } from "@std/assert"
import { describe, it } from "@std/testing/bdd"

import {
  AiErrorCode,
  type ChatRequestOptions,
  createChatClient,
  DEFAULT_BASE_URL,
  DEFAULT_TIMEOUT_MS,
  isAiError,
  normalizeBaseUrl,
} from "./chat.ts"
import {
  completionBody,
  createFakeFetcher,
  createFakeTimer,
  createRecordingLogger,
  FAKE_API_KEY,
  FAKE_BASE_URL,
  type FakeReply,
  hasFrameText,
  serialized,
  surfacedStrings,
} from "./test-fixtures.ts"

/**
 * Fail a test loudly when the fixture ran out of replies.
 *
 * A retryable status consumes more than one queued reply, so a test that queued
 * one reply and asserted on the resulting error would otherwise assert on the
 * fixture's own exhaustion error while believing it held a provider response.
 */
function assertNotExhausted(error: unknown): void {
  const text = error instanceof Error ? `${error.name}: ${error.message}` : String(error)
  assertEquals(
    text.includes("FakeFetcherExhausted"),
    false,
    `the fixture ran out of replies; the assertion would be about the fixture: ${text}`,
  )
}

/** Build a client over queued replies, with a fake clock and a recording logger. */
function harness(replies: FakeReply[], config: Parameters<typeof createChatClient>[0] = {
  apiKey: FAKE_API_KEY,
}) {
  const fake = createFakeFetcher(replies)
  const timer = createFakeTimer()
  const { logger, lines } = createRecordingLogger()
  const client = createChatClient({
    ...config,
    baseUrl: FAKE_BASE_URL,
    fetcher: fake.fetcher,
    timer,
    logger,
  })
  return { client, fake, timer, lines }
}

const ASK: ChatRequestOptions = { messages: [{ role: "user", content: "hello" }] }

describe("createChatClient credentials", () => {
  it("throws when constructed without a key", () => {
    const thrown = (() => {
      try {
        createChatClient({ apiKey: "" })
        return null
      } catch (error) {
        return error
      }
    })()

    assertExists(thrown)
    assertEquals(isAiError(thrown), true)
    if (isAiError(thrown)) {
      assertEquals(thrown.kind, "config")
      assertEquals(thrown.code, AiErrorCode.MissingApiKey)
    }
  })

  it("throws when constructed with a whitespace-only key", () => {
    let message = "not thrown"
    try {
      createChatClient({ apiKey: "   " })
    } catch (error) {
      message = isAiError(error) ? error.message : "wrong error type"
    }
    assertMatch(message, /apiKey is required/)
  })

  it("does not read a key from the environment", () => {
    const original = Deno.env.get("DEEPSEEK_API_KEY")
    Deno.env.set("DEEPSEEK_API_KEY", FAKE_API_KEY)
    try {
      let thrown = false
      try {
        createChatClient({ apiKey: "" })
      } catch {
        thrown = true
      }
      assertEquals(thrown, true, "an env key must not satisfy the constructor")
    } finally {
      if (original === undefined) Deno.env.delete("DEEPSEEK_API_KEY")
      else Deno.env.set("DEEPSEEK_API_KEY", original)
    }
  })

  it("rejects a base URL that embeds credentials", () => {
    let message = "not thrown"
    try {
      normalizeBaseUrl("https://user:secret@api.example.com/v1")
    } catch (error) {
      message = isAiError(error) ? error.message : "wrong error type"
    }
    assertMatch(message, /must not embed credentials/)
  })
})

describe("chatCompletion guards the completion envelope", () => {
  const malformed: Array<[string, unknown]> = [
    ["no choices key", { id: "c1", model: "fake-model" }],
    ["choices is not an array", { choices: {} }],
    ["choices array is empty", { choices: [] }],
    ["choices[0] is not an object", { choices: [null] }],
    ["choices[0] has no message", { choices: [{ index: 0, finish_reason: "stop" }] }],
    ["message is null", { choices: [{ message: null }] }],
    ["message has no content", { choices: [{ message: { role: "assistant" } }] }],
    ["content is null", { choices: [{ message: { role: "assistant", content: null } }] }],
    ["content is not a string", { choices: [{ message: { content: 42 } }] }],
    ["content is empty", { choices: [{ message: { content: "" } }] }],
    ["body is not an object", "not-json"],
  ]

  for (const [name, body] of malformed) {
    it(`maps a response with ${name} to a typed error`, async () => {
      const { client } = harness([{ body }, { body }, { body }])
      const error = await assertRejects(() => client.chatCompletion(ASK))

      assertEquals(
        error instanceof Error ? error.name : "unknown",
        "AiError",
        "a TypeError means choices[0].message.content is unguarded",
      )
      assertEquals(isAiError(error), true, `not an AiError: ${String(error)}`)
      if (!isAiError(error)) return
      assertEquals(error.kind, "provider")
      assertEquals(error.code, AiErrorCode.InvalidResponse)
    })
  }

  it("never resolves a malformed envelope as a completion", async () => {
    for (const [name, body] of malformed) {
      const { client } = harness([{ body }, { body }, { body }])
      const thrown = await client.chatCompletion(ASK).then(
        () => new Error(`resolved for: ${name}`),
        (error: unknown) => error,
      )
      assertEquals(isAiError(thrown), true, `not an AiError for ${name}: ${String(thrown)}`)
    }
  })
})

describe("chatCompletion checks response.ok", () => {
  const statuses = [400, 401, 403, 404, 429, 500]

  for (const status of statuses) {
    it(`surfaces the provider status for ${status}`, async () => {
      // Retryable statuses get as many queued replies as the policy allows, so a
      // retry cannot exhaust the fixture and fail for the wrong reason.
      const reply = { status, body: { error: { message: "nope", code: "bad_request" } } }
      const { client } = harness([reply, reply, reply, reply])
      const error = await assertRejects(() => client.chatCompletion(ASK))

      assertEquals(isAiError(error), true)
      if (!isAiError(error)) return
      assertEquals(error.kind, "provider")
      assertEquals(error.code, AiErrorCode.ProviderError)
      assertEquals(error.status, status)
      assertEquals(error.providerCode, "bad_request")
      assertMatch(error.message, new RegExp(`provider responded ${status}`))
      assertMatch(error.message, /nope/)
    })
  }

  it("includes the provider message but never the body verbatim", async () => {
    const { client } = harness([
      {
        status: 400,
        body: {
          error: { message: "bad request: unknown field 'prompt'" },
          echo: { prompt: "system prompt text", completion: "model completion text" },
        },
      },
    ])
    const error = await assertRejects(() => client.chatCompletion(ASK))
    assertMatch(isAiError(error) ? error.message : "", /unknown field/)
    const haystack = isAiError(error) ? surfacedStrings(error).join(" ") : ""
    assertEquals(haystack.includes("system prompt text"), false)
    assertEquals(haystack.includes("model completion text"), false)
  })

  it("reports a non-JSON error body by status alone", async () => {
    const { client } = harness([
      { status: 503, text: "<html>gateway</html>" },
      { status: 503, text: "<html>gateway</html>" },
      { status: 503, text: "<html>gateway</html>" },
    ])
    const error = await assertRejects(() => client.chatCompletion(ASK))
    assertEquals(isAiError(error) ? error.status : 0, 503)
    assertEquals(isAiError(error) ? error.message.includes("gateway") : true, false)
  })
})

describe("chatCompletion timeout and abort", () => {
  it("fails with a timeout when the provider never answers", async () => {
    const { client, fake, timer } = harness([{ hangs: true }])
    const pending = client.chatCompletion({ ...ASK, timeoutMs: 1, signal: undefined })
    await fake.whenCalled(1)
    // The deadline is the injected clock: it elapses when the test says so, not
    // when a wall clock does.
    timer.advance(1)

    const error = await assertRejects(() => pending)
    assertEquals(isAiError(error), true)
    if (!isAiError(error)) return
    assertEquals(error.kind, "timeout")
    assertEquals(error.code, AiErrorCode.Timeout)
    assertMatch(error.message, /no response within 1ms/)
  })

  it("defaults the timeout to 60s when the caller does not set one", async () => {
    const { client, fake, timer } = harness([{ hangs: true }])
    const pending = client.chatCompletion(ASK)
    await fake.whenCalled(1)
    timer.advance(DEFAULT_TIMEOUT_MS)

    const error = await assertRejects(() => pending)
    assertMatch(isAiError(error) ? error.message : "", new RegExp(`within ${DEFAULT_TIMEOUT_MS}ms`))
  })

  it("distinguishes a caller abort from a timeout", async () => {
    const controller = new AbortController()
    controller.abort()
    const { client } = harness([{ body: completionBody("unused") }])
    const error = await assertRejects(() =>
      client.chatCompletion({ ...ASK, signal: controller.signal })
    )

    assertEquals(isAiError(error), true)
    if (!isAiError(error)) return
    assertEquals(error.kind, "abort")
    assertEquals(error.code, AiErrorCode.Aborted)
    assertEquals(error.code === AiErrorCode.Timeout, false)
  })

  it("does not issue a request when the signal is already aborted", async () => {
    const controller = new AbortController()
    controller.abort()
    const { client, fake } = harness([{ body: completionBody("unused") }])
    await assertRejects(() => client.chatCompletion({ ...ASK, signal: controller.signal }))
    assertEquals(fake.calls(), 0)
  })

  it("reports a caller abort when the signal fires while the request is in flight", async () => {
    const controller = new AbortController()
    const { client, fake } = harness([{ hangs: true }])
    const pending = client.chatCompletion({
      ...ASK,
      timeoutMs: 10_000,
      signal: controller.signal,
    })
    // The abort lands once the request is provably in flight, and the deadline is
    // never advanced, so the abort is the only thing that can settle the attempt.
    await fake.whenCalled(1)
    controller.abort()

    const error = await assertRejects(() => pending)
    assertEquals(isAiError(error), true, "a raw abort reason must not escape")
    if (!isAiError(error)) return
    assertEquals(error.kind, "abort", "a caller abort is not a timeout")
    assertEquals(error.code, AiErrorCode.Aborted)
    assertEquals(fake.calls(), 1, "an abort is not retried")
    assertEquals(fake.requests[0].signalled, true, "the request must carry a signal")
  })

  it("stops a backoff wait when the caller aborts", async () => {
    const controller = new AbortController()
    const { client } = harness([{ networkError: new TypeError("connection reset") }])
    const pending = client.chatCompletion({
      ...ASK,
      signal: controller.signal,
      timeoutMs: 10_000,
    })
    // The first attempt fails and the client is now waiting on the fake timer.
    await Promise.resolve()
    controller.abort()

    const error = await assertRejects(() => pending)
    assertEquals(isAiError(error), true, "a raw abort reason must not escape")
    if (isAiError(error)) assertEquals(error.kind, "abort")
  })
})

describe("chatCompletion reports usage", () => {
  it("returns usage exactly as the provider reported it", async () => {
    const { client } = harness([
      {
        body: completionBody("hi", {
          usage: { prompt_tokens: 11, completion_tokens: 7, total_tokens: 18 },
        }),
      },
    ])
    const result = await client.chatCompletion(ASK)
    assertEquals(result.content, "hi")
    assertEquals(result.model, "fake-model")
    assertEquals(result.finishReason, "stop")
    assertEquals(result.usage, { promptTokens: 11, completionTokens: 7, totalTokens: 18 })
  })

  it("omits usage when the provider omits it", async () => {
    const { client } = harness([{ body: completionBody("hi") }])
    const result = await client.chatCompletion(ASK)
    assertEquals(result.usage, undefined)
    assertEquals("usage" in result, false)
  })

  it("passes a partially reported usage through without zero-filling", async () => {
    const { client } = harness([{ body: completionBody("hi", { usage: { total_tokens: 18 } }) }])
    const result = await client.chatCompletion(ASK)
    assertEquals(result.usage, { totalTokens: 18 })
    assertEquals(result.usage?.promptTokens, undefined)
  })

  it("treats an unrecognised usage object as absent", async () => {
    const { client } = harness([{ body: completionBody("hi", { usage: { cached: 4 } }) }])
    const result = await client.chatCompletion(ASK)
    assertEquals(result.usage, undefined)
  })
})

describe("chatCompletion retry policy", () => {
  it("honours Retry-After instead of the computed backoff", async () => {
    const { client, timer, fake } = harness([
      { status: 429, body: { error: { message: "slow down" } }, headers: { "retry-after": "2" } },
      { body: completionBody("ok") },
    ])
    const result = await client.chatCompletion(ASK)

    assertEquals(result.content, "ok")
    assertEquals(fake.calls(), 2)
    assertEquals(timer.backoffs(), [2000], "Retry-After: 2 must be read as 2000ms")
  })

  it("uses the computed backoff when the provider sends no Retry-After", async () => {
    const { client, timer } = harness([
      { status: 503, body: {} },
      { status: 503, body: {} },
      { body: completionBody("ok") },
    ])
    await client.chatCompletion(ASK)
    assertEquals(timer.backoffs(), [500, 1000])
  })

  it("gives up after the attempt cap on a persistent 429", async () => {
    const { client, fake } = harness(
      [
        { status: 429, body: {} },
        { status: 429, body: {} },
        { status: 429, body: {} },
        { status: 429, body: {} },
      ],
      { apiKey: FAKE_API_KEY, retry: { maxAttempts: 3 } },
    )
    const error = await assertRejects(() => client.chatCompletion(ASK))

    assertEquals(fake.calls(), 3, "the cap is 3 attempts, not 4")
    assertEquals(fake.remaining(), 1, "the fourth reply must stay unclaimed")
    assertEquals(isAiError(error) ? error.attempts : 0, 3)
    assertEquals(isAiError(error) ? error.status : 0, 429)
  })

  it("does not retry a 400", async () => {
    const { client, fake, timer } = harness([
      { status: 400, body: { error: { message: "bad body" } } },
      { body: completionBody("unused") },
    ])
    await assertRejects(() => client.chatCompletion(ASK))

    assertEquals(fake.calls(), 1)
    assertEquals(timer.backoffs(), [], "nothing was retried")
  })

  for (const status of [401, 403, 404]) {
    it(`does not retry a ${status}`, async () => {
      const { client, fake } = harness([{ status, body: {} }, { body: completionBody("unused") }])
      await assertRejects(() => client.chatCompletion(ASK))
      assertEquals(fake.calls(), 1)
    })
  }

  it("retries a network error", async () => {
    const { client, fake } = harness([
      { networkError: new TypeError("connection reset") },
      { body: completionBody("ok") },
    ])
    const result = await client.chatCompletion(ASK)
    assertEquals(result.content, "ok")
    assertEquals(fake.calls(), 2)
  })

  it("reports a network error after the attempt cap", async () => {
    const { client, fake } = harness(
      [
        { networkError: new TypeError("connection reset") },
        { networkError: new TypeError("connection reset") },
        { networkError: new TypeError("connection reset") },
      ],
      { apiKey: FAKE_API_KEY, retry: { maxAttempts: 2 } },
    )
    const error = await assertRejects(() => client.chatCompletion(ASK))
    assertEquals(fake.calls(), 2)
    assertEquals(isAiError(error) ? error.code : 0, AiErrorCode.NetworkError)
    assertEquals(isAiError(error) ? error.attempts : 0, 2)
  })

  it("bounds the total wait, waits included", async () => {
    const { client, timer, fake } = harness([
      { status: 503, body: {} },
      { status: 503, body: {} },
      { body: completionBody("ok") },
    ])
    await client.chatCompletion(ASK)

    assertEquals(fake.calls(), 3)
    // What the call *waited on*: one backoff per retry, and one timeout deadline
    // per attempt that was still pending when the answer arrived. The deadlines
    // are released by `cancel`; the backoffs are the only time deliberately
    // spent, and they are the whole retry budget here.
    assertEquals(timer.backoffs(), [500, 1_000], "the only time the call chose to spend")
    assertEquals(timer.slept(), 3 * 60_000 + 1_500, "three deadlines plus the backoffs")
    assertEquals(timer.elapsed(), 0, "no wall clock: the clock only moves on demand")
  })

  it("releases a request deadline once the request has settled", async () => {
    const { client, timer } = harness([{ body: completionBody("fast") }])
    await client.chatCompletion(ASK)
    assertEquals(timer.cancelled.length, 1, "the timeout wait must not stay scheduled")
    assertEquals(timer.cancelled[0].kind, "deadline")
    assertEquals(timer.cancelled[0].ms, 60_000)
  })

  it("releases every request deadline across a retry chain", async () => {
    const { client, timer } = harness([
      { status: 503, body: {} },
      { body: completionBody("ok") },
    ])
    await client.chatCompletion(ASK)
    assertEquals(timer.cancelled.filter((wait) => wait.kind === "deadline").length, 2)
    assertEquals(timer.cancelled.filter((wait) => wait.kind === "backoff").length, 0)
  })

  it("stops retrying when a wait would overrun maxElapsedMs", async () => {
    const { client, timer, fake } = harness(
      [{ status: 503, body: {} }, { body: completionBody("unused") }],
      { apiKey: FAKE_API_KEY, retry: { baseDelayMs: 5_000, maxElapsedMs: 500 } },
    )
    await assertRejects(() => client.chatCompletion(ASK))

    assertEquals(fake.calls(), 1, "the wait would have overrun the budget")
    assertEquals(timer.backoffs(), [], "no backoff was taken")
  })

  it("stops retrying when Retry-After exceeds maxRetryAfterMs", async () => {
    const { client, fake, timer } = harness([
      { status: 429, body: {}, headers: { "retry-after": "3600" } },
      { body: completionBody("unused") },
    ])
    const error = await assertRejects(() => client.chatCompletion(ASK))

    assertEquals(fake.calls(), 1)
    assertEquals(timer.backoffs(), [], "an hour-long Retry-After is not obeyed")
    assertEquals(isAiError(error) ? error.status : 0, 429)
  })

  it("retries a malformed 2xx envelope once it has a valid reply", async () => {
    const { client } = harness([{ body: { choices: [] } }, { body: completionBody("recovered") }])
    const result = await client.chatCompletion(ASK)
    assertEquals(result.content, "recovered")
  })
})

describe("chatCompletion request shape", () => {
  it("sends the messages, model, temperature and max_tokens it was given", async () => {
    const { client, fake } = harness([{ body: completionBody("ok") }])
    await client.chatCompletion({
      messages: [
        { role: "system", content: "sys" },
        { role: "user", content: "usr" },
      ],
      model: "fake-model",
      temperature: 0.3,
      maxTokens: 2000,
      responseFormat: "json_object",
      extra: { top_p: 0.9 },
    })

    const request = fake.requests[0]
    assertEquals(request.url, `${FAKE_BASE_URL}/chat/completions`)
    assertEquals(request.method, "POST")
    assertEquals(request.headers["content-type"], "application/json")
    assertEquals(request.body, {
      messages: [
        { role: "system", content: "sys" },
        { role: "user", content: "usr" },
      ],
      model: "fake-model",
      temperature: 0.3,
      max_tokens: 2000,
      response_format: { type: "json_object" },
      top_p: 0.9,
    })
    assertEquals(request.signalled, true, "every request must carry an abort signal")
  })

  it("falls back to the default base URL when none is configured", async () => {
    const fake = createFakeFetcher([{ body: completionBody("ok") }])
    const client = createChatClient({
      apiKey: FAKE_API_KEY,
      fetcher: fake.fetcher,
      timer: createFakeTimer(),
    })
    await client.chatCompletion(ASK)
    assertEquals(fake.requests[0].url, `${DEFAULT_BASE_URL}/chat/completions`)
  })

  it("sends the key only as a bearer header", async () => {
    const { client, fake } = harness([{ body: completionBody("ok") }])
    await client.chatCompletion(ASK)
    assertEquals(fake.requests[0].headers.authorization, `Bearer ${FAKE_API_KEY}`)
    assertEquals(JSON.stringify(fake.requests[0].body).includes(FAKE_API_KEY), false)
  })

  it("sends no field the request type does not declare", async () => {
    const { client, fake } = harness([{ body: completionBody("ok") }])
    await client.chatCompletion(ASK)
    const request = fake.requests[0]

    // A per-request key would arrive as an extra body field or an extra header.
    // Pinning the exact key set is what makes that inexpressible in practice,
    // not just in the type.
    assertEquals(Object.keys(request.body).sort(), ["messages"])
    assertEquals(Object.keys(request.headers).sort(), ["authorization", "content-type"])
    assertEquals(request.headers.authorization, `Bearer ${FAKE_API_KEY}`)
  })

  it("cannot express a per-request API key", () => {
    const client = createChatClient({ apiKey: FAKE_API_KEY })
    // @ts-expect-error a per-request key must not be part of the request type
    void (() => client.chatCompletion({ ...ASK, apiKey: "sk-attacker-supplied" }))
  })
})

describe("errors never carry a stack, a path or a credential", () => {
  const leakyKey = "sk-live-looking-key-that-must-not-travel"

  it("keeps frame text and paths out of everything a route would surface", async () => {
    // One attempt: a 500 is retryable, and this test is about the error surface,
    // not about the retry — so the one queued reply is the reply that surfaces.
    const { client } = harness(
      [{ status: 500, body: { error: { message: "internal" } } }],
      { apiKey: FAKE_API_KEY, retry: { maxAttempts: 1 } },
    )
    const error = await assertRejects(() => client.chatCompletion(ASK))
    assertNotExhausted(error)
    const payload = serialized(error)

    // The contract: a route that puts the error on the wire — `JSON.stringify`
    // of the error, or of a hand-picked `{ error, detail }` — cannot carry a
    // stack frame, a source path or a credential. `serialized` is the enumerable
    // own-property surface, `name` and `message` included; `stack` is the
    // runtime's own non-enumerable addition and is never copied into any field.
    //
    // A substring probe for the word `stack` is the wrong shape of check: the
    // scrubber's own marker is `<stack frame redacted>`, so the probe reddens on
    // correctly scrubbed input, while real frame text never carries the word.
    // `hasFrameText` is the sound check — frame *shape*, not the word — and the
    // marker's absence pins the other direction: the scrubber never fired here.
    assertEquals(hasFrameText(payload), false, payload)
    assertEquals(payload.includes("<stack frame redacted>"), false, payload)
    assertEquals(payload.includes(".ts:"), false, payload)
    assertEquals(payload.includes("/srv/"), false, payload)
  })

  it("reports a transport failure without its stack", async () => {
    const { client } = harness([{ networkError: new TypeError("error sending request for url") }])
    const error = await assertRejects(() => client.chatCompletion(ASK))
    const payload = serialized(error)

    assertEquals(hasFrameText(payload), false, payload)
    assertEquals(payload.includes("<stack frame redacted>"), false, payload)
    assertEquals(payload.includes("chat.test.ts"), false, payload)
  })

  it("keeps a provider message from leaking a key or a frame", async () => {
    // One attempt, so the single queued reply is what surfaces — a 500 is
    // retryable and an exhausted fixture would otherwise be the error asserted on.
    const { client } = harness(
      [
        {
          status: 500,
          body: {
            error: {
              message:
                `internal error at handler (/srv/app/routes/api/chat.ts:41:9) using ${leakyKey}`,
            },
          },
        },
      ],
      { apiKey: FAKE_API_KEY, retry: { maxAttempts: 1 } },
    )
    const error = await assertRejects(() => client.chatCompletion(ASK))
    assertNotExhausted(error)

    const haystack = isAiError(error) ? surfacedStrings(error).join(" ") : ""
    // The credential never travels.
    assertEquals(haystack.includes(leakyKey), false)
    assertEquals(serialized(error).includes(leakyKey), false)
    // Neither does a path, a line number or a frame, even though the provider put
    // all three in its own message: the frame is redacted and the description
    // survives.
    assertEquals(haystack.includes("/srv/"), false, haystack)
    assertEquals(haystack.includes(".ts:"), false, haystack)
    assertEquals(hasFrameText(haystack), false, haystack)
    assertMatch(haystack, /internal error/)
    assertMatch(haystack, /<stack frame redacted>/)
    assertMatch(haystack, /<REDACTED:API_KEY>/)
  })

  it("redacts a key the provider echoes into its own message", async () => {
    const { client } = harness([{
      status: 401,
      body: { error: { message: `bad key ${leakyKey}` } },
    }])
    const error = await assertRejects(() => client.chatCompletion(ASK))
    const haystack = isAiError(error) ? surfacedStrings(error).join(" ") : ""
    assertEquals(haystack.includes(leakyKey), false)
    assertEquals(haystack.includes("<REDACTED:API_KEY>"), true)
  })

  it("reports a transport failure without a frame or a path", async () => {
    const { client } = harness([{ networkError: new TypeError("error sending request for url") }])
    const error = await assertRejects(() => client.chatCompletion(ASK))
    const haystack = isAiError(error) ? surfacedStrings(error).join(" ") : ""
    assertEquals(haystack.includes(".ts:"), false, `file path: ${haystack}`)
    assertEquals(/at [A-Za-z_$][\w$.]* \(/.test(haystack), false, `frame text: ${haystack}`)
  })

  it("never logs the key, the prompt or the completion", async () => {
    const { client, lines, fake } = harness([
      { status: 503, body: { error: { message: `failed with ${leakyKey}` } } },
      { body: completionBody("a secret completion") },
    ])
    await client.chatCompletion({ messages: [{ role: "user", content: "a secret prompt" }] })
    assertEquals(fake.calls(), 2, "the first reply was a retryable 503")

    assertEquals(lines.length, 1, "one retry must produce exactly one log line")
    const logged = JSON.stringify(lines)
    assertEquals(logged.includes(leakyKey), false)
    assertEquals(logged.includes("a secret prompt"), false)
    assertEquals(logged.includes("a secret completion"), false)
    assertEquals(logged.includes(FAKE_API_KEY), false)
    assertEquals(lines[0].fields.delayMs, 500)
  })
})
