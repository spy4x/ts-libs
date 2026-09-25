/**
 * Append-only JSONL event log.
 *
 * One JSON object per line, appended and never rewritten. The point of the format is that a
 * crashed writer corrupts at most the final line, and every earlier line still parses — so a
 * reader must tolerate a trailing partial line rather than discarding the file.
 *
 * Appending goes through {@link FileSystemPort}'s `appendText`, one filesystem-level write per
 * event. Earlier lines are never read back and never rewritten, so the promise this module's own
 * name makes — a crash corrupts at most the final line — actually holds: the previous revision
 * read the whole file and wrote it back with one more line, so a crash mid-write could lose the
 * entire log, and the cost of each append grew with the size of the log already on disk.
 *
 * @module
 */

import { dirname } from "@std/path"

import type { FileSystemPort } from "./ports.ts"
import type { Clock } from "../universal/time.ts"

/** One log record: the caller's event plus a timestamp. */
export type LogRecord = Record<string, unknown>

/**
 * Serialise a log record to one line, stamped with the clock at append time.
 *
 * The fields are spread after `ts`, so a caller that passes its own `ts` wins — useful for
 * replaying a captured log.
 */
export function formatLogLine(event: LogRecord, now: number): string {
  return `${JSON.stringify({ ts: new Date(now).toISOString(), ...event })}\n`
}

/**
 * Parse JSONL text, skipping blank lines and reporting the lines that do not parse.
 *
 * A partial final line is the expected outcome of a crash, so it is reported rather than thrown:
 * `{ lines }` is every record that parsed, and `{ invalid }` carries the 1-based line numbers and
 * raw text of the rest.
 */
export function parseLogLines(text: string): {
  lines: LogRecord[]
  invalid: { line: number; raw: string; reason: string }[]
} {
  const lines: LogRecord[] = []
  const invalid: { line: number; raw: string; reason: string }[] = []
  const rawLines = text.split("\n")
  for (let i = 0; i < rawLines.length; i++) {
    const raw = rawLines[i].trim()
    if (raw === "") continue
    try {
      const parsed: unknown = JSON.parse(raw)
      if (parsed !== null && typeof parsed === "object" && !Array.isArray(parsed)) {
        lines.push(parsed as LogRecord)
      } else {
        invalid.push({ line: i + 1, raw, reason: "not a JSON object" })
      }
    } catch (error) {
      invalid.push({
        line: i + 1,
        raw,
        reason: error instanceof Error ? error.message : String(error),
      })
    }
  }
  return { lines, invalid }
}

/** Append-only JSONL writer over a {@link FileSystemPort}. */
export class JsonlLogger {
  readonly #fs: FileSystemPort
  readonly #path: string
  readonly #clock: Clock
  #tail: Promise<void> = Promise.resolve()

  constructor(fs: FileSystemPort, path: string, clock: Clock) {
    this.#fs = fs
    this.#path = path
    this.#clock = clock
  }

  /**
   * Append one event.
   *
   * Writes are serialised through an internal promise chain, so two concurrent `append` calls
   * cannot interleave their read-modify-write. The returned promise settles when this event is
   * durably in the file, and rejects with **its own** failure.
   *
   * A failure does not poison the chain: `#tail` is always left as a resolved promise, so a caller
   * whose disk filled up once can append again on the next tick. Without that reset every later
   * append would inherit the first rejection forever and the log would never be written again.
   */
  append(event: LogRecord): Promise<void> {
    const line = formatLogLine(event, this.#clock.now())
    const attempt = this.#tail.then(async () => {
      await this.#fs.mkdirp(dirname(this.#path))
      await this.#fs.appendText(this.#path, line)
    })
    // Attach the chain to a handler that swallows the rejection, while `attempt` still rejects for
    // this caller. A bare `this.#tail = attempt` is what makes one failure permanent.
    this.#tail = attempt.catch(() => {})
    return attempt
  }

  /** Read the log back. Invalid lines are reported, not thrown. */
  async read(): Promise<ReturnType<typeof parseLogLines>> {
    const text = await this.#fs.readText(this.#path) ?? ""
    return parseLogLines(text)
  }
}
