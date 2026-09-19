import { assertEquals, assertRejects, assertThrows } from "@std/assert"
import { createLogger, LogLevel, type LogSink } from "../console.ts"
import { FakeFileSystem } from "../testing/filesystem.ts"
import {
  backupLogFileName,
  DEFAULT_RESTORE_INSTRUCTIONS,
  formatBytes,
  formatReadme,
  parseBackupPaths,
  saveBackupLog,
  validateBackupSources,
  writeReadme,
} from "./helpers.ts"
import { BackupError } from "./types.ts"

/** Captured log lines, so a test asserts output without touching a stream. */
function collectLines(): { lines: string[]; sink: LogSink } {
  const lines: string[] = []
  return { lines, sink: { write: (line) => lines.push(line) } }
}

const FIXED = new Date("2026-03-04T05:06:07.000Z")
const clock = { now: () => FIXED }

Deno.test("formats bytes with binary units", () => {
  assertEquals(formatBytes(0), "0.00 B")
  assertEquals(formatBytes(512), "512.00 B")
  assertEquals(formatBytes(1024), "1.00 KB")
  assertEquals(formatBytes(1024 * 1024), "1.00 MB")
  assertEquals(formatBytes(1024 * 1024 * 1024 * 3), "3.00 GB")
})

Deno.test("stops at the largest known unit instead of inventing one", () => {
  assertEquals(formatBytes(1024 ** 5), "1024.00 TB")
})

Deno.test("names the log file from the injected clock", () => {
  assertEquals(
    backupLogFileName(true, FIXED),
    "2026-03-04T05-06-07_success.log",
  )
  assertEquals(
    backupLogFileName(false, FIXED),
    "2026-03-04T05-06-07_failed.log",
  )
})

Deno.test("writes the log lines under the drive's logs directory", async () => {
  const fs = new FakeFileSystem()
  const path = await saveBackupLog({
    fs,
    clock,
    mountPoint: "/mnt/drive",
    lines: ["first", "second"],
    success: true,
  })

  assertEquals(path, "/mnt/drive/logs/2026-03-04T05-06-07_success.log")
  assertEquals(fs.mkdirs, ["/mnt/drive/logs"])
  assertEquals(fs.text(path), "first\nsecond\n")
})

Deno.test("propagates a log write failure instead of reporting success", async () => {
  const fs = new FakeFileSystem()
  fs.writeTextFile = () => Promise.reject(new Error("read-only file system"))

  await assertRejects(
    () =>
      saveBackupLog({
        fs,
        clock,
        mountPoint: "/mnt/drive",
        lines: ["x"],
        success: false,
      }),
    Error,
    "read-only file system",
  )
})

Deno.test("renders a README with sizes, a total and the injected date", () => {
  const readme = formatReadme({
    backupPaths: [
      { path: { source: "~/data", target: "data" }, size: "2.00 GB" },
      { path: { source: "/srv/media", target: "media" }, size: "unknown" },
    ],
    totalBytes: 2 * 1024 ** 3,
    now: FIXED,
    nextUpdate: new Date("2026-04-04T05:06:07.000Z"),
  })

  assertEquals(readme.includes("  - ~/data → data (2.00 GB)"), true)
  assertEquals(readme.includes("  - /srv/media → media (unknown)"), true)
  assertEquals(readme.includes("**Total Backup Size:** 2.00 GB (2,147,483,648 bytes)"), true)
  assertEquals(readme.includes("**Created:** 2026-03-04"), true)
  assertEquals(readme.includes("**Next Update Due:** 2026-04-04"), true)
})

Deno.test("does not bake a repository path into the README", () => {
  const readme = formatReadme({
    backupPaths: [],
    totalBytes: 0,
    now: FIXED,
    nextUpdate: FIXED,
  })

  assertEquals(readme.includes("deno task"), false)
  assertEquals(readme.includes("~/dev/rostok"), false)
  assertEquals(readme.includes(DEFAULT_RESTORE_INSTRUCTIONS), true)
})

Deno.test("takes the restore instructions from the caller", () => {
  const readme = formatReadme({
    backupPaths: [],
    totalBytes: 0,
    now: FIXED,
    nextUpdate: FIXED,
    restoreInstructions: "ask the operator for the escrow key",
  })

  assertEquals(readme.includes("ask the operator for the escrow key"), true)
  assertEquals(String(readme.includes("rsync -avhP")), "false")
})

