/**
 * `deno task check`: format, lint, types and the unit tier, run in parallel, with quiet output.
 *
 * A passing check prints one line per task, and the test summary. A failing task also prints its
 * own output: for the tests, Deno's ` ERRORS ` section and what follows, since the report before it
 * lists every passing test (over a megabyte for this workspace).
 */

const TASKS = ["fmt:check", "lint", "ts:check", "test"]

/** The result of one task, as the report needs it. */
export interface TaskRun {
  task: string
  code: number
  /** Standard output, then standard error. */
  output: string
  seconds: number
}

/** The lines a task's run prints: one status line, and on failure the part of its output to read. */
export function report({ task, code, output, seconds }: TaskRun): string {
  const lines = output.split("\n")
  const summary = lines.findLast((line) => /^(ok|FAILED) \| /.test(line))
  const status = `${code === 0 ? "ok" : `FAILED exit=${code}`} ${task} ${seconds.toFixed(0)}s`
  const head = summary === undefined ? status : `${status} | ${summary}`
  if (code === 0) return head
  const errors = lines.findIndex((line) => line.trim() === "ERRORS")
  const detail = (errors === -1 ? lines : lines.slice(errors)).join("\n").trimEnd()
  return `${head}\n${detail}\n`
}

async function run(task: string): Promise<TaskRun> {
  const started = performance.now()
  const { code, stdout, stderr } = await new Deno.Command("deno", {
    args: ["task", "--quiet", task],
    env: { NO_COLOR: "1" },
    stdin: "null",
  }).output()
  const decoder = new TextDecoder()
  const output = decoder.decode(stdout) + decoder.decode(stderr)
  return { task, code, output, seconds: (performance.now() - started) / 1000 }
}

if (import.meta.main) {
  const runs = await Promise.all(TASKS.map(run))
  for (const result of runs) console.log(report(result))
  Deno.exit(runs.every((result) => result.code === 0) ? 0 : 1)
}
