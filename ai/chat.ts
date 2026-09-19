/**
 * OpenAI-compatible chat completions client.
 *
 * A thin `fetch` wrapper: no SDK, and no provider abstraction beyond the
 * OpenAI-compatible `/chat/completions` request shape. It owns the four things
 * every hand-rolled call site gets wrong — guarding the response envelope,
 * checking `response.ok`, bounding the request in time, and retrying only what
 * is transient — and owns nothing else. Prompt assembly, conversation storage
 * and route wiring stay in the application.
 *
 * Three seams exist so this module is testable without network or wall clock:
 * `fetcher`, `timer` and `logger`. All three default to a platform
 * implementation and all three are injected, never reached for through a global
 * inside a test-visible path.
 *
 * SECURITY: the API key is a construction-time argument. It is never accepted
 * per request, never read from `$env` at module scope, and never copied into an
 * error, a log line or a returned value. Every piece of provider-controlled text
 * passes through {@link sanitizeProviderText} on its way out.
 */

import { type Type } from "arktype"
import { type SchemaOutput as ValidationOutput } from "@ts-libs/validation"

import { parseCompletionJson, repairPrompt } from "./chat-json.ts"
import {
  type AiError,
  AiErrorCode,
  AiRequestError,
  describeCause,
  sanitizeProviderText,
} from "./errors.ts"

export * from "./errors.ts"

/** Chat roles the OpenAI-compatible request shape accepts. */
export type ChatRole = "system" | "user" | "assistant"

/**
 * One turn of the conversation.
 *
 * Deliberately `string` content only: multimodal parts and tool calls are out of
 * scope (see README), and a `string` cannot smuggle a provider-specific payload
 * through the types.
 */
export interface ChatMessage {
  role: ChatRole
  content: string
}

/** Why a wait exists, so a caller can tell a deadline from a backoff. */
export type TimerWaitKind = "deadline" | "backoff"

/** Injection point for a clock and a cancellable sleep. */
export interface Timer {
  /** Milliseconds since the epoch. Only differences are meaningful. */
  now(): number
  /**
   * Resolve after `ms` milliseconds, or reject with the signal's reason when the
   * signal aborts first. Rejecting on abort is what stops a backoff wait from
   * outliving the request that asked for it.
   *
   * Resolves with an opaque token that `cancel` accepts, so a caller can release
   * a wait it no longer needs. The token carries no meaning beyond identity: the
   * platform timer resolves to `undefined` and ignores it.
   */
  sleep(ms: number, signal?: AbortSignal, kind?: TimerWaitKind): Promise<unknown>
  /**
   * Release a wait eagerly, when the thing it was guarding settled first.
   *
   * Called by the client when a request wins its timeout race: without it, a wait
   * for the full timeout stays scheduled until it fires, which keeps a timer
   * alive for up to `timeoutMs` after the answer already arrived.
   */
  cancel?(token: unknown): void
}

const pendingWaits = new Map<unknown, () => void>()

const realTimer: Timer = {
  now: () => Date.now(),
  sleep: (ms, signal) => {
    if (signal?.aborted) return Promise.reject(signal.reason)
    return new Promise<unknown>((resolve, reject) => {
      const onAbort = () => {
        clearTimeout(id)
        pendingWaits.delete(handle)
        reject(signal?.reason)
      }
      const id = setTimeout(() => {
        signal?.removeEventListener("abort", onAbort)
        pendingWaits.delete(handle)
        resolve(undefined)
      }, ms)
      const handle = () => {
        clearTimeout(id)
        signal?.removeEventListener("abort", onAbort)
        reject(signal?.reason)
      }
      pendingWaits.set(handle, handle)
      signal?.addEventListener("abort", onAbort, { once: true })
    })
  },
  cancel: (token) => {
    const release = pendingWaits.get(token)
    if (!release) return
    pendingWaits.delete(token)
    release()
  },
}

/** Injection point for one log line. Off by default — see {@link noopLogger}. */
export interface Logger {
  warn(message: string, fields?: Record<string, unknown>): void
}

/**
 * The default logger: it discards.
 *
 * A library that logs by default writes to whatever destination the host has
 * configured, and that destination may ship off-box. A host that wants retry and
 * envelope failures recorded injects its own logger; the fields handed to it are
 * always integers and sanitized strings.
 */
