import { describe, it } from "@std/testing/bdd"
import { expect } from "@std/expect"

import { fakeClock, fakeFs } from "./_fake-fs.ts"
import { formatLogLine, JsonlLogger, parseLogLines } from "./jsonl-logger.ts"

const TS = Date.UTC(2024, 2, 12, 14, 30, 0)

describe("formatLogLine", () => {
  it("stamps an ISO timestamp and ends the line with a newline", () => {
    expect(formatLogLine({ event: "scan" }, TS)).toBe(
      `{"ts":"2024-03-12T14:30:00.000Z","event":"scan"}\n`,
    )
  })

  it("lets a caller-supplied ts win, so a captured log can be replayed", () => {
    expect(formatLogLine({ ts: "1999-01-01T00:00:00.000Z", event: "old" }, TS)).toContain(
      `"ts":"1999-01-01T00:00:00.000Z"`,
    )
  })

  it("keeps the event on one physical line even when it contains a newline", () => {
    const line = formatLogLine({ message: "first\nsecond" }, TS)
    expect(line.split("\n").length).toBe(2)
    expect(JSON.parse(line)).toEqual({
      ts: "2024-03-12T14:30:00.000Z",
      message: "first\nsecond",
    })
  })
})

describe("parseLogLines", () => {
  it("parses each line into an object", () => {
    const text = `{"a":1}\n{"b":2}\n`
    expect(parseLogLines(text).lines).toEqual([{ a: 1 }, { b: 2 }])
    expect(parseLogLines(text).invalid).toEqual([])
  })

  it("skips blank lines, including the trailing one", () => {
    expect(parseLogLines(`{"a":1}\n\n\n`).lines).toEqual([{ a: 1 }])
    expect(parseLogLines("").lines).toEqual([])
  })

  it("reports a truncated final line rather than discarding the whole log", () => {
    const text = `{"a":1}\n{"b":`
    const result = parseLogLines(text)
    expect(result.lines).toEqual([{ a: 1 }])
    expect(result.invalid.length).toBe(1)
    expect(result.invalid[0].line).toBe(2)
    expect(result.invalid[0].raw).toBe(`{"b":`)
  })

  it("reports a JSON array or scalar line, which is not a log record", () => {
    expect(parseLogLines("[1,2]").invalid[0].reason).toBe("not a JSON object")
    expect(parseLogLines("42").invalid[0].reason).toBe("not a JSON object")
    expect(parseLogLines("null").invalid[0].reason).toBe("not a JSON object")
  })

  it("reports 1-based line numbers across mixed valid and invalid lines", () => {
    const result = parseLogLines(`{"a":1}\nbroken\n{"c":3}\n`)
    expect(result.lines).toEqual([{ a: 1 }, { c: 3 }])
    expect(result.invalid.map((entry) => entry.line)).toEqual([2])
  })
})

