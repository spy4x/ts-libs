// Writes `llms.txt` and `llms-full.txt` at the repository root, for an agent working in another
// repository that uses this library. Run with `deno task llms`.
//
// `llms.txt` (llmstxt.org shape) lists every export of every published entry point: name, kind, the
// first sentence of its JSDoc and its import specifier. The names, kinds and JSDoc come from
// `deno doc --json`; the entry points come from the same `exports` maps `contract.ts` reads.
// `llms-full.txt` joins the root README and every package README.
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
  /** First sentence of the JSDoc; empty when the export has none. */
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
  const end = flat.search(/[.!?](?:\s|$)/)
  return end === -1 ? flat : flat.slice(0, end + 1)
}

interface DocJson {
  nodes: Record<
    string,
    { symbols: { name: string; declarations: { kind: string; jsDoc?: { doc?: string } }[] }[] }
  >
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
      found.push({
        name: symbol.name,
        kind: KINDS[first.kind] ?? first.kind,
        summary: firstSentence(documented?.jsDoc?.doc),
      })
    }
  }
  return found.sort((a, b) => (a.name < b.name ? -1 : a.name > b.name ? 1 : 0))
}

/** The import specifier a consumer writes: `@spy4x/net/ip` becomes `jsr:@spy4x/net/ip`. */
export function importSpecifier(entry: Entry): string {
  return `jsr:${entry.specifier}`
}

function header(packages: number): string[] {
  return [
    `# ts-libs`,
    ``,
    `> Small TypeScript libraries on web standards, for the server and the browser, published to JSR`,
    `> as \`@spy4x/*\`. ${packages} packages cover validation, time zones, email, networking, server`,
    `> primitives, realtime and more. Each one is a Deno workspace member with no UI.`,
    ``,
    `## When to use`,
    ``,
    `Before writing a helper of your own, look for it below: it may already exist under another name.`,
    `Import it, and if it falls short, extend it in the library rather than keeping a copy.`,
    ``,
    `## How to install`,
    ``,
    `\`deno add jsr:@spy4x/<package>\`, then import a name from the entry point listed with it, for`,
    `example \`import { parseIp } from "@spy4x/net/ip"\`. Every package carries the same version.`,
    `The full READMEs are in [llms-full.txt](https://raw.githubusercontent.com/spy4x/ts-libs/main/llms-full.txt).`,
    ``,
  ]
}

/** Prefix of the last line of `llms.txt`, which carries the surface fingerprint. */
export const FINGERPRINT_PREFIX = `<!-- export surface: sha256 `

/** The text of `llms.txt`. Deterministic: no dates, sorted entries and names. */
export function renderLlms(entries: EntryExports[], fingerprint: string): string {
  const lines = header(new Set(entries.map((item) => item.entry.pkg)).size)
  let previous = ""
  for (const { entry, exports } of entries) {
    if (entry.pkg !== previous) lines.push(`## @spy4x/${entry.pkg}`, ``)
    previous = entry.pkg
    lines.push(`### \`${importSpecifier(entry)}\``, ``)
    for (const item of exports) {
      const head = `- \`${item.name}\` (${item.kind}), \`${importSpecifier(entry)}\``
      lines.push(item.summary === "" ? head : `${head}: ${item.summary}`)
    }
    lines.push(``)
  }
  lines.push(`${FINGERPRINT_PREFIX}${fingerprint} -->`, ``)
  return lines.join("\n")
}

/** The text of `llms-full.txt`: each README under a header naming its file. */
export function renderLlmsFull(readmes: { path: string; text: string }[]): string {
  return readmes.map(({ path, text }) => `# ${path}\n\n${text.trim()}\n`).join("\n")
}

/** The root README, then the README of every entry's package that has one, in package order. */
export async function loadReadmes(
  root: string,
  entries: Entry[],
): Promise<{ path: string; text: string }[]> {
  const paths = ["README.md"]
  for (const pkg of [...new Set(entries.map((entry) => entry.pkg))]) paths.push(`${pkg}/README.md`)
  const readmes = []
  for (const path of paths) {
    try {
      readmes.push({ path, text: await Deno.readTextFile(join(root, path)) })
    } catch (error) {
      if (!(error instanceof Deno.errors.NotFound)) throw error
    }
  }
  return readmes
}

const REEXPORT = /^export\b[^"]*?from\s+"(\.{1,2}\/[^"]+)"/gms
const EXPORT_LINE =
  /(?:\/\*\*(?:(?!\*\/)[\s\S])*\*\/\s*)?^(?:export\b(?:\s+type)?\s*\{[^}]*\}[^\n]*|export\b[^\n]*)/gm

/**
 * The text that defines a file's export surface: every `export` statement (a braced list in full,
 * a declaration as its first line) with the JSDoc block above it. A change to a name, a kind, a
 * summary or a re-export shows here; a change inside a function body does not.
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
  console.log(`wrote llms.txt (${entries.length} entry points, ${count} exports), llms-full.txt`)
}

if (import.meta.main) await main()
