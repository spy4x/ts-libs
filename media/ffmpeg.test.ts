import { expect } from "@std/expect"
import { describe, it } from "@std/testing/bdd"
import {
  buildThumbnailArgv,
  DEFAULT_THUMBNAIL_AT_MS,
  makeThumbnail,
  runWithProgress,
} from "./ffmpeg.ts"
import { FfmpegProgressKind } from "./progress-parse.ts"
import { ProcessExecutionError } from "./process-runner.ts"
import { FakeProcessRunner } from "./test-doubles.ts"

/**
 * A progress stream shaped like ffmpeg 8.1.2's `-progress pipe:1` output, split
 * so that `out_time_us=400000` and its trailing `0` land in different chunks.
 */
const PROGRESS_CHUNKS = [
  "frame=120\nfps=30.0\nbitrate=1234.5kbits/s\ntotal_size=456789\nout_time_us=400000",
  "0\nout_time=00:00:04.000000\nspeed=1.01x\nprogress=continue\n",
  "frame=240\nout_time_us=8000000\nprogress=end\n",
]

const PROGRESS_ARGV = [
  "ffmpeg",
  "-hide_banner",
  "-nostdin",
  "-i",
  "/media/clip.mp4",
  "-progress",
  "pipe:1",
  "-f",
  "null",
  "-",
]

describe("buildThumbnailArgv", () => {
  const argv = buildThumbnailArgv({ input: "/media/clip.mp4", output: "/tmp/thumb.webp" })

  it("overwrites an existing output instead of prompting", () => {
    expect(argv).toContain("-y")
    expect(argv).toContain("-nostdin")
  })

  it("writes to the caller's output path rather than a shared temporary name", () => {
    expect(argv[argv.length - 1]).toBe("/tmp/thumb.webp")
    expect(argv).not.toContain("/tmp/videos/thumbnail.webp")
  })

  it("passes the input as a single argv entry", () => {
    expect(argv[argv.indexOf("-i") + 1]).toBe("/media/clip.mp4")
  })

  it("seeks to 1.3 seconds before the extracted frame by default", () => {
    expect(argv[argv.indexOf("-ss") + 1]).toBe("1.300")
    expect(DEFAULT_THUMBNAIL_AT_MS).toBe(1300)
  })

  it("formats a custom seek position as seconds.milliseconds", () => {
    const custom = buildThumbnailArgv({
      input: "/media/clip.mp4",
      output: "/tmp/thumb.webp",
      atMs: 250,
    })
    expect(custom[custom.indexOf("-ss") + 1]).toBe("0.250")
  })

  it("extracts exactly one frame", () => {
    expect(argv[argv.indexOf("-vframes") + 1]).toBe("1")
  })

  it("rejects an output that is not webp", () => {
    expect(() => buildThumbnailArgv({ input: "/media/clip.mp4", output: "/tmp/thumb.png" }))
      .toThrow(TypeError)
  })

  it("rejects a dash-leading input path before argv is built", () => {
    // Defence in depth: ffmpeg consumes the token after `-i` as a filename
    // whatever it starts with, so this guard is not the live injection vector —
    // the output guard below is. It is kept because a filename ffmpeg will never
    // open deserves the caller's own diagnostic.
    expect(() => buildThumbnailArgv({ input: "-vf", output: "/tmp/thumb.webp" }))
      .toThrow(TypeError)
    expect(() => buildThumbnailArgv({ input: "--help", output: "/tmp/thumb.webp" }))
      .toThrow(TypeError)
  })

  it("rejects an output path ffmpeg would read as one of its own options", () => {
    // Reproduced against ffmpeg 8.1.2 before the guard: this argv made ffmpeg
    // answer `Unrecognized option 'y.webp'` and exit 8.
    expect(() => buildThumbnailArgv({ input: "/media/clip.mp4", output: "-y.webp" }))
      .toThrow(TypeError)
  })

  it("rejects a path containing a NUL byte", () => {
    expect(() => buildThumbnailArgv({ input: "/media/clip.mp4", output: "/tmp/th\u0000umb.webp" }))
      .toThrow(TypeError)
  })

  it("names which path was rejected", () => {
    expect(() => buildThumbnailArgv({ input: "-vf", output: "/tmp/thumb.webp" }))
      .toThrow('thumbnail input must not start with "-"')
    expect(() => buildThumbnailArgv({ input: "/media/clip.mp4", output: "-y.webp" }))
      .toThrow('thumbnail output must not start with "-"')
  })

  it("still accepts a dash inside a file name", () => {
    const argv = buildThumbnailArgv({
      input: "/media/my clip; rm -rf.mp4",
      output: "/tmp/my-thumb-01.webp",
    })
    expect(argv[argv.indexOf("-i") + 1]).toBe("/media/my clip; rm -rf.mp4")
    expect(argv[argv.length - 1]).toBe("/tmp/my-thumb-01.webp")
  })
})

