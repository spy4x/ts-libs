import { assertEquals, assertRejects, assertStrictEquals, assertThrows } from "@std/assert"
import {
  DEFAULT_PORT,
  DEFAULT_TIMEOUT_MS,
  healthcheckExitCode,
  HealthcheckTimeoutError,
  LOOPBACK_HOSTS,
  type ProbeConnection,
  type ProbeConnector,
  probeLoopback,
  resolveHealthcheckPort,
  runHealthcheck,
  withDeadline,
} from "./healthcheck.ts"

/** A socket that echoes the probe byte, recording what it was asked to do. */
function echoSocket(overrides: Partial<ProbeConnection> = {}) {
  const writes: Uint8Array[] = []
  let closed = false
  const connection: ProbeConnection = {
    write: (data) => {
      writes.push(data.slice())
      return Promise.resolve(data.byteLength)
    },
    read: (buffer) => {
      buffer[0] = 0
      return Promise.resolve(1)
    },
    close: () => {
      closed = true
    },
    ...overrides,
  }
  return {
    connection,
    writes,
    get closed() {
      return closed
    },
  }
}

/** A connector that hands out one prepared socket. */
function staticConnector(connection: ProbeConnection): ProbeConnector {
  return { connect: () => Promise.resolve(connection) }
}

/** A connector whose connect never settles, for the deadline path. */
const hangingConnector: ProbeConnector = {
  connect: () => new Promise<ProbeConnection>(() => {}),
}

/**
 * A timer the test fires by hand, so no test waits on the wall clock.
 *
 * The deadline is armed *inside* the probe's promise chain, so `fire()` first
 * waits until a handler is registered. Firing immediately would trigger the
 * previous step's (already cleared) handler and the test would assert the wrong
 * failure. Handlers are fired oldest-first, which is also the only order in which
 * a cleared handler cannot be mistaken for a live one.
 */
function manualTimer() {
  const handlers: Array<() => void> = []
  const cleared: number[] = []
  let armed = 0
  return {
    timer: {
      setTimer: (handler: () => void) => {
        handlers.push(handler)
        armed = handlers.length
        return handlers.length - 1
      },
      clearTimer: (handle: number) => {
        cleared.push(handle)
      },
    },
    cleared,
    /** Number of deadlines armed so far. */
    get armed() {
      return armed
    },
    /** Wait until `expected` deadlines have been armed, then fire the newest one. */
    fire: async (expected = 1) => {
      for (let attempt = 0; armed < expected && attempt < 100; attempt++) {
        await Promise.resolve()
      }
      const handler = handlers[handlers.length - 1]
      if (!handler) throw new Error(`no deadline armed (expected ${expected})`)
      handler()
    },
  }
}

Deno.test("healthcheck: a loopback socket that echoes is healthy", async () => {
  const socket = echoSocket()
  const result = await probeLoopback({ port: 3000, connector: staticConnector(socket.connection) })
  assertEquals(result, { healthy: true })
  assertEquals(socket.writes.length, 1)
  assertEquals(socket.writes[0].byteLength, 1)
  assertEquals(socket.writes[0][0], 0)
})

Deno.test("healthcheck: the probe connects to loopback by default", async () => {
  const targets: Array<{ hostname: string; port: number }> = []
  const connector: ProbeConnector = {
    connect: (options) => {
      targets.push(options)
      return Promise.resolve(echoSocket().connection)
    },
  }
  await probeLoopback({ port: 8080, connector })
  assertEquals(targets, [{ hostname: "127.0.0.1", port: 8080 }])
})

Deno.test("healthcheck: an explicit host is used when given", async () => {
  const targets: Array<{ hostname: string; port: number }> = []
  const connector: ProbeConnector = {
    connect: (options) => {
      targets.push(options)
      return Promise.resolve(echoSocket().connection)
    },
  }
  await probeLoopback({ port: 8080, hostname: "::1", connector })
  assertEquals(targets, [{ hostname: "::1", port: 8080 }])
})

Deno.test("healthcheck: the socket is always closed", async () => {
  const socket = echoSocket()
  await probeLoopback({ port: 3000, connector: staticConnector(socket.connection) })
  assertEquals(socket.closed, true)
})

Deno.test("healthcheck: the socket is closed even when the write fails", async () => {
  const socket = echoSocket({ write: () => Promise.reject(new Error("EPIPE")) })
  const result = await probeLoopback({
    port: 3000,
    connector: staticConnector(socket.connection),
  })
  assertEquals(result, { healthy: false, reason: "write_failed" })
  assertEquals(socket.closed, true)
})

Deno.test("healthcheck: a refused connection is reported as connect_failed", async () => {
  const connector: ProbeConnector = {
    connect: () => Promise.reject(new Error("connection refused")),
  }
  const result = await probeLoopback({ port: 3000, connector })
  assertEquals(result, { healthy: false, reason: "connect_failed" })
})

