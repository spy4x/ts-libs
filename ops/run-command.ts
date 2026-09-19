/**
 * Structural command execution.
 *
 * Every external process in this package goes through the {@link CommandRunner}
 * port. Two reasons, both load-bearing:
 *
 * 1. The workspace test task is `deno test --no-prompt --allow-read --allow-env`
 *    — no `--allow-run`. A module that calls `Deno.Command` directly is
 *    untestable here, so the real adapter is the *only* thing that may construct
 *    one, and everything else takes a runner.
 * 2. `rostok` and `antonshubin.com` both build deploy commands by joining a
 *    string and running `bash -c` (or `Deno.run({ cmd: [...] })`, deprecated).
 *    A shell string cannot be audited: a container name, a path or an env value
 *    that contains a space or a `$(…)` changes the command. An argv array can —
 *    it is data, and a test asserts its exact contents.
 *
 * A secret never belongs in argv: argv is visible in the process table to every
 * user on the box (`financy/infra/scripts/db-backup-create.ts:104` passes
 * `-e AWS_SECRET_ACCESS_KEY=…` that way). Secrets go through `stdin` here, or
 * through an env file whose *path* is the only thing in argv.
 */

/** The house command result. `code` is deliberately absent — callers branch on `success`. */
export interface CommandResult {
  /** True when the process exited `0`. */
  success: boolean
  /** Decoded stdout. */
  output: string
  /** Decoded stderr. */
  error: string
}

/** Everything a command invocation may carry, besides argv. */
export interface CommandOptions {
  /** Working directory. Defaults to the parent's. */
  cwd?: string
  /**
   * Extra environment entries. Merged into the inherited environment unless
   * `clearEnv` is set; never read from `Deno.env` by this module, so an
   * accidental `HOME=/root` from cron cannot leak into a command.
   */
  env?: Record<string, string>
  /** Start from an empty environment instead of inheriting. Defaults to `false`. */
  clearEnv?: boolean
  /**
   * Run the argv through `sudo`.
   *
   * `sudo` inherits stdin by default: a piped stdin makes it wait for a password
   * silently and then fail, which is exactly the flake `rostok` hit. An explicit
   * `stdin` string wins over that and is piped instead.
   */
  sudo?: boolean
  /** Text to write to the child's stdin. The only secret-safe channel here. */
  stdin?: string
  /**
   * Called with each stdout chunk as it arrives, for progress. The full output
   * is still returned, so a caller that only wants the result omits this.
   */
  onOutput?: (chunk: string) => void
}

/** Runs a command. The one port every effectful helper in this package takes. */
export interface CommandRunner {
  /** Run `argv` and resolve with the result. Never rejects for a non-zero exit. */
  run(
    argv: readonly string[],
    options?: CommandOptions,
  ): Promise<CommandResult>
}

/** Raised by {@link mustRun} and by {@link assertNoSecretInArgv}. */
export class CommandError extends Error {
  constructor(message: string) {
    super(message)
    this.name = "CommandError"
  }
}

/**
 * Reject an argv that cannot be executed as given.
 *
 * An empty argv has no executable; an empty executable name would be resolved
 * through `PATH` depending on the platform. Both are configuration errors, not
 * runtime failures, so they throw before anything is spawned.
 *
 * @throws {CommandError} When `argv` is empty or its first entry is blank.
 */
export function assertArgv(argv: readonly string[]): void {
  if (argv.length === 0) {
    throw new CommandError("argv must contain an executable")
  }
  if (argv[0].trim() === "") {
    throw new CommandError("argv[0] must be a non-empty executable name")
  }
}

/**
 * Expand `argv` into the argv that will actually run, applying the `sudo` prefix.
 *
 * Split from execution so a test asserts the exact process arguments — including
 * that no secret, and no shell, is among them — without spawning anything.
 *
 * @throws {CommandError} When `argv` is empty or blank.
 */
export function buildInvocation(
  argv: readonly string[],
  options: CommandOptions = {},
): string[] {
  assertArgv(argv)
  return options.sudo ? ["sudo", ...argv] : [...argv]
}

