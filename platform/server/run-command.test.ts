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
        stdout: "piped",
        stderr: "piped",
      },
    }])
  })
})
