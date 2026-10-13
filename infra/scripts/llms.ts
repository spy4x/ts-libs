// Writes `llms.txt` and `llms-full.txt` at the repository root, for an agent working in another
// repository that uses this library. Run with `deno task llms`.
//
// `llms.txt` lists what every published entry point exports, one line each, as four fields
// separated by tabs: name, kind, import specifier and the first sentence of its JSDoc
// (`exportLine`). Agents in other repositories search it with `grep`, so every line stands alone;
// the lines that are not exports (the header and the fingerprint) start with `#`. A type named
// after a function or class whose parameters it describes is left out (`describesParameters`). The names, kinds and
// JSDoc come from `deno doc --json`; the entry points come from the same `exports` maps
// `contract.ts` reads. `llms-full.txt` joins the root README and every package README.
//
// `deno doc` needs `--allow-run`, which the unit tier does not have, so the unit test cannot
// regenerate `llms.txt`. Instead the file ends with a fingerprint of the entry points' export
// surface (`surfaceFingerprint`), which the test recomputes with read access alone.

import { dirname, join } from "@std/path"
import { denoDoc, type Entry, loadEntries, resolveEntry } from "./contract.ts"

/** One exported name, as `llms.txt` lists it. */
export interface ExportedName {
  name: string
  /** `function`, `class`, `interface`, `type`, `enum` or `constant`. */
  kind: string
  /**
   * First sentence of the JSDoc; empty when the export has none. A deprecated export's starts with
   * `Deprecated: ` and the first sentence of its `@deprecated` text.
   */
  summary: string
}

/** One entry point with everything it exports. */
export interface EntryExports {
  entry: Entry
  exports: ExportedName[]
}

const KINDS: Record<string, string> = {
  variable: "constant",
  typeAlias: "type",
}

/**
 * The first sentence of a JSDoc text, on one line. A `{@link X}` reads as `X`. Empty when there is
 * no text: a summary is never invented.
 */
export function firstSentence(doc: string | undefined): string {
  const paragraph = (doc ?? "").trim().split(/\n\s*\n/)[0]
  const flat = paragraph.replace(/\{@link(?:code|plain)?\s+([^}\s|]+)(?:[\s|][^}]*)?\}/g, "$1")
    .replace(/\s+/g, " ").trim()
  let end = -1
  for (const match of flat.matchAll(/[.!?](?:\s|$)/g)) {
    // "e.g." and "i.e." do not end a sentence.
    if (/(?:^|\s)(?:e\.g|i\.e)$/i.test(flat.slice(0, match.index))) continue
    end = match.index
    break
  }
  return end === -1 ? flat : flat.slice(0, end + 1)
}

interface DocTag {
  kind: string
  doc?: string
}

interface DocJson {
  nodes: Record<string, {
    /** The module's own JSDoc; a `@deprecated` tag here covers every export of the module. */
    module_doc?: { tags?: DocTag[] }
    symbols: {
      name: string
      declarations: { kind: string; jsDoc?: { doc?: string; tags?: DocTag[] } }[]
    }[]
  }>
}

/**
 * The summary of an export whose JSDoc, or whose module's JSDoc, carries `@deprecated`: the
 * word, the first sentence of the tag's text (which names the replacement), then the summary.
 * Without the tag the summary comes back unchanged.
 */
export function deprecatedSummary(summary: string, tags: DocTag[] | undefined): string {
  const tag = tags?.find((item) => item.kind === `deprecated`)
  if (tag === undefined) return summary
  const reason = firstSentence(tag.doc)
  const stop = /[.!?]$/.test(reason) ? `` : `.`
  return `${reason === `` ? `Deprecated.` : `Deprecated: ${reason}${stop}`} ${summary}`.trim()
}

