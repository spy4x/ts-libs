/**
 * The running process, on Deno, Node and Bun: its environment variables and its id.
 *
 * The one place in this package that reads `Deno.env`, `process.env` or a process id. A module that
 * needs one takes it as an option and defaults to what this module exports, so it runs unchanged on
 * every runtime and its test injects a fixed value instead.
 *
 * @example
 * ```ts
 * const port = processEnv.get("PORT") ?? "8000"
 * const storage = readEnvRecord(["FILE_STORAGE_PROVIDER", "FILE_STORAGE_BUCKET"])
 * ```
 *
 * @module
 */

import { currentHost, envReaderOver, processIdOf } from "./_runtime-host.ts"

/**
 * Reads environment values. The same shape as `EnvReader` in `@spy4x/server/config`, so a reader
 * from either package fits wherever the other is expected.
 */
export interface EnvReader {
  /** Value of `name`, or `undefined` when unset or blank. */
  get(name: string): string | undefined
}

/**
 * The process environment, read through `Deno.env` on Deno and `process.env` on Node and Bun.
 *
 * Nothing is read at import time. An empty value counts as unset, as in `@spy4x/server/config`. On
 * Deno each call needs `--allow-env` for that name, and throws without it.
 *
 * @throws {Error} From `get`, on a runtime with no process environment (a browser).
 */
export const processEnv: EnvReader = envReaderOver(currentHost)

/**
 * Read the named variables into a record, for a parser that takes one, such as `parseStorageEnv`
 * in `@spy4x/server/storage`. Only the names asked for are read, so on Deno `--allow-env` can list
 * exactly those, and no other variable lands in the record.
 *
 * A name that is unset or blank maps to `undefined`.
 */
export function readEnvRecord<Name extends string>(
  names: readonly Name[],
  env: EnvReader = processEnv,
): Record<Name, string | undefined> {
  // `fromEntries` defines own properties, so on Node and Bun a name like `__proto__` cannot reach
  // the prototype. Deno has no `__proto__` accessor, so its tests cannot show the difference.
  return Object.fromEntries(names.map((name) => [name, env.get(name)])) as Record<
    Name,
    string | undefined
  >
}

/**
 * The id of the running process: `Deno.pid` on Deno, `process.pid` on Node and Bun, `undefined`
 * where there is none (a browser).
 */
export function processId(): number | undefined {
  return processIdOf(currentHost())
}
