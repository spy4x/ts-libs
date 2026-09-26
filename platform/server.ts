/**
 * `@spy4x/platform/server` — Deno-only helpers: filesystem writes, and a shutdown signal.
 *
 * Every filesystem module here takes a `FileSystemPort` instead of calling `Deno.*` directly, so
 * the decision logic is testable under the root test task's `--allow-read --allow-env` grant (there
 * is no `--allow-write`). {@link denoFileSystem} is the Deno-bound filesystem adapter.
 *
 * {@link shutdownSignal} calls `Deno.addSignalListener` and `Deno.removeSignalListener` by default.
 * Both are options, so its tests pass fakes and fire no real signal.
 *
 * This entry point imports `Deno` types transitively — keep it out of a browser bundle.
 *
 * @module
 */

export * from "./server/atomic-json.ts"
export * from "./server/deno-fs.ts"
export * from "./server/file-lock.ts"
export * from "./server/jsonl-logger.ts"
export * from "./server/ports.ts"
export * from "./server/shutdown-signal.ts"
export * from "./server/throttled-saver.ts"
