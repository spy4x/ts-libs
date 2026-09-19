import { assertEquals, assertRejects } from "@std/assert"
import { createLogger, type Logger, LogLevel } from "../console.ts"
import type { CommandResult } from "../run-command.ts"
import { createFakeRunner, FakeCommandRunner } from "../testing/command-runner.ts"
import { FakeFileSystem } from "../testing/filesystem.ts"
import {
  checkDriveExists,
  createBackupStructure,
  ejectDrive,
  findMountPoint,
  formatDrive,
  getMountPoint,
  isMounted,
  listDrives,
  mountDrive,
  parseMountOutput,
  parseUdisksMountPoint,
  resolveMountPoint,
  unmountDrive,
} from "./drive.ts"
import { BackupError, ConfirmRequiredError } from "./types.ts"

const MOUNT_OUTPUT = `/dev/sda2 on / type ext4 (rw,relatime)
/dev/sdb1 on /media/tester/OfflineBackups type btrfs (rw,nosuid,nodev,relatime,ssd)
/dev/sdc1 on /media/tester/My Passport type exfat (rw,nosuid,nodev)
tmpfs on /run/user/1000 type tmpfs (rw,nosuid,nodev)`

function testLogger(): Logger {
  return createLogger({
    clock: { now: () => new Date("2026-03-04T05:06:07.000Z") },
    out: { write: () => {} },
    err: { write: () => {} },
    minLevel: LogLevel.DEBUG,
  })
}

/** Ports every call in this file needs; the fakes are shared per test. */
function ports(runner: FakeCommandRunner, fs = new FakeFileSystem()) {
  return { runner, fs, logger: testLogger() }
}

Deno.test("parses a mount row into device and mount point", () => {
  assertEquals(parseMountOutput(MOUNT_OUTPUT), [
    { device: "/dev/sda2", mountPoint: "/" },
    { device: "/dev/sdb1", mountPoint: "/media/tester/OfflineBackups" },
    { device: "/dev/sdc1", mountPoint: "/media/tester/My Passport" },
    { device: "tmpfs", mountPoint: "/run/user/1000" },
  ])
})

Deno.test("keeps a mount point containing a space", () => {
  assertEquals(
    findMountPoint(MOUNT_OUTPUT, "/dev/sdc1"),
    "/media/tester/My Passport",
  )
})

Deno.test("does not report sdb as mounted when only sdb1 is", () => {
  assertEquals(findMountPoint(MOUNT_OUTPUT, "/dev/sdb"), null)
  assertEquals(findMountPoint(MOUNT_OUTPUT, "/dev/sdb1"), "/media/tester/OfflineBackups")
})

Deno.test("ignores a mount row with no on separator", () => {
  assertEquals(parseMountOutput("proc proc rw 0 0"), [])
})

Deno.test("lists only disks, keeping spaces in the model", async () => {
  const runner = createFakeRunner().respond({
    output:
      "sda   931.5G  Samsung SSD 870  disk\nsda1  931.5G                  part\nsdb   1.8T    My Passport    disk\n",
  })
  const drives = await listDrives(ports(runner))

  assertEquals(drives, [
    { name: "sda", size: "931.5G", model: "Samsung SSD 870", type: "disk" },
    { name: "sdb", size: "1.8T", model: "My Passport", type: "disk" },
  ])
})

Deno.test("fails when lsblk fails instead of reporting no drives", async () => {
  const runner = createFakeRunner().alwaysFails("lsblk: command not found")
  await assertRejects(() => listDrives(ports(runner)), BackupError, "lsblk failed")
})

Deno.test("checks the block device at the path it was given", async () => {
  const fs = new FakeFileSystem()
  fs.stat = (path) =>
    Promise.resolve({
      isFile: false,
      isDirectory: false,
      isBlockDevice: path === "/dev/sdb",
      isSymlink: false,
      size: 0,
      mode: null,
      mtime: null,
    })

  assertEquals(
    await checkDriveExists({ device: "/dev/sdb", ...ports(createFakeRunner(), fs) }),
    true,
  )
  assertEquals(
    await checkDriveExists({ device: "/dev/sdz", ...ports(createFakeRunner(), fs) }),
    false,
  )
})

