/**
 * Runtime configuration for a single-page app that is built once and configured at deploy time.
 *
 * The container writes a small JSON file (usually `/config.json`) at start-up; the app fetches it
 * before it renders. A missing, unreachable or invalid file gives the caller's defaults rather
 * than a blank page. The module reads no global at import time: `fetch` is looked up when
 * {@link loadRuntimeConfig} runs, and a caller may pass its own.
 *
 * @module
 */

import type { Type } from "arktype"
import { validate } from "@spy4x/validation"
import type { InferSchema } from "../universal/schema.ts"

/** Where {@link loadRuntimeConfig} looks when the caller names no other address. */
export const DEFAULT_RUNTIME_CONFIG_URL = "/config.json"

/** What {@link loadRuntimeConfig} needs besides the schema. */
export interface LoadRuntimeConfigOptions<S extends Type> {
  /** The file's address. Defaults to {@link DEFAULT_RUNTIME_CONFIG_URL}. */
  url?: string
  /** Replaces the global `fetch`; tests use it. */
  fetcher?: typeof fetch
  /** Returned (and a warning logged) when the file cannot be read or fails the schema. */
  defaults: InferSchema<S>
}

/**
 * Fetches `url` and validates the JSON with `schema`. The request skips the browser's HTTP cache:
 * the file changes with the container, and a service worker may keep its own copy for an offline
 * start. Any failure (network, a status other than 2xx, bad JSON, a body that is not a JSON object, a value the schema rejects)
 * logs one `console.warn` and resolves to `defaults`; it never throws.
 *
 * Keys the schema does not name are kept, as arktype does by default. Pass
 * `schema.onUndeclaredKey("delete")` to drop them.
 *
 * @example
 * ```ts
 * const schema = type({ "env?": "string" }).onUndeclaredKey("delete")
 * const config = await loadRuntimeConfig(schema, { defaults: {} })
 * ```
 */
export async function loadRuntimeConfig<S extends Type>(
  schema: S,
  options: LoadRuntimeConfigOptions<S>,
): Promise<InferSchema<S>> {
  try {
    const response = await (options.fetcher ?? fetch)(
      options.url ?? DEFAULT_RUNTIME_CONFIG_URL,
      { cache: "no-store" },
    )
    if (!response.ok) throw new Error(`status ${response.status}`)
    const json: unknown = await response.json()
    // A schema whose keys are all optional accepts an array; a config file is always an object.
    if (typeof json !== "object" || json === null || Array.isArray(json)) {
      throw new Error("not a JSON object")
    }
    const result = validate(schema, json)
    if (result.error) throw new Error(result.error.description)
    return result.data as InferSchema<S>
  } catch (error) {
    console.warn("Runtime config ignored, using defaults:", error)
    return options.defaults
  }
}
