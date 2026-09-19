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
 * `-e AWS_SECRET_ACCESS_KEY=…` that way). The channels this package uses instead,
 * in order of preference:
 *
 * - `stdin` text (a program's own stdin, e.g. `bash -s`);
 * - a file the program reads itself, named by **path** in argv (an env file, an
 *   `--password-file`);
 * - the child's `env`, which is what `offline-backup/verify.ts` does for restic.
 *   This one is weaker and it is documented rather than implied: a value in the
 *   child's environment is invisible to `ps` and to `/proc/<pid>/cmdline`, but it
 *   is readable in `/proc/<pid>/environ` by the same user for the lifetime of the
 *   process, and because `env` merges into the inherited environment by default a
 *   grandchild inherits it too. `clearEnv` avoids the inheritance and not the
 *   `/proc` read. Where the program supports a password file, that is better and
 *   is the follow-up recorded in the package README.
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
   * `sudo` inherits stdin: a piped stdin makes it read the caller's program text
   * as a password, fail silently and report a generic error, which is exactly the
   * flake `rostok` hit. Combining `sudo` with `stdin` text is therefore refused by
   * {@link stdinModeFor} rather than resolved — a caller that needs both drives
   * sudo itself.
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

/**
 * Runs a command. The one port every effectful helper in this package takes.
 *
 * The contract is deliberately narrow but it has a hole worth naming: a runner
 * **may reject**, because launching a process can fail (`command.spawn()` throws
 * for a missing binary or a `cwd` that does not exist, and a fake can be written
 * either way). `runCommand` is what closes it — it converts a rejection into
 * `{ success: false, error }`, so a caller may branch on `success` and treat a
 * launch failure like any other failure. A caller that invokes a runner directly
 * gives that guarantee up.
 */
export interface CommandRunner {
  /**
   * Run `argv` and resolve with the result.
   *
   * Never rejects for a non-zero exit (that is `success: false`); may reject when
   * the process could not be launched at all.
   */
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
 * Reject an argv that carries one of `secrets`.
 *
 * Wire-in: {@link runCommand} calls this for **every** command, with the values
 * of `options.env` as the candidates. That is the boundary where the two
 * channels meet — a value passed as a child environment entry is invisible to
 * `ps`, so finding the same value in argv means the caller has just published it
 * to the process table. (Before this, the guard was exported, tested in isolation
 * and called by nothing: a dead guard reads as protection and provides none.)
 *
 * @throws {CommandError} When any argv entry contains one of `secrets`.
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
 * `sudo` and an explicit `stdin` string are **refused together**. `sudo` reads a
 * password from its stdin when it is not already cached, so piping the caller's
 * text in makes sudo consume the caller's program text as a password, fail
 * without saying so, and report a generic error — the flake this function exists
 * to prevent, and `runDeployScript` is exactly the caller that passes `stdin`.
 * A caller that genuinely needs both drives sudo itself (`sudo -S`, or `sudo`
 * with a script file).
 *
 * @throws {CommandError} When `sudo` is requested together with `stdin` text.
 */
export function stdinModeFor(
  options: CommandOptions,
): "null" | "piped" | "inherit" {
  if (options.sudo === true && options.stdin !== undefined) {
    throw new CommandError(
      "sudo cannot be combined with stdin text: sudo reads its password from stdin; " +
        "run the program through sudo itself instead",
    )
  }
  if (options.stdin !== undefined) return "piped"
  return options.sudo ? "inherit" : "null"
}

/**
 * Decode a stream of byte chunks into text, keeping multi-byte sequences intact.
 *
 * Split out of the adapter so the one part of stream handling with a real failure
 * mode — a UTF-8 sequence split across two reads — is a pure function a test can
 * drive. `TextDecoder` is stateful only with `{ stream: true }`, and the final
 * `decode()` flushes any partial sequence as the replacement character, which is
 * the correct outcome for a truncated tail.
 */
export function decodeChunks(chunks: Iterable<Uint8Array>): string {
  const decoder = new TextDecoder()
  const parts: string[] = []
  for (const chunk of chunks) parts.push(decoder.decode(chunk, { stream: true }))
  parts.push(decoder.decode())
  return parts.join("")
}

/** One chunk of output, in the shape {@link CommandOptions.onOutput} receives. */
export type OutputChunk = string

async function readStream(
  stream: ReadableStream<Uint8Array>,
  onChunk?: (chunk: OutputChunk) => void,
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

/** Normalise any rejection into the house result's `error` field. */
function toErrorText(error: unknown): string {
  if (error instanceof Error) return `${error.name}: ${error.message}`
  return String(error)
}

/**
 * The real runner, backed by `Deno.Command`.
 *
 * The only module in the package that spawns a process.
 *
 * **Total on a launch failure.** `command.spawn()` rejects for a missing
 * executable or a non-existent `cwd` (the reviewer of #50 measured both:
 * `NotFound: Failed to spawn 'definitely-not-a-binary-xyz'`, and the same for a
 * bad `cwd`), and so does a failed stdin write. Those rejections are converted
 * here into `{ success: false, error }` rather than escaping as exceptions,
 * because a missing binary is the *most likely* real-world failure and callers
 * are written to branch on `success`. {@link runCommand} applies the same
 * conversion for any other runner, so the property holds for the port, not just
 * for this adapter.
 *
 * Not covered by a test — the workspace test task grants no `--allow-run`. What is
 * delegated to this adapter, and what a run with `--allow-run` would have to
 * show, is listed in the package README ("The adapter boundary").
 */
export function createDenoCommandRunner(): CommandRunner {
  return {
    run: async (argv, options = {}) => {
      try {
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
      } catch (error) {
        return { success: false, output: "", error: toErrorText(error) }
      }
    },
  }
}

/**
 * Run a command and return the house result — **always** a result.
 *
 * Three properties, all enforced here so that a custom runner cannot opt out:
 *
 * 1. an invalid argv rejects the returned promise (the function is `async`
 *    deliberately: a synchronous throw would escape `Promise.all`);
 * 2. a secret that is an environment value may not also appear in argv
 *    ({@link assertNoSecretInArgv}), because argv is readable by every user on
 *    the box while the child's environment is not;
 * 3. a runner that **rejects** — a launch failure, which the real adapter
 *    produces for a missing binary or a bad `cwd` — becomes
 *    `{ success: false, error }` instead of an exception, so every caller that
 *    branches on `success` is total. `manageComposeStack`'s documented "a failed
 *    operation is data" depends on exactly this.
 *
 * @throws {CommandError} When `argv` is empty or blank, or when a value from
 * `options.env` also appears in argv.
 */
export async function runCommand(
  runner: CommandRunner,
  argv: readonly string[],
  options: CommandOptions = {},
): Promise<CommandResult> {
  assertArgv(argv)
  assertNoSecretInArgv(argv, Object.values(options.env ?? {}))
  try {
    return await runner.run(argv, options)
  } catch (error) {
    return { success: false, output: "", error: toErrorText(error) }
  }
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
