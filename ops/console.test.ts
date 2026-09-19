import { assertEquals, assertThrows } from "@std/assert"
import { createLogger, formatLogLine, LogLevel, type LogSink } from "./console.ts"

const FIXED = new Date("2026-01-02T03:04:05.678Z")
const clock = { now: () => FIXED }

function collector(): LogSink & { lines: string[] } {
  const lines: string[] = []
  return { lines, write: (line) => lines.push(line) }
}

Deno.test("formats a line as timestamp, level and message", () => {
  assertEquals(
    formatLogLine(LogLevel.WARN, "drive is 91% full", FIXED.toISOString()),
    "2026-01-02T03:04:05.678Z WARN drive is 91% full",
  )
})

Deno.test("stamps every line from the injected clock", () => {
  const out = collector()
  const logger = createLogger({ clock, out })
  logger.info("mounting /dev/sdb1")
  assertEquals(out.lines, ["2026-01-02T03:04:05.678Z INFO mounting /dev/sdb1"])
})

Deno.test("drops lines below minLevel instead of writing them", () => {
  const out = collector()
  const logger = createLogger({ clock, out, minLevel: LogLevel.WARN })
  logger.debug("noise")
  logger.info("more noise")
  logger.warn("kept")
  assertEquals(out.lines, ["2026-01-02T03:04:05.678Z WARN kept"])
})

Deno.test("defaults to INFO so debug output stays out of a default run", () => {
  const out = collector()
  const logger = createLogger({ clock, out })
  logger.debug("verbose")
  assertEquals(out.lines, [])
})

Deno.test("routes errors to the error sink and the rest to the output sink", () => {
  const out = collector()
  const err = collector()
  const logger = createLogger({ clock, out, err })
  logger.info("deploying")
  logger.error("rsync exited 23")
  assertEquals(out.lines, ["2026-01-02T03:04:05.678Z INFO deploying"])
  assertEquals(err.lines, ["2026-01-02T03:04:05.678Z ERROR rsync exited 23"])
})

Deno.test("records kept lines oldest first and hands back a copy", () => {
  const logger = createLogger({ clock, out: collector() })
  logger.info("first")
  logger.error("second")
  const records = logger.records()
  assertEquals(records, [
    "2026-01-02T03:04:05.678Z INFO first",
    "2026-01-02T03:04:05.678Z ERROR second",
  ])
  assertEquals(Array.isArray(records), true)
})

Deno.test("does not record when capture is off", () => {
  const logger = createLogger({ clock, out: collector(), capture: false })
  logger.info("transient")
  assertEquals(logger.records(), [])
})

Deno.test("rejects a minLevel that is not a LogLevel", () => {
  assertThrows(
    () => createLogger({ minLevel: 9 as LogLevel }),
    RangeError,
    "minLevel must be a LogLevel",
  )
})
