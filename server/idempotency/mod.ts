/**
 * `@spy4x/server/idempotency` — commands that are safe to send twice: a CQRS middleware that
 * replays the stored result of a command retried with the same key, and the stores behind it.
 * Extracted from `template/libs/server/idempotency/` (#313).
 *
 * @module
 */
export {
  type BeginOutcome,
  createIdempotencyMiddleware,
  fingerprint,
  IDEMPOTENCY_LEASE_SECONDS,
  IDEMPOTENCY_RETENTION_DAYS,
  type IdempotencyClaim,
  IdempotencyError,
  type IdempotencyErrorCode,
  type IdempotencyOptions,
  type IdempotencyStore,
  isIdempotencyKey,
  MAX_IDEMPOTENCY_COMMAND_NAME_LENGTH,
  MAX_IDEMPOTENCY_KEY_LENGTH,
} from "./idempotency.ts"
export { MemoryIdempotencyStore, type MemoryIdempotencyStoreOptions } from "./memory.ts"
export {
  IDEMPOTENCY_POSTGRES_SCHEMA,
  PostgresIdempotencyStore,
  type PostgresIdempotencyStoreOptions,
} from "./postgres.ts"
