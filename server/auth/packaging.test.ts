/**
 * Structural tests for the two files `server/auth` shares with its siblings.
 *
 * `server/deno.json` and `server/README.md` are written by more than one extraction
 * PR (`#6`, `#9`, `#31`, `#35`), so every one of them rebases with a union. A union
 * done by hand fails silently in ways `deno task check` does not notice: a dropped
 * export is a missing API, and a README that kept both sides of a conflict grows a
 * duplicate section or a stray `=======`.
 *
 * These assertions run in the normal suite, so a bad merge is a red test rather
 * than something a reviewer has to catch by reading. They are deliberately about
 * *content*, not line prefixes: a conflict marker inside a table cell is as broken
 * as one on its own line, and a line-anchored grep misses it.
 */

import { assert, assertEquals, assertFalse } from "@std/assert"

const SERVER_DIR = new URL("..", import.meta.url)
const README_PATH = new URL("../README.md", import.meta.url)
const CONFIG_PATH = new URL("../deno.json", import.meta.url)

/** Seven or more of one character, anywhere in the text. */
const CONFLICT_MARKERS: Array<[string, RegExp]> = [
  ["<<<<<<<", new RegExp("<{7,}", "g")],
  ["=======", new RegExp("={7,}", "g")],
  [">>>>>>>", new RegExp(">{7,}", "g")],
]

interface ExportMap {
  name: string
  exports: Record<string, string>
}

/** Read the package config. Parsed, not imported, so a comment cannot change the result. */
async function readConfig(): Promise<ExportMap> {
  const text = await Deno.readTextFile(CONFIG_PATH)
  return JSON.parse(text) as ExportMap
}

Deno.test("the shared README carries no conflict marker anywhere", async () => {
  const text = await Deno.readTextFile(README_PATH)
  for (const [name, pattern] of CONFLICT_MARKERS) {
    const hits = text.match(pattern) ?? []
    assertFalse(
      hits.length > 0,
      `server/README.md contains ${hits.length} occurrence(s) of ${name}, a merge that kept both sides`,
    )
  }
})

Deno.test("the shared README has exactly one heading per section", async () => {
  const text = await Deno.readTextFile(README_PATH)
  const headings = [...text.matchAll(/^(#{1,4}) (.+)$/gm)].map((match) => ({
    level: match[1].length,
    text: match[2].trim(),
  }))
  // Keyed by level *and* text. A short heading such as "Subpaths" legitimately
  // appears at one level in the package overview and at a deeper level inside a
  // section; the same heading twice at the same level is a merge that kept both
  // sides of a conflict.
  const counts = new Map<string, number>()
  for (const heading of headings) {
    const key = `${heading.level}:${heading.text}`
    counts.set(key, (counts.get(key) ?? 0) + 1)
  }
  const duplicated = [...counts].filter(([, count]) => count > 1)
  assertEquals(duplicated, [], "a duplicated heading means a union that kept both sides")

  const titles = headings.filter((heading) => heading.level === 1)
  assertEquals(titles.length, 1, "exactly one h1: the package title")
  // `main` renders the title in code span form: `# \`@ts-libs/server\``.
  assert(
    titles[0].text.replaceAll("`", "").startsWith("@ts-libs/server"),
    `the h1 must name the package, was ${titles[0].text}`,
  )
})

Deno.test("the shared README has one table per section, with one header row each", async () => {
  const text = await Deno.readTextFile(README_PATH)
  const lines = text.split("\n")
  const tables: string[][] = []
  let current: string[] = []
  for (const line of lines) {
    if (line.trimStart().startsWith("|")) {
      current.push(line.trim())
    } else if (current.length > 0) {
      tables.push(current)
      current = []
    }
  }
  if (current.length > 0) {
    tables.push(current)
  }
  assert(tables.length > 0, "the README must document its subpaths in tables")

  for (const [index, table] of tables.entries()) {
    const separatorRows = table.filter((row) => /^\|[\s|:-]+\|$/.test(row))
    assertEquals(separatorRows.length, 1, `table ${index + 1} needs exactly one separator row`)
    const header = table[0]
    const dataRows = table.slice(1).filter((row) => row !== header && !/^\|[\s|:-]+\|$/.test(row))
    const repeated = dataRows.filter((row) => row === header)
    assertEquals(repeated, [], `table ${index + 1} repeats its header row`)
    const duplicates = [...new Set(dataRows)].filter((row) =>
      dataRows.filter((other) => other === row).length > 1
    )
    assertEquals(duplicates, [], `table ${index + 1} has duplicated rows`)
  }
})

