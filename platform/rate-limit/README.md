# `@ts-libs/platform/rate-limit`

Sliding-window rate limiting for Deno and Hono, with a pluggable store. Extracted from
`mig/lib/ratelimit.ts`, `gb/apps/api/{services,middlewares}/rateLimiter.ts` and
`caldav-mcp/main.ts`, and it closes a live gap: `template`'s auth routes ship with both
`.use(rateLimiter)` calls commented out and no implementation anywhere in that repo.

## Modules

| File           | Contents                                                                        |
| -------------- | ------------------------------------------------------------------------------- |
| `memory.ts`    | `MemoryRateLimiter` (in-process), `StoreRateLimiter`, the `RateLimitStore` port |
| `kv.ts`        | `createKvStore` over a three-method `RateLimitKv`, plus `denoKvBackend`         |
| `hono.ts`      | `createRateLimitMiddleware`, draft-6 `RateLimit-*` headers, `userThenIp`        |
| `client-ip.ts` | `clientIp()` extraction order and `humanRetry()`                                |
| `mod.ts`       | Barrel for every public symbol above                                            |

## Usage

```ts
import { Hono } from "hono"
import {
  createMemoryRateLimiter,
  createRateLimitMiddleware,
  userThenIp,
} from "@ts-libs/platform/rate-limit"

const limiter = createMemoryRateLimiter({ windowMs: 60_000, limit: 10 })
const app = new Hono()
app.use(createRateLimitMiddleware(limiter, { keyResolver: userThenIp((req) => userIdFrom(req)) }))
```

Several instances share one store:

```ts
import { createKvStore, createStoreLimiter, denoKvBackend } from "@ts-libs/platform/rate-limit"

const kv = await Deno.openKv() // caller owns the handle and must close() it
const store = createKvStore({ backend: denoKvBackend(kv) })
const limiter = createStoreLimiter(store, { windowMs: 60_000, limit: 10 })
```

Redis or Postgres reach the same limiter by implementing `RateLimitStore` (`read`, `write`,
`delete`) — `createStoreLimiter` is the only thing the core needs.

## Sliding window, not fixed

A bucket holds one timestamp per _accepted_ request; only timestamps newer than `now - windowMs`
count, so an event expires exactly `windowMs` after it happened. A fixed window would let a caller
spend the whole budget in the last millisecond of one window and the whole budget again in the next
— `2 * limit` in a hair over one window, which is precisely the burst this module exists to absorb.
The boundary is half-open: an event exactly `windowMs` old no longer counts, so a 1000 ms / 1-per
limiter allows again at exactly `t0 + 1000`, denies at `t0 + 999`, and allows at `t0 + 1001`.

## Eviction policy: idle sweep, never LRU-on-insert

A bucket is dropped only when **both** hold:

- nothing has been checked against the key for `idleMs` (`seenAt <= now - idleMs`), and
- its newest recorded event is older than `now - windowMs - idleMs`.

The sweep runs when `windowMs` has elapsed since the last one, or every `SWEEP_EVERY_CHECKS` (512)
checks, whichever comes first — so a client that sends one request per key cannot outrun it.

Two consequences worth stating, because both are security properties:

- **No insertion-time eviction.** Eviction is time-driven, so a request from a brand-new key can
  never free space by pushing out an active bucket. Rotating keys does not reset an attacker's own
  counter; only waiting does.
- **A busy bucket is never swept.** `seenAt` alone would be wrong: a bucket whose most recent check
  was a _rejection_ stores no event and would look idle. Both conditions are therefore required.

Per-bucket memory is bounded by `limit` — nothing is stored for a rejected request — so a client
hammering one key grows nothing. Across keys, the sweep is the bound. `caldav-mcp`'s map had none,
which is a memory-exhaustion vector rather than untidiness.

Rejected requests are not recorded, which is what stops a blocked client from extending its own
window by retrying.

## Key resolution

`keyResolver(req)` is a parameter, never a lookup into framework state. `gb`'s only app-coupled line
was `c.get?.("auth")`, and its optional chaining silently degraded every request to a shared
`ip:unknown` bucket when the auth middleware had not run. `userThenIp(userId)` provides the
`user:<id>` / `ip:<addr>` shape; anything else is the caller's own resolver.

## `clientIp` trust boundary

Order: `CF-Connecting-IP` > first `X-Forwarded-For` hop > `X-Real-IP` > the transport peer address.
`X-Forwarded-For` is read hop by hop, never as a whole string, because a client controls the leading
part of that list.

**Every one of those headers is client-controlled unless a proxy strips and rewrites it.** A client
that reaches the origin directly can forge `X-Forwarded-For` and choose its own bucket, so the
trusted-proxy boundary is the caller's responsibility: terminate at a proxy that overwrites these
headers, or pass `trustedProxy: false` (and a `remoteAddr`) and key on the peer address alone.

## Headers

Draft-6, matching `standardHeaders: "draft-6"` in the `gb` source:

| Header                | Value                                                           |
| --------------------- | --------------------------------------------------------------- |
| `RateLimit-Limit`     | requests allowed per window                                     |
| `RateLimit-Remaining` | requests left in the window, never negative                     |
| `RateLimit-Reset`     | seconds until the window has room (or until the retry succeeds) |
| `Retry-After`         | the same countdown, on a 429 only                               |

Every value is a whole number of seconds rendered as a decimal string — no fractions, no negatives,
rounded up, because rounding down advertises a retry that the limiter still rejects. Draft-7's
combined `RateLimit` field is not emitted.

## Notes

- **Not ported:** `lyrics-populator/src/sources/rate-limiter.ts`, a 36-LOC min-gap spacer that is not
  per-key or per-host (MusicBrainz and CoverArtArchive hold separate instances, so their shared
  1 req/s was never enforced) and has no burst, concurrency cap, 429/503 backoff or jitter. The
  limiter here supersedes it.
- **Not here:** quota and usage accounting (`offer-lens/apps/api/services/demo-usage.ts`) — metering
  is a separate concern with a different lifetime.
- **Not installed:** `hono-rate-limiter` and `rate-limit-redis`. The first is this middleware; the
  second would make a Redis client a hard dependency of the limiter core, which is what the
  `RateLimitStore` port avoids.
- `denoKvBackend` is the one path with no test: the repo's `deno test` grants only `--allow-read
  --allow-env`, and `Deno.openKv()` needs `--unstable-kv` (plus a writable path). The store logic it
  feeds is covered against an in-memory fake implementing the same port.
