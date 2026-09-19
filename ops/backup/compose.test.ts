import { assertEquals, assertThrows } from "@std/assert"
import { createFakeRunner, FakeCommandRunner } from "../testing/command-runner.ts"
import { buildComposeArgs, buildComposeBase, ComposeAction, manageComposeStack } from "./compose.ts"

const STACK = { project: "gatus", composeFile: "/opt/apps/stacks/gatus/compose.yml" }

Deno.test("reports a launch failure as data, not as a rejection", async () => {
  const runner = createFakeRunner().rejectWith(
    "NotFound: Failed to spawn 'docker': entity not found",
  )

  const result = await manageComposeStack({ runner, ...STACK }, ComposeAction.START)

  assertEquals(result.success, false)
  assertEquals(result.fallbackUsed, false)
  assertEquals(result.error, "Error: NotFound: Failed to spawn 'docker': entity not found")
})

Deno.test("builds a compose start argv as an array with no shell", () => {
  const argv = buildComposeArgs(STACK, ComposeAction.START)
  assertEquals(argv, [
    "docker",
    "compose",
    "-p",
    "gatus",
    "-f",
    "/opt/apps/stacks/gatus/compose.yml",
    "start",
  ])
  assertEquals(argv.includes("bash"), false)
  assertEquals(argv.includes("-c"), false)
})

Deno.test("builds a compose stop argv", () => {
  assertEquals(buildComposeArgs(STACK, ComposeAction.STOP).at(-1), "stop")
})

Deno.test("rejects a project name that is not a docker project name", () => {
  assertThrows(
    () => buildComposeBase({ project: "gatus; rm -rf /", composeFile: "compose.yml" }),
    RangeError,
    "not a valid docker compose project name",
  )
})

Deno.test("rejects a blank compose file", () => {
  assertThrows(
    () => buildComposeBase({ project: "gatus", composeFile: "  " }),
    RangeError,
    "composeFile must not be blank",
  )
})

Deno.test("starts the stack with docker compose start when it works", async () => {
  const runner = createFakeRunner()
  const result = await manageComposeStack({ runner, ...STACK }, ComposeAction.START)

  assertEquals(result, { success: true, action: ComposeAction.START, fallbackUsed: false })
  assertEquals(runner.calls.length, 1)
  assertEquals(runner.argvOf(0)?.at(-1), "start")
})

Deno.test("falls back to up -d when the container vanished during the backup", async () => {
  const runner = new FakeCommandRunner()
  runner.respond({ success: false, error: 'service "cert-sync" has no container to start\n' })
  runner.respond({ success: true, output: "Container hl-cert-sync Started\n" })

  const result = await manageComposeStack({ runner, ...STACK }, ComposeAction.START)

  assertEquals(result, { success: true, action: ComposeAction.START, fallbackUsed: true })
  assertEquals(runner.argvOf(1), [
    "docker",
    "compose",
    "-p",
    "gatus",
    "-f",
    "/opt/apps/stacks/gatus/compose.yml",
    "up",
    "-d",
  ])
})

Deno.test(
  "passes the caller's HOME to the up -d fallback so a bind mount cannot land in /root",
  async () => {
    const runner = new FakeCommandRunner()
    runner.respond({ success: false, error: 'service "cert-sync" has no container to start\n' })
    runner.respond({ success: true, output: "" })

    await manageComposeStack(
      { runner, ...STACK, env: { HOME: "/home/operator" } },
      ComposeAction.START,
    )

    assertEquals(runner.calls[0].options.env, undefined)
    assertEquals(runner.calls[1].options.env, { HOME: "/home/operator" })
  },
)

Deno.test("does not fall back when start fails for another reason", async () => {
  const runner = createFakeRunner(() => ({
    success: false,
    output: "",
    error: "Cannot connect to the Docker daemon at unix:///var/run/docker.sock\n",
  }))

  const result = await manageComposeStack({ runner, ...STACK }, ComposeAction.START)

  assertEquals(result.success, false)
  assertEquals(result.fallbackUsed, false)
  assertEquals(result.error, "Cannot connect to the Docker daemon at unix:///var/run/docker.sock")
  assertEquals(runner.calls.length, 1)
})

Deno.test("never falls back on stop, even when a container is reported missing", async () => {
  const runner = createFakeRunner(() => ({
    success: false,
    output: "",
    error: 'service "cert-sync" has no container to start\n',
  }))

  const result = await manageComposeStack({ runner, ...STACK }, ComposeAction.STOP)

  assertEquals(result.success, false)
  assertEquals(result.fallbackUsed, false)
  assertEquals(runner.calls.length, 1)
  assertEquals(runner.argvOf(0)?.at(-1), "stop")
})

Deno.test("reports both failures when the up -d fallback also fails", async () => {
  const runner = new FakeCommandRunner()
  runner.respond({ success: false, error: 'service "cert-sync" has no container to start\n' })
  runner.respond({ success: false, error: "no such image: hl-cert-sync:latest\n" })

  const result = await manageComposeStack({ runner, ...STACK }, ComposeAction.START)

  assertEquals(result.success, false)
  assertEquals(result.fallbackUsed, true)
  assertEquals(
    result.error,
    'start failed (service "cert-sync" has no container to start); ' +
      "up -d also failed (no such image: hl-cert-sync:latest)",
  )
})

Deno.test("runs compose in the working directory the caller names", async () => {
  const runner = createFakeRunner()
  await manageComposeStack(
    { runner, ...STACK, cwd: "/opt/apps" },
    ComposeAction.START,
  )
  assertEquals(runner.calls[0].options.cwd, "/opt/apps")
})
