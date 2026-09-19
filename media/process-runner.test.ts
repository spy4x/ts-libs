import { expect } from "@std/expect"
import { describe, it } from "@std/testing/bdd"
import { createLineSplitter, ProcessExecutionError, type ProcessOutput } from "./process-runner.ts"

function collector(): { lines: string[]; splitter: ReturnType<typeof createLineSplitter> } {
  const lines: string[] = []
  return { lines, splitter: createLineSplitter((line) => lines.push(line)) }
}

const encoder = new TextEncoder()

describe("createLineSplitter", () => {
  it("emits a complete line and holds a partial one until its terminator arrives", () => {
    const { lines, splitter } = collector()
    splitter.push(encoder.encode("frame=10\nfps=0"))
    expect(lines).toEqual(["frame=10"])
    splitter.push(encoder.encode(".00\n"))
    expect(lines).toEqual(["frame=10", "fps=0.00"])
  })

  it("flushes a trailing fragment when the stream ends without a terminator", () => {
    const { lines, splitter } = collector()
    splitter.push(encoder.encode("progress=end"))
    expect(lines).toEqual([])
    splitter.flush()
    expect(lines).toEqual(["progress=end"])
  })

  it("does not split a CRLF pair that straddles two chunks", () => {
    const { lines, splitter } = collector()
    splitter.push(encoder.encode("a\r"))
    splitter.push(encoder.encode("\nb\n"))
    expect(lines).toEqual(["a", "b"])
  })

  it("treats a bare carriage return as a line break", () => {
    const { lines, splitter } = collector()
    splitter.push(encoder.encode("frame=1\rframe=2\n"))
    expect(lines).toEqual(["frame=1", "frame=2"])
  })

  it("emits an empty line for a blank line between records", () => {
    const { lines, splitter } = collector()
    splitter.push(encoder.encode("a\n\nb\n"))
    expect(lines).toEqual(["a", "", "b"])
  })

  it("decodes a multi-byte character split across two chunks", () => {
    const { lines, splitter } = collector()
    splitter.push(Uint8Array.of(0x61, 0xc3))
    splitter.push(Uint8Array.of(0xa9, 0x0a))
    expect(lines).toEqual(["aé"])
  })
})

describe("ProcessExecutionError", () => {
  const output: ProcessOutput = {
    code: 1,
    success: false,
    stdout: "",
    stderr: "line one\n\nline two\nline three\n",
  }

  it("carries the argv and the exit code of the failed process", () => {
    const error = new ProcessExecutionError("failed", output, ["ffprobe", "-v", "error", "a.mp4"])
    expect(error.code).toBe(1)
    expect(error.argv).toEqual(["ffprobe", "-v", "error", "a.mp4"])
    expect(error.message).toBe("failed")
  })

  it("quotes only the last non-empty stderr lines", () => {
    const error = new ProcessExecutionError("failed", output, ["ffprobe"])
    expect(error.stderrTail(2)).toBe("line two\nline three")
  })

  it("is an Error so a caller can catch it as one", () => {
    expect(new ProcessExecutionError("failed", output, ["ffprobe"]) instanceof Error).toBe(true)
  })
})