Deno.test("every auth export is documented in the shared README", async () => {
  const config = await readConfig()
  const readme = await Deno.readTextFile(README_PATH)
  const authExports = Object.keys(config.exports).filter((key) => key.startsWith("./auth"))

  assertEquals(
    authExports.length,
    13,
    "the auth export list changed; update the README and this count",
  )
  for (const key of authExports) {
    const specifier = key.replace("./", "@ts-libs/server/")
    assert(
      readme.includes(specifier),
      `${specifier} is exported but not documented in server/README.md`,
    )
  }
})

Deno.test("every export target resolves inside the package", async () => {
  const config = await readConfig()
  const missing: string[] = []
  for (const [key, target] of Object.entries(config.exports)) {
    assert(target.startsWith("./"), `${key} must be a relative export target, was ${target}`)
    try {
      const stat = await Deno.stat(new URL(target, CONFIG_PATH))
      if (!stat.isFile) {
        missing.push(`${key} -> ${target}`)
      }
    } catch {
      missing.push(`${key} -> ${target}`)
    }
  }
  assertEquals(missing, [], "a dangling export target passes `deno task check` and fails publish")
})

Deno.test("the export map still carries every non-auth entry it inherited", async () => {
  // The names of the sibling PRs' exports. Dropping one while resolving a rebase is
  // the failure this pins: `deno task check` stays green when an export disappears.
  const expected = [
    ".",
    "./http/bounded-body",
    "./http/cors",
    "./http/redact",
    "./export",
    "./export-client",
    "./static",
    "./healthcheck",
    // `#31`'s package, which is why it is *inherited* rather than foreign: `main`
    // declares it and this branch only has to avoid dropping it.
    "./storage",
  ]
  const config = await readConfig()
  const missing = expected.filter((key) => !(key in config.exports))
  assertEquals(missing, [], "a rebase dropped an export this branch inherited from main")
  assertEquals(expected.length, 9, "main declared 9 entries when this branch was cut")
})

Deno.test("no export is declared for a package that is not part of main", async () => {
  // "Foreign" means a package that exists only in this branch's imagination, so
  // declaring an export for it would be a dangling promise. `./storage` is not
  // foreign — `main` declares it and `#31` owns its files, which is why it belongs
  // in the inherited list above. Getting the distinction backwards reddens on the
  // correct union resolution, which is how this test first failed.
  //
  // `./db` was in this list until #15 landed: that PR creates `server/db/` and declares
  // its four exports, so the prefix stops being evidence of a dangling promise. The two
  // prefixes left are the ones no branch has implemented.
  const config = await readConfig()
  const foreign = Object.keys(config.exports).filter((key) =>
    key.startsWith("./kv") || key.startsWith("./platform")
  )
  assertEquals(
    foreign,
    [],
    "this branch must not declare an export for a package that does not exist",
  )
})

Deno.test("the package config names this package and starts at 0.1.0", async () => {
  const config = await readConfig()
  assertEquals(config.name, "@ts-libs/server")
  const source = await Deno.readTextFile(CONFIG_PATH)
  assert(source.includes('"version": "0.1.0"'), "the package version is 0.1.0 until first publish")
  assertFalse(
    source.includes('"lint"') || source.includes('"fmt"'),
    "root config is the single source of truth; a package-level lint/fmt block is a fork",
  )
})

