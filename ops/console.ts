/**
 * One logging convention for the package.
 *
 * `rostok` carries two: `+lib.ts`'s `log`/`error`/`success` (timestamped, no
 * levels) and `offline-backup/src/helpers.ts`'s `ConsoleLogger` (no levels, and
 * it captures by *replacing the global `console` methods* for the duration of a
 * run). The second one is why this module exists: patching `console` is not
 * reentrant, has no way to restore the original objects after an unhandled
 * rejection, and makes the captured lines depend on every other module in the
 * process. The levelled, sink-injected logger wins.
 *
 * Nothing here reads the process environment, the clock or a stream at module
 * scope: the clock and both sinks are injected, so a test asserts an exact line
 * without a timer and without touching stdout.
 */

/**
 * Severity, lowest first. Starts at 1 so a falsy level cannot silently mean
 * `DEBUG`, and so `minLevel` comparisons never depend on `0` being truthy.
 */
export enum LogLevel {
  DEBUG = 1,
  INFO = 2,
  WARN = 3,
  ERROR = 4,
}

/** Receives one already-formatted line. Injected so a test never writes to a stream. */
export interface LogSink {
  /** Write a formatted line. Implementations append their own newline. */
  write(line: string): void
}

/** Time source. Injected because a timestamp is the only non-deterministic part of a log line. */
export interface Clock {
  /** Current instant. Called once per log line. */
  now(): Date
}

/** The platform clock. The only implementation that is not a fake. */
export const systemClock: Clock = {
  now: () => new Date(),
}

/** Sink that writes to stdout, one line per call. */
export const stdoutSink: LogSink = {
  write: (line) => console.log(line),
}

/** Sink that writes to stderr, one line per call. */
export const stderrSink: LogSink = {
  write: (line) => console.error(line),
}

/**
 * Timestamped, levelled logger.
 *
 * `records()` exists so a caller can persist the run log (the offline-backup
 * drive keeps `logs/<timestamp>_<status>.log`) without a second logging path and
 * without patching `console`.
 */
export interface Logger {
  /** Below {@link LogLevel.INFO}. Debug detail, kept out of a default run. */
  debug(message: string): void
  /** Progress and state transitions. */
  info(message: string): void
  /** Something recoverable; the run continues. */
  warn(message: string): void
  /** Something failed. The caller decides whether it is fatal. */
  error(message: string): void
  /** Every line written so far, formatted, oldest first. A copy — mutating it changes nothing. */
  records(): readonly string[]
}

/** Everything {@link createLogger} takes. All of it optional; the defaults are the real ones. */
export interface LoggerOptions {
  /** Time source. Defaults to {@link systemClock}. */
  clock?: Clock
  /** Sink for `debug`/`info`/`warn`. Defaults to {@link stdoutSink}. */
  out?: LogSink
  /** Sink for `error`. Defaults to {@link stderrSink}. */
  err?: LogSink
  /**
   * Lines below this level are dropped. Defaults to {@link LogLevel.INFO}.
   * A value that is not a `LogLevel` is rejected: a typo would otherwise mute
   * the whole run and look like a quiet success.
   */
  minLevel?: LogLevel
  /**
   * Keep formatted lines for {@link Logger.records}. Defaults to `true`; an
   * unbounded log is a memory leak in a process that runs for days, so a caller
   * that only wants output can turn it off.
   */
  capture?: boolean
}

const LEVEL_NAMES: Record<LogLevel, string> = {
  [LogLevel.DEBUG]: "DEBUG",
  [LogLevel.INFO]: "INFO",
  [LogLevel.WARN]: "WARN",
  [LogLevel.ERROR]: "ERROR",
}

/**
 * Format one line: `<ISO timestamp> <LEVEL> <message>`.
 *
 * The level is part of the line, not ANSI colour, because the offline-backup log
 * is written to a file and read months later. `rostok`'s `%c…` CSS prefix only
 * renders in a browser console; in a terminal or a file it survives as literal
 * `%c` noise.
 */
export function formatLogLine(
  level: LogLevel,
  message: string,
  timestamp: string,
): string {
  return `${timestamp} ${LEVEL_NAMES[level]} ${message}`
}

/**
 * Build a logger.
 *
 * @throws {RangeError} When `minLevel` is not a {@link LogLevel} member.
 */
export function createLogger(options: LoggerOptions = {}): Logger {
  const clock = options.clock ?? systemClock
  const out = options.out ?? stdoutSink
  const err = options.err ?? stderrSink
  const minLevel = options.minLevel ?? LogLevel.INFO
  const capture = options.capture ?? true

  if (LEVEL_NAMES[minLevel] === undefined) {
    throw new RangeError(
      `minLevel must be a LogLevel, got ${String(minLevel)}`,
    )
  }

  const records: string[] = []

  const emit = (level: LogLevel, message: string): void => {
    if (level < minLevel) return
    const line = formatLogLine(level, message, clock.now().toISOString())
    if (capture) records.push(line)
    if (level === LogLevel.ERROR) {
      err.write(line)
      return
    }
    out.write(line)
  }

  return {
    debug: (message) => emit(LogLevel.DEBUG, message),
    info: (message) => emit(LogLevel.INFO, message),
    warn: (message) => emit(LogLevel.WARN, message),
    error: (message) => emit(LogLevel.ERROR, message),
    records: () => [...records],
  }
}
