import { assertEquals, assertRejects } from "@std/assert"
import { createLogger, type Logger, LogLevel, type LogSink } from "../console.ts"
import { createFakeRunner, FakeCommandRunner } from "../testing/command-runner.ts"
import { FakeFileSystem } from "../testing/filesystem.ts"
import {
  checkDeletedRepos,
  findDeletedRepos,
  parseRsyncProgress,
  syncArgv,
  syncBackups,
} from "./sync.ts"
import { BackupError, ConfirmRequiredError } from "./types.ts"

function testLogger(lines: string[] = []): Logger {
  const sink: LogSink = { write: (line) => lines.push(line) }
  return createLogger({
    clock: { now: () => new Date("2026-03-04T05:06:07.000Z") },
    out: sink,
    err: sink,
    minLevel: LogLevel.DEBUG,
    capture: false,
  })
}

function ports(runner: FakeCommandRunner, fs = new FakeFileSystem(), lines: string[] = []) {
  return { runner, fs, logger: testLogger(lines) }
}

Deno.test("builds the sync argv as an array with every exclude", () => {
  assertEquals(syncArgv("/home/tester/data/", "/mnt/drive/data/"), [
    "rsync",
    "-avh",
    "--info=progress2",
    "--delete",
    "--exclude=.sync*",
    "--exclude=*.tmp",
    "--exclude=.stfolder",
    "/home/tester/data/",
    "/mnt/drive/data/",
  ])
})

Deno.test("never puts a shell between the caller and rsync", () => {
  const argv = syncArgv("/srv/my data/", "/mnt/drive/my data/")
  assertEquals(argv.includes("bash"), false)
  assertEquals(argv.includes("sh"), false)
  assertEquals(argv.includes("-c"), false)
})

Deno.test("reads percent, size and speed from an rsync progress line", () => {
  assertEquals(
    parseRsyncProgress("        1.23G  45%   12.34MB/s    0:01:23 (xfr#4, to-chk=12/40)"),
    { percent: 45, size: "1.23G", speed: "12.34MB/s" },
  )
  assertEquals(
    parseRsyncProgress("      123.45M  12%    5.67MB/s    0:00:20"),
    { percent: 12, size: "123.45M", speed: "5.67MB/s" },
  )
})

Deno.test("accepts the size column with or without a trailing B", () => {
  assertEquals(parseRsyncProgress("  1.00M  10%  1.00MB/s"), {
    percent: 10,
    size: "1.00M",
    speed: "1.00MB/s",
  })
  assertEquals(parseRsyncProgress("  1.00MB  10%  1.00MB/s"), {
    percent: 10,
    size: "1.00MB",
    speed: "1.00MB/s",
  })
  assertEquals(parseRsyncProgress("  1234  45%  1.00MB/s"), {
    percent: 45,
    size: "1234",
    speed: "1.00MB/s",
  })
})

Deno.test("does not read the speed as the byte size", () => {
  assertEquals(parseRsyncProgress("  13.10M  35%   12.34MB/s    0:00:05"), {
    percent: 35,
    size: "13.10M",
    speed: "12.34MB/s",
  })
})

Deno.test("does not read the percentage as a byte size", () => {
  assertEquals(parseRsyncProgress("  5%   1.5GB/s"), {
    percent: 5,
    size: undefined,
    speed: "1.5GB/s",
  })
})

Deno.test("ignores an rsync line with no percentage", () => {
  assertEquals(parseRsyncProgress("data/photo.jpg"), null)
  assertEquals(parseRsyncProgress("sent 1.23G bytes  received 4.56K bytes"), null)
})

Deno.test("syncs each path through the injected runner", async () => {
  const runner = createFakeRunner()
  const lines: string[] = []
  await syncBackups({
    backupPaths: [
      { source: "~/data", target: "data" },
      { source: "~/photos", target: "photos" },
    ],
    mountPoint: "/mnt/drive",
    home: "/home/tester",
    progressStep: 5,
    ...ports(runner, new FakeFileSystem(), lines),
  })

  assertEquals(runner.argvOf(0), syncArgv("/home/tester/data/", "/mnt/drive/data/"))
  assertEquals(runner.argvOf(1), syncArgv("/home/tester/photos/", "/mnt/drive/photos/"))
  assertEquals(lines.some((line) => line.includes("All syncs completed")), true)
})

Deno.test("reports progress as rsync streams it, at the requested step", async () => {
  const runner = createFakeRunner()
  const lines: string[] = []

  await syncBackups({
    backupPaths: [{ source: "/srv/data", target: "data" }],
    mountPoint: "/mnt/drive",
    progressStep: 5,
    ...ports(runner, new FakeFileSystem(), lines),
  })

  assertEquals(lines.length, 4)
})

Deno.test("emits a progress line per step, with size and speed", async () => {
  const runner = createFakeRunner((_argv, options) => {
    options.onOutput?.("  1.00M  10%  1.00MB/s\n")
    options.onOutput?.("  1.10M  12%  1.00MB/s\n")
    options.onOutput?.("  2.00M  25%  1.00MB/s\n")
    return { success: true, output: "", error: "" }
  })
  const lines: string[] = []

  await syncBackups({
    backupPaths: [{ source: "/srv/data", target: "data" }],
    mountPoint: "/mnt/drive",
    progressStep: 5,
    ...ports(runner, new FakeFileSystem(), lines),
  })

  const progress = lines.filter((line) => line.includes("data: "))
  assertEquals(progress.length, 2)
  assertEquals(progress[0].endsWith("data: 10% (1.00M) @ 1.00MB/s"), true)
  assertEquals(progress[1].endsWith("data: 25% (2.00M) @ 1.00MB/s"), true)
})

