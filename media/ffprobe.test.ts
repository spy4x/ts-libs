import { expect } from "@std/expect"
import { describe, it } from "@std/testing/bdd"
import {
  asMp4Path,
  type FFProbeOutput,
  getAudioDuration,
  getDuration,
  getImageDimensions,
  getMeta,
  isMp4Format,
  isMp4Path,
} from "./ffprobe.ts"
import { ProcessExecutionError } from "./process-runner.ts"
import { FakeProcessRunner } from "./test-doubles.ts"

/**
 * Trimmed output of `ffprobe -v error -show_format -show_streams -print_format json`
 * on a 10 s h264/aac mp4, captured from ffprobe 8.1.2 on this machine.
 */
const MP4_PROBE: FFProbeOutput = {
  streams: [
    {
      index: 0,
      codec_name: "h264",
      codec_type: "video",
      width: 640,
      height: 480,
      r_frame_rate: "30/1",
      avg_frame_rate: "30/1",
      duration: "10.000000",
      tags: { language: "und", handler_name: "VideoHandler" },
    },
    {
      index: 1,
      codec_name: "aac",
      codec_type: "audio",
      duration: "10.005000",
      tags: { language: "und" },
    },
  ],
  format: {
    filename: "sample.mp4",
    nb_streams: 2,
    format_name: "mov,mp4,m4a,3gp,3g2,mj2",
    duration: "10.000000",
    size: "65789",
    tags: { major_brand: "isom" },
  },
}

const MP4_PATH = "/media/clip.mp4"

function probing(
  probe: FFProbeOutput,
  options: { code?: number; stderr?: string } = {},
): FakeProcessRunner {
  return new FakeProcessRunner(() => ({
    stdout: JSON.stringify(probe),
    code: options.code,
    stderr: options.stderr,
  }))
}

function probeOf(overrides: Partial<FFProbeOutput>): FFProbeOutput {
  return { ...MP4_PROBE, ...overrides }
}

