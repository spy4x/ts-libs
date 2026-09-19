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
 */

const SOURCES = [
  new URL("./retry.ts", import.meta.url),
  new URL("../../integrations/retry.ts", import.meta.url),
]

const label = (url: URL): string => url.pathname.split("/").slice(-2).join("/")

describe("retry core duplication", () => {
  it("keeps every copy byte-identical to the canonical file", async () => {
    const contents = await Promise.all(SOURCES.map((url) => Deno.readTextFile(url)))
    for (const [index, content] of contents.entries()) {
      expect({ file: label(SOURCES[index]), identical: content === contents[0] }).toEqual({
        file: label(SOURCES[index]),
        identical: true,
      })
    }
  })

  it("has more than one copy, so the drift check is not vacuous", () => {
    expect(SOURCES.length).toBeGreaterThan(1)
  })

  it("publishes the same export surface from every copy", async () => {
    const modules = await Promise.all(SOURCES.map((url) => import(url.href)))
    const surfaces = modules.map((module) => Object.keys(module).sort())
    for (const [index, surface] of surfaces.entries()) {
      expect({ file: label(SOURCES[index]), exports: surface }).toEqual({
        file: label(SOURCES[index]),
        exports: surfaces[0],
      })
    }
    // A copy that exported nothing would satisfy the equality above.
    expect(surfaces[0]).toContain("runWithRetry")
    expect(surfaces[0]).toContain("isPermanentStatus")
    expect(surfaces[0]).toContain("describeTransportError")
  })
})
