/**
 * Telegram bots: the Bot API client, a router for commands and button presses, conversations
 * kept in a store the caller passes in, a webhook handler and a long-polling loop.
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
