/**
 * `ops/notify/` — standalone outbound notifiers (healthchecks.io dead-man's
 * switch, ntfy push) plus the retry and header-safety core they share.
 *
 * Nothing in this directory references a backup type. `#18 ops/` owns the
 * backup contract and imports these notifiers; it must not re-export or
 * replace this barrel.
 */

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
  createAsciiHeaders,
  createExponentialBackoff,
  DEFAULT_RETRY_POLICY,
  isTransientStatus,
  parseRetryAfterMs,
  runWithRetry,
  toAsciiHeaderValue,
} from "./retry.ts"
export type { BackoffFn, Clock, RetryPolicy, RetryRunResult, Sleeper } from "./retry.ts"
