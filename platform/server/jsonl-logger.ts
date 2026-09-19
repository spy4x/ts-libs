/**
 * Append-only JSONL event log.
 *
 * One JSON object per line, appended and never rewritten. The point of the format is that a
 * crashed writer corrupts at most the final line, and every earlier line still parses — so a
 * reader must tolerate a trailing partial line rather than discarding the file.
 *
 * The port exposes no append primitive: appending is read-modify-write of the whole file, which
 * for a log is the honest trade at test scale. A production writer that needs true append should
 * supply a port backed by an `O_APPEND` descriptor.
 */

import { dirname } from "@std/path"

import type { ClockPort, FileSystemPort } from "./ports.ts"

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
  readonly #clock: ClockPort
  #tail: Promise<void> = Promise.resolve()

  constructor(fs: FileSystemPort, path: string, clock: ClockPort) {
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
      const existing = await this.#fs.readText(this.#path) ?? ""
      await this.#fs.writeText(this.#path, existing + line)
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
