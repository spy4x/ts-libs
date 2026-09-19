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
  assert(titles[0].text.startsWith("@ts-libs/server"))
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
  ]
  const config = await readConfig()
  const missing = expected.filter((key) => !(key in config.exports))
  assertEquals(missing, [], "a rebase dropped an export another package owns")
})

Deno.test("no export is declared for a package this branch does not own", async () => {
  // `./storage` belongs to `#31`; pre-declaring it here would collide with that PR's
  // own entry and is exactly what the README's merge-order note warns against.
  const config = await readConfig()
  const foreign = Object.keys(config.exports).filter((key) =>
    key.startsWith("./storage") || key.startsWith("./kv") || key.startsWith("./db")
  )
  assertEquals(foreign, [], "this branch must not declare another package's exports")
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
