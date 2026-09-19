/**
 * Environment access, always through a reader.
 *
 * `rostok/scripts/backup/src/+lib.ts:6-11` reads six variables at *module scope*,
 * so importing the module throws outside rostok's environment — a library cannot
 * do that, and neither can a test that only wants one pure function. Nothing in
 * this module touches `Deno.env` until {@link systemEnv} is actually asked for a
 * value, and even that is a swap-in adapter: the rest takes an {@link EnvReader}.
 *
 * The other half of the file is the text side of the same problem — expanding
 * `~/` and `${VAR}` inside a template, and rewriting a key in a dotenv file. The
 * rewrite is anchored (`^KEY=`) because `antonshubin.com/scripts/deploy.ts:51`
 * documents the bug an unanchored "DOMAIN equals anything" matcher causes: it
 * also matches the tail of `WWW_DOMAIN=`, so the staging host ends up in both
 * keys and Let's Encrypt fails the whole certificate order.
 */

/** Reads environment values. Injected so no test depends on the process environment. */
export interface EnvReader {
  /** Value of `name`, or `undefined` when unset. An empty value counts as unset. */
  get(name: string): string | undefined
}

/** Raised when a required value is absent. */
export class MissingEnvError extends Error {
  constructor(message: string) {
    super(message)
    this.name = "MissingEnvError"
  }
}

/** The process environment. The only adapter that reads `Deno.env`, and never at module scope. */
export const systemEnv: EnvReader = {
  get: (name) => Deno.env.get(name),
}

/**
 * A reader over a fixed record — the config a caller already parsed, and the fake
 * every test uses. An empty string is normalised to `undefined` so it behaves
 * like an unset variable rather than a set-but-blank one.
 */
export function createEnvReader(values: Record<string, string | undefined>): EnvReader {
  return {
    get: (name) => {
      const value = values[name]
      return value === undefined || value === "" ? undefined : value
    },
  }
}

/**
 * Read a required value.
 *
 * @throws {MissingEnvError} When `name` is unset or blank, unless `optional`.
 * A blank value is treated as missing because `${VAR}` expanded to nothing
 * produces a path like `//backups` or a compose project with no name, which
 * fails much later and much less clearly.
 */
export function readEnvVar(
  env: EnvReader,
  name: string,
  options: { optional?: boolean } = {},
): string {
  const value = env.get(name)
  if (value === undefined) {
    if (options.optional) return ""
    throw new MissingEnvError(`missing required environment variable: ${name}`)
  }
  return value
}

/**
 * Expand a leading `~/` against an explicit home directory.
 *
 * `rostok/scripts/+lib.ts:13` takes a *user name* and builds `/home/<user>`,
 * which is the homelab's layout, not a general one. The home directory is passed
 * in instead. Anything that does not start with `~/` is returned unchanged,
 * including a bare `~` — expanding that is the shell's job, and guessing a
 * different convention here would surprise a caller who writes `~user/path`.
 *
 * @throws {MissingEnvError} When `home` is blank and the path needs expanding:
 * `~/x` with no home resolves to `/x` otherwise, i.e. silently writes at the
 * filesystem root.
 */
export function absPath(path: string, home: string): string {
  if (!path.startsWith("~/")) return path
  if (home.trim() === "") {
    throw new MissingEnvError(`cannot expand "${path}" without a home directory`)
  }
  return `${home.replace(/\/+$/, "")}/${path.slice(2)}`
}

const PLACEHOLDER = /\$\{([^}]+)}/g

/**
 * Replace every `${NAME}` with the value from `env`.
 *
 * @throws {MissingEnvError} When a placeholder has no value. Substituting an
 * empty string instead turns a missing `PATH_APPS` into a deploy into `/`.
 */
export function substituteEnvVars(template: string, env: EnvReader): string {
  return template.replace(PLACEHOLDER, (_match, rawName: string) => {
    const name = rawName.trim()
    const value = env.get(name)
    if (value === undefined) {
      throw new MissingEnvError(`environment variable '${name}' not found`)
    }
    return value
  })
}

const ENV_KEY = /^[A-Za-z_][A-Za-z0-9_]*$/

/**
 * Rewrite `KEY=…` lines in dotenv-style text, leaving every other line alone.
 *
 * Used to derive a staging env file from the production one: only the listed keys
 * change, comments and ordering survive, and nothing is written to the process
 * environment.
 *
 * The replacement goes through a function, not a string: `String.replace` treats
 * `$&`, `$1` and `$'` in a string replacement as patterns, so a value containing
 * `$&` would expand to the matched line instead of itself.
 *
 * @throws {MissingEnvError} When the text has no line for a key, or a key is not
 * a valid identifier. `deploy.ts`'s unanchored DOMAIN replacement silently
 * rewrote the wrong key; a key that is absent has to fail loudly.
 */
export function rewriteEnvValues(
  content: string,
  replacements: Record<string, string>,
): string {
  let result = content
  const missing: string[] = []

  for (const [key, value] of Object.entries(replacements)) {
    if (!ENV_KEY.test(key)) {
      throw new MissingEnvError(`"${key}" is not a valid environment variable name`)
    }
    const line = new RegExp(`^${key}=[^\\n]*$`, "m")
    if (!line.test(result)) {
      missing.push(key)
      continue
    }
    result = result.replace(line, () => `${key}=${value}`)
  }

  if (missing.length > 0) {
    throw new MissingEnvError(`no line for ${missing.join(", ")} in the env file`)
  }

  return result
}
