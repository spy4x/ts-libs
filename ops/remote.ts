/**
 * Reaching back into the deploy target over ssh.
 *
 * `rostok` had `restartRemoteContainer` in **two** files:
 * `scripts/+lib.ts:86-101` and `scripts/remote/+lib.ts:14-29`. `grep -rn
 * restartRemoteContainer` over that repository matches only those two
 * definitions plus two callers, both importing `scripts/+lib.ts`, so the
 * `remote/` copy is dead code — and it is the kind of duplication where the
 * copies drift. (The issue reported the dead copy as missing its
 * `if (!result.success) throw`; at `158ace3` **both** copies have it, so that
 * half of the claim is withdrawn — see the PR body. The duplication itself
 * reproduces, and is why this module exists: one copy, no drift.)
 *
 * Two behaviour changes, both security-relevant:
 *
 * 1. The container name used to be interpolated into a command *string*
 *    (`docker restart ${container}` as one argv element). ssh concatenates its
 *    command arguments and hands the result to the **remote login shell**, so a
 *    name containing `;` was a remote command injection no matter how the local
 *    argv was shaped. Names are validated against docker's charset.
 * 2. `SSH_ADDRESS` is read through an injected {@link EnvReader} instead of
 *    `Deno.env.get` inside the function, so a caller can pass its own target
 *    instead of mutating the process environment to communicate with a helper.
 */

import type { Logger } from "./console.ts"
import type { EnvReader } from "./env.ts"
import { readEnvVar } from "./env.ts"
import type { CommandRunner } from "./run-command.ts"
import { CommandError, mustRun } from "./run-command.ts"

/** Docker's own container-name charset: letters, digits, `_`, `.`, `-`. */
const DOCKER_NAME = /^[a-zA-Z0-9][a-zA-Z0-9_.-]*$/

/**
 * Characters that a **remote shell** would treat as syntax.
 *
 * ssh does not transmit an argv: it joins its arguments with spaces and the
 * remote login shell parses the result. Anything that reaches a remote argv is
 * therefore still shell input, which is why this list exists even though the
 * local invocation is an array.
 */
