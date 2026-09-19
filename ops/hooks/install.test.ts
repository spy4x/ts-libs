import { assertEquals, assertRejects } from "@std/assert"
import { createEnvReader } from "../env.ts"
import { commandRunnerFails, commandRunnerSucceeds } from "../testing/command-runner.ts"
import { FakeFileSystem } from "../testing/filesystem.ts"
import { DEFAULT_HOOKS, HookInstallError, installHooks, resolveGitCommonDir } from "./install.ts"

const HOOK = [{ name: "pre-commit", content: "#!/bin/sh\nset -eu\nexit 0\n" }]

function repo(fs = new FakeFileSystem()) {
  return { fs, runner: commandRunnerSucceeds("/home/dev/app/.git\n"), cwd: "/home/dev/app" }
}

Deno.test("resolves the absolute git directory a linked worktree reports", async () => {
  const runner = commandRunnerSucceeds("/home/dev/app/.git\n")
  const dir = await resolveGitCommonDir({ fs: new FakeFileSystem(), runner, cwd: "/home/dev/app" })
  assertEquals(dir, "/home/dev/app/.git")
})

Deno.test("resolves the relative git directory the main worktree reports", async () => {
  const runner = commandRunnerSucceeds(".git\n")
  const dir = await resolveGitCommonDir({ fs: new FakeFileSystem(), runner, cwd: "/home/dev/app" })
  assertEquals(dir, "/home/dev/app/.git")
})

Deno.test("resolves a relative path with parent segments against the cwd", async () => {
  const runner = commandRunnerSucceeds("../../.git\n")
  const dir = await resolveGitCommonDir({
    fs: new FakeFileSystem(),
    runner,
    cwd: "/home/dev/app/worktrees/feature",
  })
  assertEquals(dir, "/home/dev/app/.git")
})

Deno.test(
  "honours GIT_DIR from the injected reader instead of the process environment",
  async () => {
    const runner = commandRunnerSucceeds(".git\n")
    const env = createEnvReader({ GIT_DIR: "/srv/mirror.git" })
    const dir = await resolveGitCommonDir({
      fs: new FakeFileSystem(),
      runner,
      env,
      cwd: "/home/dev",
    })
    assertEquals(dir, "/srv/mirror.git")
    assertEquals(runner.calls.length, 0)
  },
)

Deno.test(
  "fails loudly when git rev-parse fails instead of inventing a .git directory",
  async () => {
    const runner = commandRunnerFails(
      "fatal: not a git repository (or any of the parent directories): .git\n",
    )
    await assertRejects(
      () => resolveGitCommonDir({ fs: new FakeFileSystem(), runner, cwd: "/home/dev/plain" }),
      HookInstallError,
      "not a git repository",
    )
  },
)

Deno.test("falls back to the named directory when git rev-parse fails", async () => {
  const runner = commandRunnerFails("fatal: not a git repository")
  const dir = await resolveGitCommonDir({
    fs: new FakeFileSystem(),
    runner,
    cwd: "/home/dev/plain",
    fallbackDir: "/home/dev/plain/.git",
  })
  assertEquals(dir, "/home/dev/plain/.git")
})

Deno.test("rejects an empty git rev-parse result", async () => {
  const runner = commandRunnerSucceeds("\n")
  await assertRejects(
    () => resolveGitCommonDir({ fs: new FakeFileSystem(), runner, cwd: "/home/dev/app" }),
    HookInstallError,
    "printed nothing",
  )
})

Deno.test("installs a hook into the shared hooks directory with the execute bit set", async () => {
  const { fs, runner, cwd } = repo()
  const result = await installHooks({ fs, runner, cwd, hooks: HOOK })

  assertEquals(result.hooksDir, "/home/dev/app/.git/hooks")
  assertEquals(result.results, [
    { name: "pre-commit", path: "/home/dev/app/.git/hooks/pre-commit", status: "installed" },
  ])
  assertEquals(fs.text("/home/dev/app/.git/hooks/pre-commit"), HOOK[0].content)
  assertEquals(fs.modeOf("/home/dev/app/.git/hooks/pre-commit"), 0o755)
})