/** The exports in `deno doc --json` output, sorted by name (code-unit order, locale-free). */
export function exportsFromDocJson(json: DocJson): ExportedName[] {
  const found: ExportedName[] = []
  for (const node of Object.values(json.nodes)) {
    for (const symbol of node.symbols) {
      const first = symbol.declarations[0]
      if (first === undefined) continue
      // Overloads share a name; the first declaration that has a JSDoc carries the summary.
      const documented = symbol.declarations.find((declaration) => declaration.jsDoc?.doc)
      const own = symbol.declarations.find((declaration) =>
        declaration.jsDoc?.tags?.some((tag) => tag.kind === `deprecated`)
      )
      found.push({
        name: symbol.name,
        kind: KINDS[first.kind] ?? first.kind,
        summary: deprecatedSummary(
          firstSentence(documented?.jsDoc?.doc),
          own?.jsDoc?.tags ?? node.module_doc?.tags,
        ),
      })
    }
  }
  return found.sort((a, b) => (a.name < b.name ? -1 : a.name > b.name ? 1 : 0))
}

/** The endings of a type that describes the parameters of the function or class it is named after. */
export const PARAMETER_SUFFIXES = [`Props`, `Labels`, `Options`, `Config`, `Deps`, `Input`]

/**
 * The exports of one entry point that `llms.txt` leaves out: a `type` or `interface` named after
 * a function or class of the same entry point plus one of `PARAMETER_SUFFIXES`. For `FooOptions`
 * that owner is `Foo`, `foo` or `createFoo`. An interface or a type is never an owner: a type named
 * after one (`AlarmInput` next to the interface `Alarm`) is a shape of its own, not a parameter.
 */
export function describesParameters(exports: ExportedName[]): Set<string> {
  const kinds = new Map(exports.map((item) => [item.name, item.kind]))
  const takesParameters = (name: string) =>
    kinds.get(name) === `function` || kinds.get(name) === `class`
  const dropped = new Set<string>()
  for (const { name, kind } of exports) {
    if (kind !== `type` && kind !== `interface`) continue
    const suffix = PARAMETER_SUFFIXES.find((item) => name.endsWith(item) && name !== item)
    if (suffix === undefined) continue
    const base = name.slice(0, -suffix.length)
    const owners = [base, base[0].toLowerCase() + base.slice(1), `create${base}`]
    if (owners.some(takesParameters)) dropped.add(name)
  }
  return dropped
}

/**
 * One line of `llms.txt`: name, kind, import specifier and summary, separated by one tab each.
 * Any run of whitespace inside a field becomes one space, so a line always has exactly three
 * tabs; an empty summary leaves the fourth field empty.
 */
export function exportLine(item: ExportedName, specifier: string): string {
  return [item.name, item.kind, specifier, item.summary]
    .map((field) => field.replace(/\s+/g, ` `).trim()).join(`\t`)
}

/** The first lines of `llms.txt`. Each starts with `#`, as every line that is not an export does. */
export const HEADER = [
  `# ts-libs: the exports of the @spy4x/* packages on JSR, one per line.`,
  `# Columns, separated by one tab: name, kind, import specifier, summary.`,
  `# Search: git grep -n -i '<word>' origin/main -- llms.txt`,
  `# Use: deno add jsr:<package>, then import { <name> } from "<import specifier>".`,
  `# Left out: a type or interface that describes the parameters of a listed function or class Foo, foo or createFoo and is named Foo plus ${
    PARAMETER_SUFFIXES.join(`, `)
  }. Its signature: https://jsr.io/<package>/doc`,
  `# Full READMEs: https://raw.githubusercontent.com/spy4x/ts-libs/main/llms-full.txt`,
]

/** Prefix of the last line of `llms.txt`, which carries the surface fingerprint. */
export const FINGERPRINT_PREFIX = `# export surface: sha256 `

/** The text of `llms.txt`. Deterministic: no dates, sorted entries and names. */
export function renderLlms(entries: EntryExports[], fingerprint: string): string {
  const lines = [...HEADER]
  for (const { entry, exports } of entries) {
    const dropped = describesParameters(exports)
    for (const item of exports) {
      if (!dropped.has(item.name)) lines.push(exportLine(item, entry.specifier))
    }
  }
  lines.push(`${FINGERPRINT_PREFIX}${fingerprint}`, ``)
  return lines.join("\n")
}

/** The text of `llms-full.txt`: each README under a header naming its file. */
export function renderLlmsFull(readmes: { path: string; text: string }[]): string {
  return readmes.map(({ path, text }) => `# ${path}\n\n${text.trim()}\n`).join("\n")
}

const SKIPPED_DIRS = new Set(["node_modules", "dist", "coverage"])

