import { createMemorySubscriberStore } from "./memory.ts"
import { describeSubscriberStoreContract } from "./store-contract.test.ts"

describeSubscriberStoreContract(
  "createMemorySubscriberStore",
  () => Promise.resolve({ store: createMemorySubscriberStore(), close: () => Promise.resolve() }),
)
