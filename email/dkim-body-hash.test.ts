// Behaviour tests for the per-message body-hash cache, in isolation from
// dkim-verify.ts. Dependencies are injected and counted directly here, rather
// than through the test-only counters `dkim-verify.test.ts` uses to prove the
// real verifier shares one cache per message — these two files cover the same
// defect from two sides: this one is the cache's own contract, that one is
// integration evidence that `verifyDkimSignatures` actually uses it.

import { assertEquals } from "@std/assert"
import { createBodyHashCache } from "./dkim-body-hash.ts"

/** A `BodyHashDependencies` that counts its own calls, independent of the
 * module-level counters `dkim-verify.test.ts` reads. */
function countingDeps(body: string) {
  const canonicalizeCalls: string[] = []
  const digestCalls: number[] = []
  return {
    canonicalizeCalls,
    digestCalls,
    deps: {
      canonicalize: (algorithm: "simple" | "relaxed") => {
        canonicalizeCalls.push(algorithm)
        return algorithm === "relaxed" ? body.trimEnd() + "\r\n" : body
      },
      encode: (canonical: string) => new TextEncoder().encode(canonical),
      digest: (bytes: Uint8Array) => {
        digestCalls.push(bytes.length)
        return Promise.resolve(`hash:${bytes.length}`)
      },
    },
  }
}

Deno.test("hashes once for one (mode, l=) pair asked for once", async () => {
  const { deps, canonicalizeCalls, digestCalls } = countingDeps("hello\r\n")
  const cache = createBodyHashCache(deps)

  const result = await cache.get("relaxed", undefined)
  assertEquals(result, { hash: "hash:7", signedOctets: 7, totalOctets: 7 })
  assertEquals(canonicalizeCalls, ["relaxed"])
  assertEquals(digestCalls, [7])
})

Deno.test("does not re-canonicalize or re-hash a repeated (mode, l=) pair", async () => {
  const { deps, canonicalizeCalls, digestCalls } = countingDeps("hello\r\n")
  const cache = createBodyHashCache(deps)

  await cache.get("relaxed", undefined)
  await cache.get("relaxed", undefined)
  await cache.get("relaxed", undefined)

  assertEquals(canonicalizeCalls, ["relaxed"])
  assertEquals(digestCalls, [7])
})

Deno.test("re-hashes but does not re-canonicalize a new l= under the same mode", async () => {
  const { deps, canonicalizeCalls, digestCalls } = countingDeps("hello\r\n")
  const cache = createBodyHashCache(deps)

  await cache.get("relaxed", undefined)
  await cache.get("relaxed", 3)
  await cache.get("relaxed", 3)

  // One canonicalization for "relaxed", shared by both l= values; the digest
  // itself still runs once per distinct l=, not once per call.
  assertEquals(canonicalizeCalls, ["relaxed"])
  assertEquals(digestCalls, [7, 3])
})

Deno.test("canonicalizes each mode once, independently of the other", async () => {
  const { deps, canonicalizeCalls, digestCalls } = countingDeps("hello\r\n")
  const cache = createBodyHashCache(deps)

  await cache.get("relaxed", undefined)
  await cache.get("simple", undefined)
  await cache.get("relaxed", undefined)
  await cache.get("simple", undefined)

  assertEquals(canonicalizeCalls, ["relaxed", "simple"])
  assertEquals(digestCalls, [7, 7])
})

Deno.test("bounds signedOctets to the canonical body's length", async () => {
  const { deps } = countingDeps("hello\r\n") // 7 canonical octets
  const cache = createBodyHashCache(deps)

  const withinBound = await cache.get("relaxed", 4)
  assertEquals(withinBound, { hash: "hash:4", signedOctets: 4, totalOctets: 7 })

  const pastTheEnd = await cache.get("relaxed", 999)
  assertEquals(pastTheEnd, { hash: "hash:7", signedOctets: 7, totalOctets: 7 })
})

Deno.test("shares one pending computation between two concurrent gets", async () => {
  let digestStarts = 0
  let releaseDigest: (() => void) | undefined
  const gate = new Promise<void>((resolve) => (releaseDigest = resolve))

  const cache = createBodyHashCache({
    canonicalize: () => "hello\r\n",
    encode: (canonical) => new TextEncoder().encode(canonical),
    digest: async (bytes) => {
      digestStarts++
      await gate
      return `hash:${bytes.length}`
    },
  })

  const first = cache.get("relaxed", undefined)
  const second = cache.get("relaxed", undefined)
  assertEquals(
    digestStarts,
    1,
    "a second get before the first resolves must not start a second digest",
  )

  releaseDigest?.()
  assertEquals(await first, await second)
})
