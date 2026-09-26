# @spy4x/validation

arktype parsing and form-validation state. Framework-agnostic: it imports `arktype` and nothing
else, has no framework import of any kind, and mutates no global state.

```ts
import { type } from "arktype"
import { isValid, validate, validateSchema } from "@spy4x/validation"

const userSchema = type({ name: "1 <= string <= 10", joinedAt: "string.date.iso.parse" })

const { error, data } = validate(userSchema, input)
if (error) return error.description
await save(data) // `data` is parsed, so `joinedAt` is a `Date`
```

## Install

```bash
deno add jsr:@spy4x/validation
```

Runs on: shared — both the server and a browser bundle. Its sources use no `Deno.*` API.

## One outcome shape

```ts
type ValidationResult<T extends Type> =
  | { error: ValidationError; data: null }
  | { error: null; data: T["infer"] }

interface ValidationError {
  type: ErrType.Validation // so a union of store errors narrows on `type`
  message: string // VALIDATION_MESSAGE, one sentence for the user
  errors: ValidationIssues // { "address.city": [{ code, path, message }] }
  description: string // arktype's summary, one issue per line
  details: ArkErrors // arktype's own instance
}
```

`errors` files every issue under its path as arktype prints it (`"address.city"`, `"items[1]"`),
each with arktype's `code`, that `path` and a `message` without the path in it, ready to render
next to a form input. An issue with no path — a rule spanning two fields, or a value that is not an
object — goes under `FORM_FIELD` (`"_form"`) with an empty `path`, so it is never dropped.

`description` is arktype's `summary` — every issue, one per line — and `details` is arktype's own
`ArkErrors` instance, so `flatByPath`, `byPath` and iteration stay available to the caller.
`firstIssueMessage` returns the first path-prefixed message from `details`, and still accepts an
error built by hand with only `description` and `details`.

`ErrType` is declared here, not in `@spy4x/platform`, because `@spy4x/platform` imports this package
and the reverse import would be a cycle that fails `deno publish`. `@spy4x/platform/universal/errors`
re-exports the same enum next to the transport errors (`ConnectionError`, `ServerError`,
`PayloadError`) and their helpers (`connectionError`, `responseError`, `isSilentError`).

This is the shape `spy4x/template` already uses (namespace `libs/platform/types`), extended with the
`type`, `message` and `errors` the component library's store reports. One shape means
`platform/helpers` (#10) does not ship a fourth variant.

**Template migration.** Replace `import { validate } from "@template/platform/types"` with
`import { validate } from "@spy4x/validation"`. The result is unchanged, except that this package
does **not** run `configure({ onUndeclaredKey: "reject", onDeepUndeclaredKey: "reject" })` — see
below.

## Form state

`model.ts` carries the field-keyed issue map (`ValidationModel`, `FieldValidation`, `FieldIssue`,
`ValidationType`) with `isValid`, `setFieldIssue`, `schemaIssues`, `validateSchema` and
`sameValidation`. It is a plain state shape — `{ [field]: { [errorType]: { message, payload } } }` —
with no renderer in it, which is why it lives here rather than in a component library.

An arktype issue that does not belong to a single field — a rule spanning two fields, or the value
not being an object at all — is filed under `FORM_FIELD` rather than dropped, so it still makes
`isValid` return `false`. A caller that renders per-field errors should also render `vl[FORM_FIELD]`
somewhere the whole form can show it. `FORM_FIELD` is the string `"_form"`: a model with a real field
literally named `_form` would have that field's own issues and the cross-field ones overwrite each
other, so avoid that field name.

## Recognising an arktype rejection

`validate` and `schemaIssues` tell a rejection from a parsed value with `isArkErrors`, a shape check
(an array with a `summary` string and a `throw` method), not `instanceof ArkErrors`. Two different
copies of arktype in the dependency tree have two different `ArkErrors` classes, so `instanceof`
across them fails and a rejection built by one copy would be read as a successful value by the
other. Pin arktype to one exact version everywhere it is used to avoid the mismatch in the first
place; `isArkErrors` is the fallback for when that slips.

## No global arktype config

`configure({ onUndeclaredKey: "reject", onDeepUndeclaredKey: "reject" })` is deliberately **not**
called here. arktype's config is process-global: a library that flips a host's strictness at import
time changes how every other schema in that process parses, which is a side effect the host did not
ask for. Strictness belongs to the application, which can call `configure` itself before importing
schemas. `validate` parses against the schema it was given, nothing more.

## Out of scope

Transport errors are not validation. `connectionError`, `responseError`, `isSilentError` and the
`ConnectionError` / `ServerError` / `PayloadError` / `ResponseError` / `RequestError` / `StoreError`
types live in `@spy4x/platform/universal/errors`.