Deno.test("measures every target and writes the README at the mount point", async () => {
  const fs = new FakeFileSystem()
  const scanned: string[] = []
  const path = await writeReadme({
    fs,
    clock,
    mountPoint: "/mnt/drive",
    backupPaths: [
      { source: "~/data", target: "data" },
      { source: "~/photos", target: "photos" },
    ],
    scanSize: (absolutePath) => {
      scanned.push(absolutePath)
      return Promise.resolve({ bytes: 1024, human: "1.00 KB" })
    },
  })

  assertEquals(scanned, ["/mnt/drive/data", "/mnt/drive/photos"])
  assertEquals(path, "/mnt/drive/README.md")
  assertEquals(fs.writes, ["/mnt/drive/README.md"])
  assertEquals(fs.text(path).includes("1.00 KB"), true)
})

Deno.test("accepts a well-formed backup path list", () => {
  assertEquals(
    parseBackupPaths(`[{"source":"~/data","target":"data"}]`),
    [{ source: "~/data", target: "data" }],
  )
})

Deno.test("rejects an empty backup path list", () => {
  assertThrows(() => parseBackupPaths("[]"), BackupError, "non-empty array")
})

Deno.test("names the malformed JSON rather than the parse failure", () => {
  assertThrows(() => parseBackupPaths("{oops"), BackupError, "not valid JSON")
})

Deno.test("rejects a non-string source that the source implementation accepted", () => {
  assertThrows(
    () => parseBackupPaths(`[{"source":1,"target":"data"}]`),
    BackupError,
    "source must be a non-empty string",
  )
})

Deno.test("rejects a target that would escape the mount point", () => {
  assertThrows(
    () => parseBackupPaths(`[{"source":"~/data","target":"../../etc"}]`),
    BackupError,
    "must be a single path segment",
  )
})

Deno.test("rejects a blank target", () => {
  assertThrows(
    () => parseBackupPaths(`[{"source":"~/data","target":"  "}]`),
    BackupError,
    "target must not be blank",
  )
})

Deno.test("reports a missing source instead of exiting the process", async () => {
  const fs = new FakeFileSystem()
    .seedDirectory("/home/tester")
    .seedDirectory("/home/tester/data")
  const report = await validateBackupSources({
    fs,
    home: "/home/tester",
    backupPaths: [
      { source: "~/data", target: "data" },
      { source: "~/gone", target: "gone" },
    ],
  })

  assertEquals(report.valid, false)
  assertEquals(report.missing, ["/home/tester/gone"])
  assertEquals(report.notDirectories, [])
  assertEquals(report.checked, ["/home/tester/data", "/home/tester/gone"])
})

Deno.test("reports a source that is a file, not a directory", async () => {
  const fs = new FakeFileSystem().seed("/home/tester/data", "not a directory")
  const report = await validateBackupSources({
    fs,
    home: "/home/tester",
    backupPaths: [{ source: "~/data", target: "data" }],
  })

  assertEquals(report.valid, false)
  assertEquals(report.notDirectories, ["/home/tester/data"])
  assertEquals(report.missing, [])
})

Deno.test("validates a seeded directory as a usable source", async () => {
  const fs = new FakeFileSystem()
    .seedDirectory("/home/tester")
    .seedDirectory("/home/tester/data")
  const report = await validateBackupSources({
    fs,
    home: "/home/tester",
    backupPaths: [{ source: "~/data", target: "data" }],
  })

  assertEquals(report.valid, true)
})

Deno.test("refuses a tilde source with no home rather than resolving to /data", async () => {
  const fs = new FakeFileSystem()
  await assertRejects(
    () =>
      validateBackupSources({
        fs,
        backupPaths: [{ source: "~/data", target: "data" }],
      }),
    Error,
    "cannot expand",
  )
})

Deno.test("logs the README path through the injected logger", async () => {
  const fs = new FakeFileSystem()
  const { lines, sink } = collectLines()
  const logger = createLogger({ clock, out: sink, err: sink, minLevel: LogLevel.DEBUG })
  await writeReadme({
    fs,
    clock,
    mountPoint: "/mnt/drive",
    backupPaths: [{ source: "~/data", target: "data" }],
    scanSize: () => Promise.resolve({ bytes: 0, human: "0.00 B" }),
    logger,
  })

  assertEquals(lines.length, 1)
  assertEquals(lines[0].endsWith("README written: /mnt/drive/README.md"), true)
})
