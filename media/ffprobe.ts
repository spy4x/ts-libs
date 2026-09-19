/**
 * ffprobe wrappers: metadata, duration, audio duration, image dimensions.
 *
 * Ported from `roley/src/lib/server/video-processing/helpers.ts` (`getMeta`,
 * `getDuration`, `getAudioDuration`, `getImageDimensions`) and
 * `roley/src/lib/server/video-processing/types.ts`.
 *
 * Two changes shape this module:
 *
 * 1. The source passed a shell string with the media path interpolated into it
 *    (`helpers.ts:37,96,123`). Every call here is an argv array, and every
 *    caller-supplied path is checked against option injection by the shared
 *    `assertUsablePath` before argv is built.
 * 2. `getDuration` is mp4-only by contract, and the source's own comment said a
 *    caller could reach it with a webm path. The contract is now a branded
 *    parameter type plus a container check against ffprobe's own answer.
 */

import {
  assertUsablePath,
  FFPROBE_BINARY,
  type MediaDeps,
  ProcessExecutionError,
} from "./process-runner.ts"
import { parseDurationMs, type Resolution } from "./duration.ts"

/** One entry of ffprobe's `side_data_list`. */
export interface FFProbeSideData {
  side_data_type?: string
  rotation?: number
}

/** One stream of ffprobe's `streams` array. ffprobe omits fields it has no value for. */
export interface FFProbeStream {
  /** Position in the array as ffprobe numbers it; not the value the code reads. */
  index?: number
  codec_type?: string
  codec_name?: string
  width?: number
  height?: number
  duration?: string
  /** Nominal frame rate, which differs from `avg_frame_rate` on variable-rate sources. */
  r_frame_rate?: string
  avg_frame_rate?: string
  side_data_list?: FFProbeSideData[]
  tags?: Record<string, string>
}

/** ffprobe's `format` object. */
export interface FFProbeFormat {
  filename?: string
  /** Number of streams in the container. */
  nb_streams?: number
  format_name?: string
  duration?: string
  /** File size in bytes, as a string. */
  size?: string
  tags?: Record<string, string>
}

/** `ffprobe -print_format json` output. */
export interface FFProbeOutput {
  format?: FFProbeFormat
  streams?: FFProbeStream[]
}

/** Video metadata for one file. */
export interface MediaMeta {
  /**
   * Duration in milliseconds, or `0` when this wrapper refuses to report one.
   *
   * `0` has two meanings, both deliberate, and neither is "ffprobe had nothing
   * to say":
   *
   * - **Still images** (`image2`, `png_pipe`, `jpg_pipe`, `webp_pipe`): ffprobe
   *   reports no duration at all, so `0` means "not applicable".
   * - **webm**: ffprobe *does* report `format.duration` for a completed webm —
   *   measured on ffmpeg 8.1.2, 3.008 s for a 3 s clip — but a webm from a live
   *   muxer (MediaRecorder, a streaming encoder) has no `Duration` element in
   *   its Segment Info, and the number ffprobe then prints is derived from the
   *   last cluster rather than from a header. The source's contract, kept here,
   *   is to convert to mp4 and measure with `getDuration` rather than return a
   *   duration that is sometimes wrong. The cost is a mandatory conversion even
   *   when the reported duration was fine; the benefit is that `0` never means
   *   "a duration that may be badly off".
   */
  durationMs: number
  /** ffprobe's `format_name`, e.g. `"mov,mp4,m4a,3gp,3g2,mj2"`. */
  format: string | null
  width: number
  height: number
  /** Display-matrix rotation in degrees, or `0`. */
  rotation: number
  /** ffprobe's rational frame rate, e.g. `"30/1"`. */
  framerate: string | null
}

const JSON_PROBE_ARGS = [
  "-v",
  "error",
  "-show_format",
  "-show_streams",
  "-print_format",
  "json",
] as const

const AUDIO_DURATION_ARGS = [
  "-v",
  "0",
  "-hide_banner",
  "-of",
  "compact=p=0:nk=1",
  "-show_entries",
  "packet=pts_time",
  "-read_intervals",
  "99999%+#1000",
] as const

const IMAGE_ARGS = [
  "-v",
  "error",
  "-select_streams",
  "v:0",
  "-show_entries",
  "stream=width,height",
  "-of",
  "json",
] as const

declare const mp4Brand: unique symbol

/**
 * A path proven to point at an `.mp4` file.
 *
 * Only `asMp4Path` produces this type. `getDuration` accepts nothing else, so
 * passing a path that a caller cannot prove is mp4 is a compile error, not a
 * runtime throw three layers deep in a video job.
 */
