import { createFakeFetcher } from "./_fake-fetcher.test.ts"
import { describeFetcherContract } from "./fetcher-contract.test.ts"

describeFetcherContract("fake fetcher", () => {
  const fake = createFakeFetcher()
  return Promise.resolve({ ...fake, close: () => Promise.resolve() })
})
