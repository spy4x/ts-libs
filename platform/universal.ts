/**
 * `@ts-libs/platform` — universal helpers only.
 *
 * Everything re-exported here runs in Deno, a browser, a worker and an SSR pass, and calls no
 * host API beyond `Date`, `Intl`, `crypto` and `TextEncoder`. Browser-only and server-only code
 * lives behind `./browser` and `./server` so an SSR bundle cannot reach it by accident.
 *
 * This package ships **no** validator: `validate` and the `{ description, details }` error
 * envelope belong to `@ts-libs/validation`, which is a peer dependency. {@link ValidationError}
 * and friends below are re-exports, not second implementations.
 */

export * from "./universal/async.ts"
export * from "./universal/axis.ts"
export * from "./universal/concurrency.ts"
export * from "./universal/constants.ts"
export * from "./universal/errors.ts"
export * from "./universal/format-number.ts"
export * from "./universal/result.ts"
export * from "./universal/schema.ts"
export * from "./universal/text.ts"
export * from "./universal/time.ts"
export * from "./universal/time-constants.ts"
