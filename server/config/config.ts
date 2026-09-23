/**
 * A whole environment, read once and validated against one arktype schema.
 *
 * Six apps each carry their own version of this shape today: a class whose fields are one
 * `getEnvVar("NAME")` call apiece (`template/apps/api/services/config.ts`, identical in
 * `financy`), with a type-cast (`as "dev" | "prod"`) doing the work a real check should and
 * `Number(getEnvVar(...))` accepting `NaN` for a malformed number without complaint. `loadConfig`
 * replaces the per-field calls with one schema: every field is named once, its shape is checked
 * once, and a bad or missing value fails at start-up instead of turning into `NaN` or an
 * unchecked cast three requests later.
 *
 * **Scope: a flat schema.** `loadConfig` reads exactly the top-level keys an arktype object
 * schema declares — `type({ AUTH_PEPPER: "string", PORT: "string.integer.parse" })` — as
 * environment variable names, one level deep. A nested object in the schema is not read from
 * nested environment variables; there is no such thing. The config keys are the environment
 * variable names verbatim, so `SCREAMING_SNAKE_CASE` (or any other convention) is the caller's
 * choice, not this module's.
 *
 * **Numbers and booleans are strings until a morph says otherwise.** Every environment variable
 * arrives as `string | undefined`; arktype's own `"string.integer.parse"` and
 * `"string.numeric.parse"` cover the numeric cases (see the arktype documentation for the
 * distinction). There is no built-in string-to-boolean morph, so this module exports
 * {@link stringBoolean}: exactly `"true"` or `"false"`, nothing else. A format that also accepted
 * `"1"`, `"yes"` or `"on"` is a format that will one day be typo'd into a fourth spelling that
 * silently reads as false instead of failing.
 *
 * **A missing value and a blank one are the same failure**, via `EnvReader` in `./env.ts`: a
 * placeholder that expanded to nothing looks exactly like a value that was never set, so both are
 * "missing" rather than one being a mysterious empty string three layers down.
 *
 * **The failure never carries a value.** arktype's own rejection message echoes the offending
 * input (`"must be a well-formed integer string (was \"admin\")"`), which is exactly the kind of
 * text a container orchestrator captures into a log it did not ask to hold a secret. `loadConfig`
 * only ever reports which environment variables failed, by name, in {@link ConfigError.variables} —
 * never the arktype summary, never `.message`, never the value that was rejected.
 */
import { type SchemaOutput, validate } from "@ts-libs/validation/validate"
import { type } from "arktype"
import type { Type } from "arktype"
import { type EnvReader, systemEnv } from "./env.ts"

/**
 * Raised by {@link loadConfig} when one or more environment variables are missing, blank, or fail
 * the schema. `variables` names every one of them; none of their values, valid or not, appear
 * anywhere on this error.
 */
export class ConfigError extends Error {
  constructor(public readonly variables: readonly string[]) {
    super(`invalid or missing environment variable(s): ${variables.join(", ")}`)
    this.name = "ConfigError"
  }
}

/**
 * `"true"` or `"false"`, exactly — an environment boolean written by a person or a deploy script,
 * not inferred from `"1"`, `"yes"` or an empty string. See the module-level note on why the set of
 * accepted spellings is kept to two.
 */
export const stringBoolean = type("'true' | 'false'").pipe((value) => value === "true")

/**
 * The environment-variable names a flat arktype object schema declares, required and optional
 * together. Reads arktype's own `Type.json` structure rather than re-deriving it, so this stays
 * correct for a schema built with morphs (`stringBoolean`, `"string.integer.parse"`) as well as
 * plain strings.
 *
 * @throws {TypeError} When `schema` is not an object schema — {@link loadConfig}'s one
 * precondition.
 */
function objectSchemaKeys(schema: { json: object }): string[] {
  const shape = schema.json as {
    domain?: string
    required?: { key: string }[]
    optional?: { key: string }[]
  }
  if (shape.domain !== "object") {
    throw new TypeError("loadConfig requires a flat object schema, built with `type({ ... })`")
  }
  return [
    ...(shape.required ?? []).map((entry) => entry.key),
    ...(shape.optional ?? []).map((entry) => entry.key),
  ]
}

/**
 * Read every environment variable `schema` declares and validate them together, once.
 *
 * A key is left out of the value handed to arktype when `env.get(name)` returns `undefined` —
 * never set as the literal value `undefined` — so an optional key that is genuinely absent is
 * accepted as absent, and only a required key that is absent is reported as missing.
 *
 * @throws {ConfigError} One or more of the schema's keys is missing, blank, or fails its check.
 * @example
 * ```ts
 * const configSchema = type({
 *   ENV: "'dev' | 'prod'",
 *   AUTH_PEPPER: "string > 0",
 *   PORT: "string.integer.parse",
 *   FEATURE_FLAG: stringBoolean,
 * })
 * const config = loadConfig(configSchema)
 * ```
 */
export function loadConfig<T extends Type>(schema: T, env: EnvReader = systemEnv): SchemaOutput<T> {
  const raw: Record<string, string> = {}
  for (const name of objectSchemaKeys(schema)) {
    const value = env.get(name)
    if (value !== undefined) raw[name] = value
  }
  const { data, error } = validate(schema, raw)
  if (error) {
    throw new ConfigError(Object.keys(error.details.byPath).sort())
  }
  return data
}
