/**
 * The ten drive functions: enumerate, mount, unmount, eject, format, lay out the
 * directory structure.
 *
 * Ported from `rostok/scripts/offline-backup/src/drive.ts` (179 lines). Every
 * function takes one options object carrying the injected ports from
 * `./types.ts`; nothing here reads the environment, the process table, the wall
 * clock or the console.
 */

import { runCommand } from "../run-command.ts"
import {
  BackupError,
  type BackupPath,
  ConfirmRequiredError,
  DEFAULT_DEV_DIR,
  DEFAULT_PARTITION_SUFFIX,
  type DriveInfo,
  LOGS_DIR,
  type OfflineBackupPorts,
} from "./types.ts"

/** How long udev is given to publish the new partition node after `parted`. */
export const UDEV_SETTLE_MS = 2000

/** Arguments shared by every options bag in this file. */
export type DriveOptions = OfflineBackupPorts

/**
 * Split one `lsblk -ndo NAME,SIZE,MODEL,TYPE` row.
 *
 * `MODEL` contains spaces and may be empty, so the model is everything between
 * the size and the trailing TYPE column. A row shorter than four fields is not a
 * disk row; `null` says so and the caller filters.
 */
function parseLsblkLine(line: string): DriveInfo | null {
  const parts = line.trim().split(/\s+/)
  if (parts.length < 4) return null
  return {
    name: parts[0],
    size: parts[1],
    model: parts.slice(2, -1).join(" "),
    type: parts[parts.length - 1],
  }
}

/**
 * List physical disks.
 *
 * @throws {import("../run-command.ts").CommandError} When `lsblk` fails. The
 * source read `result.output` without checking `success`, so a missing `lsblk`
 * produced "no drives found" — a wrong diagnosis that sends the operator to
 * check the cable.
 */
export async function listDrives(
  options: DriveOptions,
): Promise<DriveInfo[]> {
  const result = await runCommand(options.runner, ["lsblk", "-ndo", "NAME,SIZE,MODEL,TYPE"])
  if (!result.success) {
    throw new BackupError(`lsblk failed: ${result.error.trim()}`)
  }

  return result.output
    .split("\n")
    .map((line) => parseLsblkLine(line))
    .filter((drive): drive is DriveInfo => drive !== null && drive.type === "disk")
}

/**
 * Split `mount` output into device/mount-point pairs.
 *
 * The mount point is the text between the ` on ` separator and the following
 * ` type ` column. The source used `line.split(" ")` and `parts.indexOf("on")`,
 * which happens to work for `/media/user/DRIVE` and breaks for any mount point
 * with a space (`/run/media/user/My Passport` — the exact case an external drive
 * hits): it returned `My` and the caller then unmounted a directory it never
 * named. Splitting on the ` type ` column rather than on the first space after
 * the separator is what keeps a spaced mount point intact. A row without ` on `
 * is skipped rather than guessed at.
 *
 * @returns One entry per mount line that had both a device and a mount point.
 */
export function parseMountOutput(output: string): Array<{ device: string; mountPoint: string }> {
  const mounts: Array<{ device: string; mountPoint: string }> = []
  for (const line of output.split("\n")) {
    const separator = line.indexOf(" on ")
    if (separator <= 0) continue
    const device = line.slice(0, separator).trim()
    if (device === "") continue
    const rest = line.slice(separator + 4)
    const typeColumn = rest.indexOf(" type ")
    const mountPoint = (typeColumn === -1 ? rest : rest.slice(0, typeColumn)).trim()
    if (mountPoint === "") continue
    mounts.push({ device, mountPoint })
  }
  return mounts
}

/** Find the mount point of `device`, or `null`. */
export function findMountPoint(output: string, device: string): string | null {
  const match = parseMountOutput(output).find((mount) => mount.device === device)
  return match?.mountPoint ?? null
}

/**
 * True when `device` names an existing block device.
 *
 * `device` is a full path such as `/dev/sdb1`. The source took a bare kernel name
 * and prefixed `/dev/` inside the function, which made the caller's own
 * `partition = ${device}1` and the `/dev` prefix drift apart; the prefix is now
 * the `devDir` option, defaulted to `/dev`.
 *
 * A missing device and a non-block file are both `false`: the question asked is
 * "can I write a drive at this path?", and a regular file answers no.
 */
export async function checkDriveExists(
  options: DriveOptions & { device: string; devDir?: string },
): Promise<boolean> {
  const devDir = options.devDir ?? DEFAULT_DEV_DIR
  const path = options.device.startsWith("/")
    ? options.device
    : `${devDir.replace(/\/+$/, "")}/${options.device}`
  try {
    return (await options.fs.stat(path)).isBlockDevice
  } catch {
    return false
  }
}

