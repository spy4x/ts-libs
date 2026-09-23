/**
 * Reading environment values without touching `Deno.env` at import time.
 *
 * Ported from this repository's own `ops/env.ts`, removed from the tree in #67
 * (`git log --all --oneline -- ops/env.ts`), trimmed to the environment-reading primitive:
 * `absPath`, `substituteEnvVars` and `rewriteEnvValues` were `ops`-specific deploy-templating
 * helpers, not part of "environment to typed config", and are not ported here.
 *
 * **An empty string counts as unset, everywhere in this module.** A placeholder that expanded to
 * nothing (`${VAR}` with no value, a blank line in a `.env` file) is indistinguishable from a real
 * empty string once it reaches the process environment, and treating it as "present" would let a
 * broken deploy script configure a service with `""` instead of failing at start-up. The source
 * file normalised this inconsistently — `systemEnv.get` returned a real blank value unchanged,
 * while `createEnvReader` (the one path any of its own tests exercised) folded it to `undefined` —
 * so a variable that was genuinely blank in production behaved differently from the same case
 * under test. Fixed here by normalising in both readers, at the one boundary every caller goes
 * through.
 */

/** Reads environment values. Injected so nothing here depends on the process environment. */
export interface EnvReader {
  /** Value of `name`, or `undefined` when unset or blank. */
  get(name: string): string | undefined
}

/** Raised when a required environment variable is missing or blank. Never carries a value. */
export class MissingEnvError extends Error {
  constructor(name: string) {
    super(`missing required environment variable: ${name}`)
    this.name = "MissingEnvError"
  }
}

function blankToUndefined(value: string | undefined): string | undefined {
  return value === undefined || value === "" ? undefined : value
}

/** The process environment. The only adapter that reads `Deno.env`, and never at module scope. */
export const systemEnv: EnvReader = {
  get: (name) => blankToUndefined(Deno.env.get(name)),
}

/**
 * An `EnvReader` over a fixed record — what a unit test injects instead of the process
 * environment, so a config or middleware test runs under `--allow-read --allow-env` without any
 * environment variable actually being set.
 */
export function createEnvReader(values: Record<string, string | undefined>): EnvReader {
  return {
    get: (name) => blankToUndefined(values[name]),
  }
}

/**
 * Read one required value now, outside a schema — for the one variable a caller needs before the
 * rest of its configuration can even be assembled (`ENV`, deciding which schema to validate
 * against, for example). {@link loadConfig} in `./config.ts` is the entry point for everything
 * else.
 *
 * @throws {MissingEnvError} When `name` is unset or blank, unless `optional`.
 */
export function readEnvVar(
  env: EnvReader,
  name: string,
  options: { optional?: boolean } = {},
): string {
  const value = env.get(name)
  if (value === undefined) {
    if (options.optional) return ""
    throw new MissingEnvError(name)
  }
  return value
}
