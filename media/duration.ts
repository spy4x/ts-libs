/**
 * Duration parsing and formatting, plus the rotation-aware resolution helper.
 *
 * Extracted from `roley/src/lib/server/video-processing/helpers.ts`.
 */

/** Width/height pair. */
export interface Resolution {
  width: number
  height: number
}

/** A resolution plus the display-matrix rotation reported by ffprobe. */
export interface RotatedResolution extends Resolution {
  rotation: number
}

/**
 * Parses an ffprobe value in seconds into whole milliseconds.
 *
 * The extracted source read `format.duration`, assumed exactly six fractional
 * digits and ran `durationStr.slice(0, -3)`
 * (`roley/.../helpers.ts:75` and `:114`). ffprobe does not guarantee six
 * digits: ffmpeg 8.1.2 prints `"10.000000"` for mp4, `"10.0"` for some
 * containers and `"10"` when the fraction rounds away. Against `"10.5"` the
 * old code produced `Number("10.") === 10` — a silent 500 ms error on input
 * that is valid, which shifted every downstream cut and concatenation.
 *
 * The fraction is padded/truncated to three digits instead, so six, three, two
 * and one fractional digits all land within 1 ms. Truncation (not rounding)
 * matches the source's intent and can never report a duration longer than the
 * media, which would push a seek past the end of the file.
 *
 * A comma is accepted as the decimal separator (`"10,5"`), the form some
 * locales and hand-written metadata produce. A comma is never treated as a
 * group separator here, because ffprobe never groups digits.
 *
 * @returns whole milliseconds, or `null` when the value is absent, empty or not
 * a finite non-negative number.
 */
export function parseDurationMs(value: string | number | null | undefined): number | null {
  if (typeof value === "number") {
    return Number.isFinite(value) && value >= 0 ? Math.floor(value * 1000) : null
  }
  if (typeof value !== "string") {
    return null
  }
  const match = /^(\d+)(?:[.,](\d*))?$/.exec(value.trim())
  if (!match) {
    return null
  }
  const fraction = (match[2] ?? "").padEnd(3, "0").slice(0, 3)
  return Number(match[1]) * 1000 + Number(fraction)
}

/**
 * Formats whole milliseconds as ffmpeg's `seconds.milliseconds` parameter form:
 * `120250` → `"120.250"`.
 *
 * The source (`roley/.../helpers.ts:210`) combined `Math.floor(ms / 1000)` with
 * `ms % 1000`, which yields the malformed `"-2.-500"` for negative input.
 * Negative offsets are real in video tooling (a lead-in trim starting before
 * t=0), so the sign is factored out and negatives format as `"-2.500"`.
 *
 * @throws {RangeError} when the value is not a finite number.
 */
export function formatDurationParam(durationMs: number): string {
  if (!Number.isFinite(durationMs)) {
    throw new RangeError(`durationMs must be a finite number, received ${durationMs}`)
  }
  const sign = durationMs < 0 ? "-" : ""
  const absolute = Math.floor(Math.abs(durationMs))
  return `${sign}${Math.floor(absolute / 1000)}.${String(absolute % 1000).padStart(3, "0")}`
}

/**
 * Returns the resolution a viewer actually sees.
 *
 * A display matrix rotating the frame by a quarter turn swaps the coded
 * dimensions. The source tested `rotation === -90 || rotation === 90`
 * (`roley/.../helpers.ts:223`), which misses the equivalent `-270`/`270` forms
 * that the same matrix decomposition produces; any odd multiple of 90 degrees
 * is handled here.
 */
export function getTrueResolution(media: RotatedResolution): Resolution {
  const swapsAxes = Math.abs(media.rotation) % 180 === 90
  return swapsAxes
    ? { width: media.height, height: media.width }
    : { width: media.width, height: media.height }
}
