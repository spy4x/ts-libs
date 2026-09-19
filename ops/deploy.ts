/**
 * Deploy helpers: rsync a working tree to a host, then bring a compose project up.
 *
 * `antonshubin.com/scripts/deploy.ts` supersedes the older
 * `template/infra/scripts/deploy.ts`, so it is the source for the *shape* of a
 * deploy: rsync the source honouring `.dockerignore`, sync env files separately
 * (step 1 deliberately excludes them), then
 * `docker compose -p … --env-file … up -d --build` over ssh. It is also the only
 * repository in the sweep with a coherent PWA-update story — it bumps the service
 * worker cache version before deploying — so {@link bumpServiceWorkerCacheVersion}
 * is ported with it.
 *
 * Everything about *how* the source ran those commands is replaced:
 *
 * - `antonshubin.com/scripts/deploy.ts:73-78` runs every command through
 *   `bash -c`, and `:115` builds `ssh ${SERVER} '${composeCmd}'` — a compose
 *   invocation hidden inside a string inside a string. Here every command is an
 *   argv array; the only thing on stdin is the generated bash script for
 *   {@link runDeployScript}, and that goes to `bash -s`, never to `-c`.
 * - `template/infra/scripts/deploy.ts:46,60` uses `Deno.run`, removed in Deno 2.
 * - There is no `cd` on the remote side: the compose file and every `--env-file`
 *   are named relative to `remotePath`, so the command does not depend on the
 *   remote shell's cwd (or on the cwd a caller happened to pass).
 *
 * The `plan`/`execute` split exists for auditability: {@link buildDeployPlan} is
 * a pure function returning the exact argv sequence, so a test (or a
 * `--dry-run` caller) can inspect what would run without a machine.
 */

import type { Logger } from "./console.ts"
import type { FileSystem } from "./fs.ts"
import type { EnvReader } from "./env.ts"
import { readEnvVar, substituteEnvVars } from "./env.ts"
import type { CommandOptions, CommandResult, CommandRunner } from "./run-command.ts"
import { CommandError, runCommand } from "./run-command.ts"
import { assertSafeRemoteArg, buildSshArgv } from "./remote.ts"

/** Where a deploy lands. */
export interface DeployTarget {
  /** ssh destination, e.g. `cloudlab` or `deploy@cloud.example`. */
  sshAddress: string
  /** Application directory on the remote, e.g. `~/cloudlab/apps/site`. */
  remotePath: string
  /** Docker compose project name (`-p`). */
  project: string
  /** Env files referenced with `--env-file`, relative to `remotePath`. */
  envFiles: readonly string[]
  /** Compose file relative to `remotePath`. Defaults to `compose.yml`. */
  composeFile?: string
  /**
   * Environment entries for the remote compose command.
   *
   * Non-secret only: these travel in the remote argv, which is visible to every
   * process on the target. A value that is a secret belongs in an env file
   * referenced by `--env-file`.
   */
  env?: Record<string, string>
}

/** `SOURCE`, `SSH_ADDRESS`, `PATH_APPS`-style names that must not reach argv. */
const SECRETISH_KEY = /(SECRET|TOKEN|PASSWORD|PASSWD|PRIVATE|CREDENTIAL|API_?KEY)/i

/**
 * Reject a secret-looking key from a remote argv environment.
 *
 * A heuristic on purpose: a name that says "secret" and a value that travels in
 * the process table is the exact mistake
 * `financy/infra/scripts/db-backup-create.ts:104` makes (literally
 * `-e AWS_SECRET_ACCESS_KEY=…`). A false positive costs one env-file.
 *
 * @throws {CommandError} When `entries` holds a secret-looking key.
 */
export function assertNoSecretEnvKeys(entries: Record<string, string>): void {
  for (const key of Object.keys(entries)) {
    if (SECRETISH_KEY.test(key)) {
      throw new CommandError(
        `${key} looks like a secret; pass it in a file via --env-file, not in the remote argv`,
      )
    }
  }
}

/** Arguments for syncing a working tree, honouring `.dockerignore`. */
export interface RsyncSourceOptions {
  /** Local source, e.g. `./`. */
  source: string
  /** Remote destination, e.g. `cloudlab:~/cloudlab/apps/antonshubin.com/`. */
  target: string
  /** `--delete` on the remote side. Defaults to `true`. */
  delete?: boolean
  /**
   * Paths excluded in addition to the defaults. Defaults are `.git/`, `.age/`,
   * `node_modules/` and `_fresh/` — the first two must never leave the machine,
   * the last two are rebuilt by the image.
   */
  excludes?: readonly string[]
  /** rsync filter file honoured on the sender side. Defaults to `.dockerignore`. */
  dockerignore?: string
}

