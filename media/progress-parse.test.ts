import { expect } from "@std/expect"
import { describe, it } from "@std/testing/bdd"
import {
  clampPercent,
  createFfmpegProgressParser,
  type FfmpegProgressEvent,
  FfmpegProgressKind,
  type FfmpegProgressParser,
  parseOutTime,
} from "./progress-parse.ts"

/**
 * A mid-run block, shaped like real output: ffmpeg 8.1.2 with
 * `-progress pipe:1`, captured on this machine.
 */
const CONTINUE_BLOCK = [
  "frame=120",
  "fps=30.0",
  "stream_0_0_q=28.0",
  "bitrate=1234.5kbits/s",
  "total_size=456789",
  "out_time_us=4000000",
  "out_time_ms=4000000",
  "out_time=00:00:04.000000",
  "dup_frames=0",
  "drop_frames=0",
  "speed=1.01x",
  "progress=continue",
].join("\n")

/** The final block of a 0.8 s run, captured verbatim from ffmpeg 8.1.2. */
const END_BLOCK = [
  "frame=10",
  "fps=0.00",
  "stream_0_0_q=-1.0",
  "bitrate=N/A",
  "total_size=N/A",
  "out_time_us=800000",
  "out_time_ms=800000",
  "out_time=00:00:00.800000",
  "dup_frames=0",
  "drop_frames=0",
  "speed=60.8x",
  "progress=end",
].join("\n")

function feed(parser: FfmpegProgressParser, block: string): FfmpegProgressEvent[] {
  const events: FfmpegProgressEvent[] = []
  for (const line of block.split("\n")) {
    const event = parser.push(line)
    if (event !== null) {
      events.push(event)
    }
  }
  return events
}

