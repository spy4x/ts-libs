/** Error codes a caller can branch on without matching on a message string. */
export type StorageErrorCode =
  | "invalid_config"
  | "invalid_acl"
  | "invalid_expiry"
  | "invalid_bucket"
  | "invalid_path"
  | "request_failed"

/**
 * Storage failure carrying a machine-readable `code`, the operation that failed
 * and any HTTP status the backend returned, so a caller can retry or re-map the
 * failure without parsing the message.
 */
export class StorageError extends Error {
  override readonly name = "StorageError"

  constructor(
    readonly code: StorageErrorCode,
    message: string,
    options: { operation?: string; status?: number; cause?: unknown } = {},
  ) {
    super(message, { cause: options.cause })
    this.operation = options.operation
    this.status = options.status
  }

  /** Provider method that raised the failure, when known. */
  readonly operation?: string
  /** HTTP status, when the failure came from a response. */
  readonly status?: number
}
