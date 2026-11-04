import { assert, assertEquals, assertThrows } from "@std/assert"
import { describe, it } from "@std/testing/bdd"
import { type } from "arktype"
import {
  chatJson,
  type ChatJsonRequest,
  createChatClient,
  LLM_PRESETS,
  type LlmUsage,
  type SpendGuard,
  type SpendRequest,
} from "./llm.ts"

const KEY = "sk-REALKEYISH-0123456789"
const PROMPT = "Turn this statement row into json: 2026-11-01 COFFEE HOUSE PERSONALNAME 4.50"

interface Call {
  url: string
  init: RequestInit
  body: Record<string, unknown>
}

/** A fetch stub that records every call and answers each with `respond()`. */
const stub = (respond: () => Response | Promise<Response>) => {
  const calls: Call[] = []
  const fetcher = ((input: RequestInfo | URL, init: RequestInit = {}) => {
    calls.push({ url: String(input), init, body: JSON.parse(String(init.body)) })
    return Promise.resolve().then(respond)
  }) as typeof fetch
  return { calls, fetcher }
}

/** A chat completion as DeepSeek answers it, with `content` as the model's text. */
const completion = (content: string | null, finishReason = "stop") =>
  Response.json({
    id: "0195f1e2-7c3a-7000-8000-000000000001",
    object: "chat.completion",
    choices: [{ index: 0, message: { role: "assistant", content }, finish_reason: finishReason }],
    usage: {
      prompt_tokens: 120,
      completion_tokens: 30,
      total_tokens: 150,
      prompt_cache_hit_tokens: 100,
      prompt_cache_miss_tokens: 20,
    },
  })

const Row = type({ date: "string", amount: "number.integer" })

const request = (overrides: Partial<ChatJsonRequest<typeof Row>> = {}) => ({
  messages: [{ role: "user" as const, content: PROMPT }],
  schema: Row,
  maxTokens: 200,
  ...overrides,
})

const deepseek = (fetcher: typeof fetch) =>
  createChatClient({
    baseUrl: LLM_PRESETS.deepseek,
    apiKey: KEY,
    model: "deepseek-flash",
    fetch: fetcher,
  })

/** A guard that records what it was asked and told, answering `allow`. */
const recordingGuard = (allow: boolean) => {
  const reserved: SpendRequest[] = []
  const recorded: LlmUsage[] = []
  const guard: SpendGuard = {
    reserve: (spend) => {
      reserved.push(spend)
      return Promise.resolve(allow)
    },
    record: (usage) => {
      recorded.push(usage)
      return Promise.resolve()
    },
  }
  return { guard, reserved, recorded }
}