/** Excludes applied to every source sync, whatever the caller passes. */
export const DEFAULT_SYNC_EXCLUDES: readonly string[] = [
  ".git/",
  ".age/",
  "node_modules/",
  "_fresh/",
]

/**
 * Build the argv for the source sync.
 *
 * `--filter=:- .dockerignore` is what makes the sync honour `.dockerignore`
 * *from the sending side*: rsync merges the file's patterns into its own filter
 * chain, so the source tree matches the image's build context. Env files are
 * excluded by that same file, which is why {@link buildEnvRsyncArgs} is a
 * separate step rather than an extra argument here.
 *
 * @throws {CommandError} When `source` or `target` is blank.
 */
export function buildRsyncSourceArgs(options: RsyncSourceOptions): string[] {
  if (options.source.trim() === "") throw new CommandError("rsync source must not be blank")
  if (options.target.trim() === "") throw new CommandError("rsync target must not be blank")

  const argv = ["rsync", "-avz", "--info=name1"]
  if (options.delete ?? true) argv.push("--delete")
  for (const exclude of options.excludes ?? DEFAULT_SYNC_EXCLUDES) {
    argv.push("--exclude", exclude)
  }
  argv.push("--filter", `:- ${options.dockerignore ?? ".dockerignore"}`)
  argv.push(options.source, options.target)
  return argv
}

/**
 * Build the argv for syncing env files, which step 1 deliberately excludes.
 *
 * Only file **paths** appear here — never a value.
 *
 * @throws {CommandError} When no env file is named.
 */
export function buildEnvRsyncArgs(
  target: string,
  envFiles: readonly string[],
): string[] {
  if (envFiles.length === 0) throw new CommandError("no env files to sync")
  if (target.trim() === "") throw new CommandError("rsync target must not be blank")
  return ["rsync", "-avz", ...envFiles, target]
}

/**
 * Build `ssh … docker compose … up -d --build` as an array.
 *
 * `-f` and every `--env-file` are named relative to `remotePath`, so the compose
 * invocation does not depend on the remote shell's working directory — the source
 * needed `cd ${REMOTE_PATH} && …` inside a quoted string to achieve the same
 * thing. `--build` is last because it belongs to `up`.
 *
 * @throws {CommandError} When `remotePath` or `project` is blank, a remote
 * argument carries shell syntax, or `env` holds a secret-looking key.
 */
export function buildComposeUpArgs(
  target: DeployTarget,
  sshOptions: readonly string[] = [],
): string[] {
  if (target.project.trim() === "") throw new CommandError("project must not be blank")
  assertSafeRemoteArg(target.remotePath, "remote path")

  const base = target.remotePath.replace(/\/+$/, "")
  const argparse = base === "" ? "." : base
  const composeFile = `${argparse}/${target.composeFile ?? "compose.yml"}`
  const envFlags = target.envFiles.flatMap((file) => ["--env-file", `${argparse}/${file}`])

  const remote = [
    "docker",
    "compose",
    "-p",
    target.project,
    "-f",
    composeFile,
    ...envFlags,
    "up",
    "-d",
    "--build",
  ]

  const env = target.env ?? {}
  assertNoSecretEnvKeys(env)
  const envPrefix = Object.entries(env).flatMap(([key, value]) => [`${key}=${value}`])

  return buildSshArgv(
    target.sshAddress,
    envPrefix.length === 0 ? remote : ["env", ...envPrefix, ...remote],
    sshOptions,
  )
}

/** One step of a deploy plan. */
export interface DeployPlanStep {
  /** Stable label, safe to log and grep. */
  name: string
  /** Exact argv that will run. */
  argv: readonly string[]
  /** Options passed to the runner. */
  options?: CommandOptions
}

/** The argv sequence one deploy would run. Pure data. */
export interface DeployPlan {
  /** Ordered steps. */
  steps: DeployPlanStep[]
  /** Local source directory. */
  source: string
  /** Remote destination for the source sync. */
  target: string
}