export const noopLogger: Logger = { warn: () => {} }

/** Default timeout for one HTTP request, in milliseconds. */
export const DEFAULT_TIMEOUT_MS: number = 60_000

/** Default OpenAI-compatible base URL. Never paired with a real key in tests. */
export const DEFAULT_BASE_URL: string = "https://api.example.com/v1"

/** Default total attempts (first try plus two retries). */
export const DEFAULT_MAX_ATTEMPTS: number = 3

/** Default first backoff step, in milliseconds. Doubles per attempt. */
export const DEFAULT_BASE_DELAY_MS: number = 500

/** Default ceiling for a computed backoff step. A `Retry-After` may exceed it. */
export const DEFAULT_MAX_DELAY_MS: number = 8_000

/** Default wall-clock budget across every attempt and wait, in milliseconds. */
export const DEFAULT_MAX_ELAPSED_MS: number = 60_000

/** A `Retry-After` above this is treated as advice to stop retrying. */
export const DEFAULT_MAX_RETRY_AFTER_MS: number = 60_000

/**
 * When a failure may be retried, and how long the whole call may take.
 *
 * Defaults: 3 attempts, 500 ms backoff doubling to an 8 s ceiling, 60 s budget,
 * and a `Retry-After` above 60 s ends the call instead of being obeyed.
 */
export interface RetryPolicy {
  /** Attempts in total, including the first. `1` disables retrying. */
  maxAttempts?: number
  /** First backoff step; doubles after each failed attempt. */
  baseDelayMs?: number
  /** Ceiling for a computed backoff step. */
  maxDelayMs?: number
  /** Hard wall-clock budget covering attempts, requests and waits together. */
  maxElapsedMs?: number
  /** A `Retry-After` larger than this ends the call. */
  maxRetryAfterMs?: number
}

/** Retry policy with every field present, as the internals use it. */
type ResolvedRetryPolicy = Required<RetryPolicy>

const DEFAULT_RETRY_POLICY: ResolvedRetryPolicy = {
  maxAttempts: DEFAULT_MAX_ATTEMPTS,
  baseDelayMs: DEFAULT_BASE_DELAY_MS,
  maxDelayMs: DEFAULT_MAX_DELAY_MS,
  maxElapsedMs: DEFAULT_MAX_ELAPSED_MS,
  maxRetryAfterMs: DEFAULT_MAX_RETRY_AFTER_MS,
}

/**
 * Statuses worth another attempt: rate limits, explicit retry signals, server
 * faults.
 *
 * 408 and 425 are included because both are the server saying "try again"; every
 * 5xx counts because the server failed to serve a well-formed request. Every
 * other 4xx is the caller's fault — repeating a 400 with an identical body can
 * only produce an identical 400.
 */
export function isRetryableStatus(status: number): boolean {
  return status === 408 || status === 425 || status === 429 || status >= 500
}

/** Construction options for {@link createChatClient}. */
export interface ChatClientConfig {
  /**
   * Provider API key. Required. Pass a literal from the host's secret store, or a
   * value the process already read. This module reads no environment variable.
   * The key is sent once, as `Authorization: Bearer <key>`, and appears nowhere
   * else — not in a body, not in an error, not in a log field.
   */
  apiKey: string
  /** OpenAI-compatible base URL, e.g. `https://api.example.com/v1`. */
  baseUrl?: string
  /** Model id sent with every request; a per-request `model` overrides it. */
  model?: string
  /** Fetcher; defaults to the global `fetch`. */
  fetcher?: typeof fetch
  /** Clock and sleep; defaults to the platform timer. */
  timer?: Timer
  /** Logger; defaults to {@link noopLogger}. */
  logger?: Logger
  /** Retry policy; see {@link RetryPolicy}. */
  retry?: RetryPolicy
}

/**
 * Caller-supplied overrides for one request.
 *
 * There is no `apiKey` field, on purpose: a browser-facing route that accepted a
 * key per request would let any caller spend someone else's quota and would put
 * the key on the wire from the client. The type is the cheapest place to make
 * that inexpressible, and the reader below never looks for one.
 */
