/**
 * A JSON chat client for any OpenAI-compatible model API: OpenAI, DeepSeek, Google Gemini, Ollama,
 * or any other server that speaks `POST /chat/completions`.
 *
 * Behaviour:
 *
 *  - {@link chatJson} never throws and returns `{ success, output, error }`. The reply's content
 *    is parsed as JSON and checked with the caller's arktype schema; a reply that fails is an
 *    error, never data.
 *  - **One request per call, never a retry.** A request that timed out after it was sent may
 *    already be billed, so only the caller decides whether to send it again.
 *  - **Spend guard.** An optional {@link SpendGuard} is asked before anything is sent; when it
 *    refuses, no request leaves the host. Every reply that carries token counts is reported to it,
 *    the ones that then fail the schema included, because the provider billed them.
 *  - **Nothing secret in an error.** No error carries the key, the URL, any message text or any
 *    part of the reply: transport failures are reported by class name (`describeTransportError`),
 *    HTTP failures by status alone (a provider's error text can echo the request), and schema
 *    failures by a fixed sentence. A redirect is refused, so the key never travels to another host.
 *  - The request is bounded by `AbortSignal.timeout`, and the reply is read under a byte cap
 *    (`readBoundedJson`).
 *
 * Endpoints checked against each provider's own docs on 2026-11-04 (see the package README).
 * @module
 */

import { type Type, type } from "arktype"
import { BodyReadTimeoutError, readBoundedJson } from "@spy4x/net/bounded-body"
import { describeTransportError, isRequestTimeout, releaseResponseBody } from "./retry.ts"

/** Where a provider's OpenAI-compatible API lives and how it differs from OpenAI's. */
export interface LlmEndpoint {
  /** The API root; `/chat/completions` is appended to it. */
  baseUrl: string
  /** False when the server needs no key, as a local Ollama. A plain URL needs one. */
  keyRequired: boolean
  /** The request field that caps the reply's tokens. OpenAI deprecated `max_tokens`. */
  maxTokensField: "max_tokens" | "max_completion_tokens"
}

/**
 * The OpenAI-compatible endpoints of OpenAI, DeepSeek, Google Gemini and a local Ollama. Data, not code:
 * pass one as `baseUrl` to {@link createChatClient}, or spread it to change the host, such as
 * `{ ...LLM_PRESETS.ollama, baseUrl: "http://ollama:11434/v1" }` for Ollama in another container.
 */
export const LLM_PRESETS: Readonly<
  Record<"openai" | "deepseek" | "gemini" | "ollama", LlmEndpoint>
> = Object.freeze({
  openai: Object.freeze(
    {
      baseUrl: "https://api.openai.com/v1",
      keyRequired: true,
      maxTokensField: "max_completion_tokens",
    } as const,
  ),
  deepseek: Object.freeze(
    {
      baseUrl: "https://api.deepseek.com",
      keyRequired: true,
      maxTokensField: "max_tokens",
    } as const,
  ),
  gemini: Object.freeze(
    {
      baseUrl: "https://generativelanguage.googleapis.com/v1beta/openai",
      keyRequired: true,
      maxTokensField: "max_tokens",
    } as const,
  ),
  ollama: Object.freeze(
    {
      baseUrl: "http://localhost:11434/v1",
      keyRequired: false,
      maxTokensField: "max_tokens",
    } as const,
  ),
})

/** How long one call may take by default: a model can think for a while before it answers. */
export const LLM_DEFAULT_TIMEOUT_MS = 120_000

/** The largest reply body read, in bytes. */
const MAX_REPLY_BYTES = 8 * 1024 * 1024

/** Options for {@link createChatClient}. */
export interface ChatClientOptions {
  /** A preset from {@link LLM_PRESETS}, a variation of one, or the API root of any compatible server. */
  baseUrl: string | LlmEndpoint
  /** Sent as `Authorization: Bearer`. Required unless the endpoint says `keyRequired: false`. */
  apiKey?: string
  /** The model name, such as `deepseek-flash`. */
  model: string
  /** Defaults to `globalThis.fetch`. */
  fetch?: typeof fetch
  /** Limit for one call, request and reply together. {@link LLM_DEFAULT_TIMEOUT_MS} by default. */
  timeoutMs?: number
}

/** A configured client. Holds no key or address a log line could print: they live inside the module. */
export interface ChatClient {
  /** The model this client asks. */
  readonly model: string
}

/** One message of a conversation. */
export interface ChatMessage {
  role: "system" | "user" | "assistant"
  content: string
}

