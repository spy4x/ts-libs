/**
 * Telegram Bot API client: typed calls for what a bot needs every day, and the arktype check that
 * turns an untrusted JSON value into a {@link TelegramUpdate}.
 *
 * Ported in behaviour from Financy's hand-written bot client. It follows this package's other
 * clients: a per-request timeout, retries with backoff under a {@link RetryPolicy}, no redirect
 * following, never a thrown error, and never the bot token in a result.
 *
 * It does not reuse `_post.ts` because Telegram differs where that helper is fixed: every answer,
 * an error included, is a JSON envelope whose `description` is the only useful error text, and
 * long polling needs a caller's `AbortSignal`.
 *
 * @module
 */

import { type Type, type } from "arktype"
import { createPostTransport, type PostClientOptions, type PostTransport } from "./_post.ts"
import {
  describeTransportError,
  isRequestTimeout,
  isTransientStatus,
  parseRetryAfterMs,
  releaseResponseBody,
  type RetryPolicy,
  runWithRetry,
} from "./retry.ts"
import { readBoundedJson } from "@spy4x/net/bounded-body"

/** Where the Bot API lives unless a config names a local Bot API server. */
export const TELEGRAM_API_BASE_URL = `https://api.telegram.org`

/**
 * Default retry policy: 3 attempts, 1s doubling, at most 30s per wait (Telegram's `retry_after`
 * on a 429 is honoured up to that), 60s for the whole call, +/-20% jitter.
 *
 * A retry after a timeout can deliver a message twice, because Telegram has no idempotency key:
 * the first request may have arrived. Pass `retry: { maxAttempts: 1 }` where a duplicate is worse
 * than a lost message.
 */
export const TELEGRAM_RETRY_POLICY: RetryPolicy = {
  maxAttempts: 3,
  baseDelayMs: 1_000,
  maxDelayMs: 30_000,
  totalBudgetMs: 60_000,
  jitterRatio: 0.2,
}

/** The bot to act as, for {@link TelegramClient}. */
export interface TelegramClientConfig {
  /** Bot token from BotFather, `<digits>:<letters>`. Never appears in a result or an error. */
  token: string
  /** A local Bot API server's base URL. Defaults to {@link TELEGRAM_API_BASE_URL}. */
  apiBaseUrl?: string
}

/** Transport overrides for {@link TelegramClient}; every field has a real default. */
export type TelegramClientOptions = PostClientOptions

/** Per-call overrides for {@link TelegramClient.call}. */
export interface TelegramCallOptions {
  /** Cancels the call. An aborted call resolves with code `aborted`. */
  signal?: AbortSignal
  /** Timeout of each attempt, replacing the client's `requestTimeoutMs`. */
  timeoutMs?: number
  /** `false` sends one attempt only. */
  retry?: boolean
}

/** Why a call failed. */
export type TelegramErrorCode =
  | "http_error"
  | "network_error"
  | "timeout"
  | "redirected"
  | "invalid_response"
  | "aborted"

/** Telegram accepted the call. */
export interface TelegramSuccess<T> {
  ok: true
  /** The envelope's `result`, as Telegram sent it. */
  result: T
  /** Attempts it took, including the first. */
  attempts: number
}

/** The call failed; `message` is Telegram's `description` when it sent one. */
export interface TelegramFailure {
  ok: false
  code: TelegramErrorCode
  message: string
  /** HTTP status, when Telegram answered. */
  status?: number
  attempts: number
}

/** What a {@link TelegramClient} call resolves with. It never rejects. */
export type TelegramResult<T> = TelegramSuccess<T> | TelegramFailure

/** A Telegram user or bot. */
export interface TelegramUser {
  id: number
  is_bot: boolean
  first_name: string
  last_name?: string
  username?: string
  language_code?: string
}

/** The chat a message belongs to. */
export interface TelegramChat {
  id: number
  type: string
  title?: string
  username?: string
}