/** Everything {@link buildDeployPlan} takes. */
export interface DeployPlanOptions {
  /** Deploy target. */
  target: DeployTarget
  /** Local directory to sync. Defaults to `"./"`. */
  source?: string
  /** Local env files to sync after the source. Defaults to the target's names. */
  envFiles?: readonly string[]
  /** Extra ssh flags. */
  sshOptions?: readonly string[]
}

/**
 * Build the ordered argv for a deploy: source sync, env sync, compose up.
 *
 * Pure and synchronous — no port is touched, so a test asserts the whole plan,
 * including that no step contains a shell.
 */
export function buildDeployPlan(options: DeployPlanOptions): DeployPlan {
  const source = options.source ?? "./"
  const envFiles = options.envFiles ?? options.target.envFiles
  const target = `${options.target.sshAddress}:${options.target.remotePath}`

  const steps: DeployPlanStep[] = [
    {
      name: "sync-source",
      argv: buildRsyncSourceArgs({ source, target }),
    },
  ]

  if (envFiles.length > 0) {
    steps.push({ name: "sync-env", argv: buildEnvRsyncArgs(target, envFiles) })
  }

  steps.push({
    name: "compose-up",
    argv: buildComposeUpArgs(options.target, options.sshOptions),
  })

  return { steps, source, target }
}

/** Outcome of one plan step. */
export interface DeployStepResult {
  /** Step label. */
  name: string
  /** True when the command exited `0`. */
  success: boolean
  /** stderr of a failed step. */
  error?: string
}

/** Outcome of a whole deploy. */
export interface DeployOutcome {
  /** True only when every step succeeded. */
  success: boolean
  /** One entry per attempted step, in plan order. */
  steps: DeployStepResult[]
  /** Non-fatal remarks, e.g. a service worker whose version pattern was not found. */
  warnings: string[]
  /** Service worker cache version before and after the bump, when it was attempted. */
  serviceWorkerVersion?: { from: number; to: number } | null
}

/**
 * Execute a plan, stopping at the first failure.
 *
 * Stopping early is deliberate: a compose build against a half-synced tree is
 * worse than a deploy that never started, and the plan is ordered so the remote
 * work is last.
 */
export async function runDeployPlan(
  plan: DeployPlan,
  ports: { runner: CommandRunner; logger?: Logger },
): Promise<DeployOutcome> {
  const steps: DeployStepResult[] = []

  for (const step of plan.steps) {
    ports.logger?.info(`deploy step ${step.name}`)
    const result = await runCommand(ports.runner, step.argv, step.options)
    steps.push({
      name: step.name,
      success: result.success,
      error: result.success ? undefined : result.error.trim(),
    })
    if (!result.success) {
      ports.logger?.error(`deploy step ${step.name} failed`)
      return { success: false, steps, warnings: [] }
    }
  }

  return { success: true, steps, warnings: [] }
}

/**
 * Bump the service worker cache version in `content` by one.
 *
 * Anchored on the whole assignment (`variable = "<name>-v<n>"`), not on the
 * `<name>-v<n>` substring: a version string that appears in a comment, a
 * different cache constant or a changelog entry must not be rewritten. The
 * source's own comment on the staging env rewrite (`deploy.ts:45-49`) documents
 * what an unanchored replacement costs.
 *
 * @returns `{ content, from, to }`, or `null` when the pattern is absent — the
 * caller decides whether a missing pattern is a warning or a hard failure.
 * @throws {RangeError} When `variable` or `name` is blank.
 */
export function bumpServiceWorkerCacheVersion(
  content: string,
  name: string,
  variable = "CACHE",
): { content: string; from: number; to: number } | null {
  if (variable.trim() === "") throw new RangeError("cache variable name must not be blank")
  if (name.trim() === "") throw new RangeError("cache name must not be blank")

  const escapedName = name.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")
  const escapedVariable = variable.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")
  const pattern = new RegExp(`(${escapedVariable}\\s*=\\s*"${escapedName}-v)(\\d+)(")`)
  const match = pattern.exec(content)
  if (match === null) return null

  const from = Number(match[2])
  const to = from + 1
  const next = content.replace(
    pattern,
    (_whole, prefix: string, _digits: string, suffix: string) => `${prefix}${to}${suffix}`,
  )

  return { content: next, from, to }
}

/**
 * Read the service worker cache version without changing anything.
 *
 * Same anchoring as {@link bumpServiceWorkerCacheVersion}, so a version found
 * here is a version the bump will change.
 */
