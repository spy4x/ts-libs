/**
 * The error envelope shared by `chat.ts`, `chat-json.ts` and `parse-json.ts`.
 *
 * One error shape for the whole package, and one place where text a provider or
 * a model controls is made safe to surface. It sits below the other three
 * modules so they form a chain — `errors` ← `parse-json` ← `chat-json` ←
 * `chat` — and never a cycle.
 */

/**
 * Stable failure classification.
 *
 * Values start at 1 so an unset code can never be read as a real one, and so a
 * code can be serialised to a client without a translation table.
 */
export enum AiErrorCode {
  /** The client was built without a usable API key, or with a bad base URL. */
  MissingApiKey = 1,
  /** The provider answered with a non-2xx status. */
  ProviderError = 2,
  /** The provider answered 2xx but the envelope is not a completion. */
  InvalidResponse = 3,
  /** No response inside the timeout. */
  Timeout = 4,
  /** The caller's `AbortSignal` fired. */
  Aborted = 5,
  /** The transport failed — DNS, reset connection, TLS. Retryable. */
  NetworkError = 6,
  /** The 2xx body was not parseable JSON. */
  InvalidJson = 7,
  /** The model's text contained no recoverable JSON value. */
  JsonNotFound = 8,
  /** The recovered JSON value failed the caller's arktype schema. */
  SchemaMismatch = 9,
}

/**
 * Which of the independent cancellation sources ended a request.
 *
 * Explicit rather than inferred from the signal: an `AbortSignal` that has
 * already aborted reports the same `reason` whether the caller cancelled or
 * whether this client timed the request out, and a caller needs to tell those
 * apart to decide between "stop" and "retry later".
 */
export type AiErrorKind = "provider" | "config" | "timeout" | "abort" | "network" | "json"

/**
 * The only error this package raises or returns.
 *
 * `message` is locally constructed, or provider text that has passed through
 * {@link sanitizeProviderText}. It carries no prompt, completion, credential or
 * stack frame, and neither does `cause`, which is at most an error's
 * `name: message`.
 */
export interface AiError extends Error {
  kind: AiErrorKind
  code: AiErrorCode
  /** Safe, short, caller-facing sentence. */
  message: string
  /** HTTP status, when the failure came from a provider response. */
  status?: number
  /** The provider's own machine-readable code (`error.code`, then `error.type`). */
  providerCode?: string
  /** Total attempts issued, including the first. */
  attempts?: number
  /** Safe description of the underlying cause, when there was one. */
  cause?: string
  /** Why JSON recovery gave up. Only set for `JsonNotFound`. */
  extraction?: number
}

/** Fields an {@link AiError} is built from; `name` and `stack` come from `Error`. */
export type AiErrorInit = Omit<AiError, "name" | "stack">

/**
 * Raised as the concrete implementation of {@link AiError}.
 *
 * `Error` subclassing is what keeps an unexpected `AiError`-shaped object out:
 * `isAiError` checks the class as well as the fields, so a provider payload that
 * happens to carry `kind`/`code`/`message` keys is not mistaken for a failure.
 * `stack` is inherited from `Error` — this module never copies it into a message,
 * a log field or a return value.
 */
export class AiRequestError extends Error implements AiError {
  kind: AiErrorKind
  code: AiErrorCode
  status?: number
  providerCode?: string
  attempts?: number
  override cause?: string
  extraction?: number

  constructor(error: AiErrorInit) {
    super(error.message)
    this.name = "AiError"
    this.kind = error.kind
    this.code = error.code
    this.status = error.status
    this.providerCode = error.providerCode
    this.attempts = error.attempts
    this.cause = error.cause
    this.extraction = error.extraction
  }
}

/** Narrow a caught `unknown` to {@link AiError}. */
export function isAiError(error: unknown): error is AiError {
  return error instanceof AiRequestError
}

/** Cap on provider text that may reach a message, a log field or a return value. */
const MAX_PROVIDER_TEXT: number = 400

/**
 * Control characters, built from their code points.
 *
 * Written this way because a literal `\u0000-\u001f` class in a regular
 * expression reads as an accidental control character to a linter and as an
 * invisible range to a human. Stripping them is the point: a newline inside a
 * provider message is how a forged log line gets started.
 */
const CONTROL_CHARACTERS = new RegExp(
  `[${String.fromCharCode(0)}-${String.fromCharCode(0x1f)}${String.fromCharCode(0x7f)}]+`,
  "g",
)

/**
 * Reduce provider-controlled text to something safe to surface.
 *
 * A provider error body can echo the request, including the `Authorization`
 * header, so three defences run in order: drop anything shaped like a
 * credential, drop control characters (a newline inside a message is how a
 * forged log line or a header injection gets started), then truncate. This is
 * the only function permitted to hand provider text back to a caller.
 */
export function sanitizeProviderText(text: string): string {
  return stripFrameText(text)
    .replace(/sk-[A-Za-z0-9_-]{4,}/g, "<REDACTED:API_KEY>")
    .replace(/Bearer\s+[A-Za-z0-9._~+/=-]{8,}/gi, "Bearer <REDACTED:API_KEY>")
    .replace(CONTROL_CHARACTERS, " ")
    .replace(/\s+/g, " ")
    .trim()
    .slice(0, MAX_PROVIDER_TEXT)
}

/**
 * Remove stack-frame text from provider-controlled prose.
 *
 * A provider error message frequently carries its own trace — `at handler
 * (/srv/app/routes/api/chat.ts:41:9)` — and echoing a path, a module name and a
 * line number back to a caller is exactly what this package refuses to do,
 * whether the frame came from our code or from theirs. The descriptive part
 * survives: `internal error at handler (/srv/...:41:9) using X` becomes
 * `internal error <stack frame redacted> using X`, so the message still says what
 * happened without saying where anything lives.
 *
 * Deliberately conservative: a path carrying a line and column, and an `at frame`
 * sequence, are matched. A bare `FooError: too many requests` is left alone.
 */
export function stripFrameText(text: string): string {
  return text
    // `/srv/app/routes/api/chat.ts:41:9`, `worker.js:1:2`, `mod.mts:3:4`
    .replace(/[\w./@~-]*[\w-]+\.[cm]?[jt]sx?:\d+(?::\d+)?/g, "<stack frame redacted>")
    // `at handler (...)`, `at Object.<anonymous>`, `at async Object.chatCompletion`
    .replace(/\bat\s+(?:async\s+)?[\w$][\w$.<>]*(?:\s*\([^)]*\))?/g, "<stack frame redacted>")
}

/** `name: message` for a caught value, sanitized. Never a stack. */
export function describeCause(error: unknown): string {
  const name = error instanceof Error ? error.name : "Error"
  const message = error instanceof Error ? error.message : String(error)
  return sanitizeProviderText(`${name}: ${message}`)
}

/**
 * Why JSON recovery gave up.
 *
 * A reason for the single {@link AiErrorCode.JsonNotFound} code rather than a
 * code of its own: callers filter on "was it recoverable" and then read the
 * reason for the detail.
 */
export enum JsonExtractionFailure {
  /** The text contained no `{` or `[` at all. */
  NoJsonValue = 1,
  /** Something parsed, but it was a scalar and the caller forbade scalars. */
  ScalarValue = 2,
  /** The completion was empty or whitespace. */
  Empty = 3,
}
