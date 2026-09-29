/**
 * Run a child process and get its outcome back as a value, never as a throw.
 *
 * A script that shells out to `git`, `df` or `restic` wants to branch on "did it work, and what did
 * it print", not to wrap every call in `try`/`catch`. {@link runCommand} returns
 * `{ success, code, stdout, stderr }` for a process that ran, whatever its exit code, and the same
 * shape with `success: false` and `code: -1` for one that could not start (a missing binary, a
 * missing permission, a bad working directory), with the reason in both `stderr` and `error`.
 *
 * The shape follows the process, not the house `{ success, output, error }` result: a command has
 * two output streams and an exit code, and folding them into one `output` string would lose the
 * distinction callers branch on. `error` is set only when the process could not be started, so a
 * caller can tell "ran and failed" from "never ran".
 *
 * A caller that must not wait forever passes `signal`: aborting it kills the child (`SIGTERM`), and
 * the result comes back with `success: false` and `signal: "SIGTERM"` rather than a throw. A signal
 * that is already aborted never starts the process. `stdin` defaults to `"inherit"`, as before
 * these options existed; pass `"null"` so a child that reads standard input sees end-of-file
 * instead of waiting on the caller's terminal.
 *
 * The spawner is injected. The root `test` task grants no `--allow-run`, so the tests pass a fake
 * shaped like `Deno.Command`; the default spawner is `new Deno.Command(...)`.
 *
 * @module
 */

/** What a finished child process reports; the subset of `Deno.CommandOutput` this module reads. */
export interface RunCommandOutput {
  success: boolean
  code: number
  stdout: Uint8Array
  stderr: Uint8Array
  /** The signal that killed the process, or `null` when it exited on its own. */
  signal?: Deno.Signal | null
}

/** The subset of `Deno.CommandOptions` {@link runCommand} passes to its spawner. */
export interface SpawnOptions {
  args: string[]
  cwd?: string
  env?: Record<string, string>
  stdout: "piped"
  stderr: "piped"
  /** Standard input of the child; passed only when the caller set {@link RunCommandOptions.stdin}. */
  stdin?: RunCommandStdin
  /** Kills the child when aborted; passed only when the caller set {@link RunCommandOptions.signal}. */
  signal?: AbortSignal
}

/**
 * Where the child's standard input comes from: the caller's own (`"inherit"`) or nothing
 * (`"null"`, so a read gets end-of-file at once).
 */
export type RunCommandStdin = "inherit" | "null"

/** A `Deno.Command`-shaped factory: builds a command whose `output()` runs it to completion. */
export type CommandSpawner = (
  command: string,
  options: SpawnOptions,
) => { output(): Promise<RunCommandOutput> }

/** Options for {@link runCommand}. */
export interface RunCommandOptions {
  /** Working directory of the child. Defaults to the caller's. */
  cwd?: string
  /** Extra environment variables, added to the inherited ones. */
  env?: Record<string, string>
  /**
   * Standard input of the child. Defaults to `"inherit"`, the behaviour before this option existed;
   * `"null"` keeps a child that reads input from waiting on the caller's terminal.
   */
  stdin?: RunCommandStdin
  /**
   * Aborting it kills the child with `SIGTERM`; the result then has `success: false` and `signal`
   * set. Already aborted: the process never starts, and the result has `code: -1` and `error`.
   * `AbortSignal.timeout(ms)` bounds a command in time.
   */
  signal?: AbortSignal
  /** Spawner override, for tests. Defaults to `new Deno.Command(...)`. */
  spawn?: CommandSpawner
}

/** The outcome of {@link runCommand}. */
export interface RunCommandResult {
  /** True when the process ran and exited with code 0. */
  success: boolean
  /** The exit code, or `-1` when the process could not be started. */
  code: number
  /** Everything the process wrote to standard output, decoded as UTF-8. */
  stdout: string
  /** Everything the process wrote to standard error; the start-up failure's message if it never ran. */
  stderr: string
  /** Set only when the process could not be started: why. Absent when it ran, even if it failed. */
  error?: string
  /** The signal that killed the process (`"SIGTERM"` after an abort). Absent when it exited itself. */
  signal?: Deno.Signal
}

const defaultSpawner: CommandSpawner = (command, options) => new Deno.Command(command, options)

/**
 * Run `command` (the program, then its arguments) and resolve with its outcome. Never rejects.
 *
 * No shell is involved: arguments are passed as given, so nothing needs quoting or escaping. To run
 * a shell line, pass `["bash", "-c", line]` yourself.
 */
export async function runCommand(
  command: readonly string[],
  options: RunCommandOptions = {},
): Promise<RunCommandResult> {
  const [program, ...args] = command
  if (program === undefined || program === "") {
    return failedToStart("no command given")
  }
  if (options.signal?.aborted) {
    return failedToStart(`aborted before start: ${abortReason(options.signal)}`)
  }
  try {
    const spawn = options.spawn ?? defaultSpawner
    const output = await spawn(program, {
      args,
      ...(options.cwd === undefined ? {} : { cwd: options.cwd }),
      ...(options.env === undefined ? {} : { env: options.env }),
      ...(options.stdin === undefined ? {} : { stdin: options.stdin }),
      ...(options.signal === undefined ? {} : { signal: options.signal }),
      stdout: "piped",
      stderr: "piped",
    }).output()
    const decoder = new TextDecoder()
    return {
      success: output.success,
      code: output.code,
      stdout: decoder.decode(output.stdout),
      stderr: decoder.decode(output.stderr),
      ...(output.signal ? { signal: output.signal } : {}),
    }
  } catch (error) {
    return failedToStart(error instanceof Error ? error.message : String(error))
  }
}

function abortReason(signal: AbortSignal): string {
  const reason: unknown = signal.reason
  return reason instanceof Error ? reason.message : String(reason)
}

function failedToStart(message: string): RunCommandResult {
  return { success: false, code: -1, stdout: "", stderr: message, error: message }
}