/**
 * True when `device` appears in `mount` output.
 *
 * Matched against the parsed device column, not `output.includes(device)`: the
 * source's substring test reports `sdb` as mounted when only `sdb1` is, and
 * reports `/dev/sda` as mounted when the mount table merely mentions it in a
 * comment-free-but-similar device such as `/dev/sdaa`.
 *
 * @throws {BackupError} When `mount` cannot be read.
 */
export async function isMounted(
  options: DriveOptions & { device: string },
): Promise<boolean> {
  const result = await runCommand(options.runner, ["mount"])
  return findMountPoint(result.output, options.device) !== null
}

/**
 * Mount point of `device`, or `null` when it is not mounted.
 *
 * @throws {BackupError} When `mount` cannot be read.
 */
export async function getMountPoint(
  options: DriveOptions & { device: string },
): Promise<string | null> {
  const result = await runCommand(options.runner, ["mount"])
  return findMountPoint(result.output, options.device)
}

/**
 * Pull the mount point out of `udisksctl mount` output: `Mounted /dev/sdb1 at /media/user/DRIVE.`
 *
 * The trailing period is part of the sentence, and a mount point may itself
 * contain spaces, so the path is everything after ` at ` up to the final
 * sentence-ending period — not up to the first space, which truncated
 * `/media/user/My Passport` to `/media/user/My`, and not to the end of the line,
 * which left the period in the path. Both of those failures sent the caller to a
 * directory that does not exist.
 */
export function parseUdisksMountPoint(output: string): string | null {
  const match = output.match(/ at +(.+?)\.?\s*$/im)
  const mountPoint = match?.[1]?.trim().replace(/\.$/, "")
  return mountPoint === undefined || mountPoint === "" ? null : mountPoint
}

/**
 * Mount `device` through `udisksctl` and return where it landed.
 *
 * @throws {BackupError} When the mount fails, or when `udisksctl` succeeded but
 * did not name a mount point — the source threw a bare `Error` here, and a
 * caller could not tell it from a failed mount.
 */
export async function mountDrive(
  options: DriveOptions & { device: string },
): Promise<string> {
  options.logger.info(`Mounting ${options.device}`)
  const result = await runCommand(options.runner, ["udisksctl", "mount", "-b", options.device])
  if (!result.success) {
    throw new BackupError(`failed to mount ${options.device}: ${result.error.trim()}`)
  }

  const mountPoint = parseUdisksMountPoint(result.output)
  if (mountPoint === null) {
    throw new BackupError(
      `could not determine the mount point from udisksctl output: ${result.output.trim()}`,
    )
  }

  options.logger.info(`Drive mounted at: ${mountPoint}`)
  return mountPoint
}

/** What {@link unmountDrive} needs on top of the ports. */
export interface UnmountDriveOptions extends DriveOptions {
  /** Device path, e.g. `/dev/sdb1`. */
  device: string
  /** Where it is mounted. */
  mountPoint: string
  /**
   * Remove `mountPoint` afterwards when it is an empty directory under `home`.
   * Defaults to `false`.
   *
   * The source did this unconditionally, so `umount` failing (busy device, sync
   * still flushing) fell through to `Deno.remove` on a *live* mount point and
   * reported success. Here the removal only happens when asked for, and only
   * after the unmount itself succeeded.
   */
  removeMountPoint?: boolean
  /** Home directory the mount point must live under before it is removed. */
  home?: string
}

/**
 * Unmount `device`.
 *
 * @throws {BackupError} When `udisksctl unmount` fails. The source printed a
 * warning and carried on, which is how a run ejects a drive it is still writing
 * to.
 */
export async function unmountDrive(options: UnmountDriveOptions): Promise<void> {
  options.logger.info(`Unmounting ${options.device}`)
  const result = await runCommand(options.runner, [
    "udisksctl",
    "unmount",
    "-b",
    options.device,
  ])
  if (!result.success) {
    throw new BackupError(`failed to unmount ${options.device}: ${result.error.trim()}`)
  }

  if (options.removeMountPoint === true) {
    await removeMountPointIfOurs(options)
  }
  options.logger.info("Drive unmounted")
}

/**
 * Delete a leftover mount-point directory, but only one this tool could have
 * created: a path under `home` that no longer has anything mounted on it and is
 * empty.
 *
 * The source compared `mountPoint.startsWith(Deno.env.get("HOME") || "~")` — with
 * `HOME` unset that is `"~"`, which matches nothing, so the cleanup silently
 * stopped happening; and with `HOME=/home/an` it also matches `/home/anto`, a
 * different user's directory.
 */
