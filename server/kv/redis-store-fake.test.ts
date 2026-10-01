// The in-memory store, held to the same contract the integration tier runs on a real
// `RedisKvStore` (`redis-store-contract.integration.test.ts`).

import { createFakeRedisStore } from "./fake-redis-store.test.ts"
import { describeRedisStoreContract } from "./redis-store-contract.test.ts"

describeRedisStoreContract("the in-memory store", () => {
  const fake = createFakeRedisStore()
  return Promise.resolve({
    store: fake,
    ttlSec: (key) => Promise.resolve(fake.data.get(key)?.ttlSec ?? null),
    close: () => Promise.resolve(),
  })
})
