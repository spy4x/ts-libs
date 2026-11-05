# @spy4x/validation

arktype parsing and form-validation state. Framework-agnostic: it imports `arktype` and nothing
else, has no framework import of any kind, and mutates no global state.

## Install

```bash
deno add jsr:@spy4x/validation
```

Runs on: shared — both the server and a browser bundle. Its sources use no `Deno.*` API.


## Modules

- [`@spy4x/validation`](mod.ts): both halves below, plus `fieldErrors` for the wire.
- [`@spy4x/validation/validate`](validate.ts): parse a value with an arktype schema and report
  what was wrong.
- [`@spy4x/validation/model`](model.ts): form-validation state, which field carries which issue.

Each module's usage is in its module doc, shown by `deno doc` and on JSR.