/** What a {@link SpendGuard} is asked to allow before a request is sent. */
export interface SpendRequest {
  model: string
  /** The cap on the reply's tokens. */
  maxTokens: number
  /** The length of every message's text together, for estimating the prompt's tokens. */
  promptCharacters: number
}

/** Token counts of one reply, as the provider billed them. */
export interface LlmUsage {
  promptTokens: number
  completionTokens: number
  /** Prompt tokens served from the provider's cache; 0 when the provider does not say. */
  cacheHitTokens: number
  /** Prompt tokens not served from the cache. */
  cacheMissTokens: number
}

/**
 * The port an app implements to cap what it spends, for example over `@spy4x/server/quota`'s
 * `QuotaMeter`. `reserve` answers whether the request may be sent; `record` receives what the
 * reply cost. A timeout or a dropped connection after sending calls neither again: the
 * reservation stays, because the provider may have billed it.
 */
export interface SpendGuard {
  reserve(request: SpendRequest): Promise<boolean>
  record(usage: LlmUsage): Promise<void>
}

/** Options for {@link chatJson}. */
export interface ChatJsonRequest<S extends Type> {
  /** At least one message, and one must contain the word "json", as JSON mode requires. */
  messages: readonly ChatMessage[]
  /** The arktype schema the reply's JSON must satisfy. */
  schema: S
  /** The cap on the reply's tokens. Required: DeepSeek's own default is 8K. */
  maxTokens: number
  /** 0 to 2. Omitted, the provider's default applies. */
  temperature?: number
  /** Asked before sending and told the cost after. */
  guard?: SpendGuard
}

/** Why a call failed. Branch on it, never on `message`. */
export type LlmErrorCode =
  | "invalid-request"
  | "over-budget"
  | "bad-key"
  | "insufficient-balance"
  | "rate-limited"
  | "unavailable"
  | "http-error"
  | "redirected"
  | "timeout"
  | "network-error"
  | "content-filtered"
  | "truncated"
  | "empty-reply"
  | "invalid-reply"

/** A failed call. `message` never holds the key, the URL, the prompt or the reply. */
export interface LlmError {
  code: LlmErrorCode
  message: string
  /** The HTTP status, when the server answered with one. */
  status?: number
}

/** Outcome of {@link chatJson}. */
export type ChatJsonResult<T> =
  | { success: true; output: { value: T; usage: LlmUsage }; error: null }
  | { success: false; output: null; error: LlmError }

interface ClientConfig {
  url: string
  apiKey?: string
  model: string
  maxTokensField: LlmEndpoint["maxTokensField"]
  fetch: typeof fetch
  timeoutMs: number
}

const configs = new WeakMap<ChatClient, ClientConfig>()

/** Printable ASCII without spaces, so `Headers` cannot throw on it. */
const KEY_SHAPE = /^[\x21-\x7E]+$/
const LOOPBACK = new Set(["localhost", "127.0.0.1", "[::1]"])

/**
 * Builds a client. Throws a `TypeError` on a missing or malformed option, so a wrong setup fails
 * at start-up rather than on the first call. The messages name the option, never its value.
 *
 * A key is sent only over `https`, or over `http` to this machine (`localhost`, `127.0.0.1`,
 * `[::1]`), so it never crosses a network in clear text.
 *
 * @example
 * ```ts
 * const client = createChatClient({
 *   baseUrl: LLM_PRESETS.deepseek,
 *   apiKey: "<REDACTED:API_KEY>",
 *   model: "deepseek-flash",
 * })
 * ```
 */