describe("createFfmpegProgressParser", () => {
  it("computes the percentage of a continue block from the input duration", () => {
    const [event] = feed(createFfmpegProgressParser({ totalDurationMs: 10_000 }), CONTINUE_BLOCK)
    expect(event.kind).toBe(FfmpegProgressKind.SAMPLE)
    expect(event.percent).toBe(40)
    expect(event.outTimeMs).toBe(4000)
  })

  it("reads out_time_ms as microseconds, because ffmpeg writes one microsecond value twice", () => {
    // ffmpeg 8.1.2 reports `out_time_us=800000` and `out_time_ms=800000` for the
    // same 0.8 s position, so a parser treating the second field as
    // milliseconds scales every percentage by 1000.
    const block = END_BLOCK.replace("progress=end", "progress=continue")
    const [event] = feed(createFfmpegProgressParser({ totalDurationMs: 10_000 }), block)
    expect(event.outTimeMs).toBe(800)
    expect(event.percent).toBe(8)
  })

  it("clamps a percentage above 100 when ffmpeg over-reports the elapsed time", () => {
    const block = CONTINUE_BLOCK.replace("out_time_us=4000000", "out_time_us=99999000")
    const [event] = feed(createFfmpegProgressParser({ totalDurationMs: 10_000 }), block)
    expect(event.percent).toBe(100)
  })

  it("never reports a negative percentage", () => {
    const block = CONTINUE_BLOCK.replace("out_time_us=4000000", "out_time_us=-4000000")
    const [event] = feed(createFfmpegProgressParser({ totalDurationMs: 10_000 }), block)
    expect(event.outTimeMs).toBe(-4000)
    expect(event.percent).toBe(0)
  })

  it("falls back to the timestamp field when no microsecond field is present", () => {
    const block = CONTINUE_BLOCK
      .replace("out_time_us=4000000\n", "")
      .replace("out_time_ms=4000000\n", "")
    const [event] = feed(createFfmpegProgressParser({ totalDurationMs: 8000 }), block)
    expect(event.outTimeMs).toBe(4000)
    expect(event.percent).toBe(50)
  })

  it("keeps a key it does not model in raw and still emits the block", () => {
    const [event] = feed(createFfmpegProgressParser({ totalDurationMs: 10_000 }), CONTINUE_BLOCK)
    expect(event.raw["stream_0_0_q"]).toBe("28.0")
    expect(event.raw["dup_frames"]).toBe("0")
    // Every key of the block is preserved, modelled or not.
    expect(Object.keys(event.raw).length).toBe(11)
  })

  it("reports N/A fields as null rather than NaN", () => {
    const [event] = feed(createFfmpegProgressParser({ totalDurationMs: 10_000 }), END_BLOCK)
    expect(event.bitrateKbps).toBe(null)
    expect(event.totalSizeBytes).toBe(null)
    expect(event.fps).toBe(0)
  })

  it("parses a bitrate in kbits/s and a byte count", () => {
    const [event] = feed(createFfmpegProgressParser({ totalDurationMs: 10_000 }), CONTINUE_BLOCK)
    expect(event.bitrateKbps).toBe(1234.5)
    expect(event.totalSizeBytes).toBe(456789)
    expect(event.frame).toBe(120)
    expect(event.fps).toBe(30)
  })

  it("keeps the speed field verbatim", () => {
    const [event] = feed(createFfmpegProgressParser({ totalDurationMs: 10_000 }), CONTINUE_BLOCK)
    expect(event.speed).toBe("1.01x")
  })

  it("marks progress=end as complete with 100 per cent even when the time is short", () => {
    const [event] = feed(createFfmpegProgressParser({ totalDurationMs: 8000 }), END_BLOCK)
    expect(event.kind).toBe(FfmpegProgressKind.END)
    expect(event.percent).toBe(100)
    expect(event.outTimeMs).toBe(800)
  })

  it("leaves the percentage null while the total duration is unknown", () => {
    const [event] = feed(createFfmpegProgressParser({ totalDurationMs: null }), CONTINUE_BLOCK)
    expect(event.kind).toBe(FfmpegProgressKind.SAMPLE)
    expect(event.percent).toBe(null)
    expect(event.outTimeMs).toBe(4000)
  })

  it("returns no event for a blank line, prose or a line without a separator", () => {
    const parser = createFfmpegProgressParser({ totalDurationMs: 10_000 })
    expect(parser.push("")).toBe(null)
    expect(parser.push("   ")).toBe(null)
    expect(parser.push("ffmpeg version 8.1.2")).toBe(null)
    expect(parser.push("=value-without-a-key")).toBe(null)
  })

  it("treats an unrecognised progress value as a sample rather than dropping the block", () => {
    const block = CONTINUE_BLOCK.replace("progress=continue", "progress=resuming")
    const [event] = feed(createFfmpegProgressParser({ totalDurationMs: 10_000 }), block)
    expect(event.kind).toBe(FfmpegProgressKind.SAMPLE)
    expect(event.outTimeMs).toBe(4000)
  })

  it("emits the block under construction on flush when ffmpeg died mid-block", () => {
    const parser = createFfmpegProgressParser({ totalDurationMs: 10_000 })
    const block = CONTINUE_BLOCK.replace("progress=continue", "")
    for (const line of block.split("\n")) {
      expect(parser.push(line)).toBe(null)
    }
    const event = parser.flush()
    expect(event?.outTimeMs).toBe(4000)
    expect(event?.percent).toBe(40)
  })

  it("returns null from flush when no block was started", () => {
    expect(createFfmpegProgressParser().flush()).toBe(null)
  })
})

describe("parseOutTime", () => {
  it("parses a timestamp with microseconds", () => {
    expect(parseOutTime("00:00:04.000000")).toBe(4000)
  })

  it("parses hours, minutes and a short fraction", () => {
    expect(parseOutTime("01:02:03.5")).toBe(3723500)
  })

  it("returns null for a malformed timestamp", () => {
    expect(parseOutTime("4.0")).toBe(null)
    expect(parseOutTime("N/A")).toBe(null)
    expect(parseOutTime("00:00")).toBe(null)
  })
})

describe("clampPercent", () => {
  it("passes a percentage inside the range through unchanged", () => {
    expect(clampPercent(42.5)).toBe(42.5)
  })

  it("clamps above 100", () => {
    expect(clampPercent(150)).toBe(100)
  })

  it("clamps below zero", () => {
    expect(clampPercent(-5)).toBe(0)
  })

  it("reports zero for a non-finite percentage instead of a completed bar", () => {
    expect(clampPercent(Number.NaN)).toBe(0)
    expect(clampPercent(Number.POSITIVE_INFINITY)).toBe(0)
  })
})
