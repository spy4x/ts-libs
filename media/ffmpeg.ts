/**
 * ffmpeg wrappers: thumbnail extraction and a run that reports progress.
 *
 * Extracted from `roley/src/lib/server/video-processing/helpers.ts`
 * (`makeThumbnail`, `processConcatenation`) and
 * `lyrics-populator/src/metadata.ts` (the `-attach` cover-art ffmpeg call).
 * The concatenation *pipeline* is deliberately not here — see `README.md`.
 */

import { formatDurationParam } from "./duration.ts"
import { createFfmpegProgressParser, type FfmpegProgressEvent } from "./progress-parse.ts"
import {
  assertUsablePath,
  FFMPEG_BINARY,
  type MediaDeps,
  ProcessExecutionError,
  type ProcessOutput,
} from "./process-runner.ts"

/** Wiring for one thumbnail. */
export interface ThumbnailOptions {
  /** Source media path. */
  input: string
  /**
   * Output path, which must end in `.webp`.
   *
   * ffmpeg picks the muxer from the extension, so the check is what keeps a
   * `.png`-named file from arriving as webp bytes.
   */
  output: string
  /** Seek position before the extracted frame. Defaults to 1.3 s, as in the source. */
  atMs?: number
}

/** Default seek position: 1.3 s in, past a fade-in and a black first frame. */
export const DEFAULT_THUMBNAIL_AT_MS = 1300

/**
 * Builds ffmpeg's argv for a thumbnail.
 *
 * Pure, so the argument shape is testable without a process. Three deliberate
 * differences from the source's shell string
 * (`helpers.ts:197`):
 *
 * - `-y`: the source had no overwrite flag, so a second thumbnail for the same
 *   path made ffmpeg ask "Overwrite? [y/N]" on stdin and abort (or hang when
 *   something inherited a terminal). An overwrite prompt has no place in a
 *   server-side wrapper.
 * - `-nostdin`: belt and braces for the same class, and it keeps ffmpeg from
 *   competing with the caller for the process's stdin.
 * - The output path is the caller's, not a shared constant. The source wrote
 *   every thumbnail in the process to `/tmp/videos/thumbnail.webp`
 *   (`helpers.ts:196`), so two concurrent jobs silently overwrote each other's
 *   output — the same path-derived-naming bug class as
 *   `helpers.ts:270`.
 *
 * `-ss` stays after `-i`, which decodes-and-discards rather than seeking
 * instantly: slower, but the source's behaviour and the accurate one.
 *
 * Both paths go through `assertUsablePath` before argv exists. Which of the two
 * guards is load-bearing was measured on ffmpeg 8.1.2, and they differ:
 *
 * - **Output — genuinely injectable.** `-y.webp` reached argv and ffmpeg
 *   answered `Unrecognized option 'y.webp'` with exit 8: a caller-supplied path
 *   had become a command-line flag.
 * - **Input — defence in depth, not the live vector.** ffmpeg consumes the token
 *   after `-i` as a filename whatever it starts with: `-i -y.webp` exits 254,
 *   `Error opening input file -y.webp`. The guard is kept anyway — the slot is
 *   one option-reordering away from being an option list, and a filename ffmpeg
 *   will never open deserves the caller's own diagnostic. The same distinction
 *   holds in `ffprobe.ts:374` (`getAudioDuration`), where the path lands in a
 *   trailing option slot and `-read_intervals` does reach ffprobe as an option —
 *   exit 1, `Missing argument for option 'read_intervals'`.
 * - **NUL byte — neither, and not ffmpeg's business.** `Deno.Command` throws its
 *   own `nul byte found in provided data` from inside the spawn, naming neither
 *   the argument nor the caller, so the check keeps that failure ours.
 *
 * @throws {TypeError} when either path begins with `-` or contains a NUL byte,
 * or when the output is not `.webp`. Thrown before any process is created.
 */
export function buildThumbnailArgv(
  options: ThumbnailOptions,
  ffmpegPath: string = FFMPEG_BINARY,
): string[] {
  assertUsablePath(options.input, "thumbnail input")
  assertUsablePath(options.output, "thumbnail output")
  if (!options.output.toLowerCase().endsWith(".webp")) {
    throw new TypeError(`thumbnail output must end in .webp, received ${options.output}`)
  }
  const atMs = options.atMs ?? DEFAULT_THUMBNAIL_AT_MS
  return [
    ffmpegPath,
    "-hide_banner",
    "-nostdin",
    "-y",
    "-i",
    options.input,
    "-ss",
    formatDurationParam(atMs),
    "-vframes",
    "1",
    options.output,
  ]
}

