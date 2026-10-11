/**
 * Reading build-time environment values in browser code.
 *
 * A bundler replaces `import.meta.env` (or a similar object) with the values of the build. This
 * module takes that object as a parameter, so it names no bundler and runs in a test with a plain
 * object.
 *
 * @module
 */

/** The values of a build, as a bundler exposes them. */
export type BuildEnv = Readonly<Record<string, string | boolean | undefined>>

/** Options of {@link readBuildEnvVar}. */
export interface ReadBuildEnvVarOptions {
  /** Give `""` for a missing value instead of throwing. */
  optional?: boolean
  /**
   * A prefix the bundler requires on every name it exposes to the browser (Vite: `VITE_`). The
   * plain `name` is tried first, then `prefix + name`.
   */
  prefix?: string
}

/** Thrown by {@link readBuildEnvVar} for a required variable that is missing or empty. */
export class MissingBuildEnvError extends Error {
  /** The name that was asked for, without a prefix. */
  readonly variable: string

  constructor(variable: string) {
    super(`Environment variable ${variable} is required but not set.`)
    this.name = "MissingBuildEnvError"
    this.variable = variable
  }
}

/**
 * One value of the build's environment: `env[name]`, else `env[prefix + name]`. An empty string
 * counts as missing. Only strings count: a bundler's boolean flags (`DEV`, `PROD`) are not values
 * of the project.
 *
 * @example
 * ```ts
 * const apiUrl = readBuildEnvVar(import.meta.env, "API_URL", { prefix: "VITE_" })
 * const sentry = readBuildEnvVar(import.meta.env, "SENTRY_DSN", { optional: true })
 * ```
 *
 * @throws {MissingBuildEnvError} When the value is missing and `options.optional` is not set.
 */
export function readBuildEnvVar(
  env: BuildEnv,
  name: string,
  options: ReadBuildEnvVarOptions = {},
): string {
  const direct = env[name]
  const prefixed = options.prefix === undefined ? undefined : env[`${options.prefix}${name}`]
  const value = typeof direct === "string" && direct !== ""
    ? direct
    : typeof prefixed === "string"
    ? prefixed
    : ""
  if (value === "") {
    if (options.optional) return ""
    throw new MissingBuildEnvError(name)
  }
  return value
}
