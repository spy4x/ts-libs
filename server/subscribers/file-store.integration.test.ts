import { expect } from "@std/expect"
import { describe, it } from "@std/testing/bdd"
import { createScratchFolder, removeScratchFolder } from "@integration-testing"
import { createFileSubscriberStore } from "./file-store.ts"
import { describeSubscriberStoreContract } from "./store-contract.test.ts"

describeSubscriberStoreContract("createFileSubscriberStore on a real folder", async () => {
  const folder = await createScratchFolder("it_subscribers")
  const store = createFileSubscriberStore({ path: `${folder}/lists/subscribers.json` })
  return { store, close: () => removeScratchFolder(folder) }
})

describe("createFileSubscriberStore on a real folder", () => {
  it("keeps every row when two stores on one file add at the same time", async () => {
    const folder = await createScratchFolder("it_subscribers")
    try {
      const path = `${folder}/subscribers.json`
      const stores = [createFileSubscriberStore({ path }), createFileSubscriberStore({ path })]
      const names = Array.from({ length: 20 }, (_, i) => `user${i}`)
      await Promise.all(names.map((name, i) =>
        stores[i % 2].add({
          email: `${name}@example.com`,
          key: `${name}-key`,
          mark: `${name}-mark`,
          issuedAt: 1,
          at: new Date(i),
        })
      ))
      expect(await stores[0].count()).toBe(20)
      expect(JSON.parse(await Deno.readTextFile(path)).length).toBe(20)
    } finally {
      await removeScratchFolder(folder)
    }
  })
})
