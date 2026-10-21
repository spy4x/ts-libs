/**
 * The runtime lookups behind `./process.ts`, written over an injected host object so a unit test
 * can drive the Deno, Node and Bun branches without the runtime it is running on.
 *
 * Not an entry point: nothing here is exported from the package.
 *
 * @module
 */

import type { EnvReader } from "./process.ts"

/** The globals the lookups read: `Deno` on Deno, `process` on Node and Bun. */
export interface RuntimeHost {
  Deno?: {
    env?: { get(name: string): string | undefined }
    pid?: number
  }
  process?: {
    env?: Record<string, string | undefined>
    pid?: number
  }
}

/** The running process's globals, read on every call so nothing is captured at import time. */
export function currentHost(): RuntimeHost {
  return globalThis as unknown as RuntimeHost
}

function blankToUndefined(value: string | undefined): string | undefined {
  return value === undefined || value === "" ? undefined : value
}

/**
 * An {@link EnvReader} over `host`. Deno is asked first: Deno 2 also defines `process`, and its own
 * API is the one its permission flags document.
 *
 * @throws {Error} From `get`, when the host has neither `Deno.env` nor `process.env`.
 */
export function envReaderOver(host: () => RuntimeHost): EnvReader {
  return {
    get(name) {
      const { Deno, process } = host()
      if (Deno?.env) return blankToUndefined(Deno.env.get(name))
      if (process?.env) return blankToUndefined(process.env[name])
      throw new Error("no environment: this runtime has neither Deno.env nor process.env")
    },
  }
}

/** The process id from `host`, or `undefined` on a runtime that has none (a browser, a worker). */
export function processIdOf(host: RuntimeHost): number | undefined {
  return host.Deno?.pid ?? host.process?.pid
}