export function readServiceWorkerCacheVersion(
  content: string,
  name: string,
  variable = "CACHE",
): number | null {
  const escapedName = name.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")
  const escapedVariable = variable.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")
  const match = new RegExp(`${escapedVariable}\\s*=\\s*"${escapedName}-v(\\d+)"`).exec(content)
  return match === null ? null : Number(match[1])
}

/** Options for {@link bumpServiceWorkerBeforeDeploy}. */
export interface ServiceWorkerBumpOptions {
  /** Filesystem port. */
  fs: FileSystem
  /** Path of the local service worker file. */
  path: string
  /** Cache name prefix, e.g. `antonshubin`. */
  name: string
  /** Constant holding the version. Defaults to `CACHE`. */
  variable?: string
  /** Logger. Defaults to silence. */
  logger?: Logger
}

/**
 * Bump the service worker cache version in a local file, before the sync.
 *
 * Must run **before** the rsync: the whole point is that the bytes shipped to the
 * host carry the new version. The source skipped the bump silently when the
 * pattern was missing; here the caller gets `null` and a warning, because a
 * deploy that quietly stops invalidating clients is a bug that only shows up as
 * "my site is stale" days later.
 *
 * @returns The version pair, or `null` when the file has no matching pattern.
 */
export async function bumpServiceWorkerBeforeDeploy(
  options: ServiceWorkerBumpOptions,
): Promise<{ from: number; to: number } | null> {
  const content = await options.fs.readTextFile(options.path)
  const bumped = bumpServiceWorkerCacheVersion(content, options.name, options.variable)
  if (bumped === null) {
    options.logger?.warn(
      `no ${options.variable ?? "CACHE"} version for "${options.name}" in ${options.path}`,
    )
    return null
  }
  await options.fs.writeTextFile(options.path, bumped.content)
  options.logger?.info(`sw cache ${options.name}-v${bumped.from} -> v${bumped.to}`)
  return { from: bumped.from, to: bumped.to }
}

/** A compose stack the marker-delimited deploy script knows how to deploy. */
export interface StackConfig {
  /** Directory name under `stacks/`, and the default project name. */
  name: string
  /** Compose project name when it differs from the directory name. */
  deployAs?: string
}

/** Options for {@link generateDeployScript}. */
export interface DeployScriptOptions {
  /**
   * Prefix shared by the stack's container names, used to find a container left
   * behind by an earlier deploy under a different project name. Callers pass
   * their own convention; the source hardcoded its homelab prefix.
   */
  containerPrefix: string
  /** Env files passed to compose, relative to the app directory. Defaults to `.env` plus `.env.root`. */
  envFiles?: readonly string[]
  /** Compose file name inside each stack directory. Defaults to `compose.yml`. */
  composeFile?: string
  /** Per-stack compose override under `compose-override/<name>.yml`. Defaults to `true`. */
  useOverride?: boolean
  /** Stacks to `restart` after a successful `up`. */
  restartStacks?: ReadonlySet<string>
}

/**
 * Generate the bash script that deploys every stack and prints result markers.
 *
 * The app directory arrives as `$1` — the script text contains **no** absolute
 * path, so nothing that came from configuration is interpolated into executable
 * text. Run it through {@link runDeployScript}, which pipes it to `bash -s`.
 *
 * Each stack is wrapped in `DEPLOY_START`/`DEPLOY_SUCCESS`/`DEPLOY_FAILED`
 * markers so {@link parseDeployResults} can attribute output to a stack, plus a
 * stale-container cleanup: a container created under a different compose project
 * but holding the same `container_name` makes every later `up` fail with "name
 * already in use", and its data lives in volumes, so removing it is safe.
 */
