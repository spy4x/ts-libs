/**
 * `@ts-libs/integrations` — outbound integration clients and inbound webhook
 * verification. Every client is a thin `fetch` wrapper with an injectable
 * transport, so nothing here needs network access to be tested.
 */

export { verifyWebhookRequest } from "./webhooks.ts"
export type { WebhookRejectReason, WebhookVerifierConfig, WebhookVerifyResult } from "./webhooks.ts"

export {
  HealthchecksClient,
  healthchecksConfigFromEnv,
  HealthchecksOutcome,
} from "./healthchecks.ts"
export type {
  HealthchecksClientConfig,
  HealthchecksClientOptions,
  HealthchecksErrorCode,
  HealthchecksFailure,
  HealthchecksPing,
  HealthchecksResult,
  HealthchecksRetryOptions,
  HealthchecksSuccess,
} from "./healthchecks.ts"

export { NotificationSeverity, NtfyClient, ntfyConfigFromEnv, NtfyPriority } from "./ntfy.ts"
export type {
  NtfyClientConfig,
  NtfyClientOptions,
  NtfyErrorCode,
  NtfyFailure,
  NtfyPush,
  NtfyPushed,
  NtfyResult,
  NtfyRetryOptions,
  NtfySkipped,
} from "./ntfy.ts"

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