export interface ChatRequestOptions {
  messages: ChatMessage[]
  model?: string
  temperature?: number
  /** Sent as `max_tokens`, the OpenAI-compatible field name. */
  maxTokens?: number
  /** Overrides the client's default timeout for this call. */
  timeoutMs?: number
  /** Caller cancellation, reported as `kind: "abort"`. */
  signal?: AbortSignal
  /** Sent as `response_format`; providers without support reject the request. */
  responseFormat?: "text" | "json_object"
  /** Copied verbatim to the request body. For provider-specific knobs. */
  extra?: Record<string, unknown>
}

/** Token accounting as the provider reported it. */
export interface TokenUsage {
  promptTokens?: number
  completionTokens?: number
  totalTokens?: number
}

/** A completion that satisfied every guard. */
export interface ChatCompletionResult {
  /** The assistant message text; never empty on success. */
  content: string
  /** Model the provider reports having served. */
  model?: string
  /** `finish_reason` of the first choice, e.g. `"stop"`. */
  finishReason?: string
  /**
   * Usage exactly as reported, so a caller can bill for the call.
   *
   * `undefined` when the provider sent no `usage` object — not zeroed, because
   * `0` and "unknown" are different claims and a cost dashboard must be able to
   * tell them apart. Individual fields are omitted when the provider omitted
   * them, so a partial object is possible and is passed through as-is.
   */
  usage?: TokenUsage
}

/**
 * The client surface.
 *
 * Both methods reject with an {@link AiError}, never with a raw platform error,
 * so a caller branches once: `isAiError(error)`.
 */
export interface ChatClient {
  /**
   * One chat completion.
   *
   * Retries transient failures per the client's policy, returns the first
   * well-formed completion, and rejects with a typed error otherwise.
   */
  chatCompletion(options: ChatRequestOptions): Promise<ChatCompletionResult>
  /**
   * One chat completion whose text must be a JSON value matching an arktype
   * schema. See `chat-json.ts` for the recovery and repair contract.
   */
  chatJson<T extends SchemaType>(
    options: ChatJsonRequestOptions<T>,
  ): Promise<ChatJsonResult<SchemaOutput<T>>>
}

/** arktype schema, as `@ts-libs/validation` accepts it. */
export type SchemaType = Type<unknown>

/** Output of an arktype schema — the validated, inferred value. */
export type SchemaOutput<T extends SchemaType> = ValidationOutput<T>

/** A validated value, or the error that rejected it. */
export type Outcome<T> = { error: AiError; data: null } | { error: null; data: T }

/** Arguments for {@link ChatClient.chatJson}. */
export interface ChatJsonRequestOptions<T extends SchemaType> extends ChatRequestOptions {
  /** arktype schema the recovered JSON value must satisfy. */
  schema: T
  /**
   * Repair round-trips attempted after a failed first parse. Defaults to 1;
   * `0` disables repair. Bounded at 1 — a second failure is the caller's.
   */
  repairAttempts?: number
}

/** Outcome of {@link ChatClient.chatJson}. */
export interface ChatJsonResult<T> {
  /** The validated value: `schema`'s inferred output type, never `unknown`. */
  data: T
  /** Usage summed across the completions this call issued, when reported. */
  usage?: TokenUsage
  /** Completions issued: 1 when the first answer parsed, 2 after one repair. */
  attempts: number
}

/** Error for a missing or unusable key. */
export function missingApiKeyError(): AiError {
  return new AiRequestError({
    kind: "config",
    code: AiErrorCode.MissingApiKey,
    message: "ai: an apiKey is required; pass it to createChatClient",
  })
}

/** Error for a base URL this client will not call. */
export function invalidBaseUrlError(reason: string): AiError {
  return new AiRequestError({
    kind: "config",
    code: AiErrorCode.MissingApiKey,
    message: `ai: baseUrl ${reason}`,
  })
}

/**
 * Build the client.
 *
 * @throws An {@link AiError} with `kind: "config"` when the key is missing or
 * blank, or when the base URL is not an absolute http(s) URL without embedded
 * credentials. Thrown rather than returned because wiring is where a
 * misconfigured client should fail, not the first request.
 */