/**
 * Extracts one webp thumbnail.
 *
 * @returns the output path, so a caller can chain it.
 * @throws {TypeError} when either path could be read as an ffmpeg option, or
 * when the output path is not `.webp` — both before any process is created.
 * @throws {ProcessExecutionError} when ffmpeg exits non-zero.
 */
export async function makeThumbnail(options: ThumbnailOptions, deps: MediaDeps): Promise<string> {
  const argv = buildThumbnailArgv(
    options,
    deps.ffmpegPath ?? FFMPEG_BINARY,
  )
  const output = await deps.runner.run(argv)
  if (!output.success) {
    throw new ProcessExecutionError(
      `ffmpeg could not extract a thumbnail from ${options.input}`,
      output,
      argv,
    )
  }
  return options.output
}

/** Wiring for one progress-reporting ffmpeg run. */
export interface ProgressRunOptions {
  /**
   * Full ffmpeg argv. It must ask for progress on a pipe
   * (`-progress pipe:1`), which only the caller can place correctly among its
   * own options.
   */
  argv: readonly string[]
  /**
   * Input duration in milliseconds, used for the percentage. `null` leaves
   * every `percent` at `null`.
   */
  totalDurationMs?: number | null
  /** Called for every parsed progress event. */
  onProgress?: (event: FfmpegProgressEvent) => void
  /** Called for every stderr line; ffmpeg's diagnostics are otherwise only in `output.stderr`. */
  onStderrLine?: (line: string) => void
}

/** Result of a progress-reporting run. */
export interface ProgressRunResult {
  output: ProcessOutput
  /** Every event seen, in order, including the final one. */
  events: FfmpegProgressEvent[]
  /** Last non-null percentage, or `null` when ffmpeg never reported one. */
  lastPercent: number | null
}

function assertProgressOnPipe(argv: readonly string[]): void {
  const index = argv.indexOf("-progress")
  const destination = index === -1 ? "" : argv[index + 1] ?? ""
  if (!destination.startsWith("pipe:")) {
    throw new TypeError(
      `argv must request progress on a pipe, e.g. "-progress pipe:1"; received ${
        JSON.stringify(argv)
      }`,
    )
  }
}

function lastPercentOf(events: readonly FfmpegProgressEvent[]): number | null {
  for (let index = events.length - 1; index >= 0; index -= 1) {
    const percent = events[index].percent
    if (percent !== null) {
      return percent
    }
  }
  return null
}

/**
 * Runs ffmpeg to completion, turning its `-progress` stream into typed events.
 *
 * Replaces `processConcatenation`'s raw `data.toString().match(/Progress: (\d+)%/)`
 * regex over a precompiled binary's stdout (`helpers.ts:253-267`), including
 * its clamp to 100 — ffmpeg over-reports, and so did that binary.
 *
 * @throws {TypeError} when `argv` does not request progress on a pipe.
 * @throws {ProcessExecutionError} when ffmpeg exits non-zero. Events parsed up
 * to that point are still delivered to `onProgress`.
 */
export async function runWithProgress(
  options: ProgressRunOptions,
  deps: MediaDeps,
): Promise<ProgressRunResult> {
  assertProgressOnPipe(options.argv)
  const parser = createFfmpegProgressParser({
    totalDurationMs: options.totalDurationMs ?? null,
  })
  const events: FfmpegProgressEvent[] = []
  const record = (event: FfmpegProgressEvent | null): void => {
    if (event === null) {
      return
    }
    events.push(event)
    options.onProgress?.(event)
  }

  const output = await deps.runner.stream(options.argv, {
    onStdoutLine: (line) => record(parser.push(line)),
    onStderrLine: options.onStderrLine,
  })
  // A process killed mid-block still reported a sample worth keeping.
  record(parser.flush())

  if (!output.success) {
    throw new ProcessExecutionError(
      `ffmpeg run failed: ${options.argv.join(" ")}`,
      output,
      options.argv,
    )
  }

  return { output, events, lastPercent: lastPercentOf(events) }
}