export function generateDeployScript(
  stacks: readonly StackConfig[],
  options: DeployScriptOptions,
): string {
  const envFiles = options.envFiles ?? [".env.root", ".env"]
  const composeFile = options.composeFile ?? "compose.yml"
  const lines: string[] = ["#!/usr/bin/env bash", "set -u", 'app="$1"', ""]

  for (const stack of stacks) {
    const deployAs = stack.deployAs ?? stack.name
    const compose = `"$app/stacks/${stack.name}/${composeFile}"`
    const envFlags = envFiles.map((file) => `--env-file "$app/${file}"`).join(" ")
    const composeArgs = `docker compose -p ${deployAs} -f ${compose} ${envFlags}`
    const override = `"$app/compose-override/${stack.name}.yml"`

    lines.push(`echo "DEPLOY_START:${stack.name}:${deployAs}"`)
    lines.push(`docker ps -a --filter "name=${options.containerPrefix}-${stack.name}" \\`)
    lines.push(`  --format '{{.ID}} {{.Label "com.docker.compose.project"}}' 2>/dev/null | \\`)
    lines.push(`  while read -r id project; do`)
    lines.push(`    if [ "$project" != "${deployAs}" ] && [ -n "$id" ]; then`)
    lines.push(
      `      echo "  removing stale container $id (project=$project, expected=${deployAs})"`,
    )
    lines.push(`      docker rm -f "$id" >/dev/null 2>&1 || true`)
    lines.push(`    fi`)
    lines.push(`  done`)
    lines.push(`set --`)

    if (options.useOverride ?? true) {
      lines.push(`if [ -f ${override} ]; then set -- "$@" -f ${override}; fi`)
    }

    lines.push(`if ${composeArgs} "$@" up -d --build; then`)
    lines.push(`  echo "DEPLOY_SUCCESS:${stack.name}:${deployAs}"`)
    lines.push(`else`)
    lines.push(`  echo "DEPLOY_FAILED:${stack.name}:${deployAs}"`)
    lines.push(`fi`)

    if (options.restartStacks?.has(deployAs) === true) {
      lines.push(`echo "RESTARTING:${stack.name}:${deployAs}"`)
      lines.push(`${composeArgs} "$@" restart`)
      lines.push(`echo "RESTART_DONE:${stack.name}:${deployAs}"`)
    }

    lines.push("")
  }

  return `${lines.join("\n")}\n`
}

/** Result of one stack's deploy, parsed from the script's markers. */
export interface DeployResult {
  /** Stack directory name. */
  name: string
  /** Compose project name. */
  deployAs: string
  /** True only when the success marker appeared and the failure marker did not. */
  success: boolean
  /** Output between the start and failure markers, when it failed. */
  error?: string
}

/**
 * Parse the deploy script's output into one result per stack.
 *
 * A stack that printed neither marker is reported as failed — the script always
 * prints one, so silence means the script died before reaching it.
 */
export function parseDeployResults(
  output: string,
  stacks: readonly StackConfig[],
): DeployResult[] {
  const lines = output.split("\n")
  const results: DeployResult[] = []

  for (const stack of stacks) {
    const deployAs = stack.deployAs ?? stack.name
    const started = lines.findIndex((line) =>
      line.includes(`DEPLOY_START:${stack.name}:${deployAs}`)
    )
    const succeeded = lines.findIndex((line) =>
      line.includes(`DEPLOY_SUCCESS:${stack.name}:${deployAs}`)
    )
    const failed = lines.findIndex((line) =>
      line.includes(`DEPLOY_FAILED:${stack.name}:${deployAs}`)
    )

    const success = succeeded !== -1 && failed === -1
    let error: string | undefined
    if (!success) {
      const from = started === -1 ? 0 : started + 1
      const to = failed === -1 ? lines.length : failed
      error = lines.slice(from, to).join("\n").trim()
    }

    results.push({
      name: stack.name,
      deployAs,
      success,
      ...(error === undefined || error === "" ? {} : { error }),
    })
  }

  return results
}

/** Outcome of {@link runDeployScript}. */
export interface DeployScriptRun extends CommandResult {
  /** Per-stack results parsed from the markers. */
  results: DeployResult[]
}

/**
 * Run the generated script through `bash -s`, with the app directory as `$1`.
 *
 * `bash -s` reads the program from **stdin**; `-c` would put it in argv, where
 * the process table and every `ps` on the box can read it, and where the script
 * would have to be quoted exactly once, correctly, forever.
 *
 * @throws {CommandError} When `pathApps` is blank.
 */
export async function runDeployScript(
  ports: { runner: CommandRunner; logger?: Logger },
  script: string,
  pathApps: string,
  stacks: readonly StackConfig[],
): Promise<DeployScriptRun> {
  if (pathApps.trim() === "") throw new CommandError("app directory must not be blank")
  const result = await runCommand(ports.runner, ["bash", "-s", "--", pathApps], {
    stdin: script,
  })
  return { ...result, results: parseDeployResults(result.output, stacks) }
}

