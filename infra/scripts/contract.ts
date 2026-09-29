// Writes `docs/1.0-contract.md`: for each entry point the template will import, its exported names
// and their signatures, taken from `deno doc`. Run with `deno task contract`. The list of entry
// points come from the `exports` map of every workspace member's `deno.json`, grouped under one heading per
// package and sorted; every name and signature comes from the code.
//
// A signature is the declaration line `deno doc` prints and, for a class or an interface, the lines
// of its public members; an enum's members and their values come from `deno doc --json`. JSDoc prose is left out: the contract is names, parameters and return
// types (#77, "The interfaces are frozen at 1.0").

const OUTPUT = "docs/1.0-contract.md"

interface Entry {
  /** The import specifier the template will write. */
  specifier: string
  /** The package the entry belongs to, as its directory name; the document groups by it. */
  pkg: string
}

/** The `workspace` member directories named in the root `deno.jsonc` text, without `./`. */
export function workspaceDirs(rootConfigText: string): string[] {
  const list = rootConfigText.match(/"workspace"\s*:\s*\[([^\]]*)\]/)
  if (list === null) throw new Error(`the root deno.jsonc has no "workspace" list`)
  return [...list[1].matchAll(/"\.?\/?([^"]+)"/g)].map((match) => match[1])
}

/**
 * Every published entry point: one per `exports` key of each workspace member, so a key added to a
 * member's `deno.json` joins the contract without a script edit. `readConfig` returns a member's
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

async function loadEntries(): Promise<Entry[]> {
  const dirs = workspaceDirs(await Deno.readTextFile("deno.jsonc"))
  const configs = new Map<string, { exports?: Record<string, string> }>()
  for (const dir of dirs) {
    try {
      configs.set(dir, JSON.parse(await Deno.readTextFile(`${dir}/deno.json`)))
    } catch (error) {
      if (!(error instanceof Deno.errors.NotFound)) throw error
    }
  }
  return entriesFrom(dirs, (dir) => configs.get(dir))
}

/**
 * Capabilities in #77's table that have no entry point ready yet, each with the issue that holds it.
 * Empty when every capability has one; the document then leaves the list out.
 */
const NOT_READY: string[] = []

interface DocDeclaration {
  kind: string
  def?: {
    properties?: { name: string }[]
    methods?: { name: string }[]
    members?: EnumMember[]
  }
}

interface EnumMember {
  name: string
  init?: { repr: string; value?: { kind: string } }
}

interface DocSymbol {
  name: string
  declarations: DocDeclaration[]
}

/** Resolves `@spy4x/<package>/<subpath>` to a file through that package's `deno.json`. */
async function resolveEntry(specifier: string): Promise<string> {
  const [, pkg, ...rest] = specifier.split("/")
  const config = JSON.parse(await Deno.readTextFile(`${pkg}/deno.json`))
  const key = rest.length === 0 ? "." : `./${rest.join("/")}`
  const target = config.exports?.[key]
  if (typeof target !== "string") throw new Error(`${specifier}: no "${key}" in ${pkg}/deno.json`)
  return `${pkg}/${target.replace(/^\.\//, "")}`
}

async function denoDoc(args: string[]): Promise<string> {
  const { code, stdout, stderr } = await new Deno.Command("deno", {
    args: ["doc", ...args],
    env: { NO_COLOR: "1" },
  }).output()
  if (code !== 0) throw new Error(`deno doc ${args.join(" ")}: ${new TextDecoder().decode(stderr)}`)
  return new TextDecoder().decode(stdout)
}

interface Members {
  /** Member names of every class, interface and enum exported by the file, keyed by symbol name. */
  names: Map<string, Set<string>>
  /**
   * The member lines of every enum, keyed by symbol name, as `Name = value`. `deno doc`'s text
   * rendering prints an enum member's name alone, so these come from its JSON output.
   */
  enums: Map<string, string[]>
}

async function members(file: string): Promise<Members> {
  const json = JSON.parse(await denoDoc(["--json", file]))
  const symbols = Object.values(json.nodes as Record<string, { symbols: DocSymbol[] }>)
    .flatMap((node) => node.symbols)
  const names = new Map<string, Set<string>>()
  const enums = new Map<string, string[]>()
  for (const symbol of symbols) {
    const own = new Set<string>(["constructor"])
    for (const declaration of symbol.declarations) {
      const def = declaration.def ?? {}
      for (const item of [...def.properties ?? [], ...def.methods ?? []]) own.add(item.name)
      if (declaration.kind === "enum") {
        enums.set(symbol.name, (def.members ?? []).map((member) => `  ${enumMember(member)}`))
      }
    }
    names.set(symbol.name, own)
  }
  return { names, enums }
}

