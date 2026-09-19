/**
 * `@ts-libs/integrations` — outbound integration clients and inbound webhook
 * verification. Every client is a thin `fetch` wrapper with an injectable
 * transport, so nothing here needs network access to be tested.
 */

export { SlackClient, slackConfigFromEnv } from "./slack.ts"
export type {
  SlackClientConfig,
  SlackClientOptions,
  SlackErrorCode,
  SlackFailure,
  SlackResult,
  SlackRetryOptions,
  SlackSuccess,
} from "./slack.ts"

export {
  basicAuthHeader,
  emailHash,
  MailchimpClient,
  mailchimpConfigFromEnv,
  MailchimpStatus,
  md5Hex,
  normalizeEmail,
} from "./mailchimp.ts"
export type {
  MailchimpClientConfig,
  MailchimpClientOptions,
  MailchimpContact,
  MailchimpDisabledReason,
  MailchimpError,
  MailchimpErrorCode,
  MailchimpMemberFound,
  MailchimpMemberLookup,
  MailchimpMemberMissing,
  MailchimpResult,
  MailchimpRetryOptions,
  MailchimpSkippedDisabled,
  MailchimpUpserted,
  MailchimpUpsertMethod,
} from "./mailchimp.ts"

export { verifyWebhookRequest } from "./webhooks.ts"
export type { WebhookRejectReason, WebhookVerifierConfig, WebhookVerifyResult } from "./webhooks.ts"

export {
  createExponentialBackoff,
  describeTransportError,
  isPermanentStatus,
  isTransientStatus,
  parseRetryAfterMs,
  runWithRetry,
  settle,
} from "./retry.ts"
export type {
  BackoffFn,
  Clock,
  RetryPolicy,
  RetryRunOptions,
  RetryRunResult,
  Sleeper,
} from "./retry.ts"
