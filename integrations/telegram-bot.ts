/**
 * Running a Telegram bot: a router from commands, button presses and text to handlers,
 * step-by-step conversations whose state lives in a store the caller passes in, a webhook
 * handler on web-standard `Request`/`Response`, and a long-polling loop for development.
 *
 * Ported in behaviour from Financy's bot (its webhook route, polling worker and session manager),
 * not in structure. Fixes over that source: the webhook secret is compared in constant time and
 * is required; the request body is read under a byte cap and checked with arktype; and a
 * conversation's state has an expiry and a store of the caller's choice instead of one app cache.
 *
 * @module
 */

import { type } from "arktype"
import type { ICacheStorage } from "@spy4x/platform/cache"
import { constantTimeEqualsText } from "@spy4x/platform/tokens"
import { PayloadTooLargeError, readBoundedJson } from "@spy4x/net/bounded-body"
import {
  parseTelegramUpdate,
  type TelegramCallbackQuery,
  type TelegramClient,
  type TelegramMessage,
  type TelegramResult,
  type TelegramSendMessage,
  type TelegramUpdate,
  type TelegramUser,
} from "./telegram-client.ts"

/** What a handler gets for one update. */
export interface TelegramContext {
  update: TelegramUpdate
  /** The chat to answer in. */
  chatId: number
  /** Who sent the message or pressed the button; absent for an anonymous group admin. */
  from: TelegramUser | undefined
  /** The message's text, or `undefined` for a button press. */
  text: string | undefined
  /** The button's `callback_data`, or `undefined` for a message. */
  data: string | undefined
  /**
   * For a command, the text after it (`/link 123` gives `123`). For a button routed by prefix,
   * the data after `prefix:` (`menu:open` under `menu` gives `open`). Otherwise `""`.
   */
  args: string
  client: TelegramClient
  /** Sends a message to this chat. */
  reply(
    text: string,
    extra?: Omit<TelegramSendMessage, `chat_id` | `text`>,
  ): Promise<TelegramResult<TelegramMessage>>
  /**
   * Answers the button press, with an optional toast. The bot answers a press itself after the
   * handler when the handler did not, so the button's spinner always stops. Nothing for a message.
   */
  answer(text?: string): Promise<void>
  /** The conversation this chat is in, for this person. */
  conversation: TelegramConversationControl
}

/** Starts and ends a conversation from inside a handler. */
export interface TelegramConversationControl {
  /** The running conversation's name, or `undefined`. */
  readonly name: string | undefined
  /**
   * Starts conversation `name` at its first step, replacing any running one. The handler that
   * calls it sends the first question.
   *
   * @throws {Error} When no conversation by that name is registered.
   */
  start(name: string, data?: TelegramConversationData): Promise<void>
  /** Ends the running conversation, if any. */
  end(): Promise<void>
}

/** A conversation's saved answers. Stored as JSON, so plain values only. */
export type TelegramConversationData = Record<string, unknown>

/** What a step returns: the next step and the data so far, `{ done: true }`, or nothing to stay. */
export type TelegramStepResult =
  | { step: string; data?: TelegramConversationData }
  | { done: true }
  | void

/** Handles one update. */
export type TelegramHandler = (ctx: TelegramContext) => unknown | Promise<unknown>

/** Handles one answer inside a conversation step. */
export type TelegramStepHandler = (
  ctx: TelegramContext,
  data: TelegramConversationData,
) => TelegramStepResult | Promise<TelegramStepResult>

/** Where conversation state lives: the get, set-with-expiry and delete of an `ICacheStorage`. */
export type TelegramConversationStore = Pick<ICacheStorage, `get` | `set` | `del`>

/** Construction options for {@link TelegramBot}. */
export interface TelegramBotOptions {
  client: TelegramClient
  /**
   * The bot's username without `@`. When set, a command addressed to another bot
   * (`/start@other_bot`) is ignored, which matters in a group with several bots.
   */
  username?: string
  /** Needed only when the bot registers a conversation. */
  conversations?: {
    store: TelegramConversationStore
    /** Seconds a conversation waits for its next answer. Defaults to 900. */
    ttlSec?: number
    /** Prefix of every store key. Defaults to `telegram:conversation:`. */
    keyPrefix?: string
  }
}

const savedState = type({ name: `string`, step: `string`, data: `Record<string, unknown>` })
type SavedState = typeof savedState.infer

