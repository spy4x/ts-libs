// Writes `docs/1.0-contract.md`: for each entry point the template will import, its exported names
// and their signatures, taken from `deno doc`. Run with `deno task contract`. The list of entry
// points below is the only hand-written part; every name and signature comes from the code.
//
// A signature is the declaration line `deno doc` prints, and for a class, an interface or an enum,
// the lines of its members. JSDoc prose is left out: the contract is names, parameters and return
// types (#77, "The interfaces are frozen at 1.0").

const OUTPUT = "docs/1.0-contract.md"

interface Entry {
  /** The import specifier the template will write. */
  specifier: string
  /** The capability row in #77's 1.0 table this entry serves. */
  capability: string
}

const ENTRIES: Entry[] = [
  { specifier: "@ts-libs/validation", capability: "schema validation" },
  { specifier: "@ts-libs/platform/cqrs", capability: "command, query and event bus" },
  { specifier: "@ts-libs/platform/cache", capability: "cache with `wrap()`" },
  { specifier: "@ts-libs/platform/tokens", capability: "random tokens" },
  { specifier: "@ts-libs/platform/rate-limit", capability: "rate limiting" },
  { specifier: "@ts-libs/platform/rate-limit/hono", capability: "rate limiting" },
  { specifier: "@ts-libs/server/kv", capability: "Redis key-value store" },
  { specifier: "@ts-libs/server/outbox", capability: "transactional outbox" },
  {
    specifier: "@ts-libs/server/sign-in",
    capability: "session, cookie, TOTP, password hash, auth guards",
  },
  { specifier: "@ts-libs/server/request-log", capability: "request logging" },
  { specifier: "@ts-libs/server/config", capability: "typed config from the environment" },
  { specifier: "@ts-libs/server/crypto", capability: "field encryption" },
  { specifier: "@ts-libs/server/db", capability: "Postgres access, transactions, migrations" },
  {
    specifier: "@ts-libs/server/db/migrate",
    capability: "Postgres access, transactions, migrations",
  },
  {
    specifier: "@ts-libs/server/db/postgres",
    capability: "Postgres access, transactions, migrations",
  },
]

/** Capabilities in #77's table that have no entry point ready yet, and the issue that holds them. */
const NOT_READY = [
  ["password sign-up and sign-in, mail codes, OAuth (`server/auth`)", "#57"],
  ["shared API and model types (`ApiResult`, `BaseModel`, push schemas, `RequestInfo`)", "#131"],
  ["Postgres migrations and purge on the template's camelCase client", "#138"],
]

interface DocDeclaration {
  kind: string
  def?: {
    properties?: { name: string }[]
    methods?: { name: string }[]
    members?: { name: string }[]
  }
}

interface DocSymbol {
  name: string
  declarations: DocDeclaration[]
}

/** Resolves `@ts-libs/<package>/<subpath>` to a file through that package's `deno.json`. */
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

/** Member names of every class, interface and enum exported by the file, keyed by symbol name. */
async function memberNames(file: string): Promise<Map<string, Set<string>>> {
  const json = JSON.parse(await denoDoc(["--json", file]))
  const symbols = Object.values(json.nodes as Record<string, { symbols: DocSymbol[] }>)
    .flatMap((node) => node.symbols)
  const members = new Map<string, Set<string>>()
  for (const symbol of symbols) {
    const names = new Set<string>(["constructor"])
    for (const declaration of symbol.declarations) {
      const def = declaration.def ?? {}
      for (const item of [...def.properties ?? [], ...def.methods ?? [], ...def.members ?? []]) {
        names.add(item.name)
      }
    }
    members.set(symbol.name, names)
  }
  return members
}

const MODIFIERS = /^(?:(?:public|private|protected|static|readonly|abstract|async|get|set)\s+)*/

/** The signature lines of one `deno doc` text block: the declaration and its member lines. */
function signatures(block: string[], members: Map<string, Set<string>>): string[] {
  const lines = block.filter((line) => line.trim() !== "" && !line.startsWith("Defined in "))
  const head = lines.find((line) => !line.startsWith(" "))
  if (head === undefined) return []
  const name = head.match(
    /^(?:\w+\s+)*?(?:class|interface|enum|type|function|const|let|var|namespace)\s+([\w$]+)/,
  )?.[1]
  const own = name === undefined ? undefined : members.get(name)
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
  const members = await memberNames(file)
  const text = await denoDoc([file])
  const blocks: string[][] = []
  for (const line of text.split("\n")) {
    if (line.startsWith("Defined in ")) blocks.push([])
    else blocks.at(-1)?.push(line)
  }
  const rendered = blocks
    .map((block) => signatures(block, members))
    .filter((lines) => lines.length > 0)
    .sort((a, b) => a[0].localeCompare(b[0]))
    .map((lines) => lines.join("\n"))
  return [
    `## \`${entry.specifier}\``,
    "",
    `Capability: ${entry.capability}. Source: \`${file}\`.`,
    "",
    "```text",
    rendered.join("\n\n"),
    "```",
    "",
  ].join("\n")
}

const sections = []
for (const entry of ENTRIES) sections.push(await entrySection(entry))

const document = [
  "# 1.0 contract — first draft",
  "",
  "Generated by `deno task contract` from the code on the branch it runs on. Do not edit by hand;",
  "change the code or the entry list in `infra/scripts/contract.ts`, then run the task again.",
  "",
  'This is the frame for condition 2 in #77 ("The interfaces are frozen at 1.0"): for each entry',
  "point the template will import, its exported names and their signatures. After 1.0, a change to",
  "anything listed here is additive or waits for 2.0. JSDoc is left out; the code holds it.",
  "",
  "Each signature is `deno doc`'s own text rendering. That rendering leaves out a method's own type",
  "parameters (`register<T extends Command<unknown, unknown>>(…)` prints as `register(…)`) and",
  "prints a mapped type without its braces. Where a line here and the source file named under its",
  "heading differ, the source file is the contract.",
  "",
  "Not in this draft, because no entry point is ready yet:",
  "",
  ...NOT_READY.map(([what, issue]) => `- ${what}: ${issue}`),
  "",
  ...sections,
].join("\n")

await Deno.writeTextFile(OUTPUT, document)
const fmt = await new Deno.Command("deno", { args: ["fmt", "--quiet", OUTPUT] }).output()
if (fmt.code !== 0) throw new Error(`deno fmt ${OUTPUT} failed`)
console.log(`wrote ${OUTPUT}: ${ENTRIES.length} entry points`)