export const createChatClient = (options: ChatClientOptions): ChatClient => {
  if (typeof options !== "object" || options === null) {
    throw new TypeError("createChatClient: expected an options object")
  }
  const endpoint: LlmEndpoint = typeof options.baseUrl === "string"
    ? { baseUrl: options.baseUrl, keyRequired: true, maxTokensField: "max_tokens" }
    : options.baseUrl
  if (typeof endpoint !== "object" || endpoint === null || typeof endpoint.baseUrl !== "string") {
    throw new TypeError("createChatClient: baseUrl must be a URL or an endpoint from LLM_PRESETS")
  }
  let url: URL
  try {
    url = new URL(endpoint.baseUrl)
  } catch {
    throw new TypeError("createChatClient: baseUrl is not a valid URL")
  }
  if (url.protocol !== "https:" && url.protocol !== "http:") {
    throw new TypeError("createChatClient: baseUrl must be http or https")
  }
  if (url.username !== "" || url.password !== "" || url.search !== "" || url.hash !== "") {
    throw new TypeError("createChatClient: baseUrl must not carry credentials, a query or a hash")
  }
  if (
    endpoint.maxTokensField !== "max_tokens" && endpoint.maxTokensField !== "max_completion_tokens"
  ) {
    throw new TypeError(
      "createChatClient: maxTokensField must be max_tokens or max_completion_tokens",
    )
  }
  const { apiKey } = options
  if (apiKey !== undefined && (typeof apiKey !== "string" || !KEY_SHAPE.test(apiKey))) {
    throw new TypeError("createChatClient: apiKey must be printable ASCII without spaces")
  }
  if (apiKey === undefined && endpoint.keyRequired !== false) {
    throw new TypeError("createChatClient: apiKey is required for this endpoint")
  }
  if (apiKey !== undefined && url.protocol === "http:" && !LOOPBACK.has(url.hostname)) {
    throw new TypeError("createChatClient: an apiKey is sent only over https or to localhost")
  }
  if (typeof options.model !== "string" || options.model.trim() === "") {
    throw new TypeError("createChatClient: model is required")
  }
  const timeoutMs = options.timeoutMs ?? LLM_DEFAULT_TIMEOUT_MS
  if (!Number.isFinite(timeoutMs) || timeoutMs <= 0) {
    throw new TypeError("createChatClient: timeoutMs must be a positive number")
  }

  const client: ChatClient = Object.freeze({ model: options.model })
  configs.set(client, {
    url: `${url.href.replace(/\/+$/, "")}/chat/completions`,
    apiKey,
    model: options.model,
    maxTokensField: endpoint.maxTokensField,
    fetch: options.fetch ?? globalThis.fetch,
    timeoutMs,
  })
  return client
}

const ChatRequestShape = type({
  messages: type({
    role: "'system' | 'user' | 'assistant'",
    content: "string",
  }).array().atLeastLength(1),
  maxTokens: "number.integer > 0",
  "temperature?": "0 <= number <= 2",
})

const tokenCount = type("number.integer >= 0")

const ReplyShape = type({
  choices: type({
    message: { "content?": "string | null" },
    "finish_reason?": "string | null",
  }).array().atLeastLength(1),
  usage: {
    prompt_tokens: tokenCount,
    completion_tokens: tokenCount,
    "prompt_cache_hit_tokens?": tokenCount,
    "prompt_cache_miss_tokens?": tokenCount,
    "prompt_tokens_details?": type({ "cached_tokens?": tokenCount }).or("null"),
  },
})

/** What each HTTP status means to a caller. */
const STATUS_CODES: Record<number, LlmErrorCode> = {
  400: "invalid-request",
  401: "bad-key",
  402: "insufficient-balance",
  422: "invalid-request",
  429: "rate-limited",
  500: "unavailable",
  502: "unavailable",
  503: "unavailable",
  504: "unavailable",
}

const fail = (code: LlmErrorCode, message: string, status?: number): ChatJsonResult<never> => ({
  success: false,
  output: null,
  error: status === undefined ? { code, message } : { code, message, status },
})

const toUsage = (usage: typeof ReplyShape.infer.usage): LlmUsage => {
  const hit = usage.prompt_cache_hit_tokens ?? usage.prompt_tokens_details?.cached_tokens ?? 0
  return {
    promptTokens: usage.prompt_tokens,
    completionTokens: usage.completion_tokens,
    cacheHitTokens: hit,
    cacheMissTokens: usage.prompt_cache_miss_tokens ?? Math.max(0, usage.prompt_tokens - hit),
  }
}

/**
 * Asks the model for JSON and checks it with `schema`. Sends at most one request and never throws.
 *
 * The request asks for `response_format: { type: "json_object" }`. A reply is an error when it
 * stopped at the token cap (`"truncated"`), was blocked (`"content-filtered"`), is blank
 * (`"empty-reply"`, which DeepSeek can send with `finish_reason: "stop"`), or is not JSON the
 * schema accepts (`"invalid-reply"`).
 *
 * @example
 * ```ts
 * const result = await chatJson(client, {
 *   messages: [{ role: "user", content: `Answer in json: {"ok": true}` }],
 *   schema: type({ ok: "boolean" }),
 *   maxTokens: 100,
 * })
 * if (result.success) console.log(result.output.value.ok)
 * ```
 */
