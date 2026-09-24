/**
 * Loopback healthcheck for containers with no shell and no HTTP client.
 *
 * A distroless image has no `curl`, no `wget` and no `/bin/sh`, so a
 * `HEALTHCHECK` that tries to run one can never work. The compiled binary is the
 * only executable in the image, so it has to probe itself: TCP-connect to the
 * loopback port it is listening on and close the socket again, exiting `0` when
 * the connection succeeds and `1` otherwise. That is what the app this was
 * ported from did.
 *
 * An earlier version of this file also wrote one byte after connecting and
 * waited for it to be echoed back, and reported a real, running web server as
 * down: a web server never echoes a raw TCP byte, it answers HTTP or nothing, so
 * the echo step always timed out against a live server. Connect-and-close is
 * the whole probe now. A real HTTP request would tell more — a server that
 * accepts connections but never answers one still reads healthy here — and is a
 * deliberate follow-up (#58), not built in this change.
 *
 * Where it lives: **`server/healthcheck.ts`, not a separate deploy-tooling package.**
 * `ops/` used to be that package (issue #18) and would have needed its own config for
 * 60 LOC; `ops/` was later removed from ts-libs entirely (#67). A loopback probe of an
 * HTTP server is a server concern, and this module needs no package of its own — it
 * is a `server/` subpath.
 *
 * The probe is separate from the process wrapper ({@link runHealthcheck}) so the
 * decision logic is unit-testable without a socket: `deno test` runs with
 * `--allow-read --allow-env` only, so the connector **and** the timer are injected
 * and neither `Deno.connect` nor a real deadline is exercised by a test.
 *
 * Not ported: the `caldav-mcp` two-stage Dockerfile (`denoland/deno:alpine` →
 * `gcr.io/distroless/cc-debian12` + `deno compile`). Deploy tooling is not part of
 * ts-libs; a project built from the template has its own `infra/scripts/`.
 *
 * @module
 */

/** A connected socket, narrowed to what a probe needs: closing it again. */
export interface ProbeConnection {
  /** Release the socket. Must not escape; always called by the probe. */
  close: () => void
}

/** Opens a socket. Injected so the probe is testable without `--allow-net`. */
export interface ProbeConnector {
  /** Connect to `hostname:port`, or reject. */
  connect: (options: { hostname: string; port: number }) => Promise<ProbeConnection>
}

/** Timer used for deadlines. Injected so a test never waits on the wall clock. */
export interface ProbeTimer {
  setTimer: (handler: () => void, ms: number) => number
  clearTimer: (handle: number) => void
}

/** Default per-step deadline: short enough for a container probe, long enough for a busy loop. */
export const DEFAULT_TIMEOUT_MS = 2000

/** Default service port when neither `PORT` nor `HEALTHCHECK_PORT` is set. */
export const DEFAULT_PORT = 3000

/** The only hosts a probe may target. A healthcheck has no business leaving the box. */
export const LOOPBACK_HOSTS: readonly string[] = [
  "127.0.0.1",
  "::1",
  "localhost",
  "0.0.0.0",
]

/** Why a probe failed. The only value today is a failed or timed-out connect. */
export type ProbeFailure = "connect_failed"

/** Probe outcome, kept as data so the caller — not the probe — decides what to do. */
export interface ProbeResult {
  /** True only when the socket connected, echoed the probe byte and closed cleanly. */
  healthy: boolean
  /** Why the probe failed. Absent when healthy. */
  reason?: ProbeFailure
}

/** Everything {@link probeLoopback} needs. */
export interface HealthcheckOptions {
  /** Port to probe. */
  port: number
  /**
   * Host to probe. Defaults to `127.0.0.1`. Must be a loopback address —
   * {@link LOOPBACK_HOSTS} are the only accepted values, so a probe can never be
   * pointed at a public bind by a typo or by a caller that forwards an env value
   * straight through.
   */
  hostname?: string
  /** Connector. Defaults to {@link denoConnector}. */
  connector?: ProbeConnector
  /**
   * Deadline for the connect step, in milliseconds. Defaults to
   * {@link DEFAULT_TIMEOUT_MS}. `0` disables it; a negative or non-finite value
   * is rejected, because a negative deadline silently disables the probe's only
   * bound and `NaN` would fire immediately.
   */
  timeoutMs?: number
  /** Timer for the deadline. Defaults to the platform timers. */
  timer?: ProbeTimer
}

/** Deadline exceeded. A distinct class so the probe can tell it from a real network error. */
export class HealthcheckTimeoutError extends Error {
  constructor(timeoutMs: number) {
    super(`healthcheck step exceeded ${timeoutMs}ms`)
    this.name = "HealthcheckTimeoutError"
  }
}

const platformTimer: ProbeTimer = {
  setTimer: (handler, ms) => setTimeout(handler, ms),
  clearTimer: (handle) => clearTimeout(handle),
}

/**
 * Race a step against a deadline, clearing the timer on every path.
 *
 * The losing promise is **not** awaited: a `Deno.connect` to a black-holed
 * address can stay pending past the deadline, and awaiting it would hang the very
 * process that exists to report the hang. A timeout rejects with
 * {@link HealthcheckTimeoutError}; `onTimeout` closes whatever the step holds.
 *
 * @throws {HealthcheckTimeoutError} When the deadline fires first.
 */