export function createChatClient(config: ChatClientConfig): ChatClient {
  const apiKey = typeof config.apiKey === "string" ? config.apiKey.trim() : ""
  if (!apiKey) throw missingApiKeyError()

  const baseUrl = normalizeBaseUrl(config.baseUrl ?? DEFAULT_BASE_URL)
  const fetcher = config.fetcher ?? globalThis.fetch
  const timer = config.timer ?? realTimer
  const logger = config.logger ?? noopLogger
  const policy: ResolvedRetryPolicy = { ...DEFAULT_RETRY_POLICY, ...config.retry }
  const defaultModel = config.model
  const endpoint = `${baseUrl}/chat/completions`

  async function chatCompletion(options: ChatRequestOptions): Promise<ChatCompletionResult> {
    const response = await send(options)
    return response.result
  }

  async function chatJson<T extends SchemaType>(
    options: ChatJsonRequestOptions<T>,
  ): Promise<ChatJsonResult<SchemaOutput<T>>> {
    const repairAttempts = clampRepairAttempts(options.repairAttempts)
    let completion = await send(options)
    let usage = completion.result.usage
    let attempts = 1

    for (let repair = 0; repair <= repairAttempts; repair++) {
      const parsed = parseCompletionJson(completion.result.content, options.schema)
      if (parsed.error === null) {
        return { data: parsed.data, usage, attempts }
      }
      if (repair === repairAttempts) throw parsed.error

      attempts++
      logger.warn("ai: repairing a chatJson response", {
        code: parsed.error.code,
        repair: repair + 1,
        attempt: attempts,
      })
      completion = await send({
        ...options,
        messages: [
          ...options.messages,
          { role: "assistant", content: completion.result.content },
          { role: "user", content: repairPrompt(parsed.error) },
        ],
      })
      usage = addUsage(usage, completion.result.usage)
    }

    // Unreachable: the loop returns or throws.
    throw new AiRequestError({
      kind: "json",
      code: AiErrorCode.JsonNotFound,
      message: "ai: no valid JSON value in the model response",
    })
  }

  return { chatCompletion, chatJson }

  /** One request, with retries. Returns a completion or throws an `AiError`. */
  async function send(options: ChatRequestOptions): Promise<{ result: ChatCompletionResult }> {
    const body = buildRequestBody(options, options.model ?? defaultModel)
    const timeoutMs = options.timeoutMs ?? DEFAULT_TIMEOUT_MS
    const callerSignal = options.signal
    const startedAt = timer.now()
    let attempt = 0

    while (true) {
      attempt++
      const outcome = await attemptOnce(body, timeoutMs, callerSignal)
      if ("result" in outcome) return outcome

      const retry = nextRetry(outcome.error, attempt, startedAt, callerSignal)
      if (!retry) {
        throw withAttempts(outcome.error, attempt)
      }
      logger.warn("ai: retrying a chat completion", {
        attempt,
        status: outcome.error.status,
        code: outcome.error.code,
        delayMs: retry.delayMs,
      })
      await timer.sleep(retry.delayMs, callerSignal, "backoff")
    }
  }

  /**
   * One `fetch` plus every guard, mapped to a completion or an `AiError`.
   *
   * The deadline is a `timer.sleep` raced against the request rather than a raw
   * `setTimeout`: that is what makes the timeout an injected value instead of a
   * wall-clock one. A fetcher that ignores its signal is still bounded, because
   * the race abandons the request; a fetcher that honours it is aborted so the
   * socket does not stay open.
   */
  async function attemptOnce(
    body: Record<string, unknown>,
    timeoutMs: number,
    callerSignal: AbortSignal | undefined,
  ): Promise<{ result: ChatCompletionResult } | { error: AiError }> {
    if (callerSignal?.aborted) return { error: abortedError() }

    const controller = new AbortController()
    const onCallerAbort = () => controller.abort()
    callerSignal?.addEventListener("abort", onCallerAbort, { once: true })

    const TIMEOUT = Symbol("ai-timeout")
    const CALLER_ABORT = Symbol("ai-caller-abort")
    // The wait is started synchronously, not inside the async function below,
    // so the released-deadline reference is always the same promise the timer
    // created — starting it lazily would race the release against the call.
    let wait: Promise<unknown> | undefined
    try {
      wait = timer.sleep(timeoutMs, callerSignal, "deadline")
    } catch {
      // A timer that throws instead of rejecting must not break the request.
      wait = undefined
    }
    const deadline: Promise<typeof TIMEOUT | typeof CALLER_ABORT> = wait
      ? wait.then(() => TIMEOUT, () => CALLER_ABORT)
      : Promise.resolve(CALLER_ABORT)

    const request = Promise.resolve(
      fetcher(endpoint, {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
          "Authorization": `Bearer ${apiKey}`,
        },
        body: JSON.stringify(body),
        signal: controller.signal,
      }),
    )

    let raced: Response | typeof TIMEOUT | typeof CALLER_ABORT | { failed: unknown }
    try {
      raced = await Promise.race([request, deadline])
    } catch (error) {
      raced = { failed: error }
    } finally {
      callerSignal?.removeEventListener("abort", onCallerAbort)
    }

    if (raced === TIMEOUT) {
      // Nothing else will await this promise; the handler keeps a late rejection
      // from surfacing as an unhandled one.
      request.catch(() => {})
      controller.abort()
      return { error: timeoutError(timeoutMs) }
    }
    // The race is over: release the deadline before anything else runs, so an
    // answer that arrived is not still holding a scheduled timeout.
    releaseDeadline(timer, wait)
    if (raced === CALLER_ABORT || callerSignal?.aborted) {
      request.catch(() => {})
      controller.abort()
      return { error: abortedError() }
    }
    if (raced instanceof Response) {
      return readResponse(raced)
    }

    const failed = raced.failed
    return {
      error: new AiRequestError({
        kind: "network",
        code: AiErrorCode.NetworkError,
        message: "ai: the request could not reach the provider",
        cause: describeCause(failed),
      }),
    }
  }

  /** Map a received response to a completion or an `AiError`. */
  async function readResponse(
    response: Response,
  ): Promise<{ result: ChatCompletionResult } | { error: AiError }> {
    if (!response.ok) {
      return { error: await providerError(response) }
    }

    let payload: unknown
    try {
      payload = await response.json()
    } catch (error) {
      return {
        error: new AiRequestError({
          kind: "json",
          code: AiErrorCode.InvalidJson,
          message: `ai: the provider returned a non-JSON body (status ${response.status})`,
          status: response.status,
          cause: describeCause(error),
        }),
      }
    }

    return readCompletion(payload, response.status)
  }

  /** Sleep for the policy's backoff, or `null` when no retry is allowed. */
  function nextRetry(
    error: AiError,
    attempt: number,
    startedAt: number,
    callerSignal: AbortSignal | undefined,
  ): { delayMs: number } | null {
    if (callerSignal?.aborted) return null
    if (attempt >= policy.maxAttempts) return null
    if (!isRetryable(error)) return null

    const delayMs = retryDelay(error, attempt, policy)
    if (delayMs === null) return null
    // The budget is a hard stop, not a hint: a wait that would overrun it is
    // skipped and the failure is reported now.
    if (timer.now() - startedAt + delayMs > policy.maxElapsedMs) return null
    return { delayMs }
  }
}

