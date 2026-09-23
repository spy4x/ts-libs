/**
 * A whole environment, read once and validated against one arktype schema.
 *
 * Six apps each carry their own version of this shape today: a class whose fields are one
 * `getEnvVar("NAME")` call apiece (`template/apps/api/services/config.ts`; `financy`'s carries the
 * same shape plus three Telegram-specific fields of its own), with a type-cast
 * (`as "dev" | "prod"`) doing the work a real check should and `Number(getEnvVar(...))` accepting
 * `NaN` for a malformed number without complaint. `loadConfig` replaces the per-field calls with
 * one schema: every field is named once, its shape is checked once, and a bad or missing value
 * fails at start-up instead of turning into `NaN` or an unchecked cast three requests later.
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
 * **The failure never carries a value — for an arktype rejection.** arktype's own rejection
 * message echoes the offending input (`"must be a well-formed integer string (was \"admin\")"`),
 * which is exactly the kind of text a container orchestrator captures into a log it did not ask to
 * hold a secret. `loadConfig` only ever reports which environment variables failed, by name, in
 * {@link ConfigError.variables} — never the arktype summary, never `.message`, never `.actual`, and
 * never a path segment that came from inside a parsed value (a JSON map's own key, for example) —
 * only the top-level key a declared field owns. A root-level check written with `.narrow()` (a
 * cross-field rule such as "X is required outside dev") fails at no single key, so its failure is
 * reported by its own `expected` text, printed verbatim. Write it as a rule
 * (`TELEGRAM_WEBHOOK_URL is required outside dev`), never built from the value:
 * `ctx.mustBe(\`shorter than ${value}\`)` would print the value. A morph that *throws* rather than
 * reporting through arktype's own rejection path is a second case: nothing here can recover the
 * value such a throw might carry in its own message, so `loadConfig` catches anything thrown while
 * validating and rethrows a `ConfigError` that carries none of it, without keeping the original as
 * `cause` (a `cause` is exactly a place for the original's message, value included, to survive
 * un-scrubbed). A morph that needs to fail without carrying its own value can report the variable
 * by name instead, with `.pipe.try` or `ctx.error` — see `server/README.md`.
 */
import { type SchemaOutput, validate, type ValidationResult } from "@ts-libs/validation/validate"
import { type } from "arktype"
import type { Out, Type } from "arktype"
import { type EnvReader, systemEnv } from "./env.ts"

/** A root-level failure (a `.narrow()` rejection with no single field) reads as this label. */
const CROSS_FIELD_LABEL = "(cross-field check)"

/**
 * Raised by {@link loadConfig} when one or more environment variables are missing, blank, or fail
 * the schema. `variables` names every one of them; none of their values, valid or not, appear
 * anywhere on this error.
 */
export class ConfigError extends Error {
  constructor(public readonly variables: readonly string[]) {
    super(
      variables.length > 0
        ? `invalid or missing environment variable(s): ${variables.join(", ")}`
        : "invalid or missing environment variable(s): a validation step threw instead of " +
          "reporting an issue",
    )
    this.name = "ConfigError"
  }
}

/**
 * `"true"` or `"false"`, exactly — an environment boolean written by a person or a deploy script,
 * not inferred from `"1"`, `"yes"` or an empty string. See the module-level note on why the set of
 * accepted spellings is kept to two.
 */
export const stringBoolean: Type<(In: "true" | "false") => Out<boolean>> = type("'true' | 'false'")
  .pipe((value) => value === "true")

/**
 * The environment-variable names a flat arktype object schema declares, required, optional and
 * defaulted together. Reads arktype's own, documented `Type.props`
 * (`arktype/out/variants/object.ts`'s object-type interface) rather than the internal `Type.json`
 * representation — `.props` gives the same key list for a
 * plain schema, is unaffected by `.describe()` or `.configure()`, and — its actual advantage over
 * `.json` — throws arktype's own `ParseError` on a union or a piped root, so a schema `loadConfig`
 * cannot make sense of is refused loudly.
 *
 * @throws {TypeError} When `schema` is not a flat object schema (a union or a piped root —
 * arktype's own `ParseError` from `.props` is wrapped as the cause), or when it declares no
 * properties at all
 * (an index-signature-only schema such as `type({ "[/^APP_/]": "string" })`, which `.props` reports
 * as an empty list — reading nothing from a schema that looks like it should read something is a
 * silent no-op, not a valid empty config).
 */
function objectSchemaKeys(schema: Type): string[] {
  let props: unknown
  try {
    props = (schema as unknown as { props: unknown }).props
  } catch (cause) {
    throw new TypeError(
      "loadConfig requires a flat object schema, built with `type({ ... })` — not a union or a " +
        "piped root",
      { cause },
    )
  }
  if (!Array.isArray(props) || props.length === 0) {
    throw new TypeError(
      "loadConfig requires a schema that declares at least one key by name " +
        "(an index-signature-only schema declares none)",
    )
  }
  return props.map((prop) => String((prop as { key: PropertyKey }).key))
}

/**
 * The value-free label for a failing issue that names no declared key: a root-level `.narrow()`
 * failure, or a hand-set `path` that does not start with one. Reads `issue.expected` (never
 * `actual`, which can be the whole rejected value) — never `.message` or `.summary`, and the read
 * itself is guarded, because `expected` is a getter that throws for a rejection built with
 * `ctx.reject({ message })` or `ctx.reject({ problem })` instead of `ctx.reject({ expected })`.
 * Falls back to a fixed label when the read throws, or when it is not a non-empty string.
 */
function crossFieldLabel(issue: { expected: string }): string {
  try {
    const expected = issue.expected
    return typeof expected === "string" && expected.length > 0 ? expected : CROSS_FIELD_LABEL
  } catch {
    return CROSS_FIELD_LABEL
  }
}

/**
 * Read every environment variable `schema` declares and validate them together, once.
 *
 * A key is left out of the value handed to arktype when `env.get(name)` returns `undefined` —
 * never set as the literal value `undefined` — so an optional key that is genuinely absent is
 * accepted as absent, and only a required key that is absent is reported as missing.
 *
 * @throws {ConfigError} One or more of the schema's keys is missing, blank, or fails its check —
 * or a morph inside the schema threw instead of reporting through arktype's own rejection path.
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
  const keys = objectSchemaKeys(schema)
  const declaredKeys = new Set(keys)
  const raw: Record<string, string> = {}
  for (const name of keys) {
    const value = env.get(name)
    if (value !== undefined) raw[name] = value
  }
  let result: ValidationResult<T>
  try {
    result = validate(schema, raw)
  } catch {
    // A morph that throws instead of reporting through arktype's own rejection path can carry the
    // value in its own message (`Error: bad ${value}`). Nothing here can scrub a message it did
    // not write, so the original is discarded rather than kept as `cause`.
    throw new ConfigError([])
  }
  const { data, error } = result
  if (error) {
    const variables = new Set<string>()
    for (const issue of error.details) {
      // Only the first path segment, and only when it is one of the schema's own keys: a failure
      // inside a parsed value (a JSON map, say) puts the value's own keys deeper in the path, and
      // a hand-set `ctx.reject({ path: [...] })` can put anything at all in the first segment. A
      // path this schema never declared goes through the value-free cross-field label instead.
      const first = issue.path[0]
      variables.add(
        typeof first === "string" && declaredKeys.has(first) ? first : crossFieldLabel(issue),
      )
    }
    throw new ConfigError([...variables].sort())
  }
  return data
}
