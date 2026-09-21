/**
 * The scratch-folder helper of the integration tier (#73): proves that
 * `createScratchFolder` returns a folder a test can write to and read from, that two
 * calls never collide, and that `removeScratchFolder` actually removes what it made.
 */

import { assertEquals, assertNotEquals, assertRejects } from "@std/assert"
import { describe, it } from "@std/testing/bdd"
import { createScratchFolder, removeScratchFolder } from "./scratch.ts"

describe("scratch folder", () => {
  it("writes and reads a file in the folder, then removes it", async () => {
    const folder = await createScratchFolder("it_scratch")
    const file = `${folder}/greeting.txt`

    try {
      await Deno.writeTextFile(file, "hello from the integration tier")
      assertEquals(await Deno.readTextFile(file), "hello from the integration tier")
    } finally {
      await removeScratchFolder(folder)
    }

    await assertRejects(() => Deno.stat(folder), Deno.errors.NotFound)
  })

  it("never returns the same folder twice for the same prefix", async () => {
    const first = await createScratchFolder("it_scratch")
    const second = await createScratchFolder("it_scratch")

    try {
      assertNotEquals(first, second)
    } finally {
      await removeScratchFolder(first)
      await removeScratchFolder(second)
    }
  })
})
