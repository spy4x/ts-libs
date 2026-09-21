/**
 * Run one or more `deno task`s the way CI does: `CI=true` and an empty `DENO_DIR`.
 *
 * A warm local run is not evidence — it hides cache assumptions. This script replaces a shell
 * block that every agent used to copy (`D=$(mktemp -d …)`, run, `rm -rf -- "$D"`). That block
 * had two costs: an `rm` on a shell variable makes an agent harness stop and ask a person before
 * every run, and an agent that lost the variable left the cache behind.
 *
 * `CI=true` does not freeze the lockfile: a task that resolves a dependency missing from
 * `deno.lock` downloads it, rewrites the file and still exits 0. So the script compares
 * `deno.lock` before and after, and a run that changed it fails.
 *
 * The cache lives under `.volumes/denodir/`, which is gitignored, excluded from formatting and
 * linting by the root `exclude`, skipped by `type-check.ts`, and ignored by the `test` task's own
 * `--ignore` list (that flag replaces `exclude` rather than adding to it, so it names `.volumes`
 * itself). The write grant therefore stays as narrow as the integration tier's. The cache is
 * removed in a `finally`, whether the tasks pass or fail; a run killed by a signal leaves it
 * behind, inside the gitignored folder.
 *
 * What it does not emulate: `$HOME` stays the developer's, and with several tasks named the later
 * ones see the cache the earlier ones filled, where CI gives each step a fresh container.
 *
 * Usage: `deno task check:cold` runs `check`; `deno task check:cold check:all`, or any list of
 * task names, runs each in order against the same empty cache and stops at the first failure.
 */

const tasks = Deno.args.length > 0 ? Deno.args : ["check"]

const lockfile = "deno.lock"
const lockfileBefore = await Deno.readTextFile(lockfile)

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

if (exitCode === 0 && await Deno.readTextFile(lockfile) !== lockfileBefore) {
  console.error(`cold: ${lockfile} was rewritten by the run. Commit the update or fix the import.`)
  exitCode = 1
}

Deno.exit(exitCode)
