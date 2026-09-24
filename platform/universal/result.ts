/**
 * `Result` — the narrow success/failure sum used inside a function body, and the
 * `{ success, output, error }` envelope used at a command boundary.
 *
 * Two shapes, two jobs:
 *
 * - {@link Result} is a `{ ok, value }` / `{ ok, error }` pair. It carries a *value*, so it is
 *   what a pure helper returns when failure is expected and not exceptional.
 * - {@link CommandEnvelope} is the `{ success, output, error }` triple a CLI command or job
 *   handler returns. It crosses a process or job boundary, so `error` is a message string, not a
 *   live error object — it has to survive `JSON.stringify`.
 *
 * {@link OperationResult} in `errors.ts` is the third and last: an operation result where the
 * error is a *typed* {@link AnyError} rather than a string.
 *
 * @module
 */

/** A value or an error, as a discriminated union on `ok`. */
export type Result<T, E = string> =
  | { ok: true; value: T }
  | { ok: false; error: E }

/** Wrap a success. */
export const ok = <T>(value: T): Result<T, never> => ({ ok: true, value })

/** Wrap a failure. */
export const err = <E>(error: E): Result<never, E> => ({ ok: false, error })

/** Narrow a {@link Result} to its value, or raise. Use only where failure is a programming error. */
export function unwrap<T, E>(result: Result<T, E>): T {
  if (result.ok) return result.value
  throw new Error(typeof result.error === "string" ? result.error : JSON.stringify(result.error))
}

/** Narrow a {@link Result} to its value, or fall back. */
export function unwrapOr<T, E>(result: Result<T, E>, fallback: T): T {
  return result.ok ? result.value : fallback
}

/** Outcome of a command: what it produced, or why it failed. */
export interface CommandEnvelope<T> {
  success: boolean
  output: T | null
  error: string | null
}

/** Build the success arm of a {@link CommandEnvelope}. */
export function commandOk<T>(output: T): CommandEnvelope<T> {
  return { success: true, output, error: null }
}

/** Build the failure arm of a {@link CommandEnvelope}. */
export function commandErr<T = never>(error: string): CommandEnvelope<T> {
  return { success: false, output: null, error }
}

/** Build a {@link CommandEnvelope} from a thrown error, keeping the stack out of the payload. */
export function commandFromError<T = never>(error: unknown): CommandEnvelope<T> {
  return commandErr<T>(error instanceof Error ? error.message : String(error))
}