async function findReadmes(root: string, dir: string): Promise<string[]> {
  const found: string[] = []
  for await (const item of Deno.readDir(join(root, dir))) {
    const path = `${dir}/${item.name}`
    if (item.isDirectory) {
      if (SKIPPED_DIRS.has(item.name) || /fixtures?$/i.test(item.name)) continue
      found.push(...await findReadmes(root, path))
    } else if (item.name === "README.md") found.push(path)
  }
  return found
}

/**
 * The root README, then every `README.md` under each entry's package directory (nested ones such
 * as `platform/rate-limit/README.md` included, fixture folders skipped), sorted by path.
 */
export async function loadReadmes(
  root: string,
  entries: Entry[],
): Promise<{ path: string; text: string }[]> {
  const paths = new Set<string>()
  for (const pkg of new Set(entries.map((entry) => entry.pkg))) {
    for (const path of await findReadmes(root, pkg)) paths.add(path)
  }
  const sorted = [...paths].sort((a, b) => (a < b ? -1 : a > b ? 1 : 0))
  return await Promise.all(
    ["README.md", ...sorted].map(async (path) => ({
      path,
      text: await Deno.readTextFile(join(root, path)),
    })),
  )
}

const REEXPORT = /^export\b[^"]*?from\s+"(\.{1,2}\/[^"]+)"/gms
const EXPORT_LINE =
  /(?:\/\*\*(?:(?!\*\/)[\s\S])*\*\/\s*)?^(?:export\b(?:\s+type)?\s*\{[^}]*\}[^\n]*|export\b[^\n]*)|\/\*\*(?:(?!\*\/)[\s\S])*@deprecated(?:(?!\*\/)[\s\S])*\*\//gm

/**
 * The text that defines a file's export surface: every `export` statement (a braced list in full,
 * a declaration as its first line) with the JSDoc block above it, and every other JSDoc block that
 * says `@deprecated`, which is how a module deprecates all its exports. A change to a name, a
 * kind, a summary, a deprecation or a re-export shows here; a change inside a function body does
 * not.
 */
export function exportSurface(source: string): string {
  return (source.match(EXPORT_LINE) ?? []).join("\n")
}

/**
 * A SHA-256 over the export surface of every entry point and of the files it re-exports from, in
 * a fixed order, plus the entry list. It needs read access only, so the unit test can recompute it.
 * `root` is the repository root.
 */
export async function surfaceFingerprint(root: string, entries: Entry[]): Promise<string> {
  const seen = new Set<string>()
  const parts: string[] = []
  const visit = async (file: string) => {
    if (seen.has(file)) return
    seen.add(file)
    const source = await Deno.readTextFile(join(root, file))
    parts.push(`== ${file}\n${exportSurface(source)}`)
    for (const match of source.matchAll(REEXPORT)) await visit(join(dirname(file), match[1]))
  }
  for (const entry of entries) {
    parts.push(`# ${entry.specifier}`)
    await visit(await resolveEntry(entry.specifier, root))
  }
  const digest = await crypto.subtle.digest("SHA-256", new TextEncoder().encode(parts.join("\n")))
  return [...new Uint8Array(digest)].map((byte) => byte.toString(16).padStart(2, "0")).join("")
}

async function main() {
  const entries = await loadEntries()
  const withExports: EntryExports[] = []
  for (const entry of entries) {
    const json = JSON.parse(await denoDoc(["--json", await resolveEntry(entry.specifier)]))
    withExports.push({ entry, exports: exportsFromDocJson(json) })
  }
  const fingerprint = await surfaceFingerprint(".", entries)
  await Deno.writeTextFile("llms.txt", renderLlms(withExports, fingerprint))
  await Deno.writeTextFile("llms-full.txt", renderLlmsFull(await loadReadmes(".", entries)))
  const count = withExports.reduce((sum, item) => sum + item.exports.length, 0)
  const left = withExports.reduce((sum, item) => sum + describesParameters(item.exports).size, 0)
  console.log(
    `wrote llms.txt (${entries.length} entry points, ${count - left} of ${count} exports, ` +
      `${left} parameter types left out), llms-full.txt`,
  )
}

if (import.meta.main) await main()