Deno.test("creates the hooks directory when the repository has none", async () => {
  const { fs, runner, cwd } = repo()
  await installHooks({ fs, runner, cwd, hooks: HOOK })
  assertEquals(fs.mkdirs, ["/home/dev/app/.git/hooks"])
})

Deno.test("does not rewrite a hook whose content already matches", async () => {
  const fs = new FakeFileSystem()
  fs.seedDirectory("/home/dev/app/.git/hooks")
  fs.seed("/home/dev/app/.git/hooks/pre-commit", HOOK[0].content, { mode: 0o755 })
  const runner = commandRunnerSucceeds("/home/dev/app/.git\n")

  const first = await installHooks({ fs, runner, cwd: "/home/dev/app", hooks: HOOK })
  const second = await installHooks({ fs, runner, cwd: "/home/dev/app", hooks: HOOK })

  assertEquals(first.results[0].status, "unchanged")
  assertEquals(second.results[0].status, "unchanged")
  assertEquals(fs.writes, [])
})

Deno.test("repairs a hook that lost its execute bit", async () => {
  const fs = new FakeFileSystem()
  fs.seedDirectory("/home/dev/app/.git/hooks")
  fs.seed("/home/dev/app/.git/hooks/pre-commit", HOOK[0].content, { mode: 0o644 })
  const runner = commandRunnerSucceeds("/home/dev/app/.git\n")

  const result = await installHooks({ fs, runner, cwd: "/home/dev/app", hooks: HOOK })

  assertEquals(result.results[0].status, "repaired")
  assertEquals(fs.modeOf("/home/dev/app/.git/hooks/pre-commit"), 0o755)
  assertEquals(fs.writes, [])
})

Deno.test("updates a hook whose content differs", async () => {
  const fs = new FakeFileSystem()
  fs.seedDirectory("/home/dev/app/.git/hooks")
  fs.seed("/home/dev/app/.git/hooks/pre-commit", "#!/bin/sh\nstale\n", { mode: 0o755 })
  const runner = commandRunnerSucceeds("/home/dev/app/.git\n")

  const result = await installHooks({ fs, runner, cwd: "/home/dev/app", hooks: HOOK })

  assertEquals(result.results[0].status, "updated")
  assertEquals(fs.text("/home/dev/app/.git/hooks/pre-commit"), HOOK[0].content)
})

Deno.test("treats trailing whitespace as unchanged rather than rewriting every run", async () => {
  const fs = new FakeFileSystem()
  fs.seedDirectory("/home/dev/app/.git/hooks")
  fs.seed("/home/dev/app/.git/hooks/pre-commit", `${HOOK[0].content}\n\n`, { mode: 0o755 })
  const runner = commandRunnerSucceeds("/home/dev/app/.git\n")

  const result = await installHooks({ fs, runner, cwd: "/home/dev/app", hooks: HOOK })

  assertEquals(result.results[0].status, "unchanged")
  assertEquals(fs.writes, [])
})

Deno.test("refuses to write through a symlinked hook path", async () => {
  const fs = new FakeFileSystem()
  fs.seedDirectory("/home/dev/app/.git/hooks")
  fs.seedSymlink("/home/dev/app/.git/hooks/pre-commit", "/tmp/attacker-controlled")
  const runner = commandRunnerSucceeds("/home/dev/app/.git\n")

  await assertRejects(
    () => installHooks({ fs, runner, cwd: "/home/dev/app", hooks: HOOK }),
    HookInstallError,
    "refusing to write through the symlink",
  )
  assertEquals(fs.writes, [])
})

