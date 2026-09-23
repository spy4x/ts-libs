// A package that imports itself by its own name (`@spy4x/server/sign-in` inside `server/`)
// resolves locally through the workspace, so `deno task publish:dry` passes. JSR resolves the
// same specifier against the registry, where the version being published does not exist yet,
// and the real publish fails. That broke the first 1.0.0 publish of `@spy4x/server`. Inside a
// package, sibling files are imported by relative path; the package name is for other packages.

import { assert, assertEquals } from "@std/assert"
import { fromFileUrl, join, relative } from "@std/path"

const root = fromFileUrl(new URL("../../", import.meta.url))

/** Every `.ts` file under `dir`, skipping tests, which are never published. */
async function* publishedSources(dir: string): AsyncGenerator<string> {
  for await (const entry of Deno.readDir(dir)) {
    const path = join(dir, entry.name)
    if (entry.isDirectory) yield* publishedSources(path)
    else if (entry.name.endsWith(".ts") && !entry.name.endsWith(".test.ts")) yield path
  }
}

/** The `workspace` members named in the root `deno.jsonc`, as directory names. */
async function workspaceMembers(): Promise<string[]> {
  const text = await Deno.readTextFile(join(root, "deno.jsonc"))
  const list = text.match(/"workspace"\s*:\s*\[([^\]]*)\]/)
  assert(list, "the root deno.jsonc has no workspace list: is `root` the repository root?")
  return [...list[1].matchAll(/"\.\/([^"]+)"/g)].map((match) => match[1])
}

/** A member's package name, or `undefined` when the member's directory does not exist yet. */
async function packageName(member: string): Promise<string | undefined> {
  try {
    const config = JSON.parse(await Deno.readTextFile(join(root, member, "deno.json")))
    return config.name
  } catch (error) {
    if (error instanceof Deno.errors.NotFound) return undefined
    throw error
  }
}

Deno.test("no published file imports its own package by name", async () => {
  const offenders: string[] = []
  let scanned = 0
  for (const member of await workspaceMembers()) {
    const name = await packageName(member)
    if (name === undefined) continue
    scanned++
    // `from "…"`, a side-effect `import "…"` and a dynamic `import("…")`: `deno publish`
    // rewrites all three, so all three fail on JSR the same way.
    const ownName = new RegExp(`(?:from|import)\\s*\\(?\\s*["']${name}["'/]`)
    for await (const file of publishedSources(join(root, member))) {
      const text = await Deno.readTextFile(file)
      text.split("\n").forEach((line, index) => {
        if (ownName.test(line)) offenders.push(`${relative(root, file)}:${index + 1}`)
      })
    }
  }
  // Every package on JSR today; a wrong `root` or a broken member list must not pass by scanning
  // nothing.
  assert(scanned >= 8, `scanned ${scanned} packages, expected at least 8`)
  assertEquals(offenders, [])
})