/** A message, with the fields a bot routes on. */
export interface TelegramMessage {
  message_id: number
  date: number
  chat: TelegramChat
  from?: TelegramUser
  text?: string
}

/** A press on an inline keyboard button. */
export interface TelegramCallbackQuery {
  id: string
  from: TelegramUser
  /** The message the button was on. Absent for a button on an inline-mode message. */
  message?: TelegramMessage
  data?: string
}

/**
 * One update. Only the kinds a bot routes are typed; the rest of the object is kept as Telegram
 * sent it, so a caller can still read a kind this type does not name.
 */
export interface TelegramUpdate {
  update_id: number
  message?: TelegramMessage
  edited_message?: TelegramMessage
  callback_query?: TelegramCallbackQuery
}

/** One inline keyboard button: it sends `callback_data` back to the bot, or opens `url`. */
export interface TelegramInlineButton {
  text: string
  /** At most 64 bytes. */
  callback_data?: string
  url?: string
}

/** Buttons under a message, as rows. */
export interface TelegramInlineKeyboard {
  inline_keyboard: TelegramInlineButton[][]
}

/** Parameters of `sendMessage`, named as in the Bot API. */
export interface TelegramSendMessage {
  chat_id: number | string
  text: string
  parse_mode?: `HTML` | `MarkdownV2`
  reply_markup?: TelegramInlineKeyboard
  disable_notification?: boolean
  link_preview_options?: { is_disabled?: boolean }
}

/** Parameters of `editMessageText`, named as in the Bot API. */
export interface TelegramEditMessageText {
  chat_id: number | string
  message_id: number
  text: string
  parse_mode?: `HTML` | `MarkdownV2`
  reply_markup?: TelegramInlineKeyboard
}

/** Parameters of `answerCallbackQuery`, named as in the Bot API. */
export interface TelegramAnswerCallbackQuery {
  callback_query_id: string
  /** A toast for the person who pressed the button, at most 200 characters. */
  text?: string
  show_alert?: boolean
}

/** Parameters of `setWebhook`, named as in the Bot API. */
export interface TelegramSetWebhook {
  url: string
  /** Sent back in `X-Telegram-Bot-Api-Secret-Token`; 1-256 of `A-Z a-z 0-9 _ -`. */
  secret_token?: string
  allowed_updates?: string[]
  drop_pending_updates?: boolean
}

/** One entry of the command menu. */
export interface TelegramBotCommand {
  /** 1-32 lower-case letters, digits and underscores, without the slash. */
  command: string
  description: string
}

const user = type({
  id: `number.integer`,
  is_bot: `boolean`,
  first_name: `string`,
  "last_name?": `string`,
  "username?": `string`,
  "language_code?": `string`,
})
const message = type({
  message_id: `number.integer`,
  date: `number.integer`,
  chat: { id: `number.integer`, type: `string`, "title?": `string`, "username?": `string` },
  "from?": user,
  "text?": `string`,
})
const updateSchema: Type<TelegramUpdate> = type({
  update_id: `number.integer`,
  "message?": message,
  "edited_message?": message,
  "callback_query?": { id: `string`, from: user, "message?": message, "data?": `string` },
})

/**
 * Checks an untrusted value against {@link TelegramUpdate}.
 *
 * @returns The update, or `null` when the value is not one.
 */
export function parseTelegramUpdate(value: unknown): TelegramUpdate | null {
  const result = updateSchema(value)
  return result instanceof type.errors ? null : result
}

const TOKEN_SHAPE = /^\d+:[A-Za-z0-9_-]+$/
const METHOD_SHAPE = /^[A-Za-z]+$/
/** A `getUpdates` answer holds at most 100 updates; this bounds a broken or hostile server. */
const MAX_RESPONSE_BYTES = 5 * 1024 * 1024

