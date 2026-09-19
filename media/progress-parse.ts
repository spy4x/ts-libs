/**
 * Parses ffmpeg's `-progress` key/value stream into typed progress events.
 *
 * ffmpeg writes one block of `key=value` lines per reporting interval and
 * terminates every block with `progress=continue`, or `progress=end` on the
 * last block:
 *
 * ```
 * frame=10
 * fps=0.00
 * bitrate=N/A
 * total_size=N/A
 * out_time_us=800000
 * out_time_ms=800000
 * out_time=00:00:00.800000
 * speed=60.8x
 * progress=end
 * ```
 *
 * A block is emitted as one event when its terminator arrives, not once per
 * line, so a consumer renders a coherent sample. Unmodelled keys are kept in
 * `raw` instead of being dropped, which is what makes the parser survive an
 * ffmpeg release that adds one.
 */

/**
 * Truncates a percentage into `0..100`.
 *
 * ffmpeg over-reports: `out_time` is the time the *output* has reached, which
 * for a filtered or re-timed encode can exceed the reported input duration, and
 * a resumed `-ss` seek makes the first block jump. A progress bar must not
 * render outside its track, and a negative reported time must not render as a
 * negative bar, so both ends are clamped here rather than at every consumer.
 */
export function clampPercent(value: number): number {
  if (!Number.isFinite(value)) {
    return 0
  }
  return Math.min(100, Math.max(0, value))
}

/** Which block closed. */
export enum FfmpegProgressKind {
  /** `progress=continue` — more work to do. */
  SAMPLE = 1,
  /** `progress=end` — ffmpeg finished writing the output. */
  END = 2,
}

/** Values a progress block reports, normalized to numbers where they are one. */
export interface FfmpegProgressFields {
  frame: number | null
  fps: number | null
  /** `bitrate=1234.5kbits/s` → `1234.5`; `N/A` → `null`. */
  bitrateKbps: number | null
  totalSizeBytes: number | null
  /** Media time already written, in milliseconds. */
  outTimeMs: number | null
  /** `speed=1.02x` → `"1.02x"`, kept verbatim. */
  speed: string | null
  /** Every key of the block, including the ones this parser does not model. */
  raw: Readonly<Record<string, string>>
}

/** A mid-run block. `percent` is `null` while the total duration is unknown. */
export interface FfmpegProgressSample extends FfmpegProgressFields {
  kind: FfmpegProgressKind.SAMPLE
  percent: number | null
}

/**
 * The final block.
 *
 * `percent` is pinned to `100` rather than derived: a `progress=end` block
 * reports the time ffmpeg finished writing, which for a trimmed or filtered
 * encode is legitimately shorter than the input, and reporting 96% on a
 * finished job makes a UI look stuck.
 */
export interface FfmpegProgressEnd extends FfmpegProgressFields {
  kind: FfmpegProgressKind.END
  percent: number
}

/** One parsed progress event. */
export type FfmpegProgressEvent = FfmpegProgressSample | FfmpegProgressEnd

/** Parser wiring. */
export interface FfmpegProgressParserOptions {
  /**
   * Duration of the input in milliseconds, used for the percentage.
   * `null`/`undefined`/`0` means unknown, and then `percent` stays `null`.
   */
  totalDurationMs?: number | null
}

/** Stateful line-by-line parser for one ffmpeg process. */
export interface FfmpegProgressParser {
  /** Feeds one line; returns an event when that line closed a block. */
  push(line: string): FfmpegProgressEvent | null
  /** Emits the block under construction — an ffmpeg killed mid-block leaves one. */
  flush(): FfmpegProgressEvent | null
}

function readInteger(value: string | undefined): number | null {
  if (value === undefined || !/^-?\d+$/.test(value.trim())) {
    return null
  }
  return Number(value.trim())
}

function readDecimal(value: string | undefined): number | null {
  if (value === undefined || !/^-?\d+(?:\.\d+)?$/.test(value.trim())) {
    return null
  }
  return Number(value.trim())
}