/**
 * Routes updates to handlers.
 *
 * Order for one update: a registered command; then a callback route; then a running
 * conversation, which takes any other text or button press; then the text handler. A registered
 * command always wins, so `/cancel` can end a conversation.
 *
 * ```ts
 * const bot = new TelegramBot({ client, conversations: { store } })
 *   .command(`start`, (ctx) => ctx.reply(`Hi`, { reply_markup: menu }))
 *   .callback(`menu`, (ctx) => ctx.reply(`You chose ${ctx.args}`))
 * await bot.handleUpdate(update)
 * ```
 */
export class TelegramBot {
  readonly #client: TelegramClient
  readonly #username: string | undefined
  readonly #conversations: TelegramBotOptions[`conversations`]
  readonly #commands = new Map<string, TelegramHandler>()
  readonly #callbacks = new Map<string, TelegramHandler>()
  readonly #flows = new Map<string, Record<string, TelegramStepHandler>>()
  #text: TelegramHandler | undefined

  constructor(options: TelegramBotOptions) {
    this.#client = options.client
    this.#username = options.username?.toLowerCase()
    this.#conversations = options.conversations
  }

  /** Handles `/<name>`. `name` is matched without the slash, case-insensitively. */
  command(name: string, handler: TelegramHandler): this {
    this.#commands.set(name.replace(/^\//, ``).toLowerCase(), handler)
    return this
  }

  /** Handles a button whose `callback_data` is `prefix` or starts with `prefix:`. */
  callback(prefix: string, handler: TelegramHandler): this {
    this.#callbacks.set(prefix, handler)
    return this
  }

  /** Handles any text message no command or conversation took. */
  text(handler: TelegramHandler): this {
    this.#text = handler
    return this
  }

  /**
   * Registers a conversation. Its first key is the first step; each step handler gets the
   * person's answer and the data so far.
   *
   * @throws {Error} When the bot has no conversation store, or `steps` is empty.
   */
  conversation(name: string, steps: Record<string, TelegramStepHandler>): this {
    if (!this.#conversations) {
      throw new Error(`TelegramBot needs options.conversations to register "${name}"`)
    }
    if (Object.keys(steps).length === 0) {
      throw new Error(`Conversation "${name}" has no steps`)
    }
    this.#flows.set(name, steps)
    return this
  }

  /**
   * Routes one update. A handler's error is not caught here; the webhook handler and the polling
   * loop pass it to their `onError`.
   *
   * @returns Whether a handler took the update.
   */
  async handleUpdate(update: TelegramUpdate): Promise<boolean> {
    const query = update.callback_query
    const message = update.message ?? query?.message
    if (!message) return false
    const key = this.#stateKey(message.chat.id, update.message?.from?.id ?? query?.from.id)
    let state = await this.#load(key)
    const ctx = this.#context(update, message, query, () => state, (next) => (state = next), key)

    const handler = this.#route(ctx, query, state !== null)
    if (handler === `conversation`) {
      await this.#step(ctx, state as SavedState, key)
    } else if (handler) {
      await handler(ctx)
    }
    if (query && !answered.has(ctx)) {
      await ctx.answer()
    }
    return handler !== undefined
  }

