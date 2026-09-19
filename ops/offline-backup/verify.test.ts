import { assertEquals, assertRejects } from "@std/assert"
import { createLogger, type Logger, LogLevel } from "../console.ts"
import { createFakeRunner, FakeCommandRunner } from "../testing/command-runner.ts"
import { FakeFileSystem } from "../testing/filesystem.ts"
import {
  countSelfTestRows,
  estimatedSmartMinutes,
  extractSelfTestLog,
  getBackupSize,
  latestSelfTestNumber,
  parseDuBytes,
  parseRemainingPercent,
  parseSmartHealth,
  RESTIC_PASSWORD_VAR,
  runSmartCheck,
  scanTargetForRepos,
  selfTestAdvanced,
  smartTestRunning,
  smartTestStarted,
  summariseSmartReport,
  verifyBackups,
} from "./verify.ts"
import { BackupError, ConfirmRequiredError } from "./types.ts"

const CANARY = "canary-restic-password-8b31"

function testLogger(): Logger {
  return createLogger({
    clock: { now: () => new Date("2026-03-04T05:06:07.000Z") },
    out: { write: () => {} },
    err: { write: () => {} },
    minLevel: LogLevel.DEBUG,
  })
}

function ports(runner: FakeCommandRunner, fs = new FakeFileSystem()) {
  return { runner, fs, logger: testLogger() }
}

const HEALTHY_REPORT = `smartctl 7.4 2023-08-01
SMART overall-health self-assessment test result: PASSED

SMART Self-test log structure revision number 1
Num  Test_Description    Status                  Remaining  LifeTime(hours)  LBA_of_first_error
# 1  Short offline       Completed without error       00%      1234         -
# 2  Short offline       Completed without error       00%      1200         -`

const RUNNING_REPORT = `SMART overall-health self-assessment test result: PASSED
Self-test routine in progress...
10% of test remaining`

Deno.test("parses the byte count out of du output", () => {
  assertEquals(parseDuBytes("4096\t/mnt/drive/data\n"), 4096)
  assertEquals(parseDuBytes(""), null)
  assertEquals(parseDuBytes("du: cannot access '/mnt/drive'"), null)
})

Deno.test("measures a directory through du", async () => {
  const runner = createFakeRunner().respond({ output: "2147483648\t/mnt/drive/data\n" })
  assertEquals(
    await getBackupSize({ runner, path: "/mnt/drive/data" }),
    { bytes: 2147483648, human: "2.00 GB" },
  )
  assertEquals(runner.argvOf(0), ["du", "-sb", "/mnt/drive/data"])
})

Deno.test("reports an unmeasurable directory as unknown, not as zero bytes", async () => {
  const runner = createFakeRunner().alwaysFails("du: cannot access")
  assertEquals(
    await getBackupSize({ runner, path: "/mnt/drive/gone" }),
    { bytes: 0, human: "unknown" },
  )
})

Deno.test("classifies a directory with a config file as a repository", async () => {
  const fs = new FakeFileSystem()
    .seedDirectory("/mnt/drive/data")
    .seedDirectory("/mnt/drive/data/repo-a")
    .seed("/mnt/drive/data/repo-a/config", "{}")
    .seedDirectory("/mnt/drive/data/not-a-repo")
    .seedDirectory("/mnt/drive/data/deeper")

  const scan = await scanTargetForRepos(fs, "/mnt/drive/data", "data")

  assertEquals(scan.repos, ["/mnt/drive/data/repo-a"])
  assertEquals(scan.skipped, [{ name: "data/deeper", status: "skipped" }, {
    name: "data/not-a-repo",
    status: "skipped",
  }])
  assertEquals(scan.unreadable, null)
})

Deno.test("reports an unlistable target instead of pretending it is empty", async () => {
  const fs = new FakeFileSystem()
  const scan = await scanTargetForRepos(fs, "/mnt/drive/data", "data")

  assertEquals(scan.repos, [])
  assertEquals(scan.unreadable !== null, true)
})

function verifiedFs(): FakeFileSystem {
  return new FakeFileSystem()
    .seedDirectory("/mnt/drive/data")
    .seedDirectory("/mnt/drive/data/good")
    .seed("/mnt/drive/data/good/config", "{}")
    .seedDirectory("/mnt/drive/data/bad")
    .seed("/mnt/drive/data/bad/config", "{}")
}

