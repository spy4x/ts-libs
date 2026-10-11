/**
 * A health endpoint over named checks: one `Response` that says whether the service can work.
 *
 * Each check answers one question, such as "does the database answer?". A **required** check that
 * fails means nothing works: the answer is 503 with `status: "down"`, so a load balancer or a
 * container probe takes the instance out. An **optional** check that fails means the service
 * still works, only worse (a cache is gone and requests fall back to the database): the answer
 * stays 200 with `status: "degraded"`, because restarting the instance would not bring the
 * dependency back.
 *
 * The body names each check and whether it passed, never why it failed: the endpoint is usually
 * public, and an error message can carry a host name or a credential.
 *
 * This is the HTTP side. The probe a container runs against itself is `@spy4x/server/healthcheck`.
 *
 * @module
 */

import { DEFAULT_TIMEOUT_MS, type ProbeTimer, withDeadline } from "../healthcheck.ts"

/** One check: resolves `true` when the dependency works. Anything else, or a throw, is a failure. */
export type HealthCheck = () => boolean | Promise<boolean>

/** What the endpoint says about the service as a whole. */
export type HealthStatus = "ok" | "degraded" | "down"

/** The JSON body of the answer. */
export interface HealthReport {
  /** `down` when a required check failed, `degraded` when only optional ones did, else `ok`. */
  status: HealthStatus
  /** Every check by name: `true` when it passed. */
  checks: Record<string, boolean>
  /** When the report was made, in epoch milliseconds. */
  date: number
}

/** Options of {@link createHealthHandler}. */
export interface HealthHandlerOptions {
  /** Checks the service cannot work without, by name. One failure answers 503 `down`. */
  required?: Readonly<Record<string, HealthCheck>>
  /** Checks the service can work without, by name. A failure answers 200 `degraded`. */
  optional?: Readonly<Record<string, HealthCheck>>
  /**
   * How long one check may take before it counts as failed, so a hung dependency cannot hang the
   * endpoint. Default {@link DEFAULT_TIMEOUT_MS}, two seconds.
   */
  timeoutMs?: number
  /** The clock behind `date`. Defaults to `Date.now`; tests pass a fake one. */
  now?: () => number
  /** The timer behind `timeoutMs`. Defaults to real timers; tests pass a fake one. */
  timer?: ProbeTimer
}

/** The handler {@link createHealthHandler} returns. It reads nothing from the request. */
export type HealthHandler = () => Promise<Response>

/**
 * Builds the handler of a health endpoint. Every call runs all checks at once and answers with a
 * {@link HealthReport} as JSON, marked `cache-control: no-store`: 503 when a required check
 * failed, 200 otherwise. A check that throws, rejects, resolves anything but `true` or takes longer
 * than `timeoutMs` has failed. The handler never rejects.
 *
 * It is a plain function that returns a `Response`, so it fits any server:
 *
 * ```ts
 * const health = createHealthHandler({
 *   required: { database: () => isDbConnected() },
 *   optional: { cache: () => isCacheConnected() },
 * })
 * app.get("/health", () => health()) // Hono
 * Deno.serve(health) // or the whole server
 * ```
 *
 * @throws RangeError when a name is in both `required` and `optional`, or `timeoutMs` is not a
 * finite number above 0.
 * @throws TypeError when a check is not a function.
 */
export function createHealthHandler(options: HealthHandlerOptions): HealthHandler {
  const timeoutMs = options.timeoutMs ?? DEFAULT_TIMEOUT_MS
  if (!Number.isFinite(timeoutMs) || timeoutMs <= 0) {
    throw new RangeError(`timeoutMs must be a finite number above 0, got ${timeoutMs}`)
  }
  const now = options.now ?? Date.now
  const required = Object.entries(options.required ?? {})
  const optional = Object.entries(options.optional ?? {})
  const names = new Set<string>()
  for (const [name, check] of [...required, ...optional]) {
    if (names.has(name)) throw new RangeError(`health check ${name} is both required and optional`)
    if (typeof check !== "function") throw new TypeError(`health check ${name} is not a function`)
    names.add(name)
  }

  async function passes(check: HealthCheck): Promise<boolean> {
    try {
      // The check runs inside the promise, so one that throws before its first `await` is a
      // failure like any other.
      const result = Promise.resolve().then(check)
      return await withDeadline(result, timeoutMs, () => {}, options.timer) === true
    } catch {
      return false
    }
  }

  return async function health(): Promise<Response> {
    const run = (list: [string, HealthCheck][]) =>
      Promise.all(list.map(async ([name, check]) => [name, await passes(check)] as const))
    const [requiredResults, optionalResults] = await Promise.all([run(required), run(optional)])
    const failed = (results: (readonly [string, boolean])[]) => results.some(([, ok]) => !ok)
    const status: HealthStatus = failed(requiredResults)
      ? "down"
      : failed(optionalResults)
      ? "degraded"
      : "ok"
    const report: HealthReport = {
      status,
      checks: Object.fromEntries([...requiredResults, ...optionalResults]),
      date: now(),
    }
    return new Response(JSON.stringify(report), {
      status: status === "down" ? 503 : 200,
      headers: { "content-type": "application/json", "cache-control": "no-store" },
    })
  }
}