export type Mp4Path = string & { readonly [mp4Brand]: "mp4" }

/** Whether a path carries an `.mp4` extension. Does not look at the file. */
export function isMp4Path(path: string): path is Mp4Path {
  return /\.mp4$/i.test(path)
}

/**
 * Brands a path as mp4, or throws.
 *
 * The extension check is the cheap half of the contract. `getDuration` also
 * checks ffprobe's `format_name`, so a `.mp4` that is really a webm — a
 * mislabelled upload, a failed conversion that kept the name — is still
 * rejected, with the container rather than only the name to go on.
 *
 * @throws {TypeError} when the path has no `.mp4` extension.
 */
export function asMp4Path(path: string): Mp4Path {
  if (!isMp4Path(path)) {
    throw new TypeError(`expected an .mp4 path, received ${JSON.stringify(path)}`)
  }
  return path
}

/**
 * Whether an ffprobe `format_name` denotes an mp4 family container.
 *
 * Bridges `getMeta`'s answer to the brand: `getMeta` reports the container it
 * found, and only when that container is mp4 may a caller brand the path for
 * `getDuration`.
 */
export function isMp4Format(format: string | null | undefined): boolean {
  return typeof format === "string" && format.includes("mp4")
}

async function runProbe(
  path: string,
  deps: MediaDeps,
  args: readonly string[],
): Promise<FFProbeOutput> {
  assertUsablePath(path)
  const argv = [deps.ffprobePath ?? FFPROBE_BINARY, ...args, path]
  const output = await deps.runner.run(argv)
  if (!output.success) {
    throw new ProcessExecutionError(`ffprobe failed for ${path}`, output, argv)
  }
  try {
    return JSON.parse(output.stdout) as FFProbeOutput
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error)
    throw new Error(`ffprobe returned invalid JSON for ${path}: ${message}`)
  }
}

/**
 * Picks the video stream to describe the file with.
 *
 * Ported heuristic: a `30/1` stream wins over the first video stream
 * (`helpers.ts:40-41`), which is what a file with both a 30 fps main video and
 * a lower-rate thumbnail track wants. The first video stream is the fallback.
 */
function pickVideoStream(streams: readonly FFProbeStream[]): FFProbeStream | null {
  const videoStreams = streams.filter((stream) => stream.codec_type === "video")
  return videoStreams.find((stream) => stream.avg_frame_rate === "30/1") ?? videoStreams[0] ?? null
}

/**
 * The duration to believe, in ms: the format's, else the shortest stream's.
 *
 * The source sorted the stream array in place to find the shortest
 * (`helpers.ts:28`); this does not mutate its input.
 */
function readDurationMs(probe: FFProbeOutput, streams: readonly FFProbeStream[]): number | null {
  const fromFormat = parseDurationMs(probe.format?.duration)
  if (fromFormat !== null) {
    return fromFormat
  }
  const fromStreams = streams
    .map((stream) => parseDurationMs(stream.duration))
    .filter((value): value is number => value !== null)
  return fromStreams.length === 0 ? null : Math.min(...fromStreams)
}

function readRotation(probe: FFProbeOutput, stream: FFProbeStream): number {
  const displayMatrix = stream.side_data_list?.find(
    (sideData) => sideData.side_data_type === "Display Matrix",
  )
  if (displayMatrix?.rotation) {
    return displayMatrix.rotation
  }
  const streamTag = stream.tags?.rotate
  if (streamTag !== undefined) {
    const parsed = Number.parseInt(streamTag, 10)
    if (!Number.isNaN(parsed)) {
      return parsed
    }
  }
  const formatTag = probe.format?.tags?.rotate
  if (formatTag !== undefined) {
    const parsed = Number.parseInt(formatTag, 10)
    if (!Number.isNaN(parsed)) {
      return parsed
    }
  }
  return 0
}

/**
 * Containers whose ffprobe `format.duration` this wrapper refuses to report.
 *
 * Two categories with different reasons — see `MediaMeta.durationMs`:
 *
 * - **Still images** genuinely have no duration to read.
 * - **`webm`** does have one, and this entry is a deliberate policy, not an
 *   ffprobe limitation: a completed webm reports its duration correctly
 *   (measured: 3.008 s for a 3 s clip on ffmpeg 8.1.2), but a webm written by a
 *   live muxer has no `Duration` element, so the value cannot be trusted on
 *   sight. The source had the same policy (`helpers.ts:70-72`, with its note at
 *   `helpers.ts:33-35`); it stays here, and the price is that a caller converts
 *   to mp4 and uses `getDuration` even when the duration was available.
 *
 * The source listed `webm`, `png_pipe` and `jpg_pipe`, and threw
 * `"duration could not be detected"` for everything else. Two of those three
 * names do not describe the files a caller actually passes: ffprobe 8.1.2
 * reports `image2` for a `.jpg` file and `webp_pipe` for a `.webp`, so a still
 * image reached the throwing branch. `_pipe` names appear only for piped input,
 * which is why the source's checks missed real files. The still-image demuxers
 * are listed explicitly instead of by suffix.
 */