/**
 * `Name = value`, with a string value quoted; `Name` alone when the member has no initialiser, or
 * one `deno doc` could not statically render.
 */
function enumMember(member: EnumMember): string {
  if (member.init === undefined) return member.name
  const value = member.init.value?.kind === "string"
    ? JSON.stringify(member.init.repr)
    : member.init.repr
  return `${member.name} = ${value}`
}

const MODIFIERS = /^(?:(?:public|private|protected|static|readonly|abstract|async|get|set)\s+)*/

/** The signature lines of one `deno doc` text block: the declaration and its member lines. */
function signatures(block: string[], { names, enums }: Members): string[] {
  const lines = block.filter((line) => line.trim() !== "" && !line.startsWith("Defined in "))
  const found = lines.find((line) => !line.startsWith(" "))
  if (found === undefined) return []
  // A constant holding a multi-line template literal prints as its opening backtick alone, the
  // literal's text following on lines that are not signatures; its type is `string`.
  const head = found.replace(/^((?:export\s+)?const\s+[\w$]+): `$/, "$1: string")
  const name = head.match(
    /^(?:\w+\s+)*?(?:class|interface|enum|type|function|const|let|var|namespace)\s+([\w$]+)/,
  )?.[1]
  if (name !== undefined && enums.has(name)) return [head, ...enums.get(name)!]
  const own = name === undefined ? undefined : names.get(name)
  const out = [head]
  if (own === undefined) return out
  for (const line of lines) {
    if (!/^ {2}\S/.test(line)) continue
    // A private member is not part of what a caller can use, except a private constructor, which
    // tells the caller the class is not built with `new`.
    if (/^ {2}(?:private\s|#)/.test(line) && !/^ {2}private\s+constructor\(/.test(line)) continue
    const body = line.slice(2).replace(MODIFIERS, "")
    const member = body.match(/^\[?["']?([\w$]+)/)?.[1]
    if (
      member !== undefined && own.has(member) && /^\[?["']?[\w$]+["']?\]?\??\s*[(<:=]/.test(body)
    ) {
      out.push(line)
    }
  }
  return out
}

async function entrySection(entry: Entry): Promise<string> {
  const file = await resolveEntry(entry.specifier)
  const own = await members(file)
  const text = await denoDoc([file])
  const blocks: string[][] = []
  for (const line of text.split("\n")) {
    if (line.startsWith("Defined in ")) blocks.push([])
    else blocks.at(-1)?.push(line)
  }
  const rendered = blocks
    .map((block) => signatures(block, own))
    .filter((lines) => lines.length > 0)
    .sort((a, b) => a[0].localeCompare(b[0]))
    .map((lines) => lines.join("\n"))
  return [
    `### \`${entry.specifier}\``,
    "",
    `Source: \`${file}\`.`,
    "",
    "```text",
    rendered.join("\n\n"),
    "```",
    "",
  ].join("\n")
}

async function main() {
  const ENTRIES = await loadEntries()
  const sections = []
  let previous = ""
  for (const entry of ENTRIES) {
    if (entry.pkg !== previous) sections.push(`## Package \`@spy4x/${entry.pkg}\`\n`)
    previous = entry.pkg
    sections.push(await entrySection(entry))
  }

  const document = [
    "# 1.0 contract — first draft",
    "",
    "Generated by `deno task contract` from the code on the branch it runs on. Do not edit by hand;",
    "change the code or an `exports` map, then run the task again.",
    "",
    'This is the frame for condition 2 in #77 ("The interfaces are frozen at 1.0"): for each entry',
    "point the template will import, its exported names and their signatures. After 1.0, a change to",
    "anything listed here is additive or waits for 2.0. JSDoc is left out; the code holds it.",
    "",
    "Each signature is `deno doc`'s own text rendering. That rendering leaves out a method's own type",
    "parameters (`register<T extends Command<unknown, unknown>>(…)` prints as `register(…)`) and",
    "prints a mapped type without its braces. It also leaves out a parameter's default value, so a",
    "parameter with a default (`init: RequestInit = {}`) reads as required here although a caller may",
    "omit it. Where a line here and the source file named under its heading differ, the source file",
    "is the contract.",
    "",
    ...(NOT_READY.length === 0 ? [] : [
      "Not in this draft, because no entry point is ready yet:",
      "",
      ...NOT_READY.map((line) => `- ${line}`),
      "",
    ]),
    ...sections,
  ].join("\n")

  await Deno.writeTextFile(OUTPUT, document)
  const fmt = await new Deno.Command("deno", { args: ["fmt", "--quiet", OUTPUT] }).output()
  if (fmt.code !== 0) throw new Error(`deno fmt ${OUTPUT} failed`)
  console.log(`wrote ${OUTPUT}: ${ENTRIES.length} entry points`)
}

if (import.meta.main) await main()
