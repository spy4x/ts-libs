/**
 * Per-field error codes for the wire: what a server sends so a screen can say, in its own
 * language, which field failed and why. arktype's codes are used as they are (`required`,
 * `maxLength`, `domain`, …), with no mapping list to keep in step with arktype.
 * @module
 */

import { type ArkErrors, type } from "arktype"
import { flatIssues } from "./flat-issues.ts"
import { FORM_FIELD } from "./model.ts"

/** Why one field failed: arktype's code, and the rule its message quotes. */
export interface FieldError {
  /** arktype's error code, for example `"required"`, `"maxLength"` or `"domain"`. */
  code: string
  /** The rule the value missed, such as `{ rule: 120 }` for `maxLength`; absent when there is none. */
  values?: Record<string, string | number | boolean>
}

/**
 * Failed fields keyed by path as arktype prints it (`"title"`, `"address.city"`, `"items[1]"`).
 * An issue with no path sits under {@link FORM_FIELD}.
 */
export type FieldErrors = Record<string, FieldError>

/** The arktype type of {@link FieldErrors}, for a client that reads them off the wire. */
export const fieldErrorsSchema = type({
  "[string]": {
    code: "string",
    "values?": { "[string]": "string | number | boolean" },
  },
})

/**
 * The failed fields of an arktype rejection, one entry per path. When a path failed more than one
 * constraint, the first that arktype reports is kept, since a field shows one message.
 *
 * @example
 * ```ts
 * fieldErrors(type({ title: "string <= 120" })({ title: "x".repeat(121) }) as ArkErrors)
 * // { title: { code: "maxLength", values: { rule: 120 } } }
 * ```
 */
export function fieldErrors(errors: ArkErrors): FieldErrors {
  const fields: FieldErrors = {}
  for (const { path, code, values } of flatIssues(errors)) {
    const key = path === "" ? FORM_FIELD : path
    if (Object.hasOwn(fields, key)) continue
    Object.defineProperty(fields, key, {
      value: Object.keys(values).length > 0 ? { code, values } : { code },
      enumerable: true,
      writable: true,
      configurable: true,
    })
  }
  return fields
}
