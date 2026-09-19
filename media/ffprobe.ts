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
 *    (`helpers.ts:37,96,123`). Every call here is an argv array.
 * 2. `getDuration` is mp4-only by contract, and the source's own comment said a
 *    caller could reach it with a webm path. The contract is now a branded
 *    parameter type plus a container check against ffprobe's own answer.
 */

import { FFPROBE_BINARY, type MediaDeps, ProcessExecutionError } from "./process-runner.ts"
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
   * Duration in milliseconds, or `0` for a container that does not carry one.
   *
   * ffprobe reports no usable duration for the `webm`, `png_pipe` and
   * `jpg_pipe` formats here — the source's own note said so
   * (`helpers.ts:33-35`) and kept the zero. A webm must be converted first and
   * measured with `asMp4Path` + `getDuration`.
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

/**
 * Rejects a media path ffprobe would read as an option.
 *
 * argv already removes shell interpretation, but ffprobe parses its own option
 * list, so a path beginning with `-` is still an injection into the command
 * line. A NUL byte cannot be passed to `execve` either.
 */
function assertUsablePath(path: string): void {
  if (path.startsWith("-")) {
    throw new TypeError(`media path must not start with "-": ${JSON.stringify(path)}`)
  }
  if (path.includes("\0")) {
    throw new TypeError("media path must not contain a NUL byte")
  }
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
 * Containers whose ffprobe `format.duration` is unusable.
 *
 * The source skipped `webm`, `png_pipe` and `jpg_pipe` (`helpers.ts:70-72`) and
 * threw `"duration could not be detected"` for everything else. Two of those
 * three names do not describe the files a caller actually passes: ffprobe
 * 8.1.2 reports `image2` for a `.jpg` file and `webp_pipe` for a `.webp`, so a
 * still image reached the throwing branch. `_pipe` names appear only for piped
 * input, which is why the source's checks missed real files. The still-image
 * demuxers are listed explicitly instead of by suffix.
 */
const DURATIONLESS_FORMATS = [
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
    DURATIONLESS_FORMATS.some((durationless) => format.includes(durationless))
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
 * Last packet presentation time of an audio file, in milliseconds.
 *
 * ffprobe is asked to start reading at ~27 h and to return at most 1000
 * packets, so the answer is the file's end for any realistic track. The source
 * ran `parseFloat` over the whole stdout (`helpers.ts:125`), which reads the
 * *first* number of the response and is only right because of that seek; an
 * empty response (a track shorter than the seek window, a wrong path) became
 * `NaN` and propagated into every duration arithmetic downstream. This parses
 * every line and returns the last finite value, and throws when there is none.
 *
 * @throws {ProcessExecutionError} when ffprobe exits non-zero.
 * @throws {Error} when ffprobe returns no packet time.
 */
export async function getAudioDuration(path: string, deps: MediaDeps): Promise<number> {
  assertUsablePath(path)
  const argv = [deps.ffprobePath ?? FFPROBE_BINARY, ...AUDIO_DURATION_ARGS, "-i", path]
  const output = await deps.runner.run(argv)
  if (!output.success) {
    throw new ProcessExecutionError(`ffprobe failed for ${path}`, output, argv)
  }
  let last: number | null = null
  for (const line of output.stdout.split(/\r\n|\n|\r/)) {
    const value = Number(line.trim())
    if (line.trim() !== "" && Number.isFinite(value)) {
      last = value
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
