// No package creates a UUID version 4 (#555). An id is `uuidV7()` from
// `@spy4x/platform/universal/uuid`; a value that works as a secret, or an id other people see that
// must not show when it was made, is `randomBase64Url()` from `@spy4x/platform/tokens`. This test
// reads every source and document of every package and fails on a call that makes a version 4 id,
// in TypeScript or in SQL text, and on documentation that shows one.

import { assert, assertEquals } from "@std/assert"
import { fromFileUrl, join, relative } from "@std/path"

const root = fromFileUrl(new URL("../../", import.meta.url))

/**
 * What makes a version 4 id: the Web Crypto call, the two Postgres functions, and the npm and
 * `@std/uuid` helpers under their usual names (`uuidv4()`, an imported `v4()`, a `uuid/v4` path).
 */
const FORBIDDEN = /randomUUID|gen_random_uuid|uuid_generate_v4|uuidv4\s*\(|uuid\/v4|\bv4\s*\(/gi

/**
 * The only files that may name them: the UUID module's test, which feeds version 4 ids to the
 * validators to show they are still accepted. Paths are relative to the repository root.
 */
const ALLOWED = new Set(["platform/universal/uuid.test.ts"])

/** File types that hold code, SQL or documentation a reader could copy from. */
const SCANNED = /\.(ts|tsx|js|mjs|sql|md|json|jsonc|ya?ml)$/

/** The `workspace` members named in the root `deno.jsonc`, as directory names. */
async function workspaceMembers(): Promise<string[]> {
  const text = await Deno.readTextFile(join(root, "deno.jsonc"))
  const list = text.match(/"workspace"\s*:\s*\[([^\]]*)\]/)
  assert(list, "the root deno.jsonc has no workspace list: is `root` the repository root?")
  return [...list[1].matchAll(/"\.\/([^"]+)"/g)].map((match) => match[1])
}

/** Every scanned file under `dir`, tests included. */
async function* sources(dir: string): AsyncGenerator<string> {
  for await (const entry of Deno.readDir(dir)) {
    const path = join(dir, entry.name)
    if (entry.isDirectory) {
      if (entry.name !== "node_modules") yield* sources(path)
    } else if (SCANNED.test(entry.name)) yield path
  }
}

/** `path:line: match` for every forbidden name in `text`. */
export function findUuidV4(path: string, text: string): string[] {
  return [...text.matchAll(FORBIDDEN)].map((match) =>
    `${path}:${text.slice(0, match.index).split("\n").length}: ${match[0]}`
  )
}

Deno.test("no package creates or documents a UUID version 4", async () => {
  const offenders: string[] = []
  let members = 0
  let files = 0
  for (const member of await workspaceMembers()) {
    const dir = join(root, member)
    try {
      await Deno.stat(dir)
    } catch (error) {
      // A planned member whose directory does not exist yet.
      if (error instanceof Deno.errors.NotFound) continue
      throw error
    }
    members++
    for await (const file of sources(dir)) {
      const path = relative(root, file).replaceAll("\\", "/")
      files++
      if (ALLOWED.has(path)) continue
      offenders.push(...findUuidV4(path, await Deno.readTextFile(file)))
    }
  }
  // A wrong `root` or a broken list parser must not pass by scanning less: ten packages exist
  // today, and the allowed file must have been walked past.
  assert(members >= 10, `only ${members} packages were scanned`)
  assert(files > 500, `only ${files} files were scanned`)
  assertEquals(
    offenders,
    [],
    "use uuidV7() from @spy4x/platform/universal/uuid for an id, or randomBase64Url() from " +
      "@spy4x/platform/tokens for a secret or an id that must not show its age",
  )
})

Deno.test("the UUID version 4 guard sees each way of making one", () => {
  const samples = [
    "const id = crypto.randomUUID()",
    "const { randomUUID } = crypto",
    "SELECT gen_random_uuid(), name FROM users",
    "id UUID DEFAULT GEN_RANDOM_UUID()",
    "SELECT uuid_generate_v4()",
    "const id = uuidv4()",
    "const id = uuidV4 ()",
    "const id = v4()",
    `import { generate } from "@std/uuid/v4"`,
  ]
  for (const sample of samples) {
    assertEquals(findUuidV4("sample.ts", sample).length, 1, sample)
  }
  assertEquals(findUuidV4("a.ts", "one\ntwo crypto.randomUUID()"), ["a.ts:2: randomUUID"])
})

Deno.test("the UUID version 4 guard lets version 7 ids and random tokens through", () => {
  for (
    const sample of [
      "const id = uuidV7()",
      "randomBase64Url()",
      "id uuid PRIMARY KEY",
      "ipv4(address)",
    ]
  ) {
    assertEquals(findUuidV4("sample.ts", sample), [], sample)
  }
})