async function removeMountPointIfOurs(options: UnmountDriveOptions): Promise<void> {
  const home = options.home?.replace(/\/+$/, "")
  if (home === undefined || home === "") {
    throw new BackupError("removeMountPoint needs an explicit home directory")
  }
  if (!options.mountPoint.startsWith(`${home}/`)) {
    options.logger.warn(`Not removing ${options.mountPoint}: outside ${home}`)
    return
  }
  try {
    await options.fs.remove(options.mountPoint)
    options.logger.info(`Removed mount point: ${options.mountPoint}`)
  } catch (error) {
    options.logger.warn(`Could not remove mount point ${options.mountPoint}: ${error}`)
  }
}

/**
 * Power the drive off so it can be unplugged.
 *
 * @throws {BackupError} When `udisksctl power-off` fails. The source warned and
 * returned, leaving the caller unable to distinguish "safe to unplug" from
 * "still spinning".
 */
export async function ejectDrive(
  options: DriveOptions & { device: string },
): Promise<void> {
  options.logger.info(`Ejecting ${options.device}`)
  const result = await runCommand(options.runner, [
    "udisksctl",
    "power-off",
    "-b",
    options.device,
  ])
  if (!result.success) {
    throw new BackupError(`could not eject ${options.device}: ${result.error.trim()}`)
  }
  options.logger.info("Drive ejected — safe to unplug")
}

/** What {@link formatDrive} needs on top of the ports. */
export interface FormatDriveOptions extends DriveOptions {
  /** Disk device to erase, e.g. `/dev/sdb`. */
  device: string
  /**
   * Suffix naming the first partition, appended to `device`. Defaults to `"1"`
   * (`/dev/sdb` to `/dev/sdb1`).
   *
   * The source hardcoded it, so on NVMe (`/dev/nvme0n1` to `/dev/nvme0n1p1`) it
   * formatted the wrong path. A caller with an NVMe enclosure passes `"p1"`.
   */
  partitionSuffix?: string
  /** Filesystem label for the new BTRFS volume. */
  label: string
  /** How long to wait for udev to publish the partition node. Defaults to 2000 ms. */
  settleMs?: number
  /** Directory holding block devices. Defaults to `/dev`. */
  devDir?: string
}

/**
 * Erase `device`, create a GPT table with one BTRFS partition.
 *
 * @returns `true` when the drive was formatted, `false` when the caller declined.
 * The source called `Deno.exit(0)` from inside the function to abort, which
 * terminated the process under the caller's feet mid-cleanup.
 * @throws {ConfirmRequiredError} When no `confirm` port is supplied. Erasing a
 * disk is never an implicit decision, so a headless caller must fail here rather
 * than default to "yes".
 * @throws {BackupError} When `parted` or `mkfs.btrfs` fails.
 */
export async function formatDrive(options: FormatDriveOptions): Promise<boolean> {
  const drives = await listDrives(options)
  const devDir = (options.devDir ?? DEFAULT_DEV_DIR).replace(/\/+$/, "")
  const name = options.device.startsWith(`${devDir}/`)
    ? options.device.slice(devDir.length + 1)
    : options.device
  const drive = drives.find((candidate) => candidate.name === name)
  if (drive !== undefined) {
    options.logger.warn(`Target: ${drive.name} ${drive.size} ${drive.model}`)
  } else {
    options.logger.warn(`Target: ${options.device} (not in lsblk output)`)
  }

  if (options.confirm === undefined) {
    throw new ConfirmRequiredError(
      `formatDrive would erase ${options.device} and no confirm port was supplied`,
    )
  }
  const confirmed = await options.confirm(
    `Erase ALL DATA on ${options.device} and format it as BTRFS?`,
  )
  if (!confirmed) {
    options.logger.info("Formatting cancelled")
    return false
  }

  options.logger.info("Creating GPT partition table")
  const table = await runCommand(
    options.runner,
    ["parted", options.device, "--script", "mklabel", "gpt"],
    { sudo: true },
  )
  if (!table.success) {
    throw new BackupError(`failed to create partition table: ${table.error.trim()}`)
  }

  options.logger.info("Creating primary partition")
  const partitionResult = await runCommand(
    options.runner,
    ["parted", options.device, "--script", "mkpart", "primary", "btrfs", "0%", "100%"],
    { sudo: true },
  )
  if (!partitionResult.success) {
    throw new BackupError(`failed to create partition: ${partitionResult.error.trim()}`)
  }

  const settleMs = options.settleMs ?? UDEV_SETTLE_MS
  if (settleMs > 0) {
    if (options.sleep === undefined) {
      throw new BackupError(
        `waiting ${settleMs} ms for udev needs a sleep port; pass one or set settleMs: 0`,
      )
    }
    await options.sleep(settleMs)
  }

  const suffix = options.partitionSuffix ?? DEFAULT_PARTITION_SUFFIX
  const partition = `${options.device}${suffix}`
  options.logger.info(`Formatting ${partition} with BTRFS as ${options.label}`)
  const formatted = await runCommand(
    options.runner,
    ["mkfs.btrfs", "-f", "-L", options.label, partition],
    { sudo: true },
  )
  if (!formatted.success) {
    throw new BackupError(`failed to format ${partition}: ${formatted.error.trim()}`)
  }

  options.logger.info("Drive formatted")
  return true
}