/**
 * Release a timeout wait that lost its race against a settled request.
 *
 * The promise itself is the handle, not the value it resolves to: a timer whose
 * wait resolves to an opaque token hands that token to `cancel`, and a timer
 * whose wait resolves to nothing gets `undefined` and ignores it. Passing the
 * promise means a cancelled deadline is released even when the two sides of the
 * race agree on nothing else — and leaves a scheduled timeout running for up to
 * `timeoutMs` after an answer already arrived otherwise.
 */
function releaseDeadline(timer: Timer, wait: Promise<unknown> | undefined): void {
  if (!wait || !timer.cancel) return
  timer.cancel(wait)
}

/** Clamp the repair count to `[0, 1]`: the contract is at most one extra call. */
export function clampRepairAttempts(value: number | undefined): number {
  if (value === undefined || !Number.isFinite(value)) return 1
  return Math.max(0, Math.min(1, Math.trunc(value)))
}

/**
 * Guard the completion envelope and read the first choice.
 *
 * Every step is checked, because a provider error body, an empty `choices`
 * array, a missing `message` and a `null` `content` are all shapes this client
 * has to answer with an {@link AiError} rather than a `TypeError`.
 */
export function readCompletion(
  payload: unknown,
  status: number,
): { result: ChatCompletionResult } | { error: AiError } {
  const invalid = (detail: string): { error: AiError } => ({
    error: new AiRequestError({
      kind: "provider",
      code: AiErrorCode.InvalidResponse,
      message: `ai: malformed completion response (${detail})`,
      status,
    }),
  })

  if (typeof payload !== "object" || payload === null) return invalid("body is not an object")
  const envelope = payload as Record<string, unknown>

  const choices = envelope.choices
  if (!Array.isArray(choices)) return invalid("no choices array")
  if (choices.length === 0) return invalid("choices array is empty")

  const choice = choices[0]
  if (typeof choice !== "object" || choice === null) return invalid("choices[0] is not an object")
  const record = choice as Record<string, unknown>

  const message = record.message
  if (typeof message !== "object" || message === null) {
    return invalid("choices[0].message is missing")
  }

  const content = (message as Record<string, unknown>).content
  if (content === null) return invalid("choices[0].message.content is null")
  if (typeof content !== "string") return invalid("choices[0].message.content is missing")
  if (content === "") return invalid("choices[0].message.content is empty")

  const result: ChatCompletionResult = { content }
  if (typeof envelope.model === "string") result.model = envelope.model
  if (typeof record.finish_reason === "string") result.finishReason = record.finish_reason
  const usage = readUsage(envelope.usage)
  if (usage) result.usage = usage
  return { result }
}