Deno.test("writes through a symlinked hook path only when explicitly allowed", async () => {
  const fs = new FakeFileSystem()
  fs.seedDirectory("/home/dev/app/.git/hooks")
  fs.seedSymlink("/home/dev/app/.git/hooks/pre-commit", "/tmp/shared-hook")
  const runner = commandRunnerSucceeds("/home/dev/app/.git\n")

  const result = await installHooks({
    fs,
    runner,
    cwd: "/home/dev/app",
    hooks: HOOK,
    allowSymlink: true,
  })

  assertEquals(result.results[0].status, "installed")
})

Deno.test("does not touch a mode where the platform reports none", async () => {
  const fs = new FakeFileSystem()
  const runner = commandRunnerSucceeds("/home/dev/app/.git\n")
  await installHooks({ fs, runner, cwd: "/home/dev/app", hooks: HOOK, executable: false })
  assertEquals(fs.chmods, [])
})

Deno.test("installs every default hook", async () => {
  const { fs, runner, cwd } = repo()
  const result = await installHooks({ fs, runner, cwd })
  assertEquals(
    result.results.map((entry) => entry.name),
    DEFAULT_HOOKS.map((hook) => hook.name),
  )
  assertEquals(
    result.results.map((entry) => entry.status),
    ["installed", "installed", "installed"],
  )
})

Deno.test("rejects a hook name that would escape the hooks directory", async () => {
  const { fs, runner, cwd } = repo()
  await assertRejects(
    () => installHooks({ fs, runner, cwd, hooks: [{ name: "../config", content: "x" }] }),
    HookInstallError,
    "is not a git hook name",
  )
  assertEquals(fs.writes, [])
})

Deno.test("reports a non-not-found filesystem failure instead of installing anyway", async () => {
  const fs = new FakeFileSystem()
  fs.seedDirectory("/home/dev/app/.git/hooks")
  fs.seed("/home/dev/app/.git/hooks/pre-commit", HOOK[0].content, { mode: 0o755 })
  fs.readTextFile = () => Promise.reject(new Error("EACCES: permission denied"))
  const runner = commandRunnerSucceeds("/home/dev/app/.git\n")
  await assertRejects(
    () => installHooks({ fs, runner, cwd: "/home/dev/app", hooks: HOOK }),
    Error,
    "permission denied",
  )
  assertEquals(fs.writes, [])
})

Deno.test("logs each hook through the injected logger", async () => {
  const { fs, runner, cwd } = repo()
  const lines: string[] = []
  await installHooks({
    fs,
    runner,
    cwd,
    hooks: HOOK,
    logger: {
      debug: () => {},
      info: (message) => lines.push(message),
      warn: () => {},
      error: () => {},
      records: () => lines,
    },
  })
  assertEquals(lines, [
    "installing hooks in /home/dev/app/.git/hooks",
    "pre-commit: installed",
  ])
})

Deno.test("a missing git binary is reported as an install failure", async () => {
  const runner = commandRunnerFails("command not found: git")
  await assertRejects(
    () => resolveGitCommonDir({ fs: new FakeFileSystem(), runner, cwd: "/home/dev/app" }),
    HookInstallError,
    "command not found: git",
  )
})

Deno.test("treats a blank GIT_DIR as unset instead of installing at /hooks", async () => {
  const runner = commandRunnerSucceeds("/home/dev/app/.git\n")
  const env = { get: (name: string) => (name === "GIT_DIR" ? "   " : undefined) }
  const dir = await resolveGitCommonDir({
    fs: new FakeFileSystem(),
    runner,
    env,
    cwd: "/home/dev/app",
  })
  assertEquals(dir, "/home/dev/app/.git")
  assertEquals(runner.calls.length, 1)
})

Deno.test("resolves a relative GIT_DIR against the cwd git runs in", async () => {
  const runner = commandRunnerSucceeds(".git\n")
  const env = createEnvReader({ GIT_DIR: ".git" })
  const dir = await resolveGitCommonDir({
    fs: new FakeFileSystem(),
    runner,
    env,
    cwd: "/home/dev/app",
  })
  assertEquals(dir, "/home/dev/app/.git")
  assertEquals(runner.calls.length, 0)
})
