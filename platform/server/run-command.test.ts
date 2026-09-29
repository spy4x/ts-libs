// `runCommand` against a fake spawner: the root test task has no `--allow-run`.

import { describe, it } from "@std/testing/bdd"
import { expect } from "@std/expect"

import { type CommandSpawner, runCommand, type SpawnOptions } from "./run-command.ts"

const encode = (text: string) => new TextEncoder().encode(text)

function finishing(code: number, stdout: string, stderr: string): CommandSpawner {
  return () => ({
    output: () => Promise.resolve({ success: code === 0, code, ...bytes(stdout, stderr) }),
  })
}

function bytes(stdout: string, stderr: string) {
  return { stdout: encode(stdout), stderr: encode(stderr) }
}

describe("runCommand", () => {
  it("returns success, code 0 and the decoded output of a command that succeeds", async () => {
    const result = await runCommand(["echo", "héllo"], { spawn: finishing(0, "héllo\n", "") })
    expect(result).toEqual({ success: true, code: 0, stdout: "héllo\n", stderr: "" })
  })

  it("returns success false with the exit code, stdout and stderr on a non-zero exit", async () => {
    const result = await runCommand(["false"], { spawn: finishing(3, "partial", "boom") })
    expect(result).toEqual({ success: false, code: 3, stdout: "partial", stderr: "boom" })
    expect(result.error).toBeUndefined()
  })

  it("returns a readable error instead of throwing when the binary is missing", async () => {
    const spawn: CommandSpawner = () => {
      throw new Deno.errors.NotFound("No such file or directory (os error 2): no-such-binary")
    }
    const result = await runCommand(["no-such-binary"], { spawn })
    expect(result.success).toBe(false)
    expect(result.code).toBe(-1)
    expect(result.stdout).toBe("")
    expect(result.error).toContain("no-such-binary")
    expect(result.stderr).toBe(result.error!)
  })

  it("returns the error when the spawned process rejects while running", async () => {
    const spawn: CommandSpawner = () => ({ output: () => Promise.reject("denied") })
    const result = await runCommand(["x"], { spawn })
    expect(result).toEqual({
      success: false,
      code: -1,
      stdout: "",
      stderr: "denied",
      error: "denied",
    })
  })

  it("refuses an empty command without calling the spawner", async () => {
    let called = false
    const spawn: CommandSpawner = () => {
      called = true
      throw new Error("must not run")
    }
    for (const command of [[], [""]]) {
      const result = await runCommand(command, { spawn })
      expect(result.success).toBe(false)
      expect(result.error).toBe("no command given")
    }
    expect(called).toBe(false)
  })

  it("passes the program, its arguments, cwd and env to the spawner without a shell", async () => {
    const seen: { command: string; options: SpawnOptions }[] = []
    const spawn: CommandSpawner = (command, options) => {
      seen.push({ command, options })
      return { output: () => Promise.resolve({ success: true, code: 0, ...bytes("", "") }) }
    }
    await runCommand(["git", "log", "a b; rm"], { spawn, cwd: "/repo", env: { A: "1" } })
    expect(seen).toEqual([{
      command: "git",
      options: {
        args: ["log", "a b; rm"],
        cwd: "/repo",
        env: { A: "1" },
        stdin: "null",
        stdout: "piped",
        stderr: "piped",
      },
    }])
  })

  it("returns success false and the killing signal, never a throw, when the signal aborts", async () => {
    // Like `Deno.Command`, this fake runs until its signal aborts, then reports a SIGTERM death.
    const spawn: CommandSpawner = (_command, options) => ({
      output: () =>
        new Promise((resolve) => {
          options.signal?.addEventListener("abort", () =>
            resolve({ success: false, code: 143, signal: "SIGTERM", ...bytes("partial", "") }))
        }),
    })
    const controller = new AbortController()
    const pending = runCommand(["sleep", "60"], { spawn, signal: controller.signal })
    controller.abort()
    expect(await pending).toEqual({
      success: false,
      code: 143,
      stdout: "partial",
      stderr: "",
      signal: "SIGTERM",
    })
  })

  it("never starts the process when the signal is already aborted", async () => {
    let called = false
    const spawn: CommandSpawner = () => {
      called = true
      throw new Error("must not run")
    }
    const result = await runCommand(["rm", "-rf", "cache"], {
      spawn,
      signal: AbortSignal.abort(new Error("shutting down")),
    })
    expect(called).toBe(false)
    expect(result.success).toBe(false)
    expect(result.code).toBe(-1)
    expect(result.error).toBe("aborted before start: shutting down")
  })

  it("leaves signal out of the result of a process that exited on its own", async () => {
    const spawn: CommandSpawner = () => ({
      output: () => Promise.resolve({ success: false, code: 1, signal: null, ...bytes("", "") }),
    })
    const result = await runCommand(["false"], { spawn })
    expect("signal" in result).toBe(false)
  })

  it("gives the child no standard input when stdin is not set", async () => {
    const seen: SpawnOptions[] = []
    const spawn: CommandSpawner = (_command, options) => {
      seen.push(options)
      return { output: () => Promise.resolve({ success: true, code: 0, ...bytes("", "") }) }
    }
    await runCommand(["cat"], { spawn })
    expect(seen[0].stdin).toBe("null")
  })

  it("passes stdin and the abort signal to the spawner when given", async () => {
    const seen: SpawnOptions[] = []
    const spawn: CommandSpawner = (_command, options) => {
      seen.push(options)
      return { output: () => Promise.resolve({ success: true, code: 0, ...bytes("", "") }) }
    }
    const signal = new AbortController().signal
    await runCommand(["cat"], { spawn, stdin: "inherit", signal })
    expect(seen[0].stdin).toBe("inherit")
    expect(seen[0].signal).toBe(signal)
  })
})
