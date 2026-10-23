/**
 * The one reader of a failed response's JSON body, shared by `responseError` (`errors.ts`) and
 * `apiFetch` (`../api/api.ts`) so the two never answer differently for one body. Not exported from
 * the package.
 *
 * @module
 */

import { type } from "arktype"
import { type FieldErrors, fieldErrorsSchema } from "@spy4x/validation"

/** What a failed response's body carries, each part absent when the body has none. */
export interface ErrorBodyFields {
  message?: string
  code?: string
  /** `error.reason`: the server's finer name for the refusal, under `code`. */
  reason?: string
  /** `error.fields`: each failed field's code and rule, keyed by path. */
  fields?: FieldErrors
}

/** A non-empty string, or `undefined`. */
function text(value: unknown): string | undefined {
  return typeof value === "string" && value !== "" ? value : undefined
}

/** `value` as a plain record, or an empty one when it is not an object. */
function fieldsOf(value: unknown): Record<string, unknown> {
  return value !== null && typeof value === "object" ? value as Record<string, unknown> : {}
}

/**
 * The message and code a parsed error body holds.
 *
 * The message is the first non-empty string of: the body itself when it is a bare string, `error`
 * when it is a string, `error.message`, `message`, `detail`. The code is `error.code`, else `code`.
 * So `{ error }`, `{ code, message }`, `{ error: { code, message } }` and a `{ detail }` body all
 * read alike; non-string fields are ignored. `error.reason` (a string) and `error.fields` (the
 * shape `fieldErrorsSchema` accepts) are read only from the nested object; another shape is left out.
 */
export function errorBodyFields(body: unknown): ErrorBodyFields {
  const fields = fieldsOf(body)
  const nested = fieldsOf(fields.error)
  const result: ErrorBodyFields = {}
  const message = text(body) ?? text(fields.error) ?? text(nested.message) ??
    text(fields.message) ?? text(fields.detail)
  if (message !== undefined) result.message = message
  const code = text(nested.code) ?? text(fields.code)
  if (code !== undefined) result.code = code
  const reason = text(nested.reason)
  if (reason !== undefined) result.reason = reason
  if (nested.fields !== undefined && !(fieldErrorsSchema(nested.fields) instanceof type.errors)) {
    result.fields = nested.fields as FieldErrors
  }
  return result
}
