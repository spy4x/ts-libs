/// <reference lib="deno.unstable" />
// Runs the store contract on a real Deno KV database, so the atomic checks, versionstamps and
// `expireIn` values the store relies on are those of Deno KV, not of the fake in
// `kv-store.test.ts`. The root `test` task passes `--unstable-kv` for this.
import { KvOAuthStore, type OAuthKv } from "./kv-store.ts"
import { describeOAuthStoreContract } from "./store-contract.test.ts"

/** One in-memory database for the file; each store gets its own prefix in it. */
const kv = await Deno.openKv(":memory:")
let stores = 0

/**
 * `kv`, with a minute added to every `expireIn`. The contract's manual clock starts at 1 000 and
 * its records expire at 2 000 to 5 000, which Deno KV reads as one to four seconds of real time: a
 * slow run could see a record vanish mid-test. Real Deno KV still checks the value is valid.
 */
const slowExpiry: OAuthKv = {
  get: (key) => kv.get(key),
  list: (selector) => kv.list(selector),
  atomic() {
    const op = kv.atomic()
    const wrapped: ReturnType<OAuthKv["atomic"]> = {
      check(...checks) {
        op.check(...checks)
        return wrapped
      },
      set(key, value, options) {
        const expireIn = options?.expireIn
        op.set(key, value, expireIn === undefined ? options : { expireIn: expireIn + 60_000 })
        return wrapped
      },
      delete(key) {
        op.delete(key)
        return wrapped
      },
      commit: () => op.commit(),
    }
    return wrapped
  },
}

describeOAuthStoreContract(
  "KvOAuthStore on Deno KV",
  (clock) => new KvOAuthStore(slowExpiry, { clock, prefix: ["contract", String(++stores)] }),
)
