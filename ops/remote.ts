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

/** Everything {@link restartRemoteContainer} needs. */
export interface RemoteCommandOptions {
  /** Command runner port. */
  runner: CommandRunner
  /** Reader for `SSH_ADDRESS`. */
  env: EnvReader
  /** Logger. Defaults to silence. */
  logger?: Logger
  /** Extra `ssh` flags, e.g. `["-p", "2222"]` or a batch-mode option. */
  sshOptions?: readonly string[]
}

/**
 * Build `ssh <address> <remote argv…>` as an array.
 *
 * @throws {CommandError} When `address` or any remote argument carries shell syntax.
 */
export function buildSshArgv(
  address: string,
  remoteArgv: readonly string[],
  sshOptions: readonly string[] = [],
): string[] {
  assertSafeRemoteArg(address, "ssh address")
  for (const arg of remoteArgv) {
    assertSafeRemoteArg(arg, "remote argument")
  }
  return ["ssh", ...sshOptions, address, ...remoteArgv]
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