describe("getMeta", () => {
  it("reads a three-digit fractional duration as milliseconds", async () => {
    // `"10.500".slice(0, -3)` is `"10."`, so the source returned 10000 ms here.
    const runner = probing(probeOf({ format: { ...MP4_PROBE.format, duration: "10.500" } }))
    const meta = await getMeta(MP4_PATH, { runner })
    expect(meta.durationMs).toBe(10500)
  })

  it("reads a six-digit fractional duration as milliseconds", async () => {
    const meta = await getMeta(MP4_PATH, { runner: probing(MP4_PROBE) })
    expect(meta.durationMs).toBe(10000)
  })

  it("reads an integer duration without a fraction", async () => {
    const runner = probing(probeOf({ format: { ...MP4_PROBE.format, duration: "7" } }))
    const meta = await getMeta(MP4_PATH, { runner })
    expect(meta.durationMs).toBe(7000)
  })

  it("falls back to the shortest stream duration when the format has none", async () => {
    const runner = probing(probeOf({ format: { ...MP4_PROBE.format, duration: undefined } }))
    const meta = await getMeta(MP4_PATH, { runner })
    expect(meta.durationMs).toBe(10000)
  })

  it("reports container, coded dimensions and frame rate", async () => {
    const meta = await getMeta(MP4_PATH, { runner: probing(MP4_PROBE) })
    expect(meta.format).toBe("mov,mp4,m4a,3gp,3g2,mj2")
    expect(meta.width).toBe(640)
    expect(meta.height).toBe(480)
    expect(meta.framerate).toBe("30/1")
    expect(meta.rotation).toBe(0)
  })

  it("passes the media path as a single argv entry, never as a shell string", async () => {
    const runner = probing(MP4_PROBE)
    const path = "/media/my clip; rm -rf.txt.mp4"
    await getMeta(path, { runner })
    expect(runner.argvOf(0)).toEqual([
      "ffprobe",
      "-v",
      "error",
      "-show_format",
      "-show_streams",
      "-print_format",
      "json",
      path,
    ])
  })

  it("honours a configured ffprobe binary path", async () => {
    const runner = probing(MP4_PROBE)
    await getMeta(MP4_PATH, { runner, ffprobePath: "/opt/bin/ffprobe" })
    expect(runner.argvOf(0)?.[0]).toBe("/opt/bin/ffprobe")
  })

  it("reads the rotation from a display matrix", async () => {
    const runner = probing(probeOf({
      streams: [
        {
          ...MP4_PROBE.streams![0],
          side_data_list: [{ side_data_type: "Display Matrix", rotation: 90 }],
        },
        MP4_PROBE.streams![1],
      ],
    }))
    const meta = await getMeta(MP4_PATH, { runner })
    expect(meta.rotation).toBe(90)
  })

  it("prefers the display matrix over a stream rotation tag", async () => {
    const runner = probing(probeOf({
      streams: [
        {
          ...MP4_PROBE.streams![0],
          side_data_list: [{ side_data_type: "Display Matrix", rotation: 90 }],
          tags: { rotate: "-90" },
        },
      ],
    }))
    const meta = await getMeta(MP4_PATH, { runner })
    expect(meta.rotation).toBe(90)
  })

  it("falls back to a stream rotation tag", async () => {
    const runner = probing(probeOf({
      streams: [{ ...MP4_PROBE.streams![0], tags: { rotate: "-90" } }],
    }))
    const meta = await getMeta(MP4_PATH, { runner })
    expect(meta.rotation).toBe(-90)
  })

  it("falls back to a container-level rotation tag", async () => {
    const runner = probing(probeOf({
      format: { ...MP4_PROBE.format, tags: { rotate: "180" } },
    }))
    const meta = await getMeta(MP4_PATH, { runner })
    expect(meta.rotation).toBe(180)
  })

  it("ignores a rotation tag that is not a number", async () => {
    const runner = probing(probeOf({
      streams: [{ ...MP4_PROBE.streams![0], tags: { rotate: "sideways" } }],
    }))
    const meta = await getMeta(MP4_PATH, { runner })
    expect(meta.rotation).toBe(0)
  })

  it("prefers the 30/1 video stream over the first video stream", async () => {
    const runner = probing(probeOf({
      streams: [
        { codec_type: "video", width: 320, height: 180, avg_frame_rate: "10/1" },
        { codec_type: "video", width: 640, height: 480, avg_frame_rate: "30/1" },
      ],
    }))
    const meta = await getMeta(MP4_PATH, { runner })
    expect(meta.width).toBe(640)
    expect(meta.framerate).toBe("30/1")
  })

  it("returns a zero duration for a webm container instead of throwing", async () => {
    // Captured from a real webm: `format_name` is `matroska,webm`.
    const runner = probing({
      streams: [{ codec_type: "video", width: 640, height: 480, avg_frame_rate: "30/1" }],
      format: { format_name: "matroska,webm", duration: "3.008000" },
    })
    const meta = await getMeta("/media/clip.webm", { runner })
    expect(meta.durationMs).toBe(0)
    expect(meta.format).toBe("matroska,webm")
  })

  it("returns a zero duration for a jpg still, whose container is image2", async () => {
    // ffprobe 8.1.2 reports `image2` for a .jpg file; the source only skipped
    // `jpg_pipe`, which appears for piped input, so this threw.
    const runner = probing({
      streams: [{ codec_type: "video", width: 101, height: 99 }],
      format: { format_name: "image2", duration: undefined },
    })
    const meta = await getMeta("/media/cover.jpg", { runner })
    expect(meta.durationMs).toBe(0)
  })

  it("returns a zero duration for a webp image", async () => {
    const runner = probing({
      streams: [{ codec_type: "video", width: 101, height: 99, avg_frame_rate: "25/1" }],
      format: { format_name: "webp_pipe" },
    })
    const meta = await getMeta("/media/cover.webp", { runner })
    expect(meta.durationMs).toBe(0)
  })

  it("throws when the container should carry a duration and does not", async () => {
    const runner = probing({
      streams: [{ codec_type: "video", width: 640, height: 480 }],
      format: { format_name: "mov,mp4,m4a,3gp,3g2,mj2" },
    })
    await expect(getMeta(MP4_PATH, { runner })).rejects.toThrow("duration could not be detected")
  })

  it("throws when the file has no video stream", async () => {
    const runner = probing({ streams: [{ codec_type: "audio", duration: "10.0" }] })
    await expect(getMeta(MP4_PATH, { runner })).rejects.toThrow("no video stream found")
  })

  it("throws when the video stream reports no dimensions", async () => {
    const runner = probing(probeOf({ streams: [{ codec_type: "video", duration: "10.0" }] }))
    await expect(getMeta(MP4_PATH, { runner })).rejects.toThrow("no width or height found")
  })

  it("throws a ProcessExecutionError carrying stderr when ffprobe fails", async () => {
    const runner = probing(MP4_PROBE, { code: 1, stderr: "moov atom not found\n" })
    const error = await getMeta(MP4_PATH, { runner }).catch((thrown: unknown) => thrown)
    expect(error instanceof ProcessExecutionError).toBe(true)
    expect((error as ProcessExecutionError).stderrTail()).toBe("moov atom not found")
  })

  it("throws when ffprobe answers with something that is not JSON", async () => {
    const runner = new FakeProcessRunner(() => ({ stdout: "not json at all" }))
    await expect(getMeta(MP4_PATH, { runner })).rejects.toThrow("ffprobe returned invalid JSON")
  })

  it("refuses a media path that ffprobe would read as an option, without spawning", async () => {
    const runner = probing(MP4_PROBE)
    await expect(getMeta("-i", { runner })).rejects.toThrow(TypeError)
    expect(runner.callCount).toBe(0)
  })
})

