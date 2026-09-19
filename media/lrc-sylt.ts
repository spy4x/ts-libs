/**
 * LRC → ID3 SYLT.
 *
 * Extracted from `lyrics-populator/src/metadata.ts:334-355` (`parseLrcToSylt`),
 * which fed node-id3's `synchronisedLyrics` frame. The Vorbis scanner/writer
 * that lived beside it is deliberately not ported — the extraction issue
 * records it as silently corrupting payloads over 65,025 bytes.
 *
 * Differences from the source, each a bug found while porting:
 *
 * - The timestamp regex was not global, so a line carrying several timestamps
 *   (`[00:01.00][00:05.00]chorus`) produced one entry and left the other tags
 *   glued to the text. Both are handled now.
 * - `timeStampFormat` was `1`, which ID3v2.4 §4.9 defines as *MPEG frames*,
 *   while the values written were milliseconds. The correct value for
 *   milliseconds is `2`; a player honouring the declared format read the whole
 *   lyric sheet at the wrong speed.
 * - A byte-order mark is stripped. A BOM does not break the tag match, but it
 *   does end up inside the first entry's text on some producers.
 * - The `[offset:±ms]` tag is honoured. It is what the format uses to shift a
 *   whole sheet, and ignoring it put every line out by that amount.
 */

/** ID3v2.4 §4.9 time stamp format. */
export enum SyltTimestampFormat {
  /** `1` — the value is a count of MPEG frames. */
  MPEG_FRAMES = 1,
  /** `2` — the value is a count of milliseconds. */
  MILLISECONDS = 2,
}

/** One synchronized lyric line. */
export interface SyltEntry {
  text: string
  /** Milliseconds from the start of the recording. */
  timeStamp: number
}

/** An ID3 SYLT frame, in the shape tag writers expect. */
export interface SyltTag {
  /** ISO-639-2 language code. */
  language: string
  timeStampFormat: SyltTimestampFormat
  content: SyltEntry[]
}

/** Parsing options. */
export interface ParseLrcOptions {
  /**
   * Language code for the frame. Defaults to an `[la:…]` tag in the file, then
   * to `"eng"` — the source's hardcoded value.
   */
  language?: string
}

/** Language used when neither the option nor the file says. */
export const DEFAULT_SYLT_LANGUAGE = "eng"

/**
 * A fresh timestamp pattern per use.
 *
 * A module-level `/g` regex carries `lastIndex` between calls, which turns
 * `matchAll`/`replace` into order-dependent code. Minting one per call removes
 * the shared state instead of remembering to reset it.
 */
function timestampPattern(): RegExp {
  return /\[(\d{1,3}):(\d{1,2})(?:[.:](\d{1,4}))?\]/g
}

/**
 * Converts an LRC fractional part to milliseconds.
 *
 * LRC writes the fraction *of a second*, so the digits are left-aligned:
 * `[00:01.5]` is 1.5 s, not 1 s and 5 ms. Two digits are centiseconds, three
 * are milliseconds; anything longer is truncated, anything shorter padded.
 */
function fractionToMilliseconds(fraction: string | undefined): number {
  return Number((fraction ?? "").padEnd(3, "0").slice(0, 3))
}

function readOffsetMs(text: string): number {
  const match = /\[offset:\s*([+-]?\d+)\s*\]/i.exec(text)
  return match ? Number(match[1]) : 0
}

function readLanguage(text: string): string | null {
  const match = /\[la:\s*([A-Za-z]{2,3}(?:-[A-Za-z0-9]+)?)\s*\]/.exec(text)
  return match ? match[1] : null
}

/**
 * Parses an LRC lyric sheet into an ID3 SYLT frame.
 *
 * Accepts the common variants: `\n` or `\r\n` line endings, `[mm:ss.xx]`,
 * `[mm:ss.xxx]` and `[mm:ss:xx]` timestamps, several timestamps on one line,
 * and metadata tags (`[ti:]`, `[ar:]`, `[al:]`, `[by:]`, `[length:]`, `[la:]`,
 * `[offset:]`) which are not lyrics entries.
 *
 * Entries come back sorted by timestamp, because a SYLT frame is consumed as a
 * timeline: a sheet whose lines were interleaved or out of order would otherwise
 * be indexed wrongly by a player.
 *
 * @returns the frame, or `null` when the text carries no timestamped line.
 */
export function parseLrcToSylt(lrc: string, options: ParseLrcOptions = {}): SyltTag | null {
  const text = lrc.replace(/^\uFEFF/, "")
  const offsetMs = readOffsetMs(text)
  const entries: SyltEntry[] = []

  for (const line of text.split(/\r\n|\n|\r/)) {
    const stamps = [...line.matchAll(timestampPattern())]
    if (stamps.length === 0) {
      // Metadata tag, blank line or prose — none of them is a lyric line.
      continue
    }
    const content = line.replace(timestampPattern(), "").trim()
    if (content === "") {
      // A timestamp with no text is a gap marker, not a syllable to display.
      continue
    }
    for (const stamp of stamps) {
      const timeStamp = Number(stamp[1]) * 60_000 + Number(stamp[2]) * 1000 +
        fractionToMilliseconds(stamp[3])
      entries.push({ text: content, timeStamp: Math.max(0, timeStamp + offsetMs) })
    }
  }

  if (entries.length === 0) {
    return null
  }

  return {
    language: options.language ?? readLanguage(text) ?? DEFAULT_SYLT_LANGUAGE,
    timeStampFormat: SyltTimestampFormat.MILLISECONDS,
    content: entries.sort((left, right) => left.timeStamp - right.timeStamp),
  }
}