describe("chatJson", () => {
  it("returns the reply's JSON when it matches the schema", async () => {
    const { calls, fetcher } = stub(() => completion(`{"date":"2026-11-01","amount":450}`))
    const result = await chatJson(deepseek(fetcher), request())
    assertEquals(result, {
      success: true,
      output: {
        value: { date: "2026-11-01", amount: 450 },
        usage: {
          promptTokens: 120,
          completionTokens: 30,
          cacheHitTokens: 100,
          cacheMissTokens: 20,
        },
      },
      error: null,
    })
    assertEquals(calls[0].url, "https://api.deepseek.com/chat/completions")
    assertEquals(new Headers(calls[0].init.headers).get("authorization"), `Bearer ${KEY}`)
    assertEquals(calls[0].init.redirect, "manual")
    assertEquals(calls[0].body, {
      model: "deepseek-flash",
      messages: [{ role: "user", content: PROMPT }],
      max_tokens: 200,
      response_format: { type: "json_object" },
    })
  })

  it("returns an error, never data, for a reply that fails the schema", async () => {
    const { fetcher } = stub(() => completion(`{"date":"2026-11-01","amount":"4.50"}`))
    const result = await chatJson(deepseek(fetcher), request())
    assertEquals(result.success, false)
    assertEquals(result.output, null)
    assertEquals(result.error?.code, "invalid-reply")
  })

  it("returns invalid-reply for content that is not JSON", async () => {
    const { fetcher } = stub(() => completion("Sure! Here is the row."))
    const result = await chatJson(deepseek(fetcher), request())
    assertEquals(result.error?.code, "invalid-reply")
  })

  it("returns empty-reply for a blank reply that DeepSeek marks as stopped", async () => {
    const { fetcher } = stub(() => completion("   \n  ", "stop"))
    const result = await chatJson(deepseek(fetcher), request())
    assertEquals(result.error?.code, "empty-reply")
  })

  it("returns truncated when the reply stopped at the token cap", async () => {
    const { fetcher } = stub(() => completion(`{"date":"2026-`, "length"))
    const result = await chatJson(deepseek(fetcher), request())
    assertEquals(result.error?.code, "truncated")
  })

  it("returns timeout and sends the request exactly once when it times out", async () => {
    const { calls, fetcher } = stub(() => {
      throw new DOMException("The signal has been aborted", "TimeoutError")
    })
    const result = await chatJson(deepseek(fetcher), request())
    assertEquals(result.error?.code, "timeout")
    assertEquals(calls.length, 1)
  })

  it("sends a 5xx once and reports it as unavailable", async () => {
    const { calls, fetcher } = stub(() => new Response("busy", { status: 503 }))
    const result = await chatJson(deepseek(fetcher), request())
    assertEquals(result.error, {
      code: "unavailable",
      message: "the server answered HTTP 503",
      status: 503,
    })
    assertEquals(calls.length, 1)
  })

  it("maps each documented status to its code", async () => {
    const expected: Record<number, string> = {
      400: "invalid-request",
      401: "bad-key",
      402: "insufficient-balance",
      422: "invalid-request",
      429: "rate-limited",
      500: "unavailable",
      418: "http-error",
    }
    for (const [status, code] of Object.entries(expected)) {
      const { fetcher } = stub(() => new Response(null, { status: Number(status) }))
      const result = await chatJson(deepseek(fetcher), request())
      assertEquals({ status, code: result.error?.code }, { status, code })
    }
  })

  it("refuses a redirect instead of following it", async () => {
    const { fetcher } = stub(() =>
      new Response(null, { status: 307, headers: { location: "https://elsewhere.example" } })
    )
    const result = await chatJson(deepseek(fetcher), request())
    assertEquals(result.error?.code, "redirected")
  })

  it("never calls fetch when the spend guard refuses", async () => {
    const { calls, fetcher } = stub(() => completion(`{"date":"2026-11-01","amount":450}`))
    const { guard, reserved } = recordingGuard(false)
    const result = await chatJson(deepseek(fetcher), request({ guard }))
    assertEquals(result.error?.code, "over-budget")
    assertEquals(calls.length, 0)
    assertEquals(reserved, [
      { model: "deepseek-flash", maxTokens: 200, promptCharacters: PROMPT.length },
    ])
  })

  it("never calls fetch when the spend guard throws", async () => {
    const { calls, fetcher } = stub(() => completion(`{"date":"2026-11-01","amount":450}`))
    const guard: SpendGuard = {
      reserve: () => Promise.reject(new Error("store down")),
      record: () => Promise.resolve(),
    }
    const result = await chatJson(deepseek(fetcher), request({ guard }))
    assertEquals(result.error?.code, "over-budget")
    assertEquals(calls.length, 0)
  })

  it("records the reply's token counts, a reply that fails the schema included", async () => {
    const { fetcher } = stub(() => completion(`{"wrong":true}`))
    const { guard, recorded } = recordingGuard(true)
    const result = await chatJson(deepseek(fetcher), request({ guard }))
    assertEquals(result.error?.code, "invalid-reply")
    assertEquals(recorded, [
      { promptTokens: 120, completionTokens: 30, cacheHitTokens: 100, cacheMissTokens: 20 },
    ])
  })

  it("reads OpenAI's cached-token count and caps with max_completion_tokens", async () => {
    const { calls, fetcher } = stub(() =>
      Response.json({
        choices: [{ message: { content: `{"date":"d","amount":1}` }, finish_reason: "stop" }],
        usage: {
          prompt_tokens: 50,
          completion_tokens: 5,
          prompt_tokens_details: { cached_tokens: 10 },
        },
      })
    )
    const client = createChatClient({
      baseUrl: LLM_PRESETS.openai,
      apiKey: KEY,
      model: "gpt-5-mini",
      fetch: fetcher,
    })
    const result = await chatJson(client, request())
    assertEquals(result.output?.usage, {
      promptTokens: 50,
      completionTokens: 5,
      cacheHitTokens: 10,
      cacheMissTokens: 40,
    })
    assertEquals(calls[0].url, "https://api.openai.com/v1/chat/completions")
    assertEquals(calls[0].body.max_completion_tokens, 200)
    assertEquals("max_tokens" in calls[0].body, false)
  })

  it("refuses a request whose messages never say json, without sending it", async () => {
    const { calls, fetcher } = stub(() => completion(`{}`))
    const result = await chatJson(
      deepseek(fetcher),
      request({ messages: [{ role: "user", content: "hello" }] }),
    )
    assertEquals(result.error?.code, "invalid-request")
    assertEquals(calls.length, 0)
  })

  it("refuses a maxTokens that is not a positive integer, without sending it", async () => {
    const { calls, fetcher } = stub(() => completion(`{}`))
    const result = await chatJson(deepseek(fetcher), request({ maxTokens: 0 }))
    assertEquals(result.error?.code, "invalid-request")
    assertEquals(calls.length, 0)
  })
})