Deno.test("counts passed and failed repositories and reports the first stderr line", async () => {
  const runner = createFakeRunner((argv) => {
    if (argv[0] === "which") return { success: true, output: "/usr/bin/restic", error: "" }
    return argv[2].endsWith("/good")
      ? { success: true, output: "", error: "" }
      : { success: false, output: "", error: "repo corrupted\nsecond line" }
  })

  const results = await verifyBackups({
    mountPoint: "/mnt/drive",
    backupPaths: [{ source: "~/data", target: "data" }],
    resticPassword: CANARY,
    ...ports(runner, verifiedFs()),
  })

  assertEquals(results.passed, 1)
  assertEquals(results.failed, 1)
  assertEquals(results.skipped, 0)
  assertEquals(results.details, [
    { name: "data/bad", status: "failed", error: "repo corrupted" },
    { name: "data/good", status: "passed" },
  ])
})

Deno.test("counts a directory without a config file as skipped", async () => {
  const fs = new FakeFileSystem()
    .seedDirectory("/mnt/drive/data")
    .seedDirectory("/mnt/drive/data/plain")
  const runner = createFakeRunner()

  const results = await verifyBackups({
    mountPoint: "/mnt/drive",
    backupPaths: [{ source: "~/data", target: "data" }],
    resticPassword: CANARY,
    ...ports(runner, fs),
  })

  assertEquals(results, {
    passed: 0,
    failed: 0,
    skipped: 1,
    details: [{ name: "data/plain", status: "skipped" }],
  })
})

Deno.test("passes the password on the child environment, never in argv or the process env", async () => {
  const runner = createFakeRunner((argv) =>
    argv[0] === "which"
      ? { success: true, output: "/usr/bin/restic", error: "" }
      : { success: true, output: "", error: "" }
  )

  await verifyBackups({
    mountPoint: "/mnt/drive",
    backupPaths: [{ source: "~/data", target: "data" }],
    resticPassword: CANARY,
    ...ports(runner, verifiedFs()),
  })

  const check = runner.calls.find((call) => call.argv[0] === "restic")
  assertEquals(check?.options.env, { [RESTIC_PASSWORD_VAR]: CANARY })
  assertEquals(check?.argv.includes(CANARY), false)
  assertEquals(Deno.env.get(RESTIC_PASSWORD_VAR), undefined)
})

Deno.test("reads every byte only when full verification is requested", async () => {
  const runner = createFakeRunner((argv) =>
    argv[0] === "which" ? { success: true, output: "/usr/bin/restic", error: "" } : {
      success: true,
      output: "",
      error: "",
    }
  )

  await verifyBackups({
    mountPoint: "/mnt/drive",
    backupPaths: [{ source: "~/data", target: "data" }],
    resticPassword: CANARY,
    fullVerification: true,
    ...ports(runner, verifiedFs()),
  })

  const check = runner.calls.find((call) => call.argv[0] === "restic")
  assertEquals(check?.argv, [
    "restic",
    "-r",
    "/mnt/drive/data/bad",
    "check",
    "--read-data",
  ])
})

Deno.test("skips verification only when the caller accepts a missing restic", async () => {
  const runner = createFakeRunner().alwaysFails("which: no restic in PATH")
  const results = await verifyBackups({
    mountPoint: "/mnt/drive",
    backupPaths: [{ source: "~/data", target: "data" }],
    resticPassword: CANARY,
    confirm: () => true,
    ...ports(runner, verifiedFs()),
  })

  assertEquals(results, { passed: 0, failed: 0, skipped: 0, details: [] })
})

Deno.test("refuses to continue without restic when no console can answer", async () => {
  const runner = createFakeRunner().alwaysFails("which: no restic in PATH")
  await assertRejects(
    () =>
      verifyBackups({
        mountPoint: "/mnt/drive",
        backupPaths: [{ source: "~/data", target: "data" }],
        resticPassword: CANARY,
        ...ports(runner, verifiedFs()),
      }),
    ConfirmRequiredError,
    "restic is not installed",
  )
})

Deno.test("fails when the caller declines to verify without restic", async () => {
  const runner = createFakeRunner().alwaysFails("which: no restic in PATH")
  await assertRejects(
    () =>
      verifyBackups({
        mountPoint: "/mnt/drive",
        backupPaths: [{ source: "~/data", target: "data" }],
        resticPassword: CANARY,
        confirm: () => false,
        ...ports(runner, verifiedFs()),
      }),
    BackupError,
    "restic is required",
  )
})

Deno.test("estimates the documented self-test durations", () => {
  assertEquals(estimatedSmartMinutes("short"), 2)
  assertEquals(estimatedSmartMinutes("long"), 390)
})