/** `1234.5kbits/s` → `1234.5`; `N/A` and anything unparseable → `null`. */
function readBitrateKbps(value: string | undefined): number | null {
  if (value === undefined) {
    return null
  }
  const match = /^(-?\d+(?:\.\d+)?)kbits\/s$/.exec(value.trim())
  return match ? Number(match[1]) : null
}

/** Parses ffmpeg's `HH:MM:SS.ffffff` form into milliseconds. */
export function parseOutTime(value: string): number | null {
  const match = /^(\d+):(\d{1,2}):(\d{1,2})(?:\.(\d{1,6}))?$/.exec(value.trim())
  if (!match) {
    return null
  }
  const fraction = (match[4] ?? "").padEnd(3, "0").slice(0, 3)
  return (
    Number(match[1]) * 3_600_000 +
    Number(match[2]) * 60_000 +
    Number(match[3]) * 1000 +
    Number(fraction)
  )
}

/**
 * Reads the elapsed media time of a block, in milliseconds.
 *
 * `out_time_us` wins. Its sibling `out_time_ms` is **microseconds too** despite
 * the name — ffmpeg writes the same `int64` into both fields — so treating it
 * as milliseconds would scale every percentage by 1000. Verified against the
 * binary on this machine, ffmpeg 8.1.2, for a 0.8 s frame:
 * `out_time_us=800000` and `out_time_ms=800000`. `out_time` is the
 * locale-independent fallback.
 */
export function readOutTimeMs(fields: Record<string, string>): number | null {
  const micros = readInteger(fields["out_time_us"]) ?? readInteger(fields["out_time_ms"])
  if (micros !== null) {
    return Math.floor(micros / 1000)
  }
  const outTime = fields["out_time"]
  return outTime === undefined ? null : parseOutTime(outTime)
}

/**
 * Creates a parser for one ffmpeg process.
 *
 * Expects the caller to have asked ffmpeg for progress
 * (`-progress pipe:1`); the wrapper does not inject the flag because it has to
 * be placed among ffmpeg's own options, which only the caller's argv knows how
 * to do.
 */
export function createFfmpegProgressParser(
  options: FfmpegProgressParserOptions = {},
): FfmpegProgressParser {
  const totalDurationMs = options.totalDurationMs ?? null
  let block: Record<string, string> = {}

  const toFields = (): FfmpegProgressFields => ({
    frame: readInteger(block["frame"]),
    fps: readDecimal(block["fps"]),
    bitrateKbps: readBitrateKbps(block["bitrate"]),
    totalSizeBytes: readInteger(block["total_size"]),
    outTimeMs: readOutTimeMs(block),
    speed: block["speed"] ?? null,
    raw: { ...block },
  })

  const toEvent = (end: boolean): FfmpegProgressEvent => {
    const fields = toFields()
    block = {}
    if (end) {
      return { ...fields, kind: FfmpegProgressKind.END, percent: 100 }
    }
    const percent = totalDurationMs !== null && totalDurationMs > 0 && fields.outTimeMs !== null
      ? clampPercent((fields.outTimeMs / totalDurationMs) * 100)
      : null
    return { ...fields, kind: FfmpegProgressKind.SAMPLE, percent }
  }

  return {
    push(line: string): FfmpegProgressEvent | null {
      const separator = line.indexOf("=")
      if (separator <= 0) {
        return null
      }
      const key = line.slice(0, separator).trim()
      const value = line.slice(separator + 1).trim()
      if (key === "progress") {
        // A block is complete; the value is `continue` or `end`. Anything else
        // is treated as `continue` so an unknown terminator still yields a
        // sample instead of swallowing the block.
        return toEvent(value === "end")
      }
      block[key] = value
      return null
    },

    flush(): FfmpegProgressEvent | null {
      if (Object.keys(block).length === 0) {
        return null
      }
      // No `progress=` line will arrive: a process that died mid-block still
      // reported a usable sample.
      const event = toEvent(false)
      return event
    },
  }
}