  /** Picks the handler for an update, or `conversation` when the running one takes it. */
  #route(
    ctx: TelegramContext,
    query: TelegramCallbackQuery | undefined,
    inConversation: boolean,
  ): TelegramHandler | `conversation` | undefined {
    if (!query && ctx.text?.startsWith(`/`)) {
      const match = /^\/([A-Za-z0-9_]+)(?:@([A-Za-z0-9_]+))?(?:\s+([\s\S]*))?$/.exec(ctx.text)
      const addressed = !match?.[2] || !this.#username || match[2].toLowerCase() === this.#username
      const handler = match && addressed ? this.#commands.get(match[1].toLowerCase()) : undefined
      if (handler) {
        ctx.args = match?.[3]?.trim() ?? ``
        return handler
      }
    }
    if (query?.data !== undefined) {
      const separator = query.data.indexOf(`:`)
      const prefix = separator === -1 ? query.data : query.data.slice(0, separator)
      const handler = this.#callbacks.get(prefix)
      if (handler) {
        ctx.args = separator === -1 ? `` : query.data.slice(separator + 1)
        return handler
      }
    }
    if (inConversation && (query || ctx.text !== undefined)) return `conversation`
    if (!query && ctx.text !== undefined) return this.#text
    return undefined
  }

  /** Runs the running conversation's current step and saves where it goes next. */
  async #step(ctx: TelegramContext, state: SavedState, key: string): Promise<void> {
    const result = await this.#flows.get(state.name)![state.step](ctx, state.data)
    // The step may have ended or replaced the conversation itself.
    if (ctx.conversation.name !== state.name) return
    if (!result) return
    if (`done` in result) {
      await ctx.conversation.end()
      return
    }
    if (!(result.step in this.#flows.get(state.name)!)) {
      throw new Error(`Conversation "${state.name}" has no step "${result.step}"`)
    }
    await this.#save(key, { name: state.name, step: result.step, data: result.data ?? state.data })
  }

  #context(
    update: TelegramUpdate,
    message: TelegramMessage,
    query: TelegramCallbackQuery | undefined,
    getState: () => SavedState | null,
    setState: (state: SavedState | null) => void,
    key: string,
  ): TelegramContext {
    const client = this.#client
    const chatId = message.chat.id
    const ctx: TelegramContext = {
      update,
      chatId,
      from: query ? query.from : message.from,
      text: query ? undefined : message.text,
      data: query?.data,
      args: ``,
      client,
      reply: (text, extra) => client.sendMessage({ ...extra, chat_id: chatId, text }),
      answer: async (text) => {
        if (!query || answered.has(ctx)) return
        answered.add(ctx)
        await client.answerCallbackQuery({ callback_query_id: query.id, text })
      },
      conversation: {
        get name() {
          return getState()?.name
        },
        start: async (name, data = {}) => {
          const steps = this.#flows.get(name)
          if (!steps) throw new Error(`No conversation "${name}" is registered`)
          const state = { name, step: Object.keys(steps)[0], data }
          await this.#save(key, state)
          setState(state)
        },
        end: async () => {
          setState(null)
          if (this.#conversations) await this.#conversations.store.del(key)
        },
      },
    }
    return ctx
  }

  /** One state per person per chat, so two people in a group each have their own. */
  #stateKey(chatId: number, userId: number | undefined): string {
    const prefix = this.#conversations?.keyPrefix ?? `telegram:conversation:`
    return `${prefix}${chatId}:${userId ?? chatId}`
  }

  /** The saved state, or `null` when none, expired, unreadable or no longer registered. */
  async #load(key: string): Promise<SavedState | null> {
    if (!this.#conversations || this.#flows.size === 0) return null
    const raw = await this.#conversations.store.get(key)
    if (raw === null) return null
    let parsed: unknown
    try {
      parsed = JSON.parse(raw)
    } catch {
      parsed = undefined
    }
    const state = savedState(parsed)
    if (state instanceof type.errors || !(state.step in (this.#flows.get(state.name) ?? {}))) {
      // A step renamed in a deploy, or a corrupt value: drop it rather than trap the person.
      await this.#conversations.store.del(key)
      return null
    }
    return state
  }

  async #save(key: string, state: SavedState): Promise<void> {
    const options = this.#conversations!
    await options.store.set(key, JSON.stringify(state), options.ttlSec ?? 900)
  }
}

/** Contexts whose button press is already answered. */
const answered = new WeakSet<TelegramContext>()

/** Options of {@link createTelegramWebhookHandler}. */
export interface TelegramWebhookOptions {
  /** The `secret_token` given to `setWebhook`: 1-256 of `A-Z a-z 0-9 _ -`. */
  secretToken: string
  /** Receives every valid update, for example `bot.handleUpdate`. */
  onUpdate: (update: TelegramUpdate) => unknown | Promise<unknown>
  /** Receives an error `onUpdate` threw. */
  onError: (error: unknown, update: TelegramUpdate) => void
  /** Largest body accepted. Defaults to 1 MiB; an update is a few kilobytes. */
  maxBodyBytes?: number
}

const SECRET_SHAPE = /^[A-Za-z0-9_-]{1,256}$/

/**
 * Builds a webhook endpoint: `(request) => response`, for any server that speaks `Request`.
 *
 * It answers 405 to anything but `POST`, 401 when `X-Telegram-Bot-Api-Secret-Token` is missing
 * or wrong (compared in constant time, before the body is read), 413 for a body over the cap,
 * 400 for a body that is not an update, and 200 once `onUpdate` has run. It answers 200 even
 * when `onUpdate` threw: any other status makes Telegram send the update again, and a handler
 * that already acted half-way would act twice.
 *
 * @throws {TypeError} When `secretToken` is not a valid Telegram secret.
 */