describe("getDuration", () => {
  it("returns the duration of an mp4 file in milliseconds", async () => {
    const runner = probing(MP4_PROBE)
    expect(await getDuration(asMp4Path(MP4_PATH), { runner })).toBe(10000)
  })

  it("rejects a path whose extension is not mp4 before any process runs", () => {
    expect(() => asMp4Path("/media/clip.webm")).toThrow(TypeError)
  })

  it("rejects a .mp4 path whose container is really a webm", async () => {
    const runner = probing({
      streams: [{ codec_type: "video", width: 640, height: 480 }],
      format: { format_name: "matroska,webm", duration: "3.008000" },
    })
    await expect(getDuration(asMp4Path("/media/renamed.mp4"), { runner }))
      .rejects.toThrow("getDuration needs an mp4 container")
  })

  it("throws when the mp4 has no video stream", async () => {
    const runner = probing({ streams: [], format: MP4_PROBE.format })
    await expect(getDuration(asMp4Path(MP4_PATH), { runner }))
      .rejects.toThrow("no video stream found")
  })
})

describe("mp4 path branding", () => {
  it("accepts an uppercase extension", () => {
    expect(isMp4Path("/media/CLIP.MP4")).toBe(true)
  })

  it("does not accept an extension that merely starts with mp4", () => {
    expect(isMp4Path("/media/clip.mp4.part")).toBe(false)
  })

  it("recognises the mp4 container family by ffprobe format name", () => {
    expect(isMp4Format("mov,mp4,m4a,3gp,3g2,mj2")).toBe(true)
    expect(isMp4Format("matroska,webm")).toBe(false)
    expect(isMp4Format(null)).toBe(false)
  })
})

