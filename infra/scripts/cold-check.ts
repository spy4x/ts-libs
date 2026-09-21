/**
 * Run one or more `deno task`s the way CI does: `CI=true` and an empty `DENO_DIR`.
 *
 * A warm local run is not evidence — it hides cache and `$HOME` assumptions, and `CI=true`
 * is what makes Deno treat the lockfile as frozen. This script replaces a shell block that
 * every agent used to copy (`D=$(mktemp -d …)`, run, `rm -rf -- "$D"`). That block had two
 * costs: an `rm` on a shell variable makes an agent harness stop and ask a person before
 * every run, and an agent that lost the variable left the cache behind.
 *
 * The cache lives under `.volumes/denodir/`, which is gitignored and skipped by formatting,
 * linting, the test runner and `type-check.ts`, so the write grant stays as narrow as the
 * integration tier's. It is removed in a `finally`, whether the tasks pass or fail.
 *
 * Usage: `deno task check:cold` runs `check`; `deno task check:cold check:all`, or any list of
 * task names, runs each in order against the same empty cache and stops at the first failure.
 */

const tasks = Deno.args.length > 0 ? Deno.args : ["check"]

const cacheRoot = ".volumes/denodir"
await Deno.mkdir(cacheRoot, { recursive: true })
const cacheDirectory = await Deno.makeTempDir({ dir: cacheRoot, prefix: "cold." })
// An absolute path, because `deno task` may change directory for a workspace member.
const denoDir = await Deno.realPath(cacheDirectory)

let exitCode = 0
try {
  for (const task of tasks) {
    const command = new Deno.Command("deno", {
      args: ["task", task],
      env: { CI: "true", DENO_DIR: denoDir },
      stdin: "null",
      stdout: "inherit",
      stderr: "inherit",
    })
    const status = await command.spawn().status
    console.log(`cold ${task}: exit=${status.code}`)
    if (!status.success) {
      exitCode = status.code === 0 ? 1 : status.code
      break
    }
  }
} finally {
  await Deno.remove(denoDir, { recursive: true })
}

Deno.exit(exitCode)
