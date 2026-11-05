/**
 * `@spy4x/validation` — arktype parsing and form-validation state, framework-agnostic.
 *
 * Import the barrel for both halves, or a subpath (`@spy4x/validation/model`) for one.
 *
 * ```ts
 * import { type } from "arktype"
 * import { isValid, validate, validateSchema } from "@spy4x/validation"
 *
 * const userSchema = type({ name: "1 <= string <= 10", joinedAt: "string.date.iso.parse" })
 *
 * const { error, data } = validate(userSchema, input)
 * if (error) return error.description
 * await save(data) // `data` is parsed, so `joinedAt` is a `Date`
 * ```
 *
 * ## Field codes for the wire
 *
 * `fieldErrors(errors)` turns a rejection into what a server sends so a screen can name each failed
 * field in its own language: `{ [path]: { code, values? } }`. `code` is arktype's own (`required`,
 * `maxLength`, `domain`, …), and `values` holds the rule the value missed, such as
 * `{ rule: 120 }` for `maxLength` or `{ rule: 17, exclusive: true }` for `> 17`. The submitted value
 * is never included. One entry per path, the first issue arktype reports; an issue with no path goes
 * under `FORM_FIELD`. `fieldErrorsSchema` is the arktype type of that record, for a client reading it.
 *
 * ```ts
 * fieldErrors(type({ title: "string <= 120" })({ title: "x".repeat(121) }) as ArkErrors)
 * // { title: { code: "maxLength", values: { rule: 120 } } }
 * ```
 *
 * ## No global arktype config
 *
 * `configure({ onUndeclaredKey: "reject", onDeepUndeclaredKey: "reject" })` is deliberately **not**
 * called here. arktype's config is process-global: a library that flips a host's strictness at import
 * time changes how every other schema in that process parses, which is a side effect the host did not
 * ask for. Strictness belongs to the application, which can call `configure` itself before importing
 * schemas. `validate` parses against the schema it was given, nothing more.
 *
 * ## Out of scope
 *
 * Transport errors are not validation. `connectionError`, `responseError`, `isSilentError` and the
 * `ConnectionError` / `ServerError` / `PayloadError` / `ResponseError` / `RequestError` / `StoreError`
 * types live in `@spy4x/platform/universal/errors`.
 *
 * @module
 */

export * from "./validate.ts"
export * from "./model.ts"
export * from "./fields.ts"
