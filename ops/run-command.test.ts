import { assertEquals, assertRejects, assertThrows } from "@std/assert"
import {
  assertArgv,
  assertNoSecretInArgv,
  buildInvocation,
  CommandError,
  createDenoCommandRunner,
  mustRun,
  runCommand,
  stdinModeFor,
} from "./run-command.ts"
import { createFakeRunner, FakeCommandRunner } from "./testing/command-runner.ts"

const CANARY = "canary-do-not-log-3f9a"

Deno.test("buildInvocation keeps argv as an array of single words", () => {
  const argv = buildInvocation([
    "docker",
    "compose",
    "-p",
    "antonshubincom",
    "up",
    "-d",
    "--build",
  ])
  assertEquals(argv, [
    "docker",
    "compose",
    "-p",
    "antonshubincom",
    "up",
    "-d",
    "--build",
  ])
})

Deno.test("buildInvocation never inserts a shell", () => {
  const argv = buildInvocation(["rsync", "-avz", "./", "cloudlab:~/apps/app/"])
  assertEquals(argv.includes("sh"), false)
  assertEquals(argv.includes("bash"), false)
  assertEquals(argv.includes("-c"), false)
})

Deno.test("buildInvocation prefixes sudo without rewriting the rest", () => {
  assertEquals(
    buildInvocation(["parted", "/dev/sdb", "--script", "mklabel", "gpt"], {
      sudo: true,
    }),
    [
      "sudo",
      "parted",
      "/dev/sdb",
      "--script",
      "mklabel",
      "gpt",
    ],
  )
})

Deno.test("rejects an empty argv before anything runs", async () => {
  const runner = createFakeRunner()
  assertThrows(
    () => assertArgv([]),
    CommandError,
    "argv must contain an executable",
  )
  assertThrows(
    () => buildInvocation(["  "]),
    CommandError,
    "argv[0] must be a non-empty",
  )
  await assertRejects(() => runCommand(runner, []), CommandError)
  assertEquals(runner.calls.length, 0)
})

Deno.test("runCommand hands the runner the exact argv and returns the house result", async () => {
  const runner = new FakeCommandRunner()
  runner.respond({ success: true, output: "restarted\n", error: "" })
  const result = await runCommand(runner, [
    "ssh",
    "cloudlab",
    "docker",
    "restart",
    "hl-traefik",
  ])
  assertEquals(runner.argvOf(0), [
    "ssh",
    "cloudlab",
    "docker",
    "restart",
    "hl-traefik",
  ])
  assertEquals(result, { success: true, output: "restarted\n", error: "" })
})

Deno.test("runCommand reports a failure as data rather than throwing", async () => {
  const runner = createFakeRunner(() => ({
    success: false,
    output: "",
    error: "exit 23",
  }))
  const result = await runCommand(runner, ["rsync", "./", "cloudlab:~/apps/"])
  assertEquals(result.success, false)
  assertEquals(result.error, "exit 23")
})

Deno.test("mustRun throws with the stderr when the command fails", async () => {
  const runner = createFakeRunner(() => ({
    success: false,
    output: "",
    error: "Error response from daemon: No such container: hl-gatus\n",
  }))
  await assertRejects(
    () =>
      mustRun(
        runner,
        ["ssh", "cloudlab", "docker", "restart", "hl-gatus"],
        {},
        "restart",
      ),
    CommandError,
    "restart failed: Error response from daemon: No such container: hl-gatus",
  )
})

Deno.test("mustRun returns the output when the command succeeds", async () => {
  const runner = createFakeRunner(() => ({
    success: true,
    output: "hl-traefik\n",
    error: "",
  }))
  const result = await mustRun(
    runner,
    [
      "ssh",
      "cloudlab",
      "docker",
      "restart",
      "hl-traefik",
    ],
    {},
    "restart",
  )
  assertEquals(result.output, "hl-traefik\n")
})

Deno.test("sudo inherits the terminal so a password prompt can be answered", () => {
  assertEquals(stdinModeFor({ sudo: true }), "inherit")
})

Deno.test("a non-sudo command gets a closed stdin rather than the terminal", () => {
  assertEquals(stdinModeFor({}), "null")
})

Deno.test("explicit stdin text wins over sudo's inherited terminal", () => {
  assertEquals(
    stdinModeFor({ sudo: true, stdin: "#!/bin/sh\nset -eu\n" }),
    "piped",
  )
})

Deno.test("rejects a secret in argv instead of leaking it to the process table", () => {
  assertThrows(
    () =>
      assertNoSecretInArgv([
        "docker",
        "run",
        "-e",
        `AWS_SECRET_ACCESS_KEY=${CANARY}`,
      ], [CANARY]),
    CommandError,
    "pass it on stdin or via an env file",
  )
})

Deno.test("accepts an argv whose only secret-bearing entry is an env file path", () => {
  assertNoSecretInArgv(
    ["docker", "compose", "--env-file", ".env.prod", "up", "-d"],
    [CANARY],
  )
})

Deno.test("ignores an empty secret when guarding argv", () => {
  assertNoSecretInArgv(["echo", "hi"], [""])
})

Deno.test("the real runner is exposed but never invoked by a test", () => {
  const runner = createDenoCommandRunner()
  assertEquals(typeof runner.run, "function")
})