/**
 * Read the provider's status, error code and message into an {@link AiError}.
 *
 * The body is read as text and never returned, echoed or logged: it can contain
 * the request, and the request contains the key. Only `error.message`,
 * `error.code` and `error.type` are extracted, sanitized and bounded.
 */
export async function providerError(response: Response): Promise<AiError> {
  let providerCode: string | undefined
  let providerMessage: string | undefined

  try {
    const parsed: unknown = JSON.parse(await response.text())
    if (typeof parsed === "object" && parsed !== null) {
      const record = parsed as Record<string, unknown>
      const inner = typeof record.error === "object" && record.error !== null
        ? record.error as Record<string, unknown>
        : undefined
      providerMessage = firstString(inner?.message, record.message)
      providerCode = firstString(inner?.code, inner?.type, record.code)
    }
  } catch {
    // A body that is not JSON, or that was already consumed, contributes
    // nothing. The status alone is enough to classify the failure.
  }

  const retryAfterMs = parseRetryAfter(response.headers.get("retry-after"))
  const error = new AiRequestError({
    kind: "provider",
    code: AiErrorCode.ProviderError,
    message: `ai: provider responded ${response.status}${
      providerMessage === undefined ? "" : `: ${providerMessage}`
    }`,
    status: response.status,
    providerCode,
    cause: retryAfterMs === undefined ? undefined : `retry-after ${retryAfterMs}ms`,
  })
  return error
}

function firstString(...values: unknown[]): string | undefined {
  for (const value of values) {
    if (typeof value === "string" && value.trim() !== "") return sanitizeProviderText(value)
  }
  return undefined
}

/**
 * `Retry-After` in milliseconds, or `undefined` when absent or unparseable.
 *
 * Both RFC 9110 forms are accepted: delta-seconds (`"2"`) and an HTTP-date. The
 * delta-seconds form is what rate limiters actually send; the date form costs
 * four lines and is what the spec allows a server to send, so it is handled
 * rather than ignored.
 */
export function parseRetryAfter(header: string | null, nowMs?: number): number | undefined {
  if (!header) return undefined
  const trimmed = header.trim()
  if (trimmed === "") return undefined

  if (/^\d+$/.test(trimmed)) {
    const seconds = Number(trimmed)
    return Number.isFinite(seconds) ? seconds * 1000 : undefined
  }

  const at = Date.parse(trimmed)
  if (Number.isNaN(at)) return undefined
  return Math.max(0, at - (nowMs ?? Date.now()))
}

/** Whether a failure is worth another attempt. */
export function isRetryable(error: AiError): boolean {
  switch (error.code) {
    case AiErrorCode.NetworkError:
      return true
    case AiErrorCode.ProviderError:
      return isRetryableStatus(error.status ?? 0)
    // A malformed envelope is a provider bug that is usually transient, and a
    // non-JSON 2xx body is typically a gateway error page. Both get retried.
    case AiErrorCode.InvalidResponse:
    case AiErrorCode.InvalidJson:
      return true
    default:
      return false
  }
}