const SHELL_METACHARACTER = /[\s;&|<>$`"'\\(){}*?!#\[\]]/

/**
 * Reject a value that would be read as syntax by the remote shell.
 *
 * `~` is deliberately **allowed**: a remote path like `~/apps/site` is expanded
 * by the remote shell and that is the documented behaviour callers rely on.
 *
 * @throws {CommandError} When `value` is blank or contains shell syntax.
 */
export function assertSafeRemoteArg(value: string, label: string): void {
  if (value.trim() === "") {
    throw new CommandError(`${label} must not be blank`)
  }
  const match = SHELL_METACHARACTER.exec(value)
  if (match !== null) {
    throw new CommandError(
      `${label} contains "${match[0]}", which the remote shell would execute: ${value}`,
    )
  }
}

/**
 * Reject a container name that docker would not accept.
 *
 * @throws {CommandError} When `name` is not `[a-zA-Z0-9][a-zA-Z0-9_.-]*`.
 */
export function assertDockerContainerName(name: string): void {
  if (!DOCKER_NAME.test(name)) {
    throw new CommandError(`"${name}" is not a valid docker container name`)
  }
}

/**
 * Reject an ssh destination that ssh would read as an option.
 *
 * A destination occupies the *option* position on ssh's command line, so a value
 * that starts with `-` is not a host: `SSH_ADDRESS="-oProxyCommand=/tmp/evil.sh"`
 * becomes `["ssh", "-oProxyCommand=/tmp/evil.sh", …]` and ssh runs that command
 * **locally, as the deploying user** — strictly worse than the remote-shell hazard
 * this module's other guard covers, and reachable from an environment value.
 * {@link buildSshArgv} also emits `--` before the destination, so this is the
 * second of two independent barriers.
 *
 * @throws {CommandError} When `address` starts with `-`, is blank, or carries
 * shell syntax.
 */
export function assertSshDestination(address: string): void {
  if (address.trim() === "") {
    throw new CommandError("ssh address must not be blank")
  }
  if (address.startsWith("-")) {
    throw new CommandError(
      `ssh address "${address}" starts with "-"; ssh would read it as an option, not a host`,
    )
  }
  assertSafeRemoteArg(address, "ssh address")
}

/**
 * Reject an `sshOptions` array that is not a sequence of flags and their values.
 *
 * `sshOptions` occupy ssh's option positions **by design** — `["-p","2222"]` and
 * `["-oBatchMode=yes"]` are the point — so unlike the destination these are
 * expected to start with `-`. What is refused is a bare value where a flag belongs
 * (`["2222"]`, which ssh reads as a hostname and then as the command to run) and a
 * flag-shaped value where a flag's value belongs (`["-p","-oProxyCommand=…"]`,
 * which would turn a port into an option).
 *
 * Values are **not** run through the shell-metacharacter guard: this array becomes
 * argv, no local shell is involved, and ssh's own option values legitimately
 * contain spaces (`ProxyCommand`) and `=`. The guard that matters is on the
 * destination, which is where an environment value lands.
 *
 * @throws {CommandError} When an entry is blank, a flag is malformed, or a value
 * appears where a flag was expected.
 */
export function assertSshOptions(options: readonly string[]): void {
  /** Short ssh flags that take their value in the following argument. */
  const takesValue = new Set([
    "-b",
    "-c",
    "-D",
    "-E",
    "-e",
    "-F",
    "-I",
    "-i",
    "-J",
    "-L",
    "-l",
    "-m",
    "-O",
    "-o",
    "-p",
    "-Q",
    "-R",
    "-S",
    "-W",
    "-w",
  ])
  /** Long flags that take their value in the following argument. */
  const longTakesValue = new Set([
    "--bind-address",
    "--config",
    "--escape-char",
    "--identity",
    "--jump",
    "--local-forward",
    "--login",
    "--mac",
    "--option",
    "--port",
    "--remote-forward",
    "--user",
  ])

  let awaitingValueFor: string | null = null

  for (const option of options) {
    if (option.trim() === "") {
      throw new CommandError("ssh option must not be blank")
    }

    if (awaitingValueFor !== null) {
      if (option.startsWith("-")) {
        throw new CommandError(
          `ssh option "${awaitingValueFor}" is missing its value; ` +
            `"${option}" would be read as a flag`,
        )
      }
      awaitingValueFor = null
      continue
    }

    if (!option.startsWith("-")) {
      throw new CommandError(
        `ssh option "${option}" must start with a flag, e.g. "-p" or "-o"; ` +
          `a bare value here becomes the destination`,
      )
    }
    if (!/^-(?:[A-Za-z]|-[A-Za-z][A-Za-z-]*)/.test(option)) {
      throw new CommandError(`ssh option "${option}" is not a flag ssh would accept`)
    }
    if (takesValue.has(option) || longTakesValue.has(option)) awaitingValueFor = option
  }

  if (awaitingValueFor !== null) {
    throw new CommandError(`ssh option "${awaitingValueFor}" is missing its value`)
  }
}

/** Everything {@link restartRemoteContainer} needs. */
export interface RemoteCommandOptions {
  /** Command runner port. */
  runner: CommandRunner
  /** Reader for `SSH_ADDRESS`. */
  env: EnvReader
  /** Logger. Defaults to silence. */
  logger?: Logger
  /**
   * Extra `ssh` flags, e.g. `["-p", "2222"]`, `["-o", "BatchMode=yes"]`. Validated
   * by {@link assertSshOptions}: these are the caller's own flags, so they are
   * trusted to be flags — a value that is not one is a bug in the caller, not
   * input to defend against.
   */
  sshOptions?: readonly string[]
}

/**
 * Build `ssh <options…> -- <address> <remote argv…>` as an array.
 *
 * `--` ends ssh's option parsing, so nothing after it can be read as a flag even
 * if a validation is ever loosened. The address is checked by
 * {@link assertSshDestination} and every remote argument by
 * {@link assertSafeRemoteArg}: ssh joins its command arguments and hands the
 * result to the **remote login shell**, so an argument there is still shell input.
 *
 * @throws {CommandError} When the address is option-shaped or carries shell
 * syntax, when a remote argument carries shell syntax, or when an ssh option is
 * not a flag.
 */
export function buildSshArgv(
  address: string,
  remoteArgv: readonly string[],
  sshOptions: readonly string[] = [],
): string[] {
  assertSshDestination(address)
  assertSshOptions(sshOptions)
  for (const arg of remoteArgv) {
    assertSafeRemoteArg(arg, "remote argument")
  }
  return ["ssh", ...sshOptions, "--", address, ...remoteArgv]
}

/**
 * Restart a container on the deploy target, i.e. `ssh $SSH_ADDRESS docker restart <container>`.
 *
 * For an `after.deploy` hook that needs a service to pick up config it does not
 * hot-reload — Traefik's basic-auth `usersFile`, Gatus YAML. The remote command
 * runs the container's own entrypoint, so a container restarted from a stale
 * config keeps serving stale config: the failure is silent, which is exactly why
 * a non-zero exit **throws** here rather than being logged.
 *
 * @throws {MissingEnvError} When `SSH_ADDRESS` is unset.
 * @throws {CommandError} When the container name is invalid, or the restart exits non-zero.
 */
export async function restartRemoteContainer(
  container: string,
  options: RemoteCommandOptions,
): Promise<void> {
  const address = readEnvVar(options.env, "SSH_ADDRESS")
  assertDockerContainerName(container)

  options.logger?.info(`restarting ${container} on ${address}`)
  await mustRun(
    options.runner,
    buildSshArgv(address, ["docker", "restart", container], options.sshOptions),
    {},
    `restart ${container}`,
  )
  options.logger?.info(`${container} restarted`)
}