describe("no LLM error carries the key, the prompt or the URL", () => {
  const PROMPT_WORDS = ["Turn this", "COFFEE", "PERSONALNAME", "statement"]

  const assertClean = (label: string, value: unknown): void => {
    const text = JSON.stringify(value)
    const leaks = [KEY, "REALKEYISH", "api.deepseek.com", ...PROMPT_WORDS].filter((part) =>
      text.includes(part)
    )
    assertEquals({ label, leaks }, { label, leaks: [] })
  }

  const failures: Record<string, () => Response | Promise<Response>> = {
    "transport failure quoting the URL and key": () => {
      throw new TypeError(`error sending request for url (https://api.deepseek.com/?k=${KEY})`)
    },
    "provider error text echoing the prompt and key": () =>
      Response.json({ error: { message: `Incorrect API key ${KEY} for: ${PROMPT}` } }, {
        status: 401,
      }),
    "a reply echoing the prompt that is not JSON": () => completion(PROMPT),
    "a reply body that is not a chat completion": () => new Response(`${PROMPT} ${KEY}`),
  }

  for (const [label, respond] of Object.entries(failures)) {
    it(`keeps them out of ${label}`, async () => {
      const { fetcher } = stub(respond)
      const result = await chatJson(deepseek(fetcher), request())
      assertEquals(result.success, false)
      assertClean(label, result)
    })
  }

  it("keeps them out of a reply echoing the prompt that fails the schema", async () => {
    // A literal union makes arktype quote the rejected value in its own message.
    const { fetcher } = stub(() => completion(JSON.stringify({ kind: PROMPT })))
    const result = await chatJson(deepseek(fetcher), {
      ...request(),
      schema: type({ kind: "'debit' | 'credit'" }),
    })
    assertEquals(result.error?.code, "invalid-reply")
    assertClean("schema failure", result)
  })

  it("keeps them out of a request that fails validation", async () => {
    const { fetcher } = stub(() => completion(`{}`))
    const result = await chatJson(
      deepseek(fetcher),
      // The role is checked against a literal union, whose message would quote it.
      request({ messages: [{ role: PROMPT as "user", content: PROMPT }] }),
    )
    assertEquals(result.error?.code, "invalid-request")
    assertClean("invalid request", result)
  })

  it("keeps the key out of the client object a log line would print", () => {
    const client = deepseek(stub(() => completion(`{}`)).fetcher)
    assertClean("client", client)
    assert(!String(Object.values(client)).includes(KEY))
  })
})

describe("createChatClient", () => {
  it("lets a local Ollama run without a key and sends no Authorization header", async () => {
    const { calls, fetcher } = stub(() => completion(`{"date":"d","amount":1}`))
    const client = createChatClient({ baseUrl: LLM_PRESETS.ollama, model: "qwen3", fetch: fetcher })
    const result = await chatJson(client, request())
    assertEquals(result.success, true)
    assertEquals(calls[0].url, "http://localhost:11434/v1/chat/completions")
    assertEquals(new Headers(calls[0].init.headers).has("authorization"), false)
  })

  it("accepts a preset with another host, such as Ollama in a sibling container", async () => {
    const { calls, fetcher } = stub(() => completion(`{"date":"d","amount":1}`))
    const client = createChatClient({
      baseUrl: { ...LLM_PRESETS.ollama, baseUrl: "http://ollama:11434/v1/" },
      model: "qwen3",
      fetch: fetcher,
    })
    await chatJson(client, request())
    assertEquals(calls[0].url, "http://ollama:11434/v1/chat/completions")
  })

  it("requires a key for a plain URL and for every preset but Ollama", () => {
    for (const baseUrl of ["https://llm.example", LLM_PRESETS.deepseek, LLM_PRESETS.gemini]) {
      assertThrows(() => createChatClient({ baseUrl, model: "m" }), TypeError, "apiKey is required")
    }
  })

  it("refuses to send a key over plain http to another host", () => {
    assertThrows(
      () => createChatClient({ baseUrl: "http://llm.example/v1", apiKey: KEY, model: "m" }),
      TypeError,
      "only over https",
    )
  })

  it("refuses a base URL that carries credentials or a query, without echoing it", () => {
    for (const baseUrl of [`https://user:${KEY}@llm.example`, `https://llm.example/?key=${KEY}`]) {
      const error = assertThrows(() => createChatClient({ baseUrl, apiKey: KEY, model: "m" }))
      assert(error instanceof TypeError)
      assertEquals(error.message.includes(KEY), false)
    }
  })

  it("points Gemini at its OpenAI-compatible root", async () => {
    const { calls, fetcher } = stub(() => completion(`{"date":"d","amount":1}`))
    const client = createChatClient({
      baseUrl: LLM_PRESETS.gemini,
      apiKey: KEY,
      model: "gemini-flash",
      fetch: fetcher,
    })
    await chatJson(client, request())
    assertEquals(
      calls[0].url,
      "https://generativelanguage.googleapis.com/v1beta/openai/chat/completions",
    )
  })
})
