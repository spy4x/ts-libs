/**
 * The backup contract.
 *
 * `offer-lens/backup.ts:1` imports `BackupConfig` from `@scripts/backup`, an
 * alias that is defined nowhere in that repository — `grep -rn "@scripts"
 * offer-lens` finds the import and nothing else, so the file cannot type-check
 * there. This module is that contract as a real dependency: a config file is
 * still `export default { … } satisfies BackupConfig`, but the type now resolves
 * outside `rostok`.
 *
 * Only the contract is here. `rostok`'s engine — `backup/src/operations.ts`,
 * `config.ts`, `reporting.ts` — is deliberately not ported: it discovers configs
 * by filesystem convention with no extension point, reads its env at module
 * scope, and hardcodes homelab semantics (a chown for Syncthing, `HOME=/home/$USER`,
 * a stack name regexed out of a path, restic retention 7/4/3).
 *
 * `BackupContext` and `ResticCommandOptions` are also dropped. The first carries
 * `backupsPassword` and an ntfy auth header — secrets in a published contract
 * that nothing else needs; the second is a restic command-line detail, i.e. the
 * engine's, not a consumer's.
 */

/**
 * Where a backup config is in its lifecycle.
 *
 * Starts at 1: `0` is the natural sentinel for "not set" in almost every
 * serialiser, and a config that has not started must not read as `IN_PROGRESS`.
 */
export enum BackupStatus {
  /** Running. */
  IN_PROGRESS = 1,
  /** Finished without error. */
  SUCCESS = 2,
  /** Finished, or was abandoned, with an error recorded. */
  ERROR = 3,
}

/**
 * One backup configuration.
 *
 * A config file in a project repository is a default export that satisfies this
 * shape; the runner discovers them by convention, not by registration.
 */
export interface BackupConfig {
  /** Repository name. Also the destination folder name unless `destName` overrides it. */
  name: string
  /**
   * Override the destination repo name — needed when several configs share one
   * repository, e.g. a shared service backed up once per host.
   */
  destName?: string
  /**
   * Paths to back up, `~` allowed. `"default"` means "whatever the runner
   * derives for this config", which keeps a homelab's layout out of the contract.
   */
  sourcePaths: "default" | string[]
  /** Paths whose ownership is handed back to the invoking user before the backup. */
  pathsToChangeOwnership?: "default" | string[]
  /** Containers to quiesce around the backup. */
  containers?: {
    /** Containers to stop and restart, or `"default"` for the whole compose stack. */
    stop: "default" | string[]
  }
}

/** A config plus the state one run records against it. */
export interface BackupConfigState extends BackupConfig {
  /** Path of the config file that produced this entry, relative to the config root. */
  fileName: string
  /** Lifecycle position. */
  status: BackupStatus
  /** Human-readable failure, if any. */
  error?: string
  /** Which step failed — a stable label, safe to grep for. */
  errorAtStep?: string
  /** Size of the produced repository, when it could be measured. */
  sizeGB?: number
  /** Why the size could not be measured. Present only when measurement failed. */
  sizeError?: string
  /** Wall-clock duration of the run for this config. */
  durationMs?: number
}

/** Aggregate of one run over every discovered config. */
export interface BackupResult {
  /** Per-config state, in discovery order. */
  backups: BackupConfigState[]
  /** Configs that reached {@link BackupStatus.SUCCESS}. */
  successCount: number
  /** Configs attempted. */
  totalCount: number
  /** Sum of every `sizeGB` that was measured. */
  totalSizeGB: number
  /** Wall-clock duration of the whole run. */
  durationMs: number
}

/** The exact stderr fragment docker compose prints when a container vanished. */
export const MISSING_CONTAINER_ERROR = "no container to start"

/**
 * Detect the "container disappeared while we were looking" error that
 * `docker compose start` returns when Watchtower — or anything else holding
 * `docker.sock` — removed and recreated a service container during the backup
 * window. Reproduces the stalwart `hl-cert-sync` failure where the container was
 * recreated between `stop` and `start`, leaving compose with nothing to start.
 *
 * Matched on a substring because the phrase is stable across Docker Compose v2.x
 * while the surrounding sentence is not.
 */
export function isMissingContainerError(stderr: string): boolean {
  return stderr.includes(MISSING_CONTAINER_ERROR)
}