Deno.test("fails the whole sync when rsync exits non-zero", async () => {
  const runner = createFakeRunner().alwaysFails("rsync: connection unexpectedly closed")
  await assertRejects(
    () =>
      syncBackups({
        backupPaths: [{ source: "/srv/data", target: "data" }],
        mountPoint: "/mnt/drive",
        ...ports(runner),
      }),
    BackupError,
    "rsync failed for data",
  )
})

Deno.test("refuses a tilde source with no home", async () => {
  const runner = createFakeRunner()
  await assertRejects(
    () =>
      syncBackups({
        backupPaths: [{ source: "~/data", target: "data" }],
        mountPoint: "/mnt/drive",
        ...ports(runner),
      }),
    Error,
    "cannot expand",
  )
  assertEquals(runner.calls.length, 0)
})

Deno.test("finds repositories that exist only on the drive", async () => {
  const fs = new FakeFileSystem()
    .seedDirectory("/home/tester")
    .seedDirectory("/home/tester/data")
    .seedDirectory("/home/tester/data/kept")
    .seedDirectory("/home/tester/data/deleted-locally")
    .seed("/home/tester/data/notes.txt", "a file, not a repository")
    .seedDirectory("/mnt/drive/data")
    .seedDirectory("/mnt/drive/data/kept")
    .seedDirectory("/mnt/drive/data/deleted-locally")
    .seedDirectory("/mnt/drive/data/only-on-drive")
    .seed("/mnt/drive/data/notes.txt", "a file, not a repository")

  const report = await findDeletedRepos({
    backupPaths: [{ source: "~/data", target: "data" }],
    mountPoint: "/mnt/drive",
    home: "/home/tester",
    ...ports(createFakeRunner(), fs),
  })

  assertEquals(report.orphans, { data: ["only-on-drive"] })
  assertEquals(report.unreadable, [])
})

Deno.test("reports the target it could not read instead of failing the check", async () => {
  const fs = new FakeFileSystem().seedDirectory("/home/tester/data")
  const report = await findDeletedRepos({
    backupPaths: [{ source: "~/data", target: "data" }],
    mountPoint: "/mnt/drive",
    home: "/home/tester",
    ...ports(createFakeRunner(), fs),
  })

  assertEquals(report.orphans, {})
  assertEquals(report.unreadable.length, 1)
  assertEquals(report.unreadable[0].startsWith("/mnt/drive/data: "), true)
})

Deno.test("allows the sync when the drive holds nothing extra", async () => {
  const fs = new FakeFileSystem()
    .seedDirectory("/home/tester/data")
    .seedDirectory("/mnt/drive/data")
  let asked = false

  const allowed = await checkDeletedRepos({
    backupPaths: [{ source: "~/data", target: "data" }],
    mountPoint: "/mnt/drive",
    home: "/home/tester",
    confirm: () => {
      asked = true
      return true
    },
    ...ports(createFakeRunner(), fs),
  })

  assertEquals(allowed, true)
  assertEquals(asked, false)
})

Deno.test("names the doomed repositories and asks before deleting them", async () => {
  const fs = new FakeFileSystem()
    .seedDirectory("/home/tester/data")
    .seedDirectory("/mnt/drive/data")
    .seedDirectory("/mnt/drive/data/gone")
  const questions: string[] = []
  const lines: string[] = []

  const allowed = await checkDeletedRepos({
    backupPaths: [{ source: "~/data", target: "data" }],
    mountPoint: "/mnt/drive",
    home: "/home/tester",
    confirm: (question) => {
      questions.push(question)
      return true
    },
    ...ports(createFakeRunner(), fs, lines),
  })

  assertEquals(allowed, true)
  assertEquals(questions, ["Delete these repositories from the drive and continue?"])
  assertEquals(lines.some((line) => line.endsWith("- gone")), true)
})

Deno.test("refuses to delete drive-only repositories when the caller says no", async () => {
  const fs = new FakeFileSystem()
    .seedDirectory("/home/tester/data")
    .seedDirectory("/mnt/drive/data")
    .seedDirectory("/mnt/drive/data/gone")

  assertEquals(
    await checkDeletedRepos({
      backupPaths: [{ source: "~/data", target: "data" }],
      mountPoint: "/mnt/drive",
      home: "/home/tester",
      confirm: () => false,
      ...ports(createFakeRunner(), fs),
    }),
    false,
  )
})

Deno.test("refuses to delete drive-only repositories with no console attached", async () => {
  const fs = new FakeFileSystem()
    .seedDirectory("/home/tester/data")
    .seedDirectory("/mnt/drive/data")
    .seedDirectory("/mnt/drive/data/gone")

  await assertRejects(
    () =>
      checkDeletedRepos({
        backupPaths: [{ source: "~/data", target: "data" }],
        mountPoint: "/mnt/drive",
        home: "/home/tester",
        ...ports(createFakeRunner(), fs),
      }),
    ConfirmRequiredError,
    "no confirm port was supplied",
  )
})

Deno.test("captures the log lines a caller persists", () => {
  const lines: string[] = []
  const logger = testLogger(lines)
  logger.warn("drive-only repositories found")

  assertEquals(lines.length, 1)
  assertEquals(lines[0].endsWith("WARN drive-only repositories found"), true)
})
