/**
 * Parsing a value with an arktype schema, and reporting what was wrong with it.
 *
 * One outcome shape for the whole ecosystem: {@link ValidationResult} carries either the parsed
 * value or a {@link ValidationError}. The error carries its kind ({@link ErrType.Validation}), one
 * sentence for the user, the issues keyed by field path, a one-line `description` and arktype's own
 * `details`. {@link ErrType} lives here, not in `@spy4x/platform`, so that this package can tag its
 * error without importing platform — platform imports this package, and a cycle between the two
 * fails `deno publish`. Platform re-exports the same enum.
 *
 * Nothing here touches a framework, imports another package, or mutates arktype's global config.
 * Strictness (`onUndeclaredKey`) is the host application's decision, not a library's side effect.
 * @module
 */

import type { ArkError, ArkErrors, Type } from "arktype"
// `model.ts` imports `isArkErrors` from here, so the two modules import each other. That is safe:
// neither reads the other's binding at load time, only inside a function call.
import { FORM_FIELD } from "./model.ts"

/** Value a schema produces after parsing, morphs applied. */
export type SchemaOutput<T extends Type> = T["infer"]

/** Value a schema accepts as input, before parsing. */
export type SchemaInput<T extends Type> = T["inferIn"]

/**
 * Kind of a failed operation. Numeric so it is cheap to switch on and serialise.
 *
 * A caller switches on `error.type` and gets a narrowed interface. `@spy4x/platform` re-exports
 * this enum from `@spy4x/platform/universal/errors`, where the other error shapes live.
 */
export enum ErrType {
  /** Submitted data did not satisfy the schema. Carries per-field issues. */
  Validation = 1,
  /** The request never reached the server, or the reply never came back. */
  Connection = 2,
  /** The server answered with a failure status. */
  Server = 3,
  /** A failure no other member describes. */
  Other = 4,
  /** A payload arrived that a schema could not parse: a response body or a feed item. */
  Payload = 5,
}

/** The sentence every {@link ValidationError} shows the user, whatever the fields said. */
export const VALIDATION_MESSAGE =
  "Provided data doesn't seem valid. Check the form validation error messages."

/** One schema issue, flattened for display next to a form field. */
export interface ValidationIssue {
  /** arktype's error code, for example `"domain"` or `"minLength"`. */
  code: string
  /**
   * Path of the offending value as arktype prints it, for example `"body.lower"` or `"items[1]"`.
   * An empty string for an issue with no field, which is filed under {@link FORM_FIELD}.
   */
  path: string
  /** Explanation for that value alone, without the path, for example `"must be a number"`. */
  message: string
}

/**
 * Issues keyed by field path.
 *
 * Paths, not field names: arktype reports `{ address: { city } }` as `"address.city"`, which no
 * `keyof` of the schema's output produces. A field with no issue is absent from the record.
 */
export type ValidationIssues = Record<string, ValidationIssue[] | undefined>

/** Submitted data the schema rejected. */
export interface ValidationError {
  /** Kind of the failure; always {@link ErrType.Validation}, so a union can narrow on it. */
  type: ErrType.Validation
  /** One sentence for the user: {@link VALIDATION_MESSAGE}. The fields say what was wrong. */
  message: string
  /** Every issue, keyed by field path; an issue with no field sits under {@link FORM_FIELD}. */
  errors: ValidationIssues
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
  if (isArkErrors(result)) {
    return { error: toValidationError(result), data: null }
  }
  return { error: null, data: result as SchemaOutput<T> }
}

/**
 * Whether a value is an arktype rejection, without relying on `instanceof`.
 *
 * `instanceof ArkErrors` only matches an instance built by the exact same loaded copy of arktype.
 * If the host application and this package resolve two different copies — a version mismatch
 * across packages is enough — an error built by one copy fails `instanceof` against the other's
 * class, and gets read as a successful value instead of a rejection. This checks the same public
 * shape every arktype build exposes on a rejection instead: an array of issues with a `summary`
 * string and a `throw` method.
 */
export function isArkErrors(value: unknown): value is ArkErrors {
  return (
    Array.isArray(value) &&
    typeof (value as { summary?: unknown }).summary === "string" &&
    typeof (value as { throw?: unknown }).throw === "function"
  )
}

/**
 * Build a {@link ValidationError} from arktype's issues.
 *
 * Every issue is filed under its path (`"body.lower"` for nested data), so a form can look up its
 * own field and ignore the rest; an issue with no path goes under {@link FORM_FIELD}. Issues on one
 * path are already merged by arktype. `details` is the instance the schema returned, unchanged,
 * and `description` is the flat summary those issues render to.
 */
export function toValidationError(issues: ArkErrors): ValidationError {
  const errors: ValidationIssues = {}
  for (const [path, list] of Object.entries(issues.flatByPath)) {
    errors[path === "" ? FORM_FIELD : path] = list.map((issue) => ({
      code: issue.code,
      path,
      message: problemOf(issue),
    }))
  }
  return {
    type: ErrType.Validation,
    message: VALIDATION_MESSAGE,
    errors,
    description: issues.summary,
    details: issues,
  }
}

/**
 * An issue's explanation without its path, or its full message when arktype cannot build one.
 *
 * arktype builds `problem` from the issue's `expected` text. A rejection written the way arktype's
 * own docs show it, `ctx.reject({ message: "…" })`, has a message but no `expected`, and reading
 * its `problem` throws a `TypeError`. Its `message` is the caller's own sentence, with no path in
 * it, so it is the right text to show instead.
 */
function problemOf(issue: ArkError): string {
  try {
    return issue.problem
  } catch {
    return issue.message
  }
}

/**
 * First issue message in a validation error, in the order arktype reports them.
 *
 * Useful when a whole batch is rejected and only one line of copy is available. The message is
 * path-prefixed (`"address.city must be a string"`), so a nested failure names its own field.
 * Returns `null` when the error carries no issues. Only `details` is read, so an error built by hand
 * with just `description` and `details` is accepted too.
 */
export function firstIssueMessage(
  error: Pick<ValidationError, "description" | "details">,
): string | null {
  for (const issue of error.details) {
    if (issue.message) return issue.message
  }
  return null
}
