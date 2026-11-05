/**
 * Telegram bots: the Bot API client, a router for commands and button presses, conversations
 * kept in a store the caller passes in, a webhook handler and a long-polling loop.
 *
 * ```ts
 * const client = new TelegramClient({ token })
 * const bot = new TelegramBot({ client, conversations: { store } }) // store: get, set with TTL, del
 *   .command(`start`, (ctx) => ctx.reply(`Hi`, { reply_markup: menu }))
 *   .callback(`menu`, (ctx) => ctx.reply(`You chose ${ctx.args}`)) // data `menu:<args>`
 *   .command(`rename`, async (ctx) => {
 *     await ctx.conversation.start(`rename`)
 *     await ctx.reply(`New name?`)
 *   })
 *   .conversation(`rename`, {
 *     name: (ctx) => ({ step: `confirm`, data: { name: ctx.text } }),
 *     confirm: (ctx, data) => ({ done: true }),
 *   })
 *
 * // Production: a webhook. Development: long polling until the signal aborts.
 * const webhook = createTelegramWebhookHandler({
 *   secretToken,
 *   onUpdate: (u) => bot.handleUpdate(u),
 *   onError,
 * })
 * await pollTelegramUpdates({ client, signal, onUpdate: (u) => bot.handleUpdate(u), onError })
 * ```
 *
 * - **Client.** Typed `getMe`, `sendMessage`, `editMessageText`, `deleteMessage`,
 *   `answerCallbackQuery`, `setWebhook`, `deleteWebhook` and `setMyCommands`, with parameters named
 *   as in the Bot API; `call(method, params)` reaches any other method. A result is
 *   `{ ok: true, result, attempts }` or `{ ok: false, code, message, status?, attempts }`, where
 *   `message` is Telegram's `description`. Redirects are refused, answers are read under a 5 MiB
 *   cap, and the token never appears in a result.
 * - **Retries.** 3 attempts, 1s doubling up to 30s, 60s in all; a 429's `retry_after` is honoured up to 30s.
 *   Telegram has no idempotency key, so a retry after a timeout can send a message twice: pass
 *   `retry: { maxAttempts: 1 }` where that is worse than losing it.
 * - **Webhook.** 405 for anything but `POST`; 401 when `X-Telegram-Bot-Api-Secret-Token` is missing
 *   or wrong, compared in constant time before the body is read; 413 over 1 MiB; 400 for a body
 *   arktype does not accept as an update. A handler that throws goes to `onError` and the answer is
 *   still 200, because any other status makes Telegram send the update again.
 * - **Routing.** A registered command wins (`/cancel` can always end a conversation), then a
 *   callback route by `prefix` or `prefix:`, then a running conversation, then the `text` handler.
 *   With `username` set, `/start@other_bot` reaches no handler, not even a conversation or the
 *   `text` handler. A button press the handler did not answer is answered after it, also when the
 *   handler threw, so its spinner stops; a press the bot cannot route to a chat (inline mode) gets
 *   an empty answer.
 * - **Conversations.** State is `{ name, step, data }` as JSON in the store passed in, one per person
 *   per chat, expiring after `ttlSec` (900 by default), so a restart or a second instance continues
 *   where the person left off. A step returns the next step, `{ done: true }`, or nothing to stay. A
 *   saved step that no longer exists is dropped.
 * - **Polling.** For development only. A failed call waits 1s, doubling up to 60s; an update whose
 *   handler threw still counts as read. Telegram refuses polling while a webhook is set, so call
 *   `deleteWebhook` first.
 * - **Not here.** Linking a Telegram account to a user, and any product's commands: those belong to
 *   the app.
 *
 * @module
 */

export {
  parseTelegramUpdate,
  TELEGRAM_API_BASE_URL,
  TELEGRAM_RETRY_POLICY,
  TelegramClient,
} from "./telegram-client.ts"
export type {
  TelegramAnswerCallbackQuery,
  TelegramBotCommand,
  TelegramCallbackQuery,
  TelegramCallOptions,
  TelegramChat,
  TelegramClientConfig,
  TelegramClientOptions,
  TelegramEditMessageText,
  TelegramErrorCode,
  TelegramFailure,
  TelegramInlineButton,
  TelegramInlineKeyboard,
  TelegramMessage,
  TelegramResult,
  TelegramSendMessage,
  TelegramSetWebhook,
  TelegramSuccess,
  TelegramUpdate,
  TelegramUser,
} from "./telegram-client.ts"

export { createTelegramWebhookHandler, pollTelegramUpdates, TelegramBot } from "./telegram-bot.ts"
export type {
  TelegramBotOptions,
  TelegramContext,
  TelegramConversationControl,
  TelegramConversationData,
  TelegramConversationStore,
  TelegramHandler,
  TelegramPollingOptions,
  TelegramStepHandler,
  TelegramStepResult,
  TelegramWebhookOptions,
} from "./telegram-bot.ts"