export const chatJson = async <S extends Type>(
  client: ChatClient,
  request: ChatJsonRequest<S>,
): Promise<ChatJsonResult<S["infer"]>> => {
  const config = configs.get(client)
  if (config === undefined) {
    return fail("invalid-request", "client was not made by createChatClient")
  }
  if (typeof request !== "object" || request === null) {
    return fail("invalid-request", "expected a request object")
  }
  const shape = ChatRequestShape({
    messages: request.messages,
    maxTokens: request.maxTokens,
    ...(request.temperature === undefined ? {} : { temperature: request.temperature }),
  })
  if (shape instanceof type.errors) {
    // `summary` would quote a message's text back; name only what is wrong.
    return fail(
      "invalid-request",
      "messages must be a non-empty list of { role, content }, maxTokens a positive integer " +
        "and temperature between 0 and 2",
    )
  }
  if (!shape.messages.some((message) => /json/i.test(message.content))) {
    return fail("invalid-request", `a message must contain the word "json", as JSON mode requires`)
  }
  if (typeof request.schema !== "function") {
    return fail("invalid-request", "schema must be an arktype type")
  }

  const { guard } = request
  if (guard !== undefined) {
    let allowed: boolean
    try {
      allowed = await guard.reserve({
        model: config.model,
        maxTokens: shape.maxTokens,
        promptCharacters: shape.messages.reduce((sum, message) => sum + message.content.length, 0),
      })
    } catch (cause) {
      return fail("over-budget", `the spend guard failed (${describeTransportError(cause)})`)
    }
    if (allowed !== true) return fail("over-budget", "the spend guard refused the request")
  }

  const headers: Record<string, string> = { "Content-Type": "application/json" }
  if (config.apiKey !== undefined) headers.Authorization = `Bearer ${config.apiKey}`
  const signal = AbortSignal.timeout(config.timeoutMs)
  const timedOut = (): ChatJsonResult<never> =>
    fail("timeout", `no reply within ${config.timeoutMs} ms; the request may have been billed`)

  let response: Response
  try {
    response = await config.fetch(config.url, {
      method: "POST",
      headers,
      body: JSON.stringify({
        model: config.model,
        messages: shape.messages,
        [config.maxTokensField]: shape.maxTokens,
        ...(shape.temperature === undefined ? {} : { temperature: shape.temperature }),
        response_format: { type: "json_object" },
      }),
      redirect: "manual",
      signal,
    })
  } catch (cause) {
    if (isRequestTimeout(cause)) return timedOut()
    return fail("network-error", `request failed (${describeTransportError(cause)})`)
  }

  if (response.type === "opaqueredirect" || (response.status >= 300 && response.status < 400)) {
    await releaseResponseBody(response).catch(() => {})
    return fail("redirected", "the server answered with a redirect, which is not followed")
  }
  if (!response.ok) {
    await releaseResponseBody(response).catch(() => {})
    const code = STATUS_CODES[response.status] ?? "http-error"
    return fail(code, `the server answered HTTP ${response.status}`, response.status)
  }

  let body: unknown
  try {
    body = await readBoundedJson(response, {
      maxBytes: MAX_REPLY_BYTES,
      timeoutMs: config.timeoutMs,
    })
  } catch (cause) {
    if (isRequestTimeout(cause) || cause instanceof BodyReadTimeoutError || signal.aborted) {
      return timedOut()
    }
    if (cause instanceof SyntaxError) return fail("invalid-reply", "the reply is not JSON")
    return fail("invalid-reply", `the reply could not be read (${describeTransportError(cause)})`)
  }

  const reply = ReplyShape(body)
  if (reply instanceof type.errors) {
    return fail("invalid-reply", "the reply is not a chat completion with token usage")
  }
  const usage = toUsage(reply.usage)
  if (guard !== undefined) {
    // The reply is paid for: a guard that cannot record it must not cost the caller the answer.
    await guard.record(usage).catch(() => {})
  }

  const [choice] = reply.choices
  switch (choice.finish_reason) {
    case "stop":
    case null:
    case undefined:
      break
    case "length":
      return fail("truncated", "the reply stopped at maxTokens; raise it or ask for less")
    case "content_filter":
      return fail("content-filtered", "the provider's content filter blocked the reply")
    case "insufficient_system_resource":
      return fail("unavailable", "the provider ran out of capacity before the reply was finished")
    default:
      return fail("invalid-reply", "the reply did not finish normally")
  }
  const content = choice.message.content ?? ""
  if (content.trim() === "") return fail("empty-reply", "the model sent a blank reply")

  let json: unknown
  try {
    json = JSON.parse(content)
  } catch {
    return fail("invalid-reply", "the reply's content is not JSON")
  }
  const value = request.schema(json)
  if (value instanceof type.errors) {
    // `summary` would quote the reply, which can hold the prompt's personal data.
    return fail("invalid-reply", "the reply's JSON does not match the schema")
  }
  return { success: true, output: { value: value as S["infer"], usage }, error: null }
}