Deno.test("recognises a self-test that is still running", () => {
  assertEquals(smartTestRunning(RUNNING_REPORT), true)
  assertEquals(smartTestRunning(HEALTHY_REPORT), false)
})

Deno.test("recognises all three phrasings of a started self-test", () => {
  assertEquals(smartTestStarted("Self-test execution status: 0"), true)
  assertEquals(smartTestStarted("Testing has begun"), true)
  assertEquals(smartTestStarted("Please wait 2 minutes for test to complete"), false)
})

Deno.test("counts numbered self-test log rows and ignores the header", () => {
  assertEquals(countSelfTestRows(HEALTHY_REPORT), 2)
  assertEquals(countSelfTestRows("no rows here"), 0)
})

Deno.test("reads the remaining percentage from a progress line", () => {
  assertEquals(parseRemainingPercent(RUNNING_REPORT), 10)
  assertEquals(parseRemainingPercent(HEALTHY_REPORT), null)
})

Deno.test("reads the overall health verdict", () => {
  assertEquals(parseSmartHealth(HEALTHY_REPORT), "PASSED")
  assertEquals(parseSmartHealth("no health line"), null)
})

Deno.test("extracts at most eight lines of the self-test log", () => {
  const log = extractSelfTestLog(HEALTHY_REPORT)
  assertEquals(log.startsWith("SMART Self-test log"), true)
  assertEquals(log.split("\n").length, 4)
  assertEquals(extractSelfTestLog("no log section"), "")
})

Deno.test("compares self-test numbers, not row counts, so a full log still completes", () => {
  const fullLog = `SMART Self-test log structure revision number 1
# 1  Short offline       Completed without error       00%      1000         -
# 2  Short offline       Completed without error       00%      1100         -`
  const overwritten = `SMART Self-test log structure revision number 1
# 3  Short offline       Completed without error       00%      1200         -
# 2  Short offline       Completed without error       00%      1100         -`

  assertEquals(latestSelfTestNumber(fullLog), 1)
  assertEquals(latestSelfTestNumber("no rows"), null)
  assertEquals(selfTestAdvanced(fullLog, 0), true)
  assertEquals(selfTestAdvanced(overwritten, 2), true)
  assertEquals(selfTestAdvanced(overwritten, 3), false)
  assertEquals(selfTestAdvanced("no rows", 3), false)
})

Deno.test("summarises health and the self-test log", () => {
  const summary = summariseSmartReport(HEALTHY_REPORT)
  assertEquals(summary.includes("Overall Health: PASSED"), true)
  assertEquals(summary.includes("# 1  Short offline"), true)
  assertEquals(summariseSmartReport(""), "Could not retrieve SMART results")
  assertEquals(summariseSmartReport("some unrelated report"), "Could not retrieve SMART results")
})

Deno.test("returns an empty result when smartctl is not installed", async () => {
  const runner = createFakeRunner().alwaysFails("which: no smartctl in PATH")
  assertEquals(
    await runSmartCheck({
      device: "/dev/sdb",
      type: "short",
      sleep: () => Promise.resolve(),
      clock: { now: () => new Date(0) },
      ...ports(runner),
    }),
    "",
  )
})

Deno.test("returns an empty result when sudo cannot be refreshed", async () => {
  const runner = createFakeRunner((argv) => {
    if (argv[0] === "which") return { success: true, output: "/usr/sbin/smartctl", error: "" }
    if (argv[0] === "sudo") return { success: false, output: "", error: "no tty" }
    return { success: true, output: "", error: "" }
  })

  assertEquals(
    await runSmartCheck({
      device: "/dev/sdb",
      type: "short",
      sleep: () => Promise.resolve(),
      clock: { now: () => new Date(0) },
      ...ports(runner),
    }),
    "",
  )
})

Deno.test("refuses to poll without a sleep port", async () => {
  const runner = createFakeRunner()
  await assertRejects(
    () =>
      runSmartCheck({
        device: "/dev/sdb",
        type: "short",
        clock: { now: () => new Date(0) },
        ...ports(runner),
      }),
    BackupError,
    "needs a sleep port",
  )
})

Deno.test("refuses to measure elapsed time without a clock port", async () => {
  const runner = createFakeRunner()
  await assertRejects(
    () =>
      runSmartCheck({
        device: "/dev/sdb",
        type: "short",
        sleep: () => Promise.resolve(),
        ...ports(runner),
      }),
    BackupError,
    "needs a clock port",
  )
})

/** A clock whose `now()` only moves when the injected sleep is called. */
function tickingClock(startMs: number, stepMs: number) {
  let current = startMs
  return {
    clock: { now: () => new Date(current) },
    advance: () => {
      current += stepMs
    },
    elapsedMs: () => current - startMs,
  }
}

