/**
 * `@spy4x/platform` — universal helpers only.
 *
 * Everything re-exported here runs in Deno, a browser, a worker and an SSR pass, and calls no
 * host API beyond `Date`, `Intl`, `fetch`, `crypto`, `TextEncoder`, `URL`, `FormData` and `Response`.
 * Browser-only and server-only code lives behind `./browser` and `./server` so an SSR bundle
 * cannot reach it by accident.
 *
 * This package ships **no** validator: `validate` and the validation error
 * envelope belong to `@spy4x/validation`, which is a peer dependency. {@link ValidationError}
 * and friends below are re-exports, not second implementations.
 *
 * ```ts
 * import { formatDecimal, ok } from "@spy4x/platform"
 * import { apiFetch } from "@spy4x/platform/api"
 * import { CommandBus } from "@spy4x/platform/cqrs"
 * import { makeStorage } from "@spy4x/platform/browser"
 * import { atomicWriteJson, denoFileSystem } from "@spy4x/platform/server"
 * ```
 *
 * Runs in Deno, a browser, a worker and an SSR pass. The only host APIs touched are `Date`, `Intl`,
 * `Math`, `TextEncoder`, `URL`, `FormData`, `fetch`, `crypto.getRandomValues` (only `universal/uuid`, through `@std/uuid`), `crypto.subtle.digest` (only the catalog locks of `universal/i18n`), and the `setTimeout` / `clearTimeout` pair that `universal/async` uses (it
 * `unref`s the handle where the runtime provides one). No other `crypto` calls and no DOM global: the
 * browser- and server-only halves are the other two subpaths.
 *
 * ## The error vocabulary and the result convention
 *
 * Three shapes, three jobs. They are not interchangeable, and picking the wrong one is the most common
 * source of "why is this error a string" regret.
 *
 * | Shape                         | Where it belongs                                             | Error type                |
 * | ----------------------------- | ------------------------------------------------------------ | ------------------------- |
 * | `Result<T, E>` / `ok` / `err` | inside a function body, failure expected and not exceptional | whatever the caller names |
 * | `OperationResult<T, E>`       | an operation whose failure the UI renders                    | a typed `AnyError`        |
 * | `CommandEnvelope<T>`          | a CLI command or job crossing a process boundary             | `string`                  |
 *
 * ```ts
 * const parsed = JSON.parse(raw) // throws: malformed input is a programming error
 * const result: Result<number> = tryParse(text) // returns: malformed input is expected
 * ```
 *
 * `ErrType` is the discriminant. `ValidationError` is **re-exported** from `@spy4x/validation`, not
 * redeclared: this package does not own a validation model.
 *
 * ## Dependency on `@spy4x/validation`
 *
 * `@spy4x/platform` depends on `@spy4x/validation` for exactly two things: the `ValidationError`
 * type (`universal/errors`) and the `validate(schema, value)` call behind
 * `makeStorage(..., { schema })`. There is **one** `validate` and **one** validation error envelope
 * (`type`, `message`, per-field `errors`, `description` and `details`) in the ecosystem, and it lives
 * there. `ErrType` is declared there too and re-exported from `universal/errors`, because
 * `@spy4x/validation` cannot import this package without a package cycle.
 *
 * Consequences a consumer should know:
 *
 * - **Peer dependency.** Both packages are workspace members, so `deno check` resolves
 *   `@spy4x/validation` with no `imports` entry here. Consuming from JSR or from a repo where
 *   `validation/` is absent means adding that member first — the import is not optional, and until it
 *   resolves `deno check` reports `TS2307: Import "@spy4x/validation" not a dependency` at
 *   `platform/universal/errors.ts` and `platform/browser/storage.ts`.
 * - This package ships **no** schema-parser adapter (no object exposing both a throwing parse and a
 *   non-throwing variant), no schema library of its own, and no second envelope. The source's
 *   `validate()` ran the parse twice; the bug is retired by not
 *   porting the function at all — `@spy4x/validation` parses once.
 * - Validation is applied on **write** as well as read in `makeStorage`. A value that fails its own
 *   schema on read is evicted, because a stored value that no longer matches is stale, not missing.
 * - **Strictness is the caller's schema's decision, never this package's.** `@spy4x/validation`
 *   deliberately does not call `configure({ onUndeclaredKey: ... })`, so nothing here reads or writes
 *   global arktype config either. A schema without that setting keeps an undeclared key, exactly as
 *   arktype defaults; a caller that wants unknown keys rejected writes
 *   `schema.onUndeclaredKey("reject")` on its own schema. Both halves are pinned by tests in
 *   `browser/storage.test.ts`.
 *
 * ## Servers, clocks and timers are injected
 *
 * Nothing here reads `Date.now()` outside `systemClock` (and `systemClockPort` on the server side),
 * and nothing writes a file outside a `FileSystemPort`. That is what makes the suite deterministic and
 * what makes it runnable under the root test task's permission grant. Two consequences:
 *
 * - `formatTime` and `timeAgo` need an explicit `timeZone` and `clock` to be reproducible. Use
 *   `new TimeFormatter({ timeZone, clock })` in tests; the one-off `formatTime(date, options)` accepts
 *   the same fields.
 * - `ThrottledJsonSaver.flush()` is the deterministic exit point. `markDirty()` may start a detached
 *   write, and `flush()` waits for it before deciding whether another write is needed.
 *
 * @module
 */

export * from "./universal/async.ts"
export * from "./universal/axis.ts"
export * from "./universal/bounded-integer.ts"
export * from "./universal/concurrency.ts"
export * from "./universal/constants.ts"
export * from "./universal/error-reporter.ts"
export * from "./universal/errors.ts"
export * from "./universal/format-number.ts"
export * from "./universal/honeypot.ts"
export * from "./universal/is-record.ts"
export * from "./universal/key-value-store.ts"
export * from "./universal/quick-add.ts"
export * from "./universal/result.ts"
export * from "./universal/schema.ts"
export * from "./universal/seo.ts"
export * from "./universal/sort.ts"
export * from "./universal/text.ts"
export * from "./universal/time.ts"
export * from "./universal/time-constants.ts"
export * from "./universal/uuid.ts"
