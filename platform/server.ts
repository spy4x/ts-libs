/**
 * `@spy4x/platform/server` — server helpers: filesystem writes, the running process, and a
 * shutdown signal. `process` and `runtime-fs` run on Deno, Node and Bun.
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
 * Deno-only helpers. Every filesystem module takes a port (`FileSystemPort`, `ClockPort`, `TimerPort`)
 * instead of calling `Deno.*` directly, because the root `test` task grants `--allow-read --allow-env`
 * and **no `--allow-write`**. The decision logic — what to write, when to flush, which entry to skip —
 * is tested against an in-memory fake.
 *
 * Only these touch `Deno` anyway: `denoFileSystem` and `denoByteReader` (`server/deno-fs.ts`), and
 * the `Deno.addSignalListener`/`Deno.removeSignalListener` defaults of `shutdownSignal`
 * (`server/shutdown-signal.ts`), which its tests replace with fakes. `server/process` reads the
 * environment, the process id, the arguments and the standard streams, and exits, on Deno, Node and
 * Bun alike; `server/runtime-fs` picks `denoFileSystem` on Deno and `nodeFileSystem`
 * (`node:fs/promises`) on Node and Bun. Of `denoFileSystem`'s **15 methods**,
 * five are covered by `server/deno-fs.test.ts` under the read-only grant — `exists`, `readText`,
 * `readDir`, `readBytes` and `readStream` (including the `isNotFound` mapping and the rethrow of any
 * other error, reached via `ENOTDIR`). `denoByteReader` is covered separately (chunk-size
 * independence and a missing-file rethrow). The write side — `writeText`, `appendText`, `writeBytes`,
 * `writeStream`, `rename`, `mkdirp`, `makeTempDir`, `removeTree`, `lock` and the successful branch of
 * `remove` — needs
 * `--allow-write`, so it runs in the integration tier: `server/deno-fs.integration.test.ts` holds
 * `denoFileSystem` on a real scratch folder to the shared contract in `server/fs-contract.test.ts`,
 * and the unit tier runs the same contract on the in-memory fake; `server/runtime-fs.integration.test.ts`
 * runs it on `nodeFileSystem` and `runtimeFileSystem`. Like the real disk, the fake refuses
 * to write into a folder that does not exist, `mkdirp` creates the parents, and `lock` leaves an empty
 * lock file behind.
 *
 * @module
 */

export * from "./server/atomic-json.ts"
export * from "./server/deno-fs.ts"
export * from "./server/file-lock.ts"
export * from "./server/interval-runner.ts"
export * from "./server/jsonl-logger.ts"
export * from "./server/ports.ts"
export * from "./server/process.ts"
export * from "./server/reminder-runner.ts"
export * from "./server/run-command.ts"
export * from "./server/runtime-fs.ts"
export * from "./server/shutdown-signal.ts"
export * from "./server/tcp.ts"
export * from "./server/throttled-saver.ts"
