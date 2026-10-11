/**
 * Test helpers for browser code. Import this subpath from tests only.
 *
 * @module
 */

import { memoryStorage } from "./storage.ts"

/**
 * Puts a `memoryStorage` in place of the runtime's global `localStorage`, for one test, and
 * gives it and the way back.
 *
 * A plain assignment does not replace it: in Deno `localStorage` is an accessor on `globalThis`,
 * and it keeps its values on disk from one run to the next. This redefines the property, and
 * `restore()` puts the original back, or removes the property when there was none.
 *
 * @example
 * ```ts
 * const { kept, restore } = installLocalStorage()
 * try {
 *   localStorage.setItem(`theme`, `dark`)
 *   expect(kept.size).toBe(1)
 * } finally {
 *   restore()
 * }
 * ```
 */
export function installLocalStorage(
  initial: Record<string, string> = {},
): { kept: ReturnType<typeof memoryStorage>; restore(): void } {
  const kept = memoryStorage(initial)
  const real = Object.getOwnPropertyDescriptor(globalThis, "localStorage")
  Object.defineProperty(globalThis, "localStorage", { configurable: true, value: kept })
  return {
    kept,
    restore() {
      if (real) Object.defineProperty(globalThis, "localStorage", real)
      else delete (globalThis as { localStorage?: unknown }).localStorage
    },
  }
}
