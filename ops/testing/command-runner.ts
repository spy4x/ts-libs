/**
 * Recording {@link CommandRunner} for tests.
 *
 * Test support, not API: not listed in `ops/deno.json`, imported only from
 * `*.test.ts`. Every effectful helper in this package takes a runner, so a test
 * asserts the exact argv — the property that replaces "did it build a shell
 * string?" with an assertion a machine can check.
 */

import type { CommandOptions, CommandResult, CommandRunner } from "../run-command.ts"

/** One recorded invocation. */
export interface RecordedCall {
  /** The argv the caller passed, untouched. */
  argv: readonly string[]
  /** The options the caller passed, or `{}`. */
  options: CommandOptions
}

/** Produces a result for one invocation. */
export type CommandHandler = (
  argv: readonly string[],
  options: CommandOptions,
) => CommandResult | Promise<CommandResult>

/** A successful, silent result. */
export const OK: CommandResult = { success: true, output: "", error: "" }

/**
 * A runner that records instead of running.
 *
 * Results come from a FIFO queue first (set with {@link FakeCommandRunner.respond}),
 * then from the handler, then from {@link FakeCommandRunner.fallback}. Nothing
 * touches the process table, so a test never needs `--allow-run`.
 */
export class FakeCommandRunner implements CommandRunner {
  /** Every invocation, in call order. */
  readonly calls: RecordedCall[] = []
  /** Result returned when the queue and the handler are both exhausted. */
  fallback: CommandResult = { success: true, output: "", error: "" }

  #queue: CommandResult[] = []
  #handler?: CommandHandler
  #rejection?: Error

  /** Queue one result for the next invocation. */
  respond(result: Partial<CommandResult>): this {
    this.#queue.push({ success: true, output: "", error: "", ...result })
    return this
  }

  /** Answer every invocation from a function of the argv. */
  onRun(handler: CommandHandler): this {
    this.#handler = handler
    return this
  }

  /** Fail every invocation with the same message. */
  alwaysFails(error: string): this {
    return this.onRun(() => ({ success: false, output: "", error }))
  }

  /**
   * Reject every invocation, the way a real runner does when the process cannot
   * be launched at all — a missing binary or a `cwd` that does not exist. A port
   * cannot be trusted by the callers if a fake can only resolve.
   */
  rejectWith(error: Error | string): this {
    this.#rejection = typeof error === "string" ? new Error(error) : error
    return this
  }

  /** argv of the `index`-th invocation, or `undefined` when it never happened. */
  argvOf(index: number): readonly string[] | undefined {
    return this.calls[index]?.argv
  }

  run(
    argv: readonly string[],
    options: CommandOptions = {},
  ): Promise<CommandResult> {
    this.calls.push({ argv: [...argv], options })
    if (this.#rejection !== undefined) return Promise.reject(this.#rejection)
    const queued = this.#queue.shift()
    if (queued !== undefined) return Promise.resolve(queued)
    if (this.#handler !== undefined) {
      return Promise.resolve(this.#handler(argv, options))
    }
    return Promise.resolve(this.fallback)
  }
}

/** Build a runner. Shorthand for `new FakeCommandRunner()`. */
export function createFakeRunner(handler?: CommandHandler): FakeCommandRunner {
  const runner = new FakeCommandRunner()
  if (handler !== undefined) runner.onRun(handler)
  return runner
}

/** A runner that always succeeds, returning `output` on stdout. */
export function commandRunnerSucceeds(output = ""): FakeCommandRunner {
  return createFakeRunner(() => ({ success: true, output, error: "" }))
}

/** A runner that always fails, returning `error` on stderr. */
export function commandRunnerFails(error: string): FakeCommandRunner {
  return createFakeRunner(() => ({ success: false, output: "", error }))
}
