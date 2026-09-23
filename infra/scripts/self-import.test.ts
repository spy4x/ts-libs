// A package that imports itself by its own name (`@spy4x/server/sign-in` inside `server/`)
// resolves locally through the workspace, so `deno task publish:dry` passes. JSR resolves the
// same specifier against the registry, where the version being published does not exist yet,
// and the real publish fails. That broke the first 1.0.0 publish of `@spy4x/server`. Inside a
// package, sibling files are imported by relative path; the package name is for other packages.

import { assertEquals } from "@std/assert"
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

Deno.test("no published file imports its own package by name", async () => {
  const offenders: string[] = []
  for await (const entry of Deno.readDir(root)) {
    if (!entry.isDirectory) continue
    let config: { name?: string }
    try {
      config = JSON.parse(await Deno.readTextFile(join(root, entry.name, "deno.json")))
    } catch {
      continue
    }
    if (!config.name) continue
    const ownName = new RegExp(`from\\s+["']${config.name}["'/]`)
    for await (const file of publishedSources(join(root, entry.name))) {
      const text = await Deno.readTextFile(file)
      text.split("\n").forEach((line, index) => {
        if (ownName.test(line)) offenders.push(`${relative(root, file)}:${index + 1}`)
      })
    }
  }
  assertEquals(offenders, [])
})