Deno.test("healthcheck: a failure reason never carries network text", async () => {
  const connector: ProbeConnector = {
    connect: () => Promise.reject(new Error("connect to 198.51.100.7:3000 failed: EHOSTUNREACH")),
  }
  const result = await probeLoopback({ port: 3000, connector })
  const serialised = JSON.stringify(result)
  assertStrictEquals(
    serialised.includes("198.51.100.7"),
    false,
    "reason leaked an internal address",
  )
  assertStrictEquals(serialised.includes("EHOSTUNREACH"), false, "reason leaked an errno")
})

Deno.test("healthcheck: a read that ends at EOF is not healthy", async () => {
  const socket = echoSocket({ read: () => Promise.resolve(null) })
  const result = await probeLoopback({
    port: 3000,
    connector: staticConnector(socket.connection),
  })
  assertEquals(result, { healthy: false, reason: "no_echo" })
  assertEquals(socket.closed, true)
})

Deno.test("healthcheck: a read that returns a different byte is not healthy", async () => {
  const socket = echoSocket({
    read: (buffer) => {
      buffer[0] = 0xff
      return Promise.resolve(1)
    },
  })
  const result = await probeLoopback({
    port: 3000,
    connector: staticConnector(socket.connection),
  })
  assertEquals(result, { healthy: false, reason: "no_echo" })
})

Deno.test("healthcheck: a read that returns zero bytes is not healthy", async () => {
  const socket = echoSocket({ read: () => Promise.resolve(0) })
  const result = await probeLoopback({
    port: 3000,
    connector: staticConnector(socket.connection),
  })
  assertEquals(result, { healthy: false, reason: "no_echo" })
})

Deno.test("healthcheck: a hanging connect fails when the deadline fires", async () => {
  const manual = manualTimer()
  const pending = probeLoopback({
    port: 3000,
    connector: hangingConnector,
    timeoutMs: 50,
    timer: manual.timer,
  })
  await manual.fire()
  assertEquals(await pending, { healthy: false, reason: "connect_failed" })
  assertEquals(manual.cleared.length, 1, "the deadline timer was not cleared")
})

Deno.test("healthcheck: a hanging read closes the socket and fails", async () => {
  const socket = echoSocket({ read: () => new Promise<number | null>(() => {}) })
  const manual = manualTimer()
  const pending = probeLoopback({
    port: 3000,
    connector: staticConnector(socket.connection),
    timeoutMs: 50,
    timer: manual.timer,
  })
  // The read never settles, so only the injected deadline can end the probe.
  // `fire(2)` waits for that deadline to be armed — the connect and write
  // deadlines count as 1 and 2 — then fires it.
  await manual.fire(3)
  assertEquals(await pending, { healthy: false, reason: "read_timeout" })
  assertEquals(socket.closed, true, "the hung socket was left open")
})

Deno.test("healthcheck: a zero timeout disables the deadline", async () => {
  const socket = echoSocket()
  const manual = manualTimer()
  const result = await probeLoopback({
    port: 3000,
    connector: staticConnector(socket.connection),
    timeoutMs: 0,
    timer: manual.timer,
  })
  assertEquals(result, { healthy: true })
  assertEquals(manual.cleared.length, 0)
})

Deno.test("healthcheck: an out-of-range port throws instead of reporting unhealthy", async () => {
  for (const port of [0, -1, 65536, 1.5, Number.NaN]) {
    await assertRejects(
      () => probeLoopback({ port, connector: hangingConnector }),
      RangeError,
    )
  }
})

Deno.test("healthcheck: withDeadline returns a fast result and clears its timer", async () => {
  const manual = manualTimer()
  const value = await withDeadline(Promise.resolve(7), 1000, () => {}, manual.timer)
  assertEquals(value, 7)
  assertEquals(manual.cleared.length, 1)
})

Deno.test("healthcheck: withDeadline runs its cleanup and throws on expiry", async () => {
  const manual = manualTimer()
  let cleanedUp = false
  const pending = withDeadline(
    new Promise<number>(() => {}),
    1000,
    () => {
      cleanedUp = true
    },
    manual.timer,
  )
  await manual.fire()
  await assertRejects(() => pending, HealthcheckTimeoutError)
  assertEquals(cleanedUp, true, "the timed-out step's cleanup did not run")
})

Deno.test("healthcheck: a timeout propagates the operation's own rejection", async () => {
  const manual = manualTimer()
  const failing = withDeadline(Promise.reject(new Error("boom")), 1000, () => {}, manual.timer)
  await assertRejects(() => failing, Error, "boom")
  assertEquals(manual.cleared.length, 1)
})

