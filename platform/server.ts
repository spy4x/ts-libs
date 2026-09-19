/**
 * `@ts-libs/platform/server` — helpers that touch a filesystem.
 *
 * Every module here takes a `FileSystemPort` instead of calling `Deno.*` directly, so the decision
 * logic is testable under the root test task's `--allow-read --allow-env` grant (there is no
 * `--allow-write`). {@link denoFileSystem} and {@link denoByteReader} are the only Deno-bound
 * objects, and they are thin adapters.
 *
 * This entry point imports `Deno` types transitively — keep it out of a browser bundle.
 */

export * from "./server/atomic-json.ts"
export * from "./server/deno-fs.ts"
export * from "./server/file-lock.ts"
export * from "./server/hash-file.ts"
export * from "./server/jsonl-logger.ts"
export * from "./server/ports.ts"
export * from "./server/throttled-saver.ts"
export * from "./server/walk.ts"