/**
 * @throws {CommandError} When any argv entry contains one of `secrets`.
 *
 * A guard, not a formatter: it turns "someone passed the password as an
 * argument" into a failing test instead of a line in `ps`.
 */
export function assertNoSecretInArgv(
  argv: readonly string[],
  secrets: readonly string[],
): void {
  for (const secret of secrets) {
    if (secret === "") continue
    for (const arg of argv) {
      if (arg.includes(secret)) {
        throw new CommandError(
          "a secret value reached argv; pass it on stdin or via an env file",
        )
      }
    }
  }
}

/**
 * Stdin mode for a child process, derived from {@link CommandOptions}.
 *
 * Exported and split out because it encodes the one behaviour that cannot be
 * tested end to end here (spawning needs `--allow-run`), and it is exactly the
 * behaviour that used to break: `sudo` with a *piped* stdin waits for a password
 * that can never arrive and then reports a generic failure, so `sudo` inherits
 * the terminal unless the caller supplied explicit `stdin` text.
 */
export function stdinModeFor(
  options: CommandOptions,
): "null" | "piped" | "inherit" {
  if (options.stdin !== undefined) return "piped"
  return options.sudo ? "inherit" : "null"
}

async function readStream(
  stream: ReadableStream<Uint8Array>,
  onChunk?: (chunk: string) => void,
): Promise<string> {
  const decoder = new TextDecoder()
  const parts: string[] = []
  for await (const chunk of stream) {
    const text = decoder.decode(chunk, { stream: true })
    parts.push(text)
    onChunk?.(text)
  }
  parts.push(decoder.decode())
  return parts.join("")
}

/**
 * The real runner, backed by `Deno.Command`.
 *
 * The only module in the package that spawns a process. It is not covered by a
 * test: the workspace test task grants no `--allow-run`, and adding the flag is a
 * root-config change owned by the coordinator. Everything that *decides* what to
 * run is tested against a fake runner instead — see `run-command.test.ts`.
 */
export function createDenoCommandRunner(): CommandRunner {
  return {
    run: async (argv, options = {}) => {
      const executable = buildInvocation(argv, options)
      const command = new Deno.Command(executable[0], {
        args: executable.slice(1),
        cwd: options.cwd,
        env: options.env,
        clearEnv: options.clearEnv,
        stdin: stdinModeFor(options),
        stdout: "piped",
        stderr: "piped",
      })

      const child = command.spawn()

      if (options.stdin !== undefined) {
        const writer = child.stdin.getWriter()
        await writer.write(new TextEncoder().encode(options.stdin))
        await writer.close()
      }

      const [output, error, status] = await Promise.all([
        readStream(child.stdout, options.onOutput),
        readStream(child.stderr),
        child.status,
      ])

      return { success: status.success, output, error }
    },
  }
}

/**
 * Run a command and return the house result.
 *
 * `async` even though the argv check is synchronous, so an invalid argv rejects
 * the returned promise instead of throwing before the caller can attach a
 * handler — `Promise.all([runCommand(…), …])` would otherwise lose the error.
 *
 * @throws {CommandError} When `argv` is empty or blank.
 */
export async function runCommand(
  runner: CommandRunner,
  argv: readonly string[],
  options: CommandOptions = {},
): Promise<CommandResult> {
  assertArgv(argv)
  return await runner.run(argv, options)
}

/**
 * Run a command and throw when it fails.
 *
 * `rostok` shipped two copies of its container-restart helper, one of them
 * without this check (see `ops/remote.ts`); the failure mode is a deploy that
 * reports success while the service still runs the old config. Every caller that
 * has nothing useful to do with a failure goes through here.
 *
 * @throws {CommandError} When the process exits non-zero, carrying the stderr.
 */
export async function mustRun(
  runner: CommandRunner,
  argv: readonly string[],
  options: CommandOptions = {},
  description: string,
): Promise<CommandResult> {
  const result = await runCommand(runner, argv, options)
  if (!result.success) {
    throw new CommandError(`${description} failed: ${result.error.trim()}`)
  }
  return result
}