Deno.test("stops polling as soon as the self-test log grows", async () => {
  const time = tickingClock(0, 60_000)
  let statusCalls = 0
  let latest = 0
  const runner = createFakeRunner((argv) => {
    if (argv[0] === "which") return { success: true, output: "/usr/sbin/smartctl", error: "" }
    if (argv[0] === "-v") return { success: true, output: "", error: "" }
    if (argv[1] === "-t") return { success: true, output: "Testing has begun", error: "" }
    if (argv[1] === "-l") {
      const rows = latest === 2 ? "# 2  Short offline  Completed\n" : ""
      return { success: true, output: rows, error: "" }
    }
    statusCalls++
    if (statusCalls >= 2) latest = 2
    return { success: true, output: statusCalls >= 2 ? HEALTHY_REPORT : RUNNING_REPORT, error: "" }
  })

  const summary = await runSmartCheck({
    device: "/dev/sdb",
    type: "short",
    pollIntervalMs: 60_000,
    sleep: () => {
      time.advance()
      return Promise.resolve()
    },
    clock: time.clock,
    ...ports(runner),
  })

  assertEquals(summary.includes("Overall Health: PASSED"), true)
  // One poll while running, one that sees the finished test, plus the report read.
  assertEquals(statusCalls, 3)
})

Deno.test("gives up polling after maxPolls instead of looping forever", async () => {
  const time = tickingClock(0, 1000)
  let statusCalls = 0
  const runner = createFakeRunner((argv) => {
    if (argv[0] === "which") return { success: true, output: "/usr/sbin/smartctl", error: "" }
    if (argv[0] === "-v") return { success: true, output: "", error: "" }
    if (argv[1] === "-t") return { success: true, output: "Testing has begun", error: "" }
    if (argv[1] === "-l") return { success: true, output: "", error: "" }
    statusCalls++
    return { success: true, output: RUNNING_REPORT, error: "" }
  })

  await runSmartCheck({
    device: "/dev/sdb",
    type: "short",
    pollIntervalMs: 1000,
    maxPolls: 4,
    sleep: () => {
      time.advance()
      return Promise.resolve()
    },
    clock: time.clock,
    ...ports(runner),
  })

  // Four polls in the loop plus the final report read: the loop stops on its own
  // bound, not because the test looked finished.
  assertEquals(statusCalls, 5)
})

Deno.test("stops polling when a poll exceeds the maximum wait", async () => {
  const time = tickingClock(0, 400_000)
  let statusCalls = 0
  const runner = createFakeRunner((argv) => {
    if (argv[0] === "which") return { success: true, output: "/usr/sbin/smartctl", error: "" }
    if (argv[0] === "-v") return { success: true, output: "", error: "" }
    if (argv[1] === "-t") return { success: true, output: "Testing has begun", error: "" }
    if (argv[1] === "-l") return { success: true, output: "", error: "" }
    statusCalls++
    return { success: true, output: RUNNING_REPORT, error: "" }
  })

  await runSmartCheck({
    device: "/dev/sdb",
    type: "short",
    pollIntervalMs: 400_000,
    maxWaitMs: 600_000,
    maxPolls: 10,
    sleep: () => {
      time.advance()
      return Promise.resolve()
    },
    clock: time.clock,
    ...ports(runner),
  })

  // Polls at 400 s, 800 s and 1200 s: the third exceeds the 600 s ceiling.
  assertEquals(statusCalls, 4)
})

Deno.test("stops polling when sudo authentication is lost mid-run", async () => {
  const time = tickingClock(0, 1000)
  let sudoCalls = 0
  const runner = createFakeRunner((argv) => {
    if (argv[0] === "which") return { success: true, output: "/usr/sbin/smartctl", error: "" }
    if (argv[0] === "-v") {
      sudoCalls++
      return sudoCalls <= 2
        ? { success: true, output: "", error: "" }
        : { success: false, output: "", error: "no tty" }
    }
    if (argv[1] === "-t") return { success: true, output: "Testing has begun", error: "" }
    if (argv[1] === "-l") return { success: true, output: "", error: "" }
    return { success: true, output: RUNNING_REPORT, error: "" }
  })

  await runSmartCheck({
    device: "/dev/sdb",
    type: "short",
    pollIntervalMs: 1000,
    maxPolls: 5,
    sleep: () => {
      time.advance()
      return Promise.resolve()
    },
    clock: time.clock,
    ...ports(runner),
  })

  assertEquals(sudoCalls, 3)
})