Deno.test("healthcheck: a non-loopback hostname is refused, not probed", async () => {
  // Without this, `hostname` is a free-text field that the doc comment promised
  // was loopback-only. A probe must never leave the box.
  for (const hostname of ["198.51.100.7", "example.com", "169.254.169.254", "", "LOCALHOST"]) {
    await assertRejects(
      () => probeLoopback({ port: 3000, hostname, connector: hangingConnector }),
      RangeError,
      "must be one of",
    )
  }
})

Deno.test("healthcheck: every allow-listed loopback host is accepted", async () => {
  for (const hostname of LOOPBACK_HOSTS) {
    const socket = echoSocket()
    assertEquals(
      await probeLoopback({ port: 3000, hostname, connector: staticConnector(socket.connection) }),
      { healthy: true },
    )
  }
})

Deno.test("healthcheck: a negative or non-integer deadline is refused", async () => {
  const socket = echoSocket()
  for (const timeoutMs of [-1, 1.5, Number.NaN, Number.POSITIVE_INFINITY]) {
    await assertRejects(
      () =>
        probeLoopback({
          port: 3000,
          timeoutMs,
          connector: staticConnector(socket.connection),
        }),
      RangeError,
      "timeoutMs",
    )
  }
})

Deno.test("healthcheck: a port in a non-decimal notation is refused", () => {
  // `Number()` accepts all of these; a decimal port string is bare digits.
  for (const raw of ["0x1f90", "1e3", "+8080", "8080.0", " 80 80 ", "8080abc"]) {
    assertThrows(
      () => resolveHealthcheckPort({ get: (name) => (name === "PORT" ? raw : undefined) }),
      RangeError,
      "decimal integer",
    )
  }
})

Deno.test("healthcheck: a valid decimal port is accepted after trimming", () => {
  assertEquals(resolveHealthcheckPort({ get: () => "8080" }), 8080)
  assertEquals(resolveHealthcheckPort({ get: () => " 8080 " }), 8080)
})

Deno.test("healthcheck: the exit code is 0 for a healthy service", async () => {
  const socket = echoSocket()
  const code = await healthcheckExitCode({
    port: 3000,
    connector: staticConnector(socket.connection),
  })
  assertEquals(code, 0)
})

Deno.test("healthcheck: the exit code is 1 for a dead service", async () => {
  const connector: ProbeConnector = {
    connect: () => Promise.reject(new Error("connection refused")),
  }
  assertEquals(await healthcheckExitCode({ port: 3000, connector }), 1)
})

Deno.test("healthcheck: runHealthcheck passes the exit code to the process exit", async () => {
  const exits: number[] = []
  const socket = echoSocket()
  await runHealthcheck({
    port: 3000,
    connector: staticConnector(socket.connection),
    exit: (code: number): never => {
      exits.push(code)
      throw new Error("process exit")
    },
  }).catch(() => undefined)
  assertEquals(exits, [0])

  const failing: ProbeConnector = {
    connect: () => Promise.reject(new Error("connection refused")),
  }
  await runHealthcheck({
    port: 3000,
    connector: failing,
    exit: (code: number): never => {
      exits.push(code)
      throw new Error("process exit")
    },
  }).catch(() => undefined)
  assertEquals(exits, [0, 1])
})

Deno.test("healthcheck: the probe port comes from HEALTHCHECK_PORT, then PORT", () => {
  assertEquals(
    resolveHealthcheckPort({ get: (name) => ({ HEALTHCHECK_PORT: "8080" })[name] }),
    8080,
  )
  assertEquals(resolveHealthcheckPort({ get: (name) => ({ PORT: "9000" })[name] }), 9000)
  assertEquals(
    resolveHealthcheckPort({
      get: (name) => ({ PORT: "9000", HEALTHCHECK_PORT: "8080" })[name],
    }),
    8080,
    "HEALTHCHECK_PORT must win over PORT",
  )
})

Deno.test("healthcheck: the port falls back to a default when nothing is set", () => {
  assertEquals(resolveHealthcheckPort({ get: () => undefined }), DEFAULT_PORT)
  assertEquals(resolveHealthcheckPort({ get: () => "" }), DEFAULT_PORT)
  assertEquals(resolveHealthcheckPort({ get: () => "   " }), DEFAULT_PORT)
})

Deno.test("healthcheck: an invalid port variable throws instead of probing the default", () => {
  assertThrows(() =>
    resolveHealthcheckPort({ get: (name) => (name === "PORT" ? "abc" : undefined) })
  )
  assertThrows(() =>
    resolveHealthcheckPort({ get: (name) => (name === "PORT" ? "70000" : undefined) })
  )
  assertThrows(() => resolveHealthcheckPort({ get: (name) => (name === "PORT" ? "0" : undefined) }))
})

Deno.test("healthcheck: the default deadline is short enough for a container probe", () => {
  assertStrictEquals(DEFAULT_TIMEOUT_MS <= 5000, true)
  assertStrictEquals(DEFAULT_TIMEOUT_MS > 0, true)
})