Deno.test("resolves a bare drive name under the injected dev directory", async () => {
  const fs = new FakeFileSystem()
  const seen: string[] = []
  fs.stat = (path) => {
    seen.push(path)
    return Promise.reject(new Error("no such file or directory"))
  }

  assertEquals(
    await checkDriveExists({ device: "sdb1", devDir: "/dev", ...ports(createFakeRunner(), fs) }),
    false,
  )
  assertEquals(seen, ["/dev/sdb1"])
})

Deno.test("reports a missing device as absent, not as an error", async () => {
  const fs = new FakeFileSystem()
  assertEquals(
    await checkDriveExists({ device: "/dev/sdz", ...ports(createFakeRunner(), fs) }),
    false,
  )
})

Deno.test("treats a mounted partition as mounted", async () => {
  const runner = createFakeRunner().respond({ output: MOUNT_OUTPUT })
  assertEquals(await isMounted({ device: "/dev/sdb1", ...ports(runner) }), true)
})

Deno.test("reports the mount point of an unmounted device as null", async () => {
  const runner = createFakeRunner().respond({ output: MOUNT_OUTPUT })
  assertEquals(await getMountPoint({ device: "/dev/sdz1", ...ports(runner) }), null)
})

Deno.test("reads the mount point out of udisksctl output", () => {
  assertEquals(
    parseUdisksMountPoint(
      "Mounted /dev/sdb1 at /media/tester/OfflineBackups.\n",
    ),
    "/media/tester/OfflineBackups",
  )
  assertEquals(
    parseUdisksMountPoint(
      "Mounted /dev/sdc1 at /media/tester/My Passport.\n",
    ),
    "/media/tester/My Passport",
  )
})

Deno.test("mounts with an argv array and returns the reported mount point", async () => {
  const runner = createFakeRunner().respond({
    output: "Mounted /dev/sdb1 at /media/tester/OfflineBackups.\n",
  })
  const mountPoint = await mountDrive({ device: "/dev/sdb1", ...ports(runner) })

  assertEquals(mountPoint, "/media/tester/OfflineBackups")
  assertEquals(runner.argvOf(0), ["udisksctl", "mount", "-b", "/dev/sdb1"])
})

Deno.test("throws when a successful mount names no mount point", async () => {
  const runner = createFakeRunner().respond({ output: "Mounted /dev/sdb1\n" })
  await assertRejects(
    () => mountDrive({ device: "/dev/sdb1", ...ports(runner) }),
    BackupError,
    "could not determine the mount point",
  )
})

Deno.test("throws when the mount command fails", async () => {
  const runner = createFakeRunner().alwaysFails("Error mounting /dev/sdb1: busy")
  await assertRejects(
    () => mountDrive({ device: "/dev/sdb1", ...ports(runner) }),
    BackupError,
    "failed to mount /dev/sdb1",
  )
})

Deno.test("throws when unmount fails instead of warning and continuing", async () => {
  const runner = createFakeRunner().alwaysFails("target is busy")
  await assertRejects(
    () =>
      unmountDrive({
        device: "/dev/sdb1",
        mountPoint: "/media/tester/OfflineBackups",
        ...ports(runner),
      }),
    BackupError,
    "failed to unmount /dev/sdb1",
  )
})

Deno.test("leaves the mount point directory alone unless asked to remove it", async () => {
  const fs = new FakeFileSystem().seedDirectory("/media/tester/OfflineBackups")
  const runner = createFakeRunner()
  await unmountDrive({
    device: "/dev/sdb1",
    mountPoint: "/media/tester/OfflineBackups",
    ...ports(runner, fs),
  })

  assertEquals(fs.has("/media/tester/OfflineBackups"), true)
})

Deno.test("refuses to remove a mount point outside the given home", async () => {
  const fs = new FakeFileSystem().seedDirectory("/media/tester/OfflineBackups")
  const runner = createFakeRunner()
  await unmountDrive({
    device: "/dev/sdb1",
    mountPoint: "/media/tester/OfflineBackups",
    removeMountPoint: true,
    home: "/home/other",
    ...ports(runner, fs),
  })

  assertEquals(fs.has("/media/tester/OfflineBackups"), true)
})

