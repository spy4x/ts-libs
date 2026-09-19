# @ts-libs/validation

arktype parsing and form-validation state. Framework-agnostic: it imports `arktype` and nothing
else, has no framework import of any kind, and mutates no global state.

```ts
import { type } from "arktype"
import { isValid, validate, validateSchema } from "@ts-libs/validation"

const userSchema = type({ name: "1 <= string <= 10", joinedAt: "string.date.iso.parse" })

const { error, data } = validate(userSchema, input)
if (error) return error.description
await save(data) // `data` is parsed, so `joinedAt` is a `Date`
```

## One outcome shape

```ts
type ValidationResult<T extends Type> =
  | { error: ValidationError; data: null } // { description, details }
  | { error: null; data: T["infer"] }
```

`description` is arktype's `summary` — every issue, one per line — and `details` is arktype's own
`ArkErrors` instance, so `flatByPath`, `byPath` and iteration stay available to the caller.

This is the shape `spy4x/template` already uses (namespace `libs/platform/types`). It is a strict
superset of the simpler `{ message, errors }` shape the component library returned: a consumer that
only wants one line reads `.error.description`, and a consumer that wants per-field issues reads
`.error.details.flatByPath`. One shape means `platform/helpers` (#10) does not ship a fourth variant.

**Template migration.** Replace `import { validate } from "@template/platform/types"` with
`import { validate } from "@ts-libs/validation"`. The result is unchanged, except that this package
does **not** run `configure({ onUndeclaredKey: "reject", onDeepUndeclaredKey: "reject" })` — see
below.

## Form state

`model.ts` carries the field-keyed issue map (`ValidationModel`, `FieldValidation`, `FieldIssue`,
`ValidationType`) with `isValid`, `setFieldIssue`, `schemaIssues`, `validateSchema` and
`sameValidation`. It is a plain state shape — `{ [field]: { [errorType]: { message, payload } } }` —
with no renderer in it, which is why it lives here rather than in a component library.

## No global arktype config

`configure({ onUndeclaredKey: "reject", onDeepUndeclaredKey: "reject" })` is deliberately **not**
called here. arktype's config is process-global: a library that flips a host's strictness at import
time changes how every other schema in that process parses, which is a side effect the host did not
ask for. Strictness belongs to the application, which can call `configure` itself before importing
schemas. `validate` parses against the schema it was given, nothing more.

## Out of scope

Transport errors are not validation. `connectionError`, `responseError`, `isSilentError` and the
`ConnectionError` / `ServerError` / `ResponseError` / `StoreError` types stay in the component
library (follow-up consumer tracked by the deletion issue linked from this package's PR); they are
candidates for a later `net/` or `server/http` port.
