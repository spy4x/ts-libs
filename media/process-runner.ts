/**
 * The process port every binary-backed wrapper in this package goes through.
 *
 * `media/` never spawns a process directly. `getMeta`, `getDuration`,
 * `getAudioDuration`, `getImageDimensions`, `makeThumbnail`, `runWithProgress`
 * and the PATH probe all receive a `ProcessRunner` through `MediaDeps`.
 * Production wiring passes `denoCommandRunner`; tests pass the fake in
 * `test-doubles.ts`. That is why this package's suite needs `--allow-read` and
 * `--allow-env` but never `--allow-run`.
 */

/** A process that ran to completion. */
export interface ProcessOutput {
  code: number
  success: boolean
  stdout: string
  stderr: string
}

/** Line-oriented callbacks, invoked once per complete line. */
export interface ProcessLineHandlers {
  onStdoutLine?: (line: string) => void
  onStderrLine?: (line: string) => void
}

/**
 * Runs a binary to completion.
 *
 * `argv` is an argument vector, never a shell string: `argv[0]` names the
 * binary and every later entry is passed verbatim. No implementation may route
 * it through a shell — the source this package was extracted from interpolated
 * paths into a shell string (`roley/.../helpers.ts:37,96,123,197`), where a
 * filename containing a space or `;` changed the command.
 */
export interface ProcessRunner {
  /** Runs to completion, buffering both streams. */
  run(argv: readonly string[]): Promise<ProcessOutput>
  /**
   * Runs to completion, streaming complete lines to `handlers` as they arrive
   * and buffering them as well, so the caller can report progress and still
   * quote stderr when the process fails.
   */
  stream(argv: readonly string[], handlers: ProcessLineHandlers): Promise<ProcessOutput>
}

/** Wiring for every wrapper in this package. */
export interface MediaDeps {
  runner: ProcessRunner
  /** ffmpeg binary name or path. Defaults to `"ffmpeg"`, resolved through `PATH`. */
  ffmpegPath?: string
  /** ffprobe binary name or path. Defaults to `"ffprobe"`, resolved through `PATH`. */
  ffprobePath?: string
}

/** Default binary names. The library bundles no binaries; see `README.md`. */
export const FFMPEG_BINARY = "ffmpeg"
export const FFPROBE_BINARY = "ffprobe"

/** Thrown when a binary exits non-zero. Carries the argv, exit code and stderr tail. */
export class ProcessExecutionError extends Error {
  readonly argv: readonly string[]
  readonly code: number
  readonly stderr: string

  constructor(message: string, output: ProcessOutput, argv: readonly string[]) {
    super(message)
    this.name = "ProcessExecutionError"
    this.argv = [...argv]
    this.code = output.code
    this.stderr = output.stderr
  }

  /** The last `lines` non-empty stderr lines, for error messages. */
  stderrTail(lines = 3): string {
    return this.stderr
      .split(/\r\n|\n|\r/)
      .filter((line) => line.trim().length > 0)
      .slice(-lines)
      .join("\n")
  }
}

/**
 * Rejects a filesystem path that a media binary would read as one of its own
 * options, or that no `execve` call can carry.
 *
 * Passing `argv` instead of a shell string removes shell interpretation, but it
 * does **not** remove option parsing: ffmpeg and ffprobe parse their own
 * argument list, so a path that begins with `-` is read as a flag. Reaching them
 * with `output: "-y.webp"` produced `Unrecognized option 'y.webp'` and exit 8 on
 * ffmpeg 8.1.2 — a caller-supplied path became a command-line flag. A NUL byte
 * is rejected for the same reason to keep the failure ours: `Deno.Command`
 * otherwise throws its own `nul byte found in provided data` from deep inside
 * the spawn, which names neither the argument nor the caller.
 *
 * Every wrapper in this package runs its caller-supplied paths through here
 * before building argv.
 *
 * @param kind what the path is, for the diagnostic — `"media path"`,
 * `"thumbnail output"`.
 * @throws {TypeError} before any process is created.
 */
export function assertUsablePath(path: string, kind = "media path"): void {
  if (path.startsWith("-")) {
    throw new TypeError(`${kind} must not start with "-": ${JSON.stringify(path)}`)
  }
  if (path.includes("\0")) {
    throw new TypeError(`${kind} must not contain a NUL byte: ${JSON.stringify(path)}`)
  }
}