/**
 * Read the configured volume directories out of compose files.
 *
 * Matches a bind mount whose source starts with `${VOLUMES_PATH}/`, which is the
 * convention that keeps every stack's data under one directory. Nested
 * placeholders are substituted as well, and both a missing `VOLUMES_PATH` and an
 * unknown nested variable **throw**: the source left the placeholder in the
 * string, so a failed lookup produced a directory literally named
 * `${VOLUMES_PATH}` and a deploy that looked fine.
 *
 * @throws {MissingEnvError} When `VOLUMES_PATH` or a nested variable is unset.
 */
export function extractVolumePaths(
  composeContents: readonly string[],
  env: EnvReader,
): string[] {
  const volumesPath = readEnvVar(env, "VOLUMES_PATH").replace(/\/+$/, "")
  const paths = new Set<string>()

  for (const content of composeContents) {
    for (const match of content.matchAll(/\$\{VOLUMES_PATH\}\/([^:\n]*):/g)) {
      const subPath = match[1].trim()
      if (subPath === "") continue
      paths.add(`${volumesPath}/${substituteEnvVars(subPath, env)}`)
    }
  }

  return [...paths]
}

/** Options for {@link getRemoteChecksums}. */
export interface RemoteChecksumOptions {
  /** Command runner port. */
  runner: CommandRunner
  /** ssh destination. */
  sshAddress: string
  /** Remote base directory the file paths are relative to. */
  remotePath: string
  /** Files to hash, relative to `remotePath`. */
  files: readonly string[]
  /** Extra ssh flags. */
  sshOptions?: readonly string[]
}

/**
 * SHA-256 of each remote file, so a deploy can restart only what changed.
 *
 * The source ran `sha256sum "path" 2>/dev/null || true` through a shell, which
 * both hides a real failure and interpolates a path into a command string. Here
 * the command is argv, and a file that cannot be hashed is simply absent from the
 * map — the caller treats "absent" as "changed", which is the safe direction.
 *
 * @throws {CommandError} When a remote path carries shell syntax.
 */
export async function getRemoteChecksums(
  options: RemoteChecksumOptions,
): Promise<Map<string, string>> {
  const checksums = new Map<string, string>()
  const base = options.remotePath.replace(/\/+$/, "")

  for (const file of options.files) {
    const remoteFile = `${base}/${file}`
    assertSafeRemoteArg(remoteFile, "remote config path")
    const result = await runCommand(
      options.runner,
      buildSshArgv(options.sshAddress, ["sha256sum", remoteFile], options.sshOptions),
    )
    if (!result.success) continue

    const hash = result.output.trim().split(/\s+/)[0] ?? ""
    if (/^[0-9a-f]{64}$/.test(hash)) checksums.set(file, hash)
  }

  return checksums
}

/** Everything {@link deploy} takes. */
export interface DeployOptions extends DeployPlanOptions {
  /** Command runner port. */
  runner: CommandRunner
  /** Filesystem port, used only for the service worker bump. */
  fs: FileSystem
  /** Logger. Defaults to silence. */
  logger?: Logger
  /**
   * Service worker to bump before the sync. Omit when the project has no PWA —
   * the version bump is the one deploy step that is genuinely opt-in.
   */
  serviceWorker?: {
    /** Local path of the service worker file. */
    path: string
    /** Cache name prefix. */
    name: string
    /** Constant holding the version. Defaults to `CACHE`. */
    variable?: string
  }
}

/**
 * Deploy: bump the service worker, sync source, sync env files, bring compose up.
 *
 * A failed step stops the deploy and is reported per step; the outcome is data
 * rather than an exit, so a CLI wrapper decides what a failure means for it.
 * A missing service worker pattern is a warning, not a failure: the deploy itself
 * is still correct.
 */
export async function deploy(options: DeployOptions): Promise<DeployOutcome> {
  const warnings: string[] = []
  let serviceWorkerVersion: { from: number; to: number } | null | undefined

  if (options.serviceWorker !== undefined) {
    serviceWorkerVersion = await bumpServiceWorkerBeforeDeploy({
      fs: options.fs,
      path: options.serviceWorker.path,
      name: options.serviceWorker.name,
      variable: options.serviceWorker.variable,
      logger: options.logger,
    })
    if (serviceWorkerVersion === null) {
      warnings.push(
        `no service worker cache version for "${options.serviceWorker.name}" in ${options.serviceWorker.path}`,
      )
    }
  }

  const plan = buildDeployPlan(options)
  const outcome = await runDeployPlan(plan, { runner: options.runner, logger: options.logger })

  return { ...outcome, warnings: [...warnings, ...outcome.warnings], serviceWorkerVersion }
}
