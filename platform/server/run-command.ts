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
}

/** The subset of `Deno.CommandOptions` {@link runCommand} passes to its spawner. */
export interface SpawnOptions {
  args: string[]
  cwd?: string
  env?: Record<string, string>
  stdout: "piped"
  stderr: "piped"
}

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
  try {
    const spawn = options.spawn ?? defaultSpawner
    const output = await spawn(program, {
      args,
      ...(options.cwd === undefined ? {} : { cwd: options.cwd }),
      ...(options.env === undefined ? {} : { env: options.env }),
      stdout: "piped",
      stderr: "piped",
    }).output()
    const decoder = new TextDecoder()
    return {
      success: output.success,
      code: output.code,
      stdout: decoder.decode(output.stdout),
      stderr: decoder.decode(output.stderr),
    }
  } catch (error) {
    return failedToStart(error instanceof Error ? error.message : String(error))
  }
}

function failedToStart(message: string): RunCommandResult {
  return { success: false, code: -1, stdout: "", stderr: message, error: message }
}
