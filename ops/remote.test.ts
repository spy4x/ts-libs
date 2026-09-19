import { assertEquals, assertRejects, assertThrows } from "@std/assert"
import { createEnvReader, MissingEnvError } from "./env.ts"
import { CommandError } from "./run-command.ts"
import { commandRunnerFails, commandRunnerSucceeds } from "./testing/command-runner.ts"
import {
  assertDockerContainerName,
  assertSafeRemoteArg,
  buildSshArgv,
  restartRemoteContainer,
} from "./remote.ts"

const ENV = createEnvReader({ SSH_ADDRESS: "deploy@cloud.example" })

Deno.test("restarts the container with docker's own argv, not a shell string", async () => {
  const runner = commandRunnerSucceeds("hl-traefik\n")
  await restartRemoteContainer("hl-traefik", { runner, env: ENV })

  assertEquals(runner.argvOf(0), [
    "ssh",
    "deploy@cloud.example",
    "docker",
    "restart",
    "hl-traefik",
  ])
  assertEquals(runner.argvOf(0)?.includes("-c"), false)
})

Deno.test("throws when the remote restart fails", async () => {
  const runner = commandRunnerFails("Error response from daemon: No such container: hl-gatus\n")
  await assertRejects(
    () => restartRemoteContainer("hl-gatus", { runner, env: ENV }),
    CommandError,
    "restart hl-gatus failed: Error response from daemon: No such container: hl-gatus",
  )
})

Deno.test("throws before running anything when SSH_ADDRESS is unset", async () => {
  const runner = commandRunnerSucceeds()
  await assertRejects(
    () => restartRemoteContainer("hl-traefik", { runner, env: createEnvReader({}) }),
    MissingEnvError,
    "SSH_ADDRESS",
  )
  assertEquals(runner.calls.length, 0)
})

Deno.test("rejects a container name that would be executed by the remote shell", async () => {
  const runner = commandRunnerSucceeds()
  await assertRejects(
    () => restartRemoteContainer("hl-traefik; rm -rf /", { runner, env: ENV }),
    CommandError,
    "not a valid docker container name",
  )
  assertEquals(runner.calls.length, 0)
})

Deno.test("accepts a container name with docker's allowed punctuation", () => {
  assertDockerContainerName("hl-cert-sync")
  assertDockerContainerName("app_1.2")
})

Deno.test("rejects a remote argument carrying shell metacharacters", () => {
  assertThrows(
    () => assertSafeRemoteArg("/opt/apps; touch /tmp/pwned", "remote argument"),
    CommandError,
    "which the remote shell would execute",
  )
  assertThrows(() => assertSafeRemoteArg("$(id)", "remote argument"), CommandError)
  assertThrows(() => assertSafeRemoteArg("", "remote argument"), CommandError, "must not be blank")
})

Deno.test("allows a tilde path because the remote shell expands it", () => {
  assertSafeRemoteArg("~/cloudlab/apps/site", "remote argument")
})

Deno.test("builds ssh argv with the caller's flags before the address", () => {
  assertEquals(
    buildSshArgv("deploy@cloud.example", ["docker", "restart", "hl-traefik"], ["-p", "2222"]),
    ["ssh", "-p", "2222", "deploy@cloud.example", "docker", "restart", "hl-traefik"],
  )
})

Deno.test("logs the restart through the injected logger", async () => {
  const lines: string[] = []
  const logger = {
    debug: () => {},
    info: (message: string) => lines.push(message),
    warn: () => {},
    error: () => {},
    records: () => lines,
  }
  await restartRemoteContainer("hl-traefik", {
    runner: commandRunnerSucceeds(),
    env: ENV,
    logger,
  })
  assertEquals(lines, [
    "restarting hl-traefik on deploy@cloud.example",
    "hl-traefik restarted",
  ])
})
