/**
 * `@spy4x/platform/server` — helpers that touch a filesystem.
 *
 * Every module here takes a `FileSystemPort` instead of calling `Deno.*` directly, so the decision
 * logic is testable under the root test task's `--allow-read --allow-env` grant (there is no
 * `--allow-write`). {@link denoFileSystem} is the only Deno-bound object, and it is a thin adapter.
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
export * from "./server/throttled-saver.ts"