describe("getAudioDuration", () => {
  const audioRunner = (stdout: string) => new FakeProcessRunner(() => ({ stdout }))

  it("returns the last packet time in milliseconds, not the first number in the response", async () => {
    const runner = audioRunner("8.266304\n8.333333\n8.466667\n")
    expect(await getAudioDuration("/media/track.mp4", { runner })).toBe(8467)
  })

  it("asks ffprobe for the tail of the file", async () => {
    const runner = audioRunner("1.0\n")
    await getAudioDuration("/media/track.mp4", { runner })
    const argv = runner.argvOf(0) ?? []
    expect(argv).toContain("-read_intervals")
    expect(argv.slice(-2)).toEqual(["-i", "/media/track.mp4"])
  })

  it("throws when ffprobe returns no packet timestamps", async () => {
    const runner = audioRunner("\n")
    await expect(getAudioDuration("/media/silent.mp4", { runner }))
      .rejects.toThrow("no packet timestamps returned")
  })

  it("throws a ProcessExecutionError when ffprobe fails", async () => {
    const runner = new FakeProcessRunner(() => ({ code: 1, stderr: "No such file or directory" }))
    await expect(getAudioDuration("/media/gone.mp4", { runner }))
      .rejects.toThrow(ProcessExecutionError)
  })

  it("refuses a dash-leading path that would land in ffprobe's option list", async () => {
    // `getAudioDuration` appends its own `-i` before the path, so the path lands
    // in an option slot: `-read_intervals` reached ffprobe 8.1.2 in a hand run
    // and it answered exit 1, `Missing argument for option 'read_intervals'`.
    const runner = new FakeProcessRunner(() => ({ stdout: "1.0\n" }))
    const error = await getAudioDuration("-read_intervals", { runner })
      .catch((thrown: unknown) => thrown)
    expect(error instanceof TypeError).toBe(true)
    expect((error as TypeError).message).toBe(
      'media path must not start with "-": "-read_intervals"',
    )
    expect(runner.callCount).toBe(0)
  })

  it("refuses a NUL byte in the path before creating any process", async () => {
    // Without the guard this reached `Deno.Command`, which threw its own
    // `nul byte found in provided data` from inside the spawn, naming neither
    // the argument nor the caller.
    const runner = new FakeProcessRunner(() => ({ stdout: "1.0\n" }))
    const error = await getAudioDuration("/media/tra\u0000ck.mp4", { runner })
      .catch((thrown: unknown) => thrown)
    expect(error instanceof TypeError).toBe(true)
    expect((error as TypeError).message).toBe(
      'media path must not contain a NUL byte: "/media/tra\\u0000ck.mp4"',
    )
    expect(runner.callCount).toBe(0)
  })
})

describe("getImageDimensions", () => {
  it("reduces an odd width and height to even numbers", async () => {
    // Captured from a real 101x99 png: an odd dimension cannot be encoded as yuv420p.
    const runner = probing({ streams: [{ width: 101, height: 99 }] })
    expect(await getImageDimensions("/media/cover.png", { runner })).toEqual({
      width: 100,
      height: 98,
    })
  })

  it("leaves even dimensions alone", async () => {
    const runner = probing({ streams: [{ width: 640, height: 480 }] })
    expect(await getImageDimensions("/media/cover.webp", { runner })).toEqual({
      width: 640,
      height: 480,
    })
  })

  it("selects the first video stream of the image", async () => {
    const runner = probing({ streams: [{ width: 640, height: 480 }] })
    await getImageDimensions("/media/cover.webp", { runner })
    expect(runner.argvOf(0)).toEqual([
      "ffprobe",
      "-v",
      "error",
      "-select_streams",
      "v:0",
      "-show_entries",
      "stream=width,height",
      "-of",
      "json",
      "/media/cover.webp",
    ])
  })

  it("throws when the image reports no dimensions", async () => {
    const runner = probing({ streams: [] })
    await expect(getImageDimensions("/media/broken.png", { runner }))
      .rejects.toThrow("could not read image dimensions")
  })
})
