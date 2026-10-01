// Runs the `SessionStore` contract against the fake every sign-in unit test uses.
// `postgres-session-store.integration.test.ts` runs the same suite against Postgres.

import { createFakeStore } from "./fake-store.test.ts"
import { describeSessionStoreContract } from "./session-store-contract.test.ts"

describeSessionStoreContract("createFakeStore", () => {
  let nextUserId = 1
  return Promise.resolve({
    store: createFakeStore().store,
    addUser: () => Promise.resolve({ userId: nextUserId++, columns: {} }),
    close: () => Promise.resolve(),
  })
})