export function createTelegramWebhookHandler(
  options: TelegramWebhookOptions,
): (request: Request) => Promise<Response> {
  if (!SECRET_SHAPE.test(options.secretToken)) {
    throw new TypeError(`Telegram webhook secretToken must be 1-256 of A-Z a-z 0-9 _ -`)
  }
  const maxBytes = options.maxBodyBytes ?? 1024 * 1024
  return async (request) => {
    if (request.method !== `POST`) {
      return new Response(null, { status: 405, headers: { allow: `POST` } })
    }
    const given = request.headers.get(`x-telegram-bot-api-secret-token`) ?? ``
    if (!(await constantTimeEqualsText(given, options.secretToken))) {
      await request.body?.cancel().catch(() => undefined)
      return new Response(null, { status: 401 })
    }
    let update: TelegramUpdate | null
    try {
      update = parseTelegramUpdate(await readBoundedJson(request, { maxBytes }))
    } catch (cause) {
      return new Response(null, { status: cause instanceof PayloadTooLargeError ? 413 : 400 })
    }
    if (!update) return new Response(null, { status: 400 })
    try {
      await options.onUpdate(update)
    } catch (error) {
      options.onError(error, update)
    }
    return new Response(null, { status: 200 })
  }
}

/** Options of {@link pollTelegramUpdates}. */
export interface TelegramPollingOptions {
  client: TelegramClient
  /** Receives every valid update, in order, one at a time. */
  onUpdate: (update: TelegramUpdate) => unknown | Promise<unknown>
  /** Receives a failed `getUpdates`, an invalid update, or an error `onUpdate` threw. */
  onError: (error: unknown) => void
  /** Stops the loop. The returned promise resolves once it has stopped. */
  signal: AbortSignal
  /** Seconds Telegram holds a `getUpdates` call open. Defaults to 30. */
  timeoutSec?: number
  /** Update kinds to receive, as `getUpdates`'s `allowed_updates`. */
  allowedUpdates?: string[]
  /** Waits between failed calls; must return early when `signal` aborts. Injected by tests. */
  sleep?: (ms: number, signal: AbortSignal) => Promise<void>
}

/**
 * Long polling for development, where Telegram cannot reach a webhook. Runs until `signal`
 * aborts and never rejects. A failed call waits 1s, doubling up to 60s, then tries again.
 *
 * Telegram refuses `getUpdates` (409) while a webhook is set: call `deleteWebhook` first.
 * An update whose handler threw still counts as read, so one bad update cannot stall the loop.
 */
export async function pollTelegramUpdates(options: TelegramPollingOptions): Promise<void> {
  const { client, signal } = options
  const timeoutSec = options.timeoutSec ?? 30
  const sleep = options.sleep ?? abortableSleep
  let offset: number | undefined
  let failures = 0
  while (!signal.aborted) {
    const answer = await client.call<unknown[]>(
      `getUpdates`,
      { offset, timeout: timeoutSec, allowed_updates: options.allowedUpdates },
      { signal, timeoutMs: (timeoutSec + 10) * 1000, retry: false },
    )
    if (signal.aborted) return
    if (!answer.ok || !Array.isArray(answer.result)) {
      failures++
      options.onError(
        new Error(
          answer.ok
            ? `Telegram getUpdates returned no list`
            : `Telegram getUpdates failed: ${answer.code}: ${answer.message}`,
        ),
      )
      await sleep(Math.min(1000 * 2 ** (failures - 1), 60_000), signal)
      continue
    }
    failures = 0
    for (const raw of answer.result) {
      const id = (raw as { update_id?: unknown } | null)?.update_id
      if (typeof id === `number` && Number.isInteger(id)) {
        offset = Math.max(offset ?? 0, id + 1)
      }
      const update = parseTelegramUpdate(raw)
      if (!update) {
        options.onError(new Error(`Telegram sent an update that is not valid`))
        continue
      }
      try {
        await options.onUpdate(update)
      } catch (error) {
        options.onError(error)
      }
      if (signal.aborted) return
    }
  }
}

/** Waits `ms`, or less when `signal` aborts first. */
function abortableSleep(ms: number, signal: AbortSignal): Promise<void> {
  return new Promise((resolve) => {
    if (signal.aborted) return resolve()
    const done = () => {
      clearTimeout(timer)
      signal.removeEventListener(`abort`, done)
      resolve()
    }
    const timer = setTimeout(done, ms)
    signal.addEventListener(`abort`, done, { once: true })
  })
}
