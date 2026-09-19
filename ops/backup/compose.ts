/**
 * Quiesce and restore a compose stack around a backup.
 *
 * `rostok/scripts/backup/src/operations.ts:82-142` is the source, minus the
 * engine around it. The behaviour worth keeping is the start path: prefer
 * `docker compose start` (fast, no env re-evaluation, leaves bind mounts alone)
 * and fall back to `docker compose up -d` **only** when compose reports that a
 * container vanished, which is what happens when Watchtower recreates a service
 * mid-backup. `up -d` is idempotent: it recreates what is missing and leaves the
 * rest running.
 *
 * Three changes from the source, all deliberate:
 *
 * - `HOME` is supplied by the caller, not derived from `$USER`. The source forces
 *   `HOME=/home/${USER}` for the fallback, which is the right fix for the incident
 *   it documents — cron runs the backup as root, so a `~` in a bind mount resolves
 *   to `/root` and the stack comes up with paths pointing at the wrong place — but
 *   the *reason* is "the operator's home", not "a directory named after the
 *   current user". Passing it in keeps a homelab layout out of the library.
 * - The environment is not read here. `Deno.env.toObject()` into the child is a
 *   second, invisible source of configuration; the caller passes what the stack
 *   needs.
 * - Failure is returned, not written into a config object. Deciding what a
 *   failure means belongs to the caller, and this module has no config.
 */

import type { Logger } from "../console.ts"
import type { CommandRunner } from "../run-command.ts"
import { runCommand } from "../run-command.ts"
import { isMissingContainerError } from "./types.ts"

/** What to do to the stack. */
export enum ComposeAction {
  /** Bring containers back up. Falls back to `up -d` when they vanished. */
  START = 1,
  /** Stop containers in place. Never falls back — a stop failure is real. */
  STOP = 2,
}

/** Everything {@link manageComposeStack} needs. */
export interface ComposeStackOptions {
  /** Command runner port. */
  runner: CommandRunner
  /** Compose project name, i.e. `-p`. Must be a valid docker project name. */
  project: string
  /** Compose file, passed as `-f`. */
  composeFile: string
  /** Working directory for the compose invocation. */
  cwd?: string
  /**
   * Environment for the fallback `up -d` only — `HOME` in particular. Omitted
   * means the child inherits the parent's environment.
   */
  env?: Record<string, string>
  /** Logger. Defaults to silence. */
  logger?: Logger
}

/** Outcome of a stack operation. */
export interface ComposeResult {
  /** True when the stack is in the requested state. */
  success: boolean
  /** Which action was requested. */
  action: ComposeAction
  /** True when `start` failed with a vanished container and `up -d` was used. */
  fallbackUsed: boolean
  /** Combined stderr, present only on failure. */
  error?: string
}

/** Docker accepts `[a-z0-9]` first, then `[a-z0-9_-]`, for a project name. */
const PROJECT_NAME = /^[a-z0-9][a-z0-9_-]*$/

/**
 * Build the argv prefix shared by every compose action.
 *
 * An argv array, never a string: the project name and the compose path reach
 * docker as separate arguments, so neither can become a second command.
 *
 * @throws {RangeError} When `project` is not a valid docker project name or
 * `composeFile` is blank.
 */
export function buildComposeBase(
  options: Pick<ComposeStackOptions, "project" | "composeFile">,
): string[] {
  if (!PROJECT_NAME.test(options.project)) {
    throw new RangeError(`"${options.project}" is not a valid docker compose project name`)
  }
  if (options.composeFile.trim() === "") {
    throw new RangeError("composeFile must not be blank")
  }
  return ["docker", "compose", "-p", options.project, "-f", options.composeFile]
}

/**
 * Build the argv for one compose action.
 *
 * @throws {RangeError} From {@link buildComposeBase} for an invalid project name.
 */
export function buildComposeArgs(
  options: Pick<ComposeStackOptions, "project" | "composeFile">,
  action: ComposeAction,
): string[] {
  const verb = action === ComposeAction.START ? "start" : "stop"
  return [...buildComposeBase(options), verb]
}

/**
 * Start or stop a compose stack, with the vanished-container fallback on start.
 *
 * @throws {RangeError} From {@link buildComposeArgs} for an invalid project name.
 * @returns A {@link ComposeResult}; a failed operation is data, not a throw, so
 * one bad stack does not abandon the rest of a run.
 */
export async function manageComposeStack(
  options: ComposeStackOptions,
  action: ComposeAction,
): Promise<ComposeResult> {
  const verb = action === ComposeAction.START ? "starting" : "stopping"
  options.logger?.info(`${verb} compose stack ${options.project}`)

  const base = buildComposeArgs(options, action)
  const result = await runCommand(options.runner, base, { cwd: options.cwd })

  if (result.success) {
    return { success: true, action, fallbackUsed: false }
  }

  if (action !== ComposeAction.START || !isMissingContainerError(result.error)) {
    return {
      success: false,
      action,
      fallbackUsed: false,
      error: result.error.trim(),
    }
  }

  options.logger?.warn(
    `start found no container to start; falling back to up -d`,
  )

  const fallback = await runCommand(
    options.runner,
    [...buildComposeBase(options), "up", "-d"],
    { cwd: options.cwd, env: options.env },
  )

  if (fallback.success) {
    options.logger?.info("up -d fallback succeeded")
    return { success: true, action, fallbackUsed: true }
  }

  options.logger?.error("up -d fallback failed")
  return {
    success: false,
    action,
    fallbackUsed: true,
    error: `start failed (${result.error.trim()}); up -d also failed (${fallback.error.trim()})`,
  }
}
