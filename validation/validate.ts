/**
 * Parsing a value with an arktype schema, and reporting what was wrong with it.
 *
 * One outcome shape for the whole ecosystem: {@link ValidationResult} carries either the parsed
 * value or a {@link ValidationError} with a one-line `description` and arktype's own `details`.
 *
 * Nothing here touches a framework, imports another package, or mutates arktype's global config.
 * Strictness (`onUndeclaredKey`) is the host application's decision, not a library's side effect.
 */

import { type ArkErrors, Type, type } from "arktype"

/** Value a schema produces after parsing, morphs applied. */
export type SchemaOutput<T extends Type> = T["infer"]

/** Value a schema accepts as input, before parsing. */
export type SchemaInput<T extends Type> = T["inferIn"]

/** Submitted data the schema rejected. */
export interface ValidationError {
  /** Human-readable summary — arktype's `summary`, one issue per line. */
  description: string
  /**
   * arktype's errors instance itself, not a copy of it.
   *
   * Keeping the class is what leaves `flatByPath`, `byPath`, `summary` and iteration available to
   * the caller; a plain array of messages would throw all of that away.
   */
  details: ArkErrors
}

/** Outcome of {@link validate}: the parsed value, or the error that rejected it. */
export type ValidationResult<T extends Type> =
  | { error: ValidationError; data: null }
  | { error: null; data: SchemaOutput<T> }

/**
 * Parse `value` with an arktype schema exactly once.
 *
 * Returns `{ data }` on success and `{ error }` on failure, so a caller branches without a
 * try/catch, and `data` is the *parsed* value — a morph (`"string.date.iso.parse"`) has already
 * run, so a date field hands back a `Date`, not the string it was given.
 *
 * @example
 * ```ts
 * const { error, data } = validate(userSchema, input)
 * if (error) return error.description
 * await save(data)
 * ```
 */
export function validate<T extends Type>(schema: T, value: unknown): ValidationResult<T> {
  const result = schema(value)
  if (result instanceof type.errors) {
    return { error: toValidationError(result), data: null }
  }
  return { error: null, data: result as SchemaOutput<T> }
}

/**
 * Build a {@link ValidationError} from arktype's issues.
 *
 * `details` is the instance the schema returned, unchanged: the caller keeps `flatByPath` for
 * per-field lookup and `byPath` for nested reads, and `description` is the flat summary those
 * issues render to.
 */
export function toValidationError(issues: ArkErrors): ValidationError {
  return { description: issues.summary, details: issues }
}

/**
 * First issue message in a validation error, in the order arktype reports them.
 *
 * Useful when a whole batch is rejected and only one line of copy is available. The message is
 * path-prefixed (`"address.city must be a string"`), so a nested failure names its own field.
 * Returns `null` when the error carries no issues.
 */
export function firstIssueMessage(error: ValidationError): string | null {
  for (const issue of error.details) {
    if (issue.message) return issue.message
  }
  return null
}
