/**
 * `@spy4x/server/kv` — a Redis-backed key-value store, scoped to a caller-supplied
 * key prefix. Extracted from `template/libs/server/kv/+index.ts` (#75).
 *
 * `RedisKvStore`. A small wrapper over `@iuioiua/redis`'s `RedisClient`: `get`, `set` with a TTL,
 * `take`, `del`, `eval`, `reset`, `close`. Extracted from `template/libs/server/kv/+index.ts` (#75);
 * `financy`'s copy differs from the template's by one import line (its own module alias for the cache
 * interface) and was not otherwise consulted. It runs on Deno, Node and Bun: the socket comes from
 * `@spy4x/platform/server/tcp`'s `connectTcp` (`Deno.connect` on Deno, `node:net` on Node and Bun).
 *
 * **Password and ACL user.** `RedisKvStore.connect(host, port, prefix, { username?, password? })` sends
 * `AUTH` before `PING`, on the first connection and on every reconnect. Without a `password` nothing
 * is sent and three-argument calls behave as before; an empty password counts as none; a `username`
 * without a `password` throws a `TypeError`. `AUTH` and `PING` share the connect deadline. A server
 * that refuses the credentials or needs ones you did not give makes `connect` reject with a
 * `RedisKvStoreAuthError`, whose `code` is `WRONGPASS` or `NOAUTH` (match on that, not on the text) and
 * whose messages are `KV server refused the credentials (WRONGPASS)` and
 * `KV server requires a password: pass options.password to connect()`. The socket is closed, and
 * neither the password nor the server's own text appears in the error. If the password changes on the
 * server later, the next reconnect fails with a `RedisKvStoreConnectionError` whose `cause` is that
 * `RedisKvStoreAuthError`.
 *
 * **Structurally compatible with `ICacheStorage`.** `@spy4x/platform/cache`'s `ICacheStorage` (#125)
 * names `server/kv` in its own doc as the interface's Redis implementation, briefed against these exact
 * signatures: `get(key): Promise<string | null>`, `set(key, value: string, ttlSec): Promise<void>`,
 * `del(key): Promise<void>`, `reset(): Promise<void>`. This module does not import
 * `@spy4x/platform/cache` — the two were extracted in parallel and neither depends on the other's
 * branch — so the match is verified structurally: `deno check` accepts `const _: ICacheStorage = store`
 * and rejects a `{ get }`-only object with `TS2739`.
 *
 * **Rate-limit storage: `redisRateLimitKv(store)`.** Adapts a `RedisKvStore` to the `RateLimitKv` port
 * of `@spy4x/platform/rate-limit/kv`, so `createKvStore({ backend: redisRateLimitKv(kv) })` shares one
 * limit across API instances. It works against Redis and Valkey (same protocol). Values are JSON;
 * `expireIn` (milliseconds) is rounded up to whole seconds, never to 0, and no `expireIn` means no
 * expiry; a value JSON cannot represent throws `TypeError`. `get` returns `undefined` for a key that
 * holds invalid JSON (another application's key) so one foreign key cannot fail every request for that
 * client; the limiter overwrites it on its next write. **Not atomic across instances:** the platform
 * store reads, adds an event and writes back with plain `GET`/`SET`. When two instances read the same
 * window at once, both accept and the later write overwrites the earlier one, so an accepted request
 * can go unrecorded. This repeats while requests overlap: under lockstep bursts the effective limit
 * approaches `limit x instances` (measured: 32 of 32 simultaneous requests accepted at a limit of 10,
 * four connections). Fine for one instance; for several, use the atomic store below.
 * `RedisKvStore.setWithoutExpiry`
 * was added for the no-expiry case.
 *
 * **Atomic rate-limit storage: `createRedisRateLimitStore(store, options?)`.** A `RateLimitStore` for
 * `createStoreLimiter` from `@spy4x/platform/rate-limit` that holds the exact limit across any number
 * of API instances: `createStoreLimiter(createRedisRateLimitStore(kv), { windowMs, limit })`. It keeps
 * each window in a Redis sorted set and implements the optional `RateLimitStore.consume`, one Lua
 * script (`EVAL`) that drops events older than the window, counts, records the request only when
 * there is room, and sets the key's expiry, all in one step that Redis runs before it serves anyone
 * else. In the integration tier, four connections firing 32 simultaneous requests at a limit of 10 per
 * round, for five rounds, accept exactly 10 each round; the same burst through `redisRateLimitKv` plus
 * `createKvStore` accepts all 32.
 *
 * - **The clock is the limiter's, not Redis `TIME`.** "Now" is what the limiter passes in, so behaviour
 *   matches the other stores and tests stay deterministic; the key's real expiry is a Redis TTL of
 *   `windowMs`. Instances with skewed clocks disagree on the window's start, so keep them on NTP.
 * - **Plain `EVAL`, no `EVALSHA`.** The script travels with each call (a few hundred bytes), so a Redis
 *   restart or failover never answers `NOSCRIPT` and there is no fallback path to get wrong.
 * - **Own key namespace.** Default `ratelimit-atomic` under the `RedisKvStore` prefix (option
 *   `keyPrefix`). Keys are sorted sets; pointing it at keys `redisRateLimitKv` wrote makes Redis answer
 *   `WRONGTYPE`.
 * - **`refund` is atomic too**, through the optional `RateLimitStore.release`: one Lua script removes
 *   the single event recorded at `at` (or the newest), so a refund cannot erase requests other
 *   instances recorded meanwhile. A store without `release` refunds by `read` then `write`, and there
 *   a refund overlapping other instances' checks can erase their events and let more than `limit`
 *   through.
 * - **A resend after a dead connection** reuses the same event id, so `consume` records no extra event;
 *   it may answer "rejected" for a request that was in fact recorded (the first run took the last
 *   slot). A resent `release` with `at` removes a second event only when another one shares that
 *   millisecond; without `at` it also removes the next-newest event.
 * - To run scripts, `RedisKvStore.eval(script, keys, args)` was added: keys are prefixed like every
 *   other method's, `args` arrive as `ARGV`.
 *
 * **Every key lives under a mandatory prefix, and `reset()` only touches that prefix.** The ported
 * original's `reset()` sent `FLUSHDB`, which deletes every key in the whole Redis database — another
 * application's keys, another test run's keys, everything. A shared library should not offer that.
 * `RedisKvStore.connect` takes a `keyPrefix` and refuses an empty one; every key is stored as
 * `<prefix>:<key>`, and `reset()` walks only that prefix with `SCAN`/`DEL` — `SCAN` rather than `KEYS`,
 * because `KEYS` blocks the whole server for the scan's duration on a large database, which is exactly
 * the kind of shared-resource risk the prefix scoping exists to avoid.
 *
 * **A prefix is a string match, not a namespace hierarchy.** A store with prefix `app` also reads and
 * resets the keys of a store with prefix `app:sub`: `app` addresses its own key `sub:k` at
 * `app:sub:k`, which is exactly where `app:sub` addresses its key `k`. Choose prefixes that are not
 * one another's sub-string across the `:` separator, unless that overlap is intended.
 *
 * **Fixed at extraction time**, all in `redis-kv-store.ts`:
 *
 * | Bug                                                                                                                                                                                      | Pinned by                                                                                                                                                                                                                     |
 * | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
 * | `reset()` sent `FLUSHDB`, wiping the whole database                                                                                                                                      | `sets, gets, deletes and resets within its own prefix only`                                                                                                                                                                   |
 * | `reset()`'s `SCAN MATCH` pattern did not escape `*`, `?`, `[`, `]` or `\` in the prefix, so a prefix containing one of them matched other stores' keys                                   | `reset() escapes glob metacharacters in the prefix instead of matching them as a pattern`                                                                                                                                     |
 * | `get<T extends Reply>` let a caller cast an arbitrary type onto a `GET` reply                                                                                                            | `get` is typed `Promise<string \| null>`, matching the protocol                                                                                                                                                               |
 * | `set(key, value, ttlSec)` forwarded `ttlSec` straight to `SET … EX`, and Redis refuses a non-integer, zero, negative or infinite value with an opaque protocol error or a `NaN` argument | `rejects a ttlSec that is not a positive integer`                                                                                                                                                                             |
 * | `close()` called `Deno.Conn.close()` unconditionally, which throws `BadResource` on a connection already closed                                                                          | `close() is safe to call more than once`                                                                                                                                                                                      |
 * | every method called the client directly after `close()` or after the connection died, crashing the process with an uncaught `BadResource` instead of rejecting                           | `rejects instead of crashing after close()`; `get` after the connection is killed by `rejects instead of crashing once the connection is killed` and `rejects every call still queued at the moment the connection is killed` |
 *
 * An ordinary error reply from Redis (`WRONGTYPE`, an out-of-memory refusal, `READONLY`, `BUSY`)
 * rejects that one call with `RedisError` from `@iuioiua/redis` and leaves the store usable; only a
 * failed read or write marks the connection dead. Pinned by
 * `keeps working after Redis answers one command with an error`.
 *
 * `connect()` also dropped the ported original's `console.log("✅ Connected to KV")`: a library
 * primitive should not write to stdout on a caller's behalf. The caller decides whether connecting is
 * worth logging.
 *
 * **Reconnects itself once the connection dies (#158).** Earlier, a dead connection was permanent:
 * every method recorded the failure once and threw `RedisKvStoreConnectionError` forever after, even
 * once Redis came back. Nothing watches the connection on its own; a dropped socket is noticed only
 * when a call next tries to use it. A call that finds the connection already recorded dead opens a
 * fresh one first (the same TCP connect + `PING` steps `connect()` itself runs, each bounded to a
 * fixed 5-second timeout, because an unreachable host hangs a TCP connect for the OS's multi-minute
 * timeout and a host that accepts the connection but never answers would hang the `PING` forever),
 * swaps it in, and only then sends its command. Concurrent calls that all find the connection dead
 * share one in-flight reconnect instead of each opening its own socket. `close()` racing a reconnect
 * still leaves no socket open.
 *
 * **Resends a command once after reconnecting (#169).** The call whose own write or read fails on a
 * dead connection (not an error reply from Redis) reconnects and sends its command once more on the
 * fresh connection, so a Redis restart no longer costs the first call after it. A resend is not free
 * when the first send did reach Redis before the socket died: `GET`, `SCAN` and `CLIENT ID` only read,
 * but a resent `SET … EX` or `DEL` can overwrite a write another client made in between, and a resent
 * `GETDEL` finds the key already gone, so `take` returns `null` and the value is lost.
 * Each call reconnects at most once: a call that already reconnected before its first send, a call
 * whose one reconnect fails, and a resend that fails again all throw `RedisKvStoreConnectionError`,
 * with the failure as `cause`. While Redis is down, every call fails after one bounded attempt, with
 * no retry loop. An error reply such as `WRONGTYPE` is never resent.
 *
 * **Bounds every command (#172).** A command on an open connection waits at most 5 seconds for its
 * reply. When Redis freezes (`docker pause`, a stuck host), the store closes the connection, records
 * the failure and throws `RedisKvStoreConnectionError` with a `TimeoutError` as `cause`. Every command
 * queued behind it on that connection also throws `RedisKvStoreConnectionError`, with its own failed
 * read as `cause`. The next call reconnects. Neither the timed-out command nor those queued behind it
 * is resent, since a frozen Redis would hold each caller for another full bound. Before
 * this, a frozen Redis turned into request latency equal to the freeze. All three 5-second bounds are
 * fixed internal constants, not options on `connect()`.
 *
 * **`take(key)`** reads a value and deletes its key in one atomic `GETDEL` (Redis 6.2 or later), for
 * one-time values such as a pending sign-in flow: two concurrent calls never both receive the value.
 * A resend after a dead connection never returns it a second time either, but it can return `null` for
 * a value the lost first send already deleted.
 *
 * Net effect for a caller: a Redis restart costs no call at all when Redis is back by the time the
 * resend reconnects, and otherwise only the calls made while Redis is actually down; a frozen Redis
 * costs each affected call at most one command bound. This is what let `spy4x/seed`'s
 * `crashOnConnectionLoss` adapter be replaced by ordinary per-request error handling.
 *
 * Pinned by `redis-kv-store.test.ts` (fakes, no real Redis) and by
 * `redis-kv-store.integration.test.ts`, whose `answers the first call after its connection is killed,
 * by reconnecting and resending` kills the store's own connection with `CLIENT KILL ID` and shows the
 * next `get` returning the stored value on a new connection.
 *
 * @module
 */
export {
  RedisKvStore,
  RedisKvStoreAuthError,
  RedisKvStoreClosedError,
  RedisKvStoreConnectionError,
  type RedisKvStoreOptions,
} from "./redis-kv-store.ts"
export { type RateLimitRedisStore, redisRateLimitKv } from "./rate-limit-kv.ts"
export {
  createRedisRateLimitStore,
  type RateLimitRedisScriptStore,
  type RedisRateLimitStoreOptions,
} from "./redis-rate-limit-store.ts"
