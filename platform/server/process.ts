/**
 * The running process, on Deno, Node and Bun: its environment variables, id, working directory,
 * arguments, exit, standard error and standard input.
 *
 * The one place in this package that reads `Deno.env`, `process.env`, a process id, the working
 * directory, the arguments or the standard streams. A module that needs one takes it as an option and defaults to what this
 * module exports, so it runs unchanged on every runtime and its test injects a fixed value instead.
 *
 * @example
 * ```ts
 * const port = processEnv.get("PORT") ?? "8000"
 * const storage = readEnvRecord(["FILE_STORAGE_PROVIDER", "FILE_STORAGE_BUCKET"])
 * const [path] = processArgs()
 * if (!path) {
 *   writeStderr("usage: send <file>\n")
 *   exitProcess(2)
 * }
 * ```
 *
 * @module
 */

import {
  argsOf,
  currentHost,
  envReaderOver,
  exitOver,
  processIdOf,
  standardInputOver,
  workingDirectoryOf,
  writeStderrOver,
} from "./_runtime-host.ts"

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

/**
 * The process's working directory: `Deno.cwd()` on Deno, `process.cwd()` on Node and Bun. On Deno
 * it needs `--allow-read`.
 *
 * @throws {Error} On a runtime with neither (a browser).
 */
export function workingDirectory(): string {
  return workingDirectoryOf(currentHost())
}

/**
 * The command-line arguments after the script: `Deno.args` on Deno, `process.argv` without the
 * runtime and script paths on Node and Bun. A new array on each call.
 *
 * @throws {Error} On a runtime with neither (a browser).
 */
export function processArgs(): string[] {
  return argsOf(currentHost())
}

/**
 * End the process now with exit `code`: `Deno.exit` on Deno, `process.exit` on Node and Bun.
 *
 * @throws {Error} On a runtime with neither (a browser), so the caller never carries on as if the
 * process had ended.
 */
export function exitProcess(code: number): never {
  return exitOver(currentHost(), code)
}

/**
 * Write `text` to standard error as it is, with no line break added: for a prompt, where
 * `console.error` would end the line. On Deno the write is synchronous.
 *
 * @throws {Error} On a runtime with no standard error (a browser).
 */
export function writeStderr(text: string): void {
  writeStderrOver(currentHost(), text)
}

/**
 * The process's standard input, for a command-line script: a hidden password prompt in raw mode,
 * or text piped in. The same shape as `Deno.stdin`'s methods, so code written against those runs
 * unchanged.
 */
export interface StandardInput {
  /** `true` when standard input is a terminal rather than a pipe or a file. */
  isTerminal(): boolean
  /**
   * Turn the terminal's raw mode on or off: in raw mode every key arrives at once and nothing is
   * echoed.
   *
   * @throws {Error} When standard input is not a terminal.
   */
  setRaw(raw: boolean): void
  /** Read up to `buffer.byteLength` bytes into `buffer`: the number read, or `null` at the end. */
  read(buffer: Uint8Array): Promise<number | null>
  /** Everything left on standard input, decoded as UTF-8. */
  text(): Promise<string>
}

/**
 * Standard input: `Deno.stdin` on Deno, `process.stdin` on Node and Bun.
 *
 * On Node and Bun the stream is paused and unref'd between reads, so a script that has its answer
 * ends without closing standard input first. Nothing is read at import time.
 *
 * @throws {Error} From each method, on a runtime with no standard input (a browser).
 */
export const processStdin: StandardInput = standardInputOver(currentHost)