type Attempt<T> =
  | TelegramSuccess<T>
  | (Omit<TelegramFailure, "attempts"> & {
    retryable: boolean
    retryAfterMs?: number
  })

/**
 * Calls the Telegram Bot API as one bot.
 *
 * ```ts
 * const telegram = new TelegramClient({ token })
 * const sent = await telegram.sendMessage({ chat_id: 42, text: `Hello` })
 * if (!sent.ok) report(sent.code, sent.message)
 * ```
 */
export class TelegramClient {
  readonly #baseUrl: string
  readonly #transport: PostTransport

  /** @throws {TypeError} When the token or the base URL is malformed. The token is never quoted. */
  constructor(config: TelegramClientConfig, options: TelegramClientOptions = {}) {
    if (!TOKEN_SHAPE.test(config.token)) {
      throw new TypeError(`Telegram bot token is malformed; expected <digits>:<letters>`)
    }
    const apiBaseUrl = (config.apiBaseUrl ?? TELEGRAM_API_BASE_URL).replace(/\/+$/, ``)
    if (!URL.canParse(apiBaseUrl)) {
      throw new TypeError(`Telegram apiBaseUrl is not a URL`)
    }
    this.#baseUrl = `${apiBaseUrl}/bot${config.token}`
    this.#transport = createPostTransport(TELEGRAM_RETRY_POLICY, options)
  }

  /**
   * Calls any Bot API method. The typed methods below cover the daily ones; this is for the rest.
   * `result` is not validated: it is typed as `T` on the caller's word.
   */
  async call<T>(
    method: string,
    params: object = {},
    options: TelegramCallOptions = {},
  ): Promise<TelegramResult<T>> {
    if (!METHOD_SHAPE.test(method)) {
      return { ok: false, code: `invalid_response`, message: `not a method name`, attempts: 0 }
    }
    const transport = this.#transport
    const policy = options.retry === false
      ? { ...transport.policy, maxAttempts: 1 }
      : transport.policy
    const body = JSON.stringify(params)
    const run = await runWithRetry<Attempt<T>>({
      policy,
      sleep: transport.sleep,
      clock: transport.clock,
      backoff: transport.backoff,
      attempt: async (_attempt, remainingBudgetMs) => {
        const timeoutMs = options.timeoutMs ??
          Math.max(Math.min(transport.requestTimeoutMs, remainingBudgetMs), 0)
        const value = await this.#once<T>(method, body, timeoutMs, options.signal)
        return {
          failed: !value.ok && value.retryable,
          retryAfterMs: value.ok ? undefined : value.retryAfterMs,
          value,
        }
      },
    })
    if (run.result.ok) {
      return { ...run.result, attempts: run.attempts }
    }
    const { code, message, status } = run.result
    return { ok: false, code, message, status, attempts: run.attempts }
  }

  /** The bot itself; a cheap way to check the token works. */
  getMe(): Promise<TelegramResult<TelegramUser>> {
    return this.call(`getMe`)
  }

  /** Sends a text message. */
  sendMessage(params: TelegramSendMessage): Promise<TelegramResult<TelegramMessage>> {
    return this.call(`sendMessage`, params)
  }

  /** Replaces a message's text and, optionally, its buttons. */
  editMessageText(params: TelegramEditMessageText): Promise<TelegramResult<TelegramMessage>> {
    return this.call(`editMessageText`, params)
  }

  /** Deletes a message. */
  deleteMessage(
    params: { chat_id: number | string; message_id: number },
  ): Promise<TelegramResult<true>> {
    return this.call<true>(`deleteMessage`, params)
  }

  /** Stops the button's spinner, with an optional toast. Telegram expects it for every press. */
  answerCallbackQuery(params: TelegramAnswerCallbackQuery): Promise<TelegramResult<true>> {
    return this.call(`answerCallbackQuery`, params)
  }

  /** Points Telegram at a webhook URL. */
  setWebhook(params: TelegramSetWebhook): Promise<TelegramResult<true>> {
    return this.call(`setWebhook`, params)
  }