/** Compute the wait before the next attempt, or `null` to give up. */
export function retryDelay(
  error: AiError,
  attempt: number,
  policy: ResolvedRetryPolicy,
): number | null {
  const retryAfterMs = parseRetryAfterCause(error.cause)
  if (retryAfterMs !== undefined) {
    // A provider asking for longer than the policy allows is telling us to stop,
    // not to wait: obeying a 30-minute `Retry-After` inside a request handler
    // holds the socket for 30 minutes.
    if (retryAfterMs > policy.maxRetryAfterMs) return null
    return retryAfterMs
  }
  return Math.min(policy.baseDelayMs * 2 ** (attempt - 1), policy.maxDelayMs)
}

function parseRetryAfterCause(cause: string | undefined): number | undefined {
  const match = cause?.match(/^retry-after (\d+)ms$/)
  return match ? Number(match[1]) : undefined
}

/** Attach the attempt count to the error that ended the call. */
function withAttempts(error: AiError, attempts: number): AiError {
  error.attempts = attempts
  return error
}

function buildRequestBody(
  options: ChatRequestOptions,
  model: string | undefined,
): Record<string, unknown> {
  const body: Record<string, unknown> = {
    messages: options.messages.map((message) => ({ role: message.role, content: message.content })),
  }
  if (model !== undefined) body.model = model
  if (options.temperature !== undefined) body.temperature = options.temperature
  if (options.maxTokens !== undefined) body.max_tokens = options.maxTokens
  if (options.responseFormat === "json_object") body.response_format = { type: "json_object" }
  if (options.extra) Object.assign(body, options.extra)
  return body
}

/**
 * Read `usage` defensively.
 *
 * Both the snake_case OpenAI spelling and a camelCase spelling are accepted,
 * because providers that claim compatibility differ here. Nothing is zero-filled:
 * a field the provider omitted stays `undefined`, and a `usage` object with no
 * recognisable field is reported as absent rather than as `{ 0, 0, 0 }`.
 */
export function readUsage(value: unknown): TokenUsage | undefined {
  if (typeof value !== "object" || value === null) return undefined
  const record = value as Record<string, unknown>
  const usage: TokenUsage = {}
  const prompt = readCount(record.prompt_tokens, record.promptTokens)
  const completion = readCount(record.completion_tokens, record.completionTokens)
  const total = readCount(record.total_tokens, record.totalTokens)
  if (prompt !== undefined) usage.promptTokens = prompt
  if (completion !== undefined) usage.completionTokens = completion
  if (total !== undefined) usage.totalTokens = total
  return Object.keys(usage).length === 0 ? undefined : usage
}

function readCount(...values: unknown[]): number | undefined {
  for (const value of values) {
    if (typeof value === "number" && Number.isFinite(value)) return value
  }
  return undefined
}

/** Add two usage records field by field, leaving an unknown field unknown. */
export function addUsage(
  left: TokenUsage | undefined,
  right: TokenUsage | undefined,
): TokenUsage | undefined {
  if (!left) return right
  if (!right) return left
  const usage: TokenUsage = {}
  const prompt = add(left.promptTokens, right.promptTokens)
  const completion = add(left.completionTokens, right.completionTokens)
  const total = add(left.totalTokens, right.totalTokens)
  if (prompt !== undefined) usage.promptTokens = prompt
  if (completion !== undefined) usage.completionTokens = completion
  if (total !== undefined) usage.totalTokens = total
  return Object.keys(usage).length === 0 ? undefined : usage
}

function add(left: number | undefined, right: number | undefined): number | undefined {
  if (left === undefined) return right
  if (right === undefined) return left
  return left + right
}

function timeoutError(timeoutMs: number): AiError {
  return new AiRequestError({
    kind: "timeout",
    code: AiErrorCode.Timeout,
    message: `ai: no response within ${timeoutMs}ms`,
  })
}

function abortedError(): AiError {
  return new AiRequestError({
    kind: "abort",
    code: AiErrorCode.Aborted,
    message: "ai: the request was cancelled by the caller",
  })
}

/** Reject anything that is not a credential-free absolute http(s) URL. */
export function normalizeBaseUrl(raw: string): string {
  const trimmed = raw.trim()
  let url: URL
  try {
    url = new URL(trimmed)
  } catch {
    throw invalidBaseUrlError("must be an absolute http(s) URL")
  }
  if (url.protocol !== "http:" && url.protocol !== "https:") {
    throw invalidBaseUrlError("must use http or https")
  }
  if (url.username || url.password) {
    throw invalidBaseUrlError("must not embed credentials")
  }
  return url.href.replace(/\/+$/, "")
}