describe("makeThumbnail", () => {
  it("returns the output path when ffmpeg succeeds", async () => {
    const runner = new FakeProcessRunner(() => ({}))
    const path = await makeThumbnail(
      { input: "/media/clip.mp4", output: "/tmp/thumb.webp" },
      { runner },
    )
    expect(path).toBe("/tmp/thumb.webp")
    expect(runner.argvOf(0)?.[0]).toBe("ffmpeg")
  })

  it("uses a configured ffmpeg binary", async () => {
    const runner = new FakeProcessRunner(() => ({}))
    await makeThumbnail(
      { input: "/media/clip.mp4", output: "/tmp/thumb.webp" },
      { runner, ffmpegPath: "/usr/bin/ffmpeg" },
    )
    expect(runner.argvOf(0)?.[0]).toBe("/usr/bin/ffmpeg")
  })

  it("refuses a dash-leading output before creating any process", async () => {
    const runner = new FakeProcessRunner(() => ({}))
    const error = await makeThumbnail(
      { input: "/media/clip.mp4", output: "-y.webp" },
      { runner },
    ).catch((thrown: unknown) => thrown)
    expect(error instanceof TypeError).toBe(true)
    expect((error as TypeError).message).toBe(
      'thumbnail output must not start with "-": "-y.webp"',
    )
    expect(runner.callCount).toBe(0)
  })

  it("refuses a dash-leading input before creating any process", async () => {
    const runner = new FakeProcessRunner(() => ({}))
    const error = await makeThumbnail(
      { input: "-vf", output: "/tmp/thumb.webp" },
      { runner },
    ).catch((thrown: unknown) => thrown)
    expect(error instanceof TypeError).toBe(true)
    expect(runner.callCount).toBe(0)
  })

  it("refuses a NUL byte in the output path before creating any process", async () => {
    const runner = new FakeProcessRunner(() => ({}))
    const error = await makeThumbnail(
      { input: "/media/clip.mp4", output: "/tmp/th\u0000umb.webp" },
      { runner },
    ).catch((thrown: unknown) => thrown)
    expect(error instanceof TypeError).toBe(true)
    expect((error as TypeError).message).toContain("thumbnail output must not contain a NUL byte")
    expect(runner.callCount).toBe(0)
  })

  it("throws a ProcessExecutionError carrying stderr when ffmpeg fails", async () => {
    const runner = new FakeProcessRunner(() => ({
      code: 1,
      stderr: "Invalid data found when processing input\n",
    }))
    const error = await makeThumbnail(
      { input: "/media/clip.mp4", output: "/tmp/thumb.webp" },
      { runner },
    ).catch((thrown: unknown) => thrown)
    expect(error instanceof ProcessExecutionError).toBe(true)
    expect((error as ProcessExecutionError).stderrTail()).toBe(
      "Invalid data found when processing input",
    )
  })
})

describe("runWithProgress", () => {
  it("refuses an argv that does not ask ffmpeg for progress on a pipe", async () => {
    const runner = new FakeProcessRunner(() => ({}))
    await expect(
      runWithProgress({ argv: ["ffmpeg", "-i", "/media/clip.mp4", "out.webp"] }, { runner }),
    ).rejects.toThrow(TypeError)
    expect(runner.callCount).toBe(0)
  })

  it("computes the percentage of a run whose progress line straddles two chunks", async () => {
    const runner = new FakeProcessRunner(() => ({ chunks: PROGRESS_CHUNKS }))
    const result = await runWithProgress(
      { argv: PROGRESS_ARGV, totalDurationMs: 8000 },
      { runner },
    )
    expect(result.events.length).toBe(2)
    expect(result.events[0].kind).toBe(FfmpegProgressKind.SAMPLE)
    expect(result.events[0].percent).toBe(50)
    expect(result.events[0].outTimeMs).toBe(4000)
  })

  it("reports the final block as complete with a hundred per cent", async () => {
    const runner = new FakeProcessRunner(() => ({ chunks: PROGRESS_CHUNKS }))
    const result = await runWithProgress({ argv: PROGRESS_ARGV, totalDurationMs: 8000 }, { runner })
    const last = result.events[result.events.length - 1]
    expect(last.kind).toBe(FfmpegProgressKind.END)
    expect(last.percent).toBe(100)
    expect(result.lastPercent).toBe(100)
  })

  it("calls back with every event as it arrives", async () => {
    const runner = new FakeProcessRunner(() => ({ chunks: PROGRESS_CHUNKS }))
    const seen: number[] = []
    await runWithProgress({
      argv: PROGRESS_ARGV,
      totalDurationMs: 8000,
      onProgress: (event) => {
        if (event.percent !== null) {
          seen.push(event.percent)
        }
      },
    }, { runner })
    expect(seen).toEqual([50, 100])
  })

  it("keeps the events it parsed when ffmpeg exits non-zero", async () => {
    const runner = new FakeProcessRunner(() => ({ chunks: PROGRESS_CHUNKS, code: 1 }))
    const percents: number[] = []
    const error = await runWithProgress({
      argv: PROGRESS_ARGV,
      totalDurationMs: 8000,
      onProgress: (event) => {
        if (event.percent !== null) {
          percents.push(event.percent)
        }
      },
    }, { runner }).catch((thrown: unknown) => thrown)
    expect(error instanceof ProcessExecutionError).toBe(true)
    expect(percents).toEqual([50, 100])
  })

  it("forwards stderr lines to the caller", async () => {
    const runner = new FakeProcessRunner(() => ({
      chunks: PROGRESS_CHUNKS,
      stderr: "frame= warning one\nwarning two\n",
    }))
    const warnings: string[] = []
    await runWithProgress({
      argv: PROGRESS_ARGV,
      totalDurationMs: 8000,
      onStderrLine: (line) => warnings.push(line),
    }, { runner })
    expect(warnings).toEqual(["frame= warning one", "warning two"])
  })

  it("leaves the percentage null when the input duration is unknown", async () => {
    const runner = new FakeProcessRunner(() => ({ chunks: PROGRESS_CHUNKS }))
    const result = await runWithProgress({ argv: PROGRESS_ARGV }, { runner })
    expect(result.events[0].percent).toBe(null)
    expect(result.lastPercent).toBe(100)
  })
})
