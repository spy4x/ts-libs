import { createMemorySendLog } from "./memory-send-log.ts"
import { describeSendLogContract } from "./send-log-contract.test.ts"

describeSendLogContract(
  "createMemorySendLog",
  () => Promise.resolve({ log: createMemorySendLog(), close: () => Promise.resolve() }),
)