export async function withDeadline<T>(
  operation: Promise<T>,
  timeoutMs: number,
  onTimeout: () => void,
  timer: ProbeTimer = platformTimer,
): Promise<T> {
  if (timeoutMs <= 0) return await operation
  let handle: number | null = null
  try {
    return await Promise.race([
      operation,
      new Promise<never>((_, reject) => {
        handle = timer.setTimer(() => {
          onTimeout()
          reject(new HealthcheckTimeoutError(timeoutMs))
        }, timeoutMs)
      }),
    ])
  } finally {
    if (handle !== null) timer.clearTimer(handle)
  }
}

/**
 * Probe a loopback port by connecting and closing again.
 *
 * @returns `{ healthy: true }` when the connect succeeds, or
 * `{ healthy: false, reason: "connect_failed" }` when it is refused or misses
 * its deadline — never a message from the network stack, which could name an
 * internal address.
 * @throws {RangeError} When `port` is not an integer in 1-65535, when `hostname`
 * is not a {@link LOOPBACK_HOSTS} entry, or when `timeoutMs` is negative or not
 * an integer. All three are configuration errors rather than an unhealthy
 * service, and must not exit `1` next to a real outage.
 */
export async function probeLoopback(options: HealthcheckOptions): Promise<ProbeResult> {
  const { port, hostname = "127.0.0.1" } = options
  const connector = options.connector ?? denoConnector
  const timeoutMs = options.timeoutMs ?? DEFAULT_TIMEOUT_MS
  const timer = options.timer ?? platformTimer

  if (!Number.isInteger(port) || port < 1 || port > 65535) {
    throw new RangeError(`healthcheck port must be 1-65535, got ${port}`)
  }
  if (!LOOPBACK_HOSTS.includes(hostname)) {
    throw new RangeError(
      `healthcheck hostname must be one of ${LOOPBACK_HOSTS.join(", ")}, got "${hostname}"`,
    )
  }
  if (!Number.isInteger(timeoutMs) || timeoutMs < 0) {
    throw new RangeError(`healthcheck timeoutMs must be a non-negative integer, got ${timeoutMs}`)
  }

  let connection: ProbeConnection
  try {
    connection = await withDeadline(
      connector.connect({ hostname, port }),
      timeoutMs,
      () => {},
      timer,
    )
  } catch {
    return { healthy: false, reason: "connect_failed" }
  }

  // A leaked probe socket every 30 seconds is a file-descriptor leak in a
  // container that has no way to report it.
  connection.close()
  return { healthy: true }
}

/**
 * Exit code for the probe: `0` healthy, `1` unhealthy.
 *
 * Separate from the process exit so the whole decision is a value a test can
 * assert — `runHealthcheck` is then the one line that cannot be tested without
 * ending the test runner.
 *
 * @throws {RangeError} Forwarded from {@link probeLoopback} for an invalid port.
 */
export async function healthcheckExitCode(options: HealthcheckOptions): Promise<0 | 1> {
  const result = await probeLoopback(options)
  return result.healthy ? 0 : 1
}

/** Process surface used to exit; injected so a test never ends the test runner. */
export interface ExitAdapter {
  /** Terminate the process with `code`. Never returns. */
  exit: (code: number) => never
}

/**
 * Compute the exit code and terminate the process.
 *
 * The exit happens after the probe has closed its socket.
 *
 * @throws {RangeError} Forwarded from {@link probeLoopback} for an invalid port.
 */
export async function runHealthcheck(
  options: HealthcheckOptions & { exit?: ExitAdapter["exit"] },
): Promise<void> {
  const exit = options.exit ?? ((code: number): never => Deno.exit(code))
  exit(await healthcheckExitCode(options))
}

/**
 * Port the healthcheck should probe, from the process environment.
 *
 * `HEALTHCHECK_PORT` wins over `PORT`, so a container can be probed on a port the
 * app does not serve without changing the app.
 *
 * The value must be bare decimal digits, matching the rule this package applies
 * to `content-length`: `Number()` alone also accepts `1e3`, `0x1f90`, `+8080`
 * and `" 8080"`, none of which are valid decimal port strings, and a port parsed
 * from a value like that probes something the operator never wrote down.
 *
 * @throws {RangeError} When a set value is not a decimal integer in 1-65535. A
 * healthcheck that silently probes the default reports a healthy service as dead,
 * which is worse than failing to start.
 */
export function resolveHealthcheckPort(
  env: { get: (name: string) => string | undefined },
): number {
  for (const name of ["HEALTHCHECK_PORT", "PORT"]) {
    const raw = env.get(name)
    if (raw === undefined || raw.trim() === "") continue
    if (!/^\d+$/.test(raw.trim())) {
      throw new RangeError(`${name} must be a decimal integer in 1-65535, got "${raw}"`)
    }
    const port = Number(raw.trim())
    if (!Number.isSafeInteger(port) || port < 1 || port > 65535) {
      throw new RangeError(`${name} must be an integer in 1-65535, got "${raw}"`)
    }
    return port
  }
  return DEFAULT_PORT
}

/** Adapter over `Deno.connect`, used when no connector is injected. */
export const denoConnector: ProbeConnector = {
  connect: async (options) => {
    const connection = await Deno.connect(options)
    return { close: () => connection.close() }
  },
}