/** What {@link createBackupStructure} needs on top of the ports. */
export interface CreateBackupStructureOptions extends DriveOptions {
  /** Mount point of the drive. */
  mountPoint: string
  /** Path pairs whose targets must exist. */
  backupPaths: readonly BackupPath[]
  /**
   * Owner for a recursive `chown`, e.g. `deploy`, a numeric uid, or
   * `uid:gid`.
   *
   * Omitted means no `chown` at all. The source read `Deno.env.get("USER")`,
   * which is `root` under `sudo` — so the homelab's own drive ended up owned by
   * root on the runs that mattered — and defaulted to the literal `"user"` when
   * unset, which either failed or chowned to an unrelated account.
   */
  owner?: string
}

/**
 * Create `<mountPoint>/logs` and one directory per target.
 *
 * Idempotent: `mkdir` is recursive, so an existing tree is left alone.
 * @throws {BackupError} When a `chown` was requested and failed; the source
 * warned and continued into a sync that then could not write.
 */
export async function createBackupStructure(
  options: CreateBackupStructureOptions,
): Promise<void> {
  options.logger.info("Ensuring backup directory structure")

  if (options.owner !== undefined && options.owner.trim() !== "") {
    const chown = await runCommand(
      options.runner,
      ["chown", "-R", options.owner, options.mountPoint],
      { sudo: true },
    )
    if (!chown.success) {
      throw new BackupError(
        `could not set ownership of ${options.mountPoint} to ${options.owner}: ` +
          chown.error.trim(),
      )
    }
  }

  const directories = [
    `${options.mountPoint}/${LOGS_DIR}`,
    ...options.backupPaths.map((backupPath) => `${options.mountPoint}/${backupPath.target}`),
  ]
  for (const directory of directories) {
    await options.fs.mkdir(directory, { recursive: true })
  }

  options.logger.info("Directory structure ready")
}

/** What {@link resolveMountPoint} needs. */
export interface ResolveMountPointOptions extends DriveOptions {
  /** Partition device, e.g. `/dev/sdb1`. */
  device: string
  /**
   * Question asked when the device is already mounted. The existing mount point
   * is used when the answer is true, otherwise the device is unmounted and
   * mounted afresh.
   */
  mountPointQuestion?: string
  /** Home directory, only needed when `removeMountPoint` is set. */
  home?: string
}

/**
 * Decide where the backup tree lives: an existing mount, or a fresh one.
 *
 * Extracted from the block the source repeated in `create.ts:154-170`,
 * `restore.ts:66-82` and `verify-mode.ts:59-75` — byte-identical per the reviewer
 * of #50, so the duplication is the reason this owns the behaviour once, not
 * evidence of drift.
 * With no `confirm` port and the device already mounted, the existing mount
 * point is used: that is the conservative choice, it is what the operator
 * already set up, and nothing is written outside it.
 *
 * @throws {BackupError} When the device is mounted but `mount` does not name its
 * mount point — the source left `MOUNT_POINT` as `""` and the next step wrote
 * into `/backups`.
 */
export async function resolveMountPoint(
  options: ResolveMountPointOptions,
): Promise<string> {
  const existing = await getMountPoint(options)
  if (existing === null) {
    return await mountDrive(options)
  }

  options.logger.info(`${options.device} is already mounted at ${existing}`)
  const question = options.mountPointQuestion ??
    `Use the existing mount point ${existing}?`
  const useExisting = options.confirm === undefined ? true : await options.confirm(question)
  if (useExisting) {
    return existing
  }

  await unmountDrive({ ...options, device: options.device, mountPoint: existing })
  return await mountDrive(options)
}