const UNTRUSTED_DURATION_FORMATS = [
  "webm",
  "png_pipe",
  "jpg_pipe",
  "jpeg_pipe",
  "webp_pipe",
  "image2",
  "image2pipe",
] as const

function lacksDuration(format: string | null): boolean {
  return format === null ||
    UNTRUSTED_DURATION_FORMATS.some((untrusted) => format.includes(untrusted))
}

/**
 * Reads container, video dimensions, rotation, frame rate and duration.
 *
 * @throws {ProcessExecutionError} when ffprobe exits non-zero.
 * @throws {Error} when the file has no video stream, no dimensions, or a
 * duration that cannot be parsed for a container that should carry one.
 */
export async function getMeta(path: string, deps: MediaDeps): Promise<MediaMeta> {
  const probe = await runProbe(path, deps, JSON_PROBE_ARGS)
  const streams = probe.streams ?? []
  const video = pickVideoStream(streams)
  if (video === null) {
    throw new Error(`no video stream found in ${path}`)
  }
  const width = Number(video.width)
  const height = Number(video.height)
  if (!width || !height) {
    throw new Error(`no width or height found in ${path}`)
  }

  const format = probe.format?.format_name ?? null
  let durationMs = 0
  if (!lacksDuration(format)) {
    const parsed = readDurationMs(probe, streams)
    if (parsed === null) {
      throw new Error(`duration could not be detected in ${path}`)
    }
    durationMs = parsed
  }

  return {
    durationMs,
    format,
    width,
    height,
    rotation: readRotation(probe, video),
    framerate: video.avg_frame_rate ?? null,
  }
}

/**
 * Duration of an mp4 file, in milliseconds.
 *
 * **mp4 only.** The source threw `"File must converted mp4 to get correct
 * duration"` for anything else (`helpers.ts:100-102`) while its own call sites
 * could hand it a webm that had not been converted yet — a bug that surfaced as
 * a thrown error mid-job rather than as a compile error. The brand makes it a
 * compile error: `getDuration("clip.webm", deps)` does not type-check, and
 * `asMp4Path("clip.webm")` throws before ffprobe is ever spawned.
 *
 * @throws {Error} when ffprobe reports a non-mp4 container, no video stream or
 * no dimensions.
 */
export async function getDuration(mp4Path: Mp4Path, deps: MediaDeps): Promise<number> {
  const probe = await runProbe(mp4Path, deps, JSON_PROBE_ARGS)
  const format = probe.format?.format_name ?? null
  if (!isMp4Format(format)) {
    throw new Error(
      `getDuration needs an mp4 container, but ${mp4Path} is ${format ?? "of unknown format"}`,
    )
  }
  const streams = probe.streams ?? []
  const video = pickVideoStream(streams)
  if (video === null) {
    throw new Error(`no video stream found in ${mp4Path}`)
  }
  if (!Number(video.width) || !Number(video.height)) {
    throw new Error(`no width or height found in ${mp4Path}`)
  }
  const parsed = readDurationMs(probe, streams)
  if (parsed === null) {
    throw new Error(`duration could not be detected in ${mp4Path}`)
  }
  return parsed
}

/**
 * One field of an ffprobe `-show_entries` line as ffprobe prints it: a decimal
 * number, with an optional sign and exponent, and **nothing else**.
 *
 * Anchored deliberately. `Number("5.015510|")` is `NaN` and `Number("5.015510x")`
 * is `NaN`, so an unanchored or lenient read (`parseFloat`) either discards a
 * real value or accepts a truncated one; both are worse than saying which field
 * this parser could not read.
 */
const PACKET_FIELD_VALUE = /^[+-]?(?:\d+(?:\.\d*)?|\.\d+)(?:[eE][+-]?\d+)?$/

/** A section marker of the default writer: `[PACKET]`, `[SIDE_DATA]`, `[/SIDE_DATA]`. */
const SECTION_MARKER = /^\[.*\]$/