Deno.test("removes an empty mount point under home when asked", async () => {
  const fs = new FakeFileSystem()
    .seedDirectory("/media/tester")
    .seedDirectory("/media/tester/OfflineBackups")
  const runner = createFakeRunner()
  await unmountDrive({
    device: "/dev/sdb1",
    mountPoint: "/media/tester/OfflineBackups",
    removeMountPoint: true,
    home: "/media/tester",
    ...ports(runner, fs),
  })

  assertEquals(fs.has("/media/tester/OfflineBackups"), false)
})

Deno.test("propagates a failed eject instead of warning", async () => {
  const runner = createFakeRunner().alwaysFails("Could not power off")
  await assertRejects(
    () => ejectDrive({ device: "/dev/sdb", ...ports(runner) }),
    BackupError,
    "could not eject /dev/sdb",
  )
})

Deno.test("ejects with udisksctl power-off on the disk device", async () => {
  const runner = createFakeRunner()
  await ejectDrive({ device: "/dev/sdb", ...ports(runner) })
  assertEquals(runner.argvOf(0), ["udisksctl", "power-off", "-b", "/dev/sdb"])
})

function partedsRunner(result: Partial<CommandResult> = {}): FakeCommandRunner {
  return createFakeRunner((argv) => {
    if (argv[0] === "parted" || argv[0] === "mkfs.btrfs") {
      return { success: true, output: "", error: "", ...result }
    }
    return { success: true, output: "sdb 1.8T My Passport disk\n", error: "" }
  })
}

Deno.test("erases only after the caller confirms, with sudo argv", async () => {
  const runner = partedsRunner()
  const asked: string[] = []
  const formatted = await formatDrive({
    device: "/dev/sdb",
    label: "OfflineBackups",
    settleMs: 0,
    confirm: (question) => {
      asked.push(question)
      return true
    },
    ...ports(runner),
  })

  assertEquals(formatted, true)
  assertEquals(asked, ["Erase ALL DATA on /dev/sdb and format it as BTRFS?"])
  assertEquals(runner.argvOf(1), ["parted", "/dev/sdb", "--script", "mklabel", "gpt"])
  assertEquals(runner.calls[1].options.sudo, true)
  assertEquals(runner.argvOf(3), [
    "mkfs.btrfs",
    "-f",
    "-L",
    "OfflineBackups",
    "/dev/sdb1",
  ])
})

Deno.test("does not format or sleep when the caller declines", async () => {
  const runner = partedsRunner()
  let slept = false
  const formatted = await formatDrive({
    device: "/dev/sdb",
    label: "OfflineBackups",
    settleMs: 2000,
    sleep: () => {
      slept = true
      return Promise.resolve()
    },
    confirm: () => false,
    ...ports(runner),
  })

  assertEquals(formatted, false)
  assertEquals(slept, false)
  assertEquals(runner.calls.length, 1)
})

Deno.test("refuses to format without a confirm port", async () => {
  const runner = partedsRunner()
  await assertRejects(
    () =>
      formatDrive({
        device: "/dev/sdb",
        label: "OfflineBackups",
        settleMs: 0,
        ...ports(runner),
      }),
    ConfirmRequiredError,
    "no confirm port was supplied",
  )
  assertEquals(runner.argvOf(0), ["lsblk", "-ndo", "NAME,SIZE,MODEL,TYPE"])
})

Deno.test("appends the caller's partition suffix", async () => {
  const runner = partedsRunner()
  await formatDrive({
    device: "/dev/nvme0n1",
    partitionSuffix: "p1",
    label: "OfflineBackups",
    settleMs: 0,
    confirm: () => true,
    ...ports(runner),
  })

  assertEquals(runner.argvOf(3), [
    "mkfs.btrfs",
    "-f",
    "-L",
    "OfflineBackups",
    "/dev/nvme0n1p1",
  ])
})

