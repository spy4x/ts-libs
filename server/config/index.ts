/**
 * `@spy4x/server/config` — environment to typed config, over an injected `EnvReader`.
 *
 * Import the barrel for both halves, or a subpath (`./env.ts`, `./config.ts`) directly within the
 * package.
 *
 * `EnvReader`, `MissingEnvError`, `systemEnv`, `createEnvReader`, `readEnvVar`, `loadConfig`,
 * `ConfigError`, `ConfigIssue`, `stringBoolean`.
 *
 * `loadConfig` reads the environment through one arktype schema, validated once at start-up: every
 * field is named once, its shape is checked once, and a bad or missing value fails loudly instead of
 * turning into `NaN` or an unchecked cast three requests later. `readEnvVar` is the small
 * single-variable helper for the one value a caller needs before the rest of its configuration can
 * even be assembled (`ENV`, deciding which schema to validate against, for example).
 *
 * **An empty string counts as missing, in every reader.** A placeholder that expanded to nothing
 * (`${VAR}` with no value, a blank `.env` line) is indistinguishable from a real empty string once it
 * reaches the process environment, and treating it as present would let a broken deploy script
 * configure a service with `""` instead of failing at start-up.
 *
 * **Scope: a flat schema.** `loadConfig(schema, env = systemEnv)` reads exactly the top-level keys an
 * arktype object schema declares — `type({ AUTH_PEPPER: "string", PORT: "string.integer.parse" })`
 * — as environment variable names, one level deep. It finds those keys through arktype's own
 * documented `Type.props` (`required`/`optional`/defaulted, each `{ key, kind, ... }` —
 * `arktype/out/variants/object.ts`'s object-type interface): `.props` stays correct through
 * `.describe()` and `.configure()`, and throws arktype's own `ParseError` on a union or a piped root,
 * which `loadConfig` wraps as `TypeError`. A schema whose `.props` comes back empty (an
 * index-signature-only schema such as `type({ "[/^APP_/]": "string" })`, which validates but names no
 * field) is refused the same way, rather than silently reading nothing. A nested object in the schema
 * is not read from nested environment variables — there is no such thing here.
 *
 * **Numbers and booleans are strings until a morph says otherwise.** Every environment variable
 * arrives as `string | undefined`. arktype's own `"string.integer.parse"` and `"string.numeric.parse"`
 * cover the numeric cases. There is no built-in string-to-boolean morph, so this module exports
 * `stringBoolean`: exactly `"true"` or `"false"`, nothing else — a format that also accepted `"1"`,
 * `"yes"` or `"on"` is a format that will one day be typo'd into a fourth spelling that silently reads
 * as false instead of failing.
 *
 * **A key is read only when it is not blank**, so `raw[name] = value` is skipped entirely rather than
 * set to `undefined`: arktype's own `exactOptionalPropertyTypes` distinguishes an object key that is
 * absent from one explicitly set to `undefined`, and would otherwise reject a genuinely-unset optional
 * variable as "must be a string, was undefined" instead of accepting its absence. The same omission is
 * also what lets a defaulted key (`PORT: "string.integer.parse = '3000'"` — required, not optional;
 * arktype's default syntax is its own way of saying "may be absent") fall back to its schema default
 * when the variable is absent.
 *
 * **The failure never carries a value — for an arktype rejection.** arktype's own rejection text
 * echoes the offending input (`must be a well-formed integer string (was "admin")`), which is exactly
 * the kind of text a container orchestrator's log capture was never meant to hold a secret in.
 * `ConfigError.variables` lists only the top-level environment-variable names that failed, sorted;
 * nothing here reads arktype's `.message`, `.summary` or `.actual` for a value that reached
 * validation. That top-level restriction is deliberate: a failure inside a _parsed_ value — a JSON map
 * whose entries are checked one by one, say — puts the value's own keys deeper in arktype's path
 * (`API_TOKENS["sk_live_…"]`), so only `issue.path`'s first segment is used, and only when it is one
 * of the schema's own declared keys. A hand-set `ctx.reject({ path: [...] })` inside a `.narrow()`
 * could otherwise put anything at all in that first segment; the same restriction closes that route
 * too.
 *
 * **`ConfigError.issues` says why each variable failed.** Beside `variables` (unchanged), `issues` is
 * a list of `{ name, reason }`, one per variable, in the same sorted order as `variables`. A reason is
 * one of three things: `is missing`, `has an invalid value`, or `must be <text arktype builds from the
 * schema>`, for example `must be at least length 9` or `must be "dev" or "prod"`. The fixed `has an
 * invalid value` is used for a failure inside a parsed value (a JSON map) and for every `predicate`
 * issue: a `.narrow()` or `ctx.mustBe` text, or `string.url`, because that text is written by the
 * schema's author and may quote the value. A union's text is cut to what sits between `<name> must be`
 * and the first `(was`, or falls back to the fixed phrase. As a last guard, any reason that still
 * contains the raw value falls back too. `actual` and arktype's own `message` are never read.
 * `message` is unchanged, so a start-up log line that wants reasons formats `issues` itself. A morph
 * that threw gives an empty `issues`.
 *
 * **A root-level check is reported by its own `expected` text, printed verbatim.** A cross-field rule
 * written with `.narrow()` (financy's "`TELEGRAM_WEBHOOK_URL` is required outside dev", checked across
 * two fields) fails at no single key, so arktype reports it at the root path, mapped here to the
 * issue's own `expected` text — never `actual`, which is the whole rejected object. Write it as a rule
 * (`TELEGRAM_WEBHOOK_URL is required outside dev`), never built from the value:
 * ``ctx.mustBe(`shorter than ${value}`)`` would print the value. Reading `expected` is guarded: it is
 * a getter that throws for a rejection built with arktype's other documented style,
 * `ctx.reject({ message })` or `ctx.reject({ problem })`, so a thrown or empty `expected` falls back
 * to a fixed `(cross-field check)` label instead of crashing `loadConfig`.
 *
 * **A morph that throws is not an arktype rejection, and cannot be scrubbed the same way.** A morph
 * written as a `.pipe` callback that throws its own `Error` (`bad ${value}`, say) escapes arktype's
 * own error path entirely — the thrown error's message can carry the value, and nothing here wrote
 * that message, so nothing here can safely rewrite it. `loadConfig` catches anything thrown while
 * validating and rethrows a `ConfigError` with an empty `variables` list and a generic message,
 * explicitly without keeping the original as `cause` — a `cause` is exactly a place for the original's
 * message, value included, to survive un-scrubbed onto the new error. A morph that needs to fail
 * without carrying its own value can report the variable by name instead: write it with `.pipe.try` or
 * `ctx.error` (both arktype's own), either of which reports through the normal rejection path above
 * rather than throwing.
 *
 * ```ts
 * import { type } from "arktype"
 * import { loadConfig, stringBoolean } from "@spy4x/server/config"
 *
 * const configSchema = type({
 *   ENV: "'dev' | 'prod'",
 *   AUTH_PEPPER: "string > 0",
 *   PORT: "string.integer.parse",
 *   "FEATURE_FLAG?": stringBoolean,
 * })
 *
 * // reads Deno.env; a test injects createEnvReader({...}) instead
 * export const config = loadConfig(configSchema)
 * ```
 *
 * @module
 */
export * from "./env.ts"
export * from "./config.ts"