/** Incrementally splits a byte stream into complete lines. */
export interface LineSplitter {
  /** Feeds one chunk; complete lines are delivered to the callback. */
  push(chunk: Uint8Array): void
  /** Emits the buffered fragment, if any. Call once the stream has ended. */
  flush(): void
}

/**
 * Creates a splitter that turns chunks into complete lines.
 *
 * `\n`, `\r\n` and a bare `\r` all terminate a line. ffmpeg writes
 * `-progress` blocks with `\n` on a pipe but reuses one `\r`-terminated line
 * when stdout is a terminal, and a `\r\n` pair can straddle two chunks. A
 * trailing fragment stays buffered until its terminator arrives, so progress
 * parsing never sees a half-written `out_time_us=…`.
 */
export function createLineSplitter(onLine: (line: string) => void): LineSplitter {
  const decoder = new TextDecoder()
  let buffer = ""

  const drain = (final: boolean): void => {
    let index = 0
    while (index < buffer.length) {
      const lf = buffer.indexOf("\n", index)
      const cr = buffer.indexOf("\r", index)
      const terminator = lf === -1 ? cr : cr === -1 ? lf : Math.min(lf, cr)
      if (terminator === -1) {
        break
      }
      const isCarriageReturn = buffer[terminator] === "\r"
      // A chunk may end between `\r` and `\n`; wait for the next chunk instead
      // of emitting an empty line.
      if (isCarriageReturn && terminator + 1 === buffer.length && !final) {
        break
      }
      const step = isCarriageReturn && buffer[terminator + 1] === "\n" ? 2 : 1
      onLine(buffer.slice(index, terminator))
      index = terminator + step
    }
    buffer = buffer.slice(index)
    if (final && buffer.length > 0) {
      const rest = buffer
      buffer = ""
      onLine(rest)
    }
  }

  return {
    push(chunk: Uint8Array): void {
      buffer += decoder.decode(chunk, { stream: true })
      drain(false)
    },
    flush(): void {
      buffer += decoder.decode()
      drain(true)
    },
  }
}

async function drainStream(
  source: ReadableStream<Uint8Array>,
  splitter: LineSplitter,
): Promise<void> {
  const reader = source.getReader()
  try {
    while (true) {
      const { done, value } = await reader.read()
      if (done) {
        break
      }
      splitter.push(value)
    }
  } finally {
    splitter.flush()
  }
}

/**
 * `ProcessRunner` on `Deno.Command`.
 *
 * `stdin` is `"null"` on purpose: an inherited stdin lets a child block on an
 * interactive prompt (ffmpeg asks before overwriting an output file) and hang
 * the caller forever. Long-lived servers must not share their stdin with a
 * child either.
 */
export const denoCommandRunner: ProcessRunner = {
  async run(argv: readonly string[]): Promise<ProcessOutput> {
    const command = new Deno.Command(argv[0], {
      args: [...argv.slice(1)],
      stdin: "null",
      stdout: "piped",
      stderr: "piped",
    })
    const output = await command.output()
    const decoder = new TextDecoder()
    return {
      code: output.code,
      success: output.success,
      stdout: decoder.decode(output.stdout),
      stderr: decoder.decode(output.stderr),
    }
  },

  async stream(
    argv: readonly string[],
    handlers: ProcessLineHandlers,
  ): Promise<ProcessOutput> {
    const command = new Deno.Command(argv[0], {
      args: [...argv.slice(1)],
      stdin: "null",
      stdout: "piped",
      stderr: "piped",
    })
    const child = command.spawn()

    const stdoutLines: string[] = []
    const stderrLines: string[] = []
    const stdoutSplitter = createLineSplitter((line) => {
      stdoutLines.push(line)
      handlers.onStdoutLine?.(line)
    })
    const stderrSplitter = createLineSplitter((line) => {
      stderrLines.push(line)
      handlers.onStderrLine?.(line)
    })

    // Both pipes must be drained concurrently: waiting for `child.status`
    // before reading a full pipe buffer deadlocks.
    const [status] = await Promise.all([
      child.status,
      drainStream(child.stdout, stdoutSplitter),
      drainStream(child.stderr, stderrSplitter),
    ])

    return {
      code: status.code,
      success: status.success,
      stdout: stdoutLines.join("\n"),
      stderr: stderrLines.join("\n"),
    }
  },
}
