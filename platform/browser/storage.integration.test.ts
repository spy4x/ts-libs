// Deno's real `localStorage`, held to the same contract the unit tier runs on `memoryStorage`
// (`storage.test.ts`). Every key carries a unique prefix and is removed in `finally`, because
// another worktree may share the origin's storage.

import { uniqueKeyPrefix } from "@integration-testing"
import { describeStorageContract } from "./storage-contract.test.ts"

describeStorageContract(`localStorage`, () => {
  const prefix = uniqueKeyPrefix(`it_storage`)
  return {
    storage: localStorage,
    prefix,
    close: () => {
      for (let i = localStorage.length - 1; i >= 0; i--) {
        const key = localStorage.key(i)
        if (key?.startsWith(prefix)) localStorage.removeItem(key)
      }
    },
  }
})
