// Runs the `ObjectFs` contract against the in-memory fake. `local.integration.test.ts` runs the same
// suite against real disk.

import { createMemoryObjectFs } from "./memory-fs.ts"
import { describeObjectFsContract } from "./object-fs-contract.test.ts"

describeObjectFsContract(
  "createMemoryObjectFs",
  () =>
    Promise.resolve({ fs: createMemoryObjectFs(), root: "/data", close: () => Promise.resolve() }),
)
