import { expect } from "@std/expect"
import { describe, it } from "@std/testing/bdd"

/**
 * The retry mechanism is one module, copied byte-for-byte into two packages
 * because neither owns a shared ancestor directory and `#16`/`#18` must stay
 * file-disjoint. This suite is the assertion that makes the duplication safe:
 * if either copy is edited alone, the bytes differ and this fails.
 *
 * It earned its place. The two copies had already diverged in four ways —
 * jitter honoured in one and ignored in the other, `isPermanentStatus` present
 * in one only, a different backoff signature, and a disagreeing
 * `maxAttempts: 0` guard — none of which any behavioural test could see,
 * because each package only ever exercised its own copy.
 *
 * The copies are **found on disk**, not listed by hand. Three assertions read
 * that list, and a hand-written literal makes all three vacuous at once:
 * deleting a copy leaves a literal that still names it, so even the "more than
 * one copy" claim is then a claim about the literal rather than about the tree.
 */

/**
 * The directory that holds every package — two levels above this file, which is
 * `ops/notify/retry-drift.test.ts` inside that root. Resolved from this file,
 * never from `$HOME` or the cwd.
 */
const TREE_ROOT = new URL("../../", import.meta.url)

/** Directories that cannot hold a package copy. */
const IGNORED_DIRECTORIES = new Set([".git", "node_modules"])

/** Every `retry.ts` under `directory`, as repo-relative paths. */
const findRetryFiles = async (directory: URL, prefix: string): Promise<string[]> => {
  const found: string[] = []
  for await (const entry of Deno.readDir(directory)) {
    const relative = prefix === "" ? entry.name : `${prefix}/${entry.name}`
    if (entry.isDirectory) {
      if (!IGNORED_DIRECTORIES.has(entry.name)) {
        found.push(...await findRetryFiles(new URL(`${entry.name}/`, directory), relative))
      }
      continue
    }
    if (entry.isFile && entry.name === "retry.ts") {
      found.push(relative)
    }
  }
  return found
}

/** The copies, sorted, so the assertions that read them are deterministic. */
const SOURCES = (await findRetryFiles(TREE_ROOT, "")).sort().map((path) => ({
  path,
  url: new URL(path, TREE_ROOT),
}))

const label = (path: string): string => path.split("/").slice(-2).join("/")

describe("retry core duplication", () => {
  it("finds every copy on disk, so the drift check is not vacuous", () => {
    // These two, and nothing else. A copy added under a third package is one
    // nobody compares; a copy deleted is a drift check that no longer reads
    // what it claims to read. Both are failures here, and a hand-written list
    // cannot see either of them.
    expect(SOURCES.length).toBeGreaterThan(1)
    expect(SOURCES.map((source) => source.path)).toEqual([
      "integrations/retry.ts",
      "ops/notify/retry.ts",
    ])
  })

  it("keeps every copy byte-identical to the canonical file", async () => {
    const contents = await Promise.all(SOURCES.map((source) => Deno.readTextFile(source.url)))
    for (const [index, content] of contents.entries()) {
      expect({ file: label(SOURCES[index].path), identical: content === contents[0] }).toEqual({
        file: label(SOURCES[index].path),
        identical: true,
      })
    }
  })

  it("publishes the same export surface from every copy", async () => {
    const modules = await Promise.all(SOURCES.map((source) => import(source.url.href)))
    const surfaces = modules.map((module) => Object.keys(module).sort())
    for (const [index, surface] of surfaces.entries()) {
      expect({ file: label(SOURCES[index].path), exports: surface }).toEqual({
        file: label(SOURCES[index].path),
        exports: surfaces[0],
      })
    }
    // A copy that exported nothing would satisfy the equality above.
    expect(surfaces[0]).toContain("runWithRetry")
    expect(surfaces[0]).toContain("isPermanentStatus")
    expect(surfaces[0]).toContain("describeTransportError")
  })

  it("refuses a URL-shaped error name, so the kind field cannot carry one", async () => {
    // Pins the behaviour that must not regress when the guard in `retry.ts`
    // changes: a URL-shaped `name` was refused by the alphabetic bound the
    // module used to carry and is refused by the class allowlist it carries now.
    const module = await import(SOURCES[0].url.href) as {
      describeErrorKind: (cause: unknown) => string
    }
    const shaped = new TypeError("boom")
    Object.defineProperty(shaped, "name", {
      value: "https://hooks.slack.invalid/services/T/B/REALTOKENISH",
    })
    expect(module.describeErrorKind(shaped)).toBe("Error")
    const spelled = new TypeError("boom")
    Object.defineProperty(spelled, "name", { value: "REALTOKENISH" })
    expect(module.describeErrorKind(spelled)).toBe("Error")
    // ...and a class the platform throws is still named, so the refusal above is
    // not "refuse everything".
    expect(module.describeErrorKind(new TypeError("boom"))).toBe("TypeError")
  })
})
