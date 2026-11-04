// The entry points every workspace member publishes, read from the `exports` map of its
// `deno.json`, and a `deno doc` runner. `llms.ts` builds `llms.txt` from them.

export interface Entry {
  /** The import specifier a consumer writes. */
  specifier: string
  /** The package the entry belongs to, as its directory name. */
  pkg: string
}

/** The `workspace` member directories named in the root `deno.jsonc` text, without `./`. */
export function workspaceDirs(rootConfigText: string): string[] {
  const list = rootConfigText.match(/"workspace"\s*:\s*\[([^\]]*)\]/)
  if (list === null) throw new Error(`the root deno.jsonc has no "workspace" list`)
  return [...list[1].matchAll(/"\.?\/?([^"]+)"/g)].map((match) => match[1])
}

/**
 * Throws when a top-level directory holds a `deno.json` but is not in the `workspace` list. Deno
 * would not publish such a package, and the regex read of the list drops a member silently when a
 * comment inside the array breaks it; either way `llms.txt` would shrink without a sign. A listed
 * directory that does not exist is fine: Deno skips it.
 */
export function assertWorkspaceComplete(listed: string[], withConfig: string[]): void {
  const missing = withConfig.filter((dir) => !listed.includes(dir)).sort()
  if (missing.length > 0) {
    throw new Error(
      `top-level directories with a deno.json but not in the root "workspace" list: ${
        missing.join(", ")
      }`,
    )
  }
}

/**
 * Every published entry point: one per `exports` key of each workspace member, so a key added to a
 * member's `deno.json` joins the list without a script edit. `readConfig` returns a member's
 * parsed `deno.json`, or `undefined` when its directory does not exist (Deno skips such a member
 * too). The result is sorted by specifier, so the output does not depend on member or key order.
 * `"."` becomes the bare package name; `"./tz"` becomes `@spy4x/<dir>/tz`.
 */
export function entriesFrom(
  dirs: string[],
  readConfig: (dir: string) => { exports?: Record<string, string> | string } | undefined,
): Entry[] {
  const entries: Entry[] = []
  for (const dir of dirs) {
    const config = readConfig(dir)
    if (config === undefined) continue
    const exports = typeof config.exports === "string" ? { ".": config.exports } : config.exports
    for (const key of Object.keys(exports ?? {})) {
      entries.push({ specifier: `@spy4x/${dir}${key.replace(/^\./, "")}`, pkg: dir })
    }
  }
  return entries.sort((a, b) => a.specifier.localeCompare(b.specifier))
}

/**
 * Reads and parses the `deno.json` at `path`. Only a missing file counts as absent (`undefined`);
 * any other failure, such as invalid JSON or a permission error, throws with the path in the
 * message, so a broken config stops the run instead of shrinking the list.
 */
async function readConfig(
  path: string,
): Promise<{ exports?: Record<string, string> } | undefined> {
  let text: string
  try {
    text = await Deno.readTextFile(path)
  } catch (error) {
    if (error instanceof Deno.errors.NotFound) return undefined
    throw new Error(`${path}: ${error instanceof Error ? error.message : error}`, { cause: error })
  }
  try {
    return JSON.parse(text)
  } catch (error) {
    throw new Error(`${path}: ${error instanceof Error ? error.message : error}`, { cause: error })
  }
}

/** Reads every workspace member's entry points from the repository at `root` (default: cwd). */
export async function loadEntries(root = "."): Promise<Entry[]> {
  const dirs = workspaceDirs(await Deno.readTextFile(`${root}/deno.jsonc`))
  const withConfig: string[] = []
  for await (const item of Deno.readDir(root)) {
    if (!item.isDirectory) continue
    if ((await readConfig(`${root}/${item.name}/deno.json`)) !== undefined) {
      withConfig.push(item.name)
    }
  }
  assertWorkspaceComplete(dirs, withConfig)
  const configs = new Map<string, { exports?: Record<string, string> }>()
  for (const dir of dirs) {
    const config = await readConfig(`${root}/${dir}/deno.json`)
    if (config !== undefined) configs.set(dir, config)
  }
  return entriesFrom(dirs, (dir) => configs.get(dir))
}

/** Resolves `@spy4x/<package>/<subpath>` to a file through that package's `deno.json`. */
export async function resolveEntry(specifier: string, root = "."): Promise<string> {
  const [, pkg, ...rest] = specifier.split("/")
  const config = JSON.parse(await Deno.readTextFile(`${root}/${pkg}/deno.json`))
  const key = rest.length === 0 ? "." : `./${rest.join("/")}`
  const target = config.exports?.[key]
  if (typeof target !== "string") throw new Error(`${specifier}: no "${key}" in ${pkg}/deno.json`)
  return `${pkg}/${target.replace(/^\.\//, "")}`
}

export async function denoDoc(args: string[]): Promise<string> {
  const { code, stdout, stderr } = await new Deno.Command("deno", {
    args: ["doc", ...args],
    env: { NO_COLOR: "1" },
  }).output()
  if (code !== 0) throw new Error(`deno doc ${args.join(" ")}: ${new TextDecoder().decode(stderr)}`)
  return new TextDecoder().decode(stdout)
}