/** The key the default writer puts in front of a value, e.g. `pts_time=5.015510`. */
const KEY_PREFIX = /^[A-Za-z_][A-Za-z0-9_]*=/

/**
 * Last packet presentation time of an audio file, in milliseconds.
 *
 * ffprobe is asked to start reading at ~27 h and to return at most 1000
 * packets, so the answer is the file's end for any realistic track. The source
 * ran `parseFloat` over the whole stdout (`helpers.ts:125`), which reads the
 * *first* number of the response and is only right because of that seek; an
 * empty response (a track shorter than the seek window, a wrong path) became
 * `NaN` and propagated into every duration arithmetic downstream. This reads
 * every value in the response and returns the last one, and throws when there
 * is none.
 *
 * Parsing rule, pinned line by line in `ffprobe.test.ts`. ffprobe's two writers
 * are both read, because the punctuation differs and the numbers do not:
 *
 * - Lines end with `\n`, `\r\n` or `\r`. A blank line and the default writer's
 *   section markers carry no value and are skipped.
 * - A line is split on `|`, the compact writer's field separator. It also
 *   *trails* the last field of a packet whose `[SIDE_DATA]` section has no
 *   selected field — measured on ffmpeg 8.1.2, every mp3 packet prints
 *   `5.015510|` (its Skip Samples side data), the tail packet of an opus file
 *   prints `4.993500|` (its end trim), while aac and flac print bare numbers.
 *   Empty fields are dropped, which is what makes the trailing separator
 *   harmless.
 * - `N/A`, ffprobe's own sentinel for a field it has no value for, is skipped:
 *   `ffprobe -of compact=p=0:nk=1 -show_entries packet=pts_time` on a raw h264
 *   elementary stream answers `N/A` per packet. Under this wrapper's far seek
 *   that same file produces no line at all, so the sentinel is defence in
 *   depth — and it is still not a duration: no timestamp means the error below.
 * - What is left is one value, with the default writer's `pts_time=` prefix
 *   stripped. A field that is none of the above — the separator left inside a
 *   value, a truncated number, an entry this argv never asked for — throws
 *   rather than being dropped in silence: dropping fields in silence is exactly
 *   what made this function throw on every real ffprobe run.
 *
 * @throws {ProcessExecutionError} when ffprobe exits non-zero.
 * @throws {Error} when ffprobe returns no packet time, or a field that is not a number.
 */
export async function getAudioDuration(path: string, deps: MediaDeps): Promise<number> {
  assertUsablePath(path)
  const argv = [deps.ffprobePath ?? FFPROBE_BINARY, ...AUDIO_DURATION_ARGS, "-i", path]
  const output = await deps.runner.run(argv)
  if (!output.success) {
    throw new ProcessExecutionError(`ffprobe failed for ${path}`, output, argv)
  }
  let last: number | null = null
  for (const rawLine of output.stdout.split(/\r\n|\n|\r/)) {
    const line = rawLine.trim()
    if (line === "" || SECTION_MARKER.test(line)) {
      continue
    }
    for (const rawField of line.split("|")) {
      const field = rawField.trim().replace(KEY_PREFIX, "")
      if (field === "" || field === "N/A") {
        continue
      }
      if (!PACKET_FIELD_VALUE.test(field)) {
        throw new Error(
          `ffprobe returned a packet field that is not a timestamp for ${path}: ${
            JSON.stringify(field)
          }`,
        )
      }
      last = Number(field)
    }
  }
  if (last === null) {
    throw new Error(`no packet timestamps returned for ${path}`)
  }
  return Math.round(last * 1000)
}

/**
 * Image dimensions, rounded down to even numbers.
 *
 * Replaces the source's `image-size` dependency
 * (`roley/src/lib/server/imagesUtils.ts`-adjacent `getImageDimensions` used
 * npm `image-size`) with ffprobe, which is already required for everything else
 * in this package. The source's trailing behaviour is kept: an odd width or
 * height is reduced by one, because an odd dimension cannot be encoded as
 * `yuv420p` and the caller's next step is an ffmpeg encode.
 *
 * @throws {Error} when the file has no readable dimensions.
 */
export async function getImageDimensions(path: string, deps: MediaDeps): Promise<Resolution> {
  const probe = await runProbe(path, deps, IMAGE_ARGS)
  const width = Number(probe.streams?.[0]?.width)
  const height = Number(probe.streams?.[0]?.height)
  if (!width || !height) {
    throw new Error(`could not read image dimensions from ${path}`)
  }
  return {
    width: width % 2 === 0 ? width : width - 1,
    height: height % 2 === 0 ? height : height - 1,
  }
}