Deno.test("waits for udev between parted and mkfs", async () => {
  const runner = partedsRunner()
  const waits: number[] = []
  await formatDrive({
    device: "/dev/sdb",
    label: "OfflineBackups",
    sleep: (ms) => {
      waits.push(ms)
      return Promise.resolve()
    },
    confirm: () => true,
    ...ports(runner),
  })

  assertEquals(waits, [2000])
})

Deno.test("fails before writing anything when the partition table cannot be created", async () => {
  const runner = createFakeRunner((argv) => {
    if (argv[0] === "parted") {
      return { success: false, output: "", error: "Error: /dev/sdb is in use" }
    }
    return { success: true, output: "", error: "" }
  })

  await assertRejects(
    () =>
      formatDrive({
        device: "/dev/sdb",
        label: "OfflineBackups",
        settleMs: 0,
        confirm: () => true,
        ...ports(runner),
      }),
    BackupError,
    "failed to create partition table",
  )
  assertEquals(runner.calls.length, 2)
})

Deno.test("creates the logs directory and every target under the mount point", async () => {
  const fs = new FakeFileSystem()
  const runner = createFakeRunner()
  await createBackupStructure({
    mountPoint: "/mnt/drive",
    backupPaths: [
      { source: "~/data", target: "data" },
      { source: "~/photos", target: "photos" },
    ],
    ...ports(runner, fs),
  })

  assertEquals(fs.mkdirs, ["/mnt/drive/logs", "/mnt/drive/data", "/mnt/drive/photos"])
  assertEquals(runner.calls.length, 0)
})

Deno.test("does not chown the drive unless an owner is given", async () => {
  const runner = createFakeRunner()
  await createBackupStructure({
    mountPoint: "/mnt/drive",
    backupPaths: [],
    ...ports(runner),
  })

  assertEquals(runner.calls.length, 0)
})

Deno.test("chowns the mount point to the explicit owner", async () => {
  const runner = createFakeRunner()
  await createBackupStructure({
    mountPoint: "/mnt/drive",
    backupPaths: [],
    owner: "deploy",
    ...ports(runner),
  })

  assertEquals(runner.argvOf(0), ["chown", "-R", "deploy", "/mnt/drive"])
  assertEquals(runner.calls[0].options.sudo, true)
})

Deno.test("fails when the requested chown fails", async () => {
  const runner = createFakeRunner().alwaysFails("chown: invalid user")
  await assertRejects(
    () =>
      createBackupStructure({
        mountPoint: "/mnt/drive",
        backupPaths: [],
        owner: "deploy",
        ...ports(runner),
      }),
    BackupError,
    "could not set ownership",
  )
})

Deno.test("mounts a device that is not mounted yet", async () => {
  const runner = createFakeRunner((argv) =>
    argv[0] === "mount"
      ? { success: true, output: MOUNT_OUTPUT, error: "" }
      : { success: true, output: "Mounted /dev/sde1 at /media/tester/Backup.\n", error: "" }
  )

  assertEquals(
    await resolveMountPoint({ device: "/dev/sde1", ...ports(runner) }),
    "/media/tester/Backup",
  )
})

Deno.test("keeps an existing mount point when no console can answer", async () => {
  const runner = createFakeRunner().respond({ output: MOUNT_OUTPUT })
  assertEquals(
    await resolveMountPoint({ device: "/dev/sdb1", ...ports(runner) }),
    "/media/tester/OfflineBackups",
  )
  assertEquals(runner.calls.length, 1)
})

Deno.test("remounts when the caller declines the existing mount point", async () => {
  const runner = createFakeRunner((argv) =>
    argv[0] === "mount"
      ? { success: true, output: MOUNT_OUTPUT, error: "" }
      : { success: true, output: "Mounted /dev/sdb1 at /media/tester/Fresh.\n", error: "" }
  )

  const mountPoint = await resolveMountPoint({
    device: "/dev/sdb1",
    confirm: () => false,
    ...ports(runner),
  })

  assertEquals(mountPoint, "/media/tester/Fresh")
  assertEquals(runner.argvOf(1), ["udisksctl", "unmount", "-b", "/dev/sdb1"])
  assertEquals(runner.argvOf(2), ["udisksctl", "mount", "-b", "/dev/sdb1"])
})