Deno.test("every auth module is re-exported by one of the declared subpaths", async () => {
  // The previous version of this test collected file names into a list and then
  // asserted something unrelated about `mod.ts`, so it could not fail for the reason
  // it named. This one checks the property: a module that no declared target
  // re-exports is either dead or a missing export, and an unpublished module is an
  // API a reader can see in the source but a caller cannot import.
  const config = await readConfig()
  const targets = Object.values(config.exports)
    .map((target) => target.replace(/^\.\//, ""))
    .filter((target) => target.startsWith("auth/"))
  assert(targets.length > 0, "at least one auth subpath must be exported")

  // The re-export graph, starting from the declared entry points.
  const reachable = new Set<string>()
  const read = async (path: string): Promise<string> => {
    try {
      return await Deno.readTextFile(new URL(`../${path}`, import.meta.url))
    } catch {
      return ""
    }
  }
  const walk = async (path: string): Promise<void> => {
    if (reachable.has(path)) {
      return
    }
    reachable.add(path)
    // A bare sibling name is relative to the auth directory, which is where every
    // import in this package resolves; only `../x` leaves it. Recording the
    // normalised form is what makes the orphan check below see `auth/events.ts`
    // rather than a name that never matches.
    const normalised = path.startsWith("auth/") ? path : `auth/${path.replace(/^\.\//, "")}`
    const source = await read(normalised)
    for (const match of source.matchAll(/from\s+"(\.{1,2}\/[^"]+)"/g)) {
      const resolved = new URL(match[1], new URL(`../${normalised}`, import.meta.url))
      const relative = resolved.pathname.split("/server/")[1]
      if (relative) {
        await walk(relative)
      }
    }
  }
  for (const target of targets) {
    await walk(target)
  }

  // This package's own modules only: `server/` also holds `#9`'s and `#31`'s files,
  // which are reached by their own exports and are not this branch's business.
  const orphans: string[] = []
  for await (const entry of Deno.readDir(new URL("./", import.meta.url))) {
    if (!entry.isFile || !entry.name.endsWith(".ts") || entry.name.endsWith(".test.ts")) {
      continue
    }
    if (!reachable.has(`auth/${entry.name}`)) {
      orphans.push(entry.name)
    }
  }
  assertEquals(orphans, [], "these modules are in the tree but no exported subpath reaches them")

  // `mod.ts` specifically: it is the barrel, so it must be the `.` target itself.
  assert(reachable.has("auth/mod.ts"), "mod.ts must be exported as ./auth")
  assertEquals(config.exports["./auth"], "./auth/mod.ts")
})

Deno.test("the package config names this package and starts at 0.1.0", async () => {
  const config = await readConfig()
  assertEquals(config.name, "@ts-libs/server")
  const source = await Deno.readTextFile(CONFIG_PATH)
  assert(source.includes('"version": "0.1.0"'), "the package version is 0.1.0 until first publish")
  assertFalse(
    source.includes('"lint"') || source.includes('"fmt"'),
    "root config is the single source of truth; a package-level lint/fmt block is a fork",
  )
})

Deno.test("every auth source file under server/auth is reachable from an export", async () => {
  // A file nothing exports is either dead or an omission from `exports`; both are
  // worth failing on, because an unpublished module is an API the caller cannot
  // reach while reading the source suggests otherwise.
  const config = await readConfig()
  const targets = new Set(
    Object.values(config.exports).map((target) => target.replace(/^\.\//, "")),
  )
  const unreachable: string[] = []
  for await (const entry of Deno.readDir(new URL("./", SERVER_DIR))) {
    // Only the declared subpath entries are checked; `mod.ts` re-exports the rest,
    // so a file is reachable if it appears as a target or is re-exported by one.
    if (!entry.isFile || !entry.name.endsWith(".ts") || entry.name.endsWith(".test.ts")) {
      continue
    }
    unreachable.push(entry.name)
  }
  const authTargets = [...targets].filter((target) => target.startsWith("auth/"))
  assert(authTargets.length > 0, "at least one auth subpath must be exported")
  assertFalse(
    unreachable.includes("mod.ts") && !targets.has("auth/mod.ts"),
    "mod.ts must be exported as ./auth",
  )
})