describe("JsonlLogger", () => {
  it("appends a stamped line per event", async () => {
    const fs = fakeFs()
    const logger = new JsonlLogger(fs, "/dir/job.log.jsonl", fakeClock(TS))
    await logger.append({ event: "start" })
    await logger.append({ event: "done", count: 3 })

    const text = fs.files.get("/dir/job.log.jsonl") as string
    expect(text.split("\n").filter(Boolean).length).toBe(2)
    const { lines, invalid } = await logger.read()
    expect(invalid).toEqual([])
    expect(lines).toEqual([
      { ts: "2024-03-12T14:30:00.000Z", event: "start" },
      { ts: "2024-03-12T14:30:00.000Z", event: "done", count: 3 },
    ])
  })

  it("appends through the filesystem port instead of reading the whole file back first", async () => {
    // Before the fix, `append` read the existing file and wrote it back with one more line, so the
    // cost of each append grew with the size of the log and a crash mid-write could lose every
    // earlier line. A true append never reads the file at all.
    const fs = fakeFs({ "/job.jsonl": `{"ts":"old","event":"previous"}\n` })
    const logger = new JsonlLogger(fs, "/job.jsonl", fakeClock(TS))
    await logger.append({ event: "next" })

    expect(fs.calls.some((call) => call.op === "readText")).toBe(false)
    expect(fs.calls.filter((call) => call.op === "appendText").length).toBe(1)
    expect(fs.calls.some((call) => call.op === "writeText")).toBe(false)
  })

  it("creates the log directory before the first write", async () => {
    const fs = fakeFs()
    await new JsonlLogger(fs, "/dir/sub/job.jsonl", fakeClock(TS)).append({ event: "x" })
    expect(fs.dirs.has("/dir/sub")).toBe(true)
  })

  it("preserves an existing file's contents instead of truncating", async () => {
    const fs = fakeFs({ "/job.jsonl": `{"ts":"old","event":"previous"}\n` })
    await new JsonlLogger(fs, "/job.jsonl", fakeClock(TS)).append({ event: "next" })
    const { lines } = await new JsonlLogger(fs, "/job.jsonl", fakeClock(TS)).read()
    expect(lines.map((line) => line.event)).toEqual(["previous", "next"])
  })

  it("serialises concurrent appends, so no event is lost or interleaved", async () => {
    const fs = fakeFs()
    const logger = new JsonlLogger(fs, "/job.jsonl", fakeClock(TS))
    await Promise.all(
      Array.from({ length: 25 }, (_, i) => logger.append({ event: "e", n: i })),
    )
    const { lines, invalid } = await logger.read()
    expect(invalid).toEqual([])
    expect(lines.length).toBe(25)
    expect(lines.map((line) => line.n)).toEqual(Array.from({ length: 25 }, (_, i) => i))
  })

  it("recovers from a transient write failure instead of dying permanently", async () => {
    const fs = fakeFs()
    const logger = new JsonlLogger(fs, "/logs/job.jsonl", fakeClock(TS))

    fs.failWrites.add("/logs/job.jsonl")
    await expect(logger.append({ n: 1 })).rejects.toThrow("write refused: /logs/job.jsonl")

    // The disk error is gone. Before the fix every later append inherited the first rejection.
    fs.failWrites.clear()
    await expect(logger.append({ n: 2 })).resolves.toBeUndefined()
    await expect(logger.append({ n: 3 })).resolves.toBeUndefined()

    const { lines, invalid } = await logger.read()
    expect(invalid).toEqual([])
    expect(lines.map((line) => line.n)).toEqual([2, 3])
  })

  it("reports a stale failure as its own error, not as the next caller's", async () => {
    const fs = fakeFs()
    const logger = new JsonlLogger(fs, "/logs/job.jsonl", fakeClock(TS))
    fs.failWrites.add("/logs/job.jsonl")
    await expect(logger.append({ n: 1 })).rejects.toThrow("write refused")
    fs.failWrites.clear()
    // A successful append must not reject, and the failure must not be replayed.
    const second = await logger.append({ n: 2 }).then(() => "ok", (e: Error) => e.message)
    expect(second).toBe("ok")
  })

  it("does not poison the chain when the failure is in mkdirp rather than the write", async () => {
    const fs = fakeFs()
    const logger = new JsonlLogger(fs, "/logs/job.jsonl", fakeClock(TS))
    const realMkdirp = fs.mkdirp
    fs.mkdirp = () => Promise.reject(new Error("mkdir refused"))
    await expect(logger.append({ n: 1 })).rejects.toThrow("mkdir refused")

    fs.mkdirp = realMkdirp
    await expect(logger.append({ n: 2 })).resolves.toBeUndefined()
    expect(fs.files.get("/logs/job.jsonl")).toContain(`"n":2`)
  })

  it("reads back an empty file as no records", async () => {
    expect(await new JsonlLogger(fakeFs(), "/absent.jsonl", fakeClock()).read()).toEqual({
      lines: [],
      invalid: [],
    })
  })
})