  /** Removes the webhook, which long polling needs first. */
  deleteWebhook(params: { drop_pending_updates?: boolean } = {}): Promise<TelegramResult<true>> {
    return this.call(`deleteWebhook`, params)
  }

  /** Sets the command menu people see next to the message field. */
  setMyCommands(params: { commands: TelegramBotCommand[] }): Promise<TelegramResult<true>> {
    return this.call(`setMyCommands`, params)
  }

  /** One HTTP attempt. Never throws. */
  async #once<T>(
    method: string,
    body: string,
    timeoutMs: number,
    callerSignal: AbortSignal | undefined,
  ): Promise<Attempt<T>> {
    if (callerSignal?.aborted) {
      return { ok: false, code: `aborted`, message: `call aborted`, retryable: false }
    }
    const timeout = AbortSignal.timeout(timeoutMs)
    try {
      const response = await this.#transport.fetcher(`${this.#baseUrl}/${method}`, {
        method: `POST`,
        headers: { "content-type": `application/json` },
        body,
        // A redirect would carry the token in the path to wherever `Location` points.
        redirect: `manual`,
        signal: callerSignal ? AbortSignal.any([timeout, callerSignal]) : timeout,
      })
      if (response.type === `opaqueredirect` || (response.status >= 300 && response.status < 400)) {
        await releaseResponseBody(response).catch(() => undefined)
        return {
          ok: false,
          code: `redirected`,
          message: `Telegram answered with a redirect (${response.status})`,
          status: response.status,
          retryable: false,
        }
      }
      return await readEnvelope<T>(response)
    } catch (cause) {
      if (callerSignal?.aborted) {
        return { ok: false, code: `aborted`, message: `call aborted`, retryable: false }
      }
      if (isRequestTimeout(cause)) {
        return {
          ok: false,
          code: `timeout`,
          message: `Telegram request timed out after ${timeoutMs}ms`,
          retryable: true,
        }
      }
      // `fetch` puts the URL, and so the token, in its error text.
      return {
        ok: false,
        code: `network_error`,
        message: describeTransportError(cause),
        retryable: true,
      }
    }
  }
}

/** Reads Telegram's `{ ok, result }` or `{ ok, error_code, description, parameters }` envelope. */
async function readEnvelope<T>(response: Response): Promise<Attempt<T>> {
  const retryable = isTransientStatus(response.status)
  let payload: unknown
  try {
    payload = await readBoundedJson(response, { maxBytes: MAX_RESPONSE_BYTES })
  } catch (cause) {
    // A timeout or an abort while the body streams in is the attempt's, not a bad answer.
    if (cause instanceof Error && (cause.name === `TimeoutError` || cause.name === `AbortError`)) {
      throw cause
    }
    await releaseResponseBody(response).catch(() => undefined)
    return {
      ok: false,
      code: response.ok ? `invalid_response` : `http_error`,
      message: `${response.status} ${response.statusText}`.trim(),
      status: response.status,
      retryable,
    }
  }
  const envelope = (typeof payload === `object` && payload !== null ? payload : {}) as {
    ok?: unknown
    result?: unknown
    description?: unknown
    parameters?: { retry_after?: unknown }
  }
  if (response.ok && envelope.ok === true && `result` in envelope) {
    return { ok: true, result: envelope.result as T, attempts: 0 }
  }
  const retryAfter = envelope.parameters?.retry_after
  return {
    ok: false,
    code: response.ok ? `invalid_response` : `http_error`,
    message: typeof envelope.description === `string`
      ? envelope.description
      : `${response.status} ${response.statusText}`.trim(),
    status: response.status,
    retryable,
    retryAfterMs: typeof retryAfter === `number` && retryAfter >= 0
      ? retryAfter * 1000
      : parseRetryAfterMs(response.headers.get(`Retry-After`)),
  }
}
