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
const app = new Hono<{ Bindings: { remoteAddr?: string } }>()

// `remoteAddr` reads the connection's own peer address from whatever the runtime exposes —
// `Deno.serve`'s `server.requestIP(req)`, `Bun.serve`'s `server.requestIP(req)`, or a value an
// earlier middleware stored. It reaches the resolver as `context.remoteAddr`.
app.use(createRateLimitMiddleware(limiter, {
  remoteAddr: ({ env }) => env?.remoteAddr,
  keyResolver: userThenIp((req) => userIdFrom(req)),
}))
```

Leave `trustedProxy` off (the default) unless a proxy in front strips and rewrites the forwarding
headers; with it on and no proxy, the limiter is trivially defeated — see the trust boundary below.

Several instances share one store:

```ts
import { createKvStore, createStoreLimiter, denoKvBackend } from "@ts-libs/platform/rate-limit"

const kv = await Deno.openKv() // caller owns the handle and must close() it
const store = createKvStore({ backend: denoKvBackend(kv) })
const limiter = createStoreLimiter(store, { windowMs: 60_000, limit: 10 })
```

Redis or Postgres reach the same limiter by implementing `RateLimitStore` (`read`, `write`,
`delete`) — `createStoreLimiter` is the only thing the core needs.

**Read-modify-write is not atomic across instances.** Two isolates can read the same value and both
accept, so the effective limit under concurrency is `limit + (concurrent isolates - 1)`. The
3-method port is what forecloses a Deno KV `atomic().check()` compare-and-swap: that is a deliberate
design choice, not a backend limitation — a cross-instance lock per request would serialise the API
on the limiter, and a limiter that errs one request generous is better than one that is down. If you
need an exact count, put the counter behind a store that has an atomic increment and accept the
round-trip.

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

So a bucket that ever recorded an event is retained for `windowMs + idleMs`, and the idle grace
alone only retires a bucket that has no events left (every recorded event already outside its
window). The sweep runs when `windowMs` has elapsed since the last one, or every
`SWEEP_EVERY_CHECKS` (512) checks, whichever comes first — so a client that sends one request per key
cannot outrun it.

**Memory envelope.** At the defaults (`windowMs` 60 s, `idleMs` 600 s) a bucket lives 660 s, so
steady-state retention is `request_rate × 660` keys — about 660k keys at 1,000 req/s. Measured on
this implementation across 200,000 rotating buckets: **353.5 bytes per bucket**, so roughly
**222 MiB (233 MB)** at that rate. That is the price of the
10-minute grace, and `idleMs` is the knob: the `mig` implementation this replaces pruned at
`request_rate × windowMs` (60 s), i.e. 11× tighter, at the cost of dropping a bucket the moment its
window closed. Lower `idleMs` towards `windowMs` to trade memory for extra sweep churn.

Two consequences worth stating, because both are security properties:

- **No insertion-time eviction.** Eviction is time-driven, so a request from a brand-new key can
  never free space by pushing out an active bucket. Rotating keys does not reset an attacker's own
  counter; only waiting does.
- **A busy bucket is never swept.** `seenAt` alone would be wrong: a bucket whose most recent check
  was a _rejection_ stores no event and would look idle. Both conditions are therefore required.
- **No wall clock, and no per-event shifting.** Every timing decision goes through the injected
  `Clock`, including the seed for the automatic sweep, and a prune costs one binary search plus one
  `slice` rather than a `shift()` per stale event. Both regressions are now caught: seeding
  `lastSweepAt` from `Date.now()` fails `schedules its automatic sweep from the injected clock, never
  the wall clock`, and restoring the loop fails the array-operation guard.

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

With `trustedProxy: false` (the default) only the transport peer address is used. With
`trustedProxy: true` the order is `CF-Connecting-IP` > first `X-Forwarded-For` hop > `X-Real-IP` >
peer address. `X-Forwarded-For` is read hop by hop, never as a whole string, because a client
controls the leading part of that list.

**Every one of those headers is client-controlled unless a proxy strips and rewrites it.** A client
that reaches the origin directly can forge `X-Forwarded-For` and choose its own bucket, so the
trusted-proxy boundary is the caller's responsibility. The middleware supports both ends of that
choice:

- **Behind a proxy that rewrites the headers:** pass `trustedProxy: true` to `userThenIp`. Nothing
  else is needed; the headers are trustworthy because the proxy set them last.
- **No such proxy:** leave `trustedProxy` at its default (`false`) and wire `remoteAddr`, which
  `keyResolver` receives as `context.remoteAddr` (see Usage). Keys then follow the connection's own
  peer address, which a client cannot set.

Without a `remoteAddr` accessor the resolver has no peer address at all and falls back to the
placeholder `clientIp` returns, `0.0.0.0` — and **every** header-less client then shares one bucket,
so one caller exhausting it denies the rest. If you cannot obtain a peer address, treat the shared
bucket as a backstop and front the service with a proxy.

**Where the trust decision lives.** Exactly three places can consult a forwarding header, and all
three default to not trusting one: `clientIp`'s `trustedProxy` parameter, `userThenIp`'s
`trustedProxy` option, and the `keyResolver` you write — which sees a header only if you read one.
There is deliberately no fourth. This package used to export a `resolveIdentityKey` helper that built
a key from a `Request` plus a peer address passed as a plain string; its `trustedProxy` default was
`true`, it duplicated `userThenIp`, and it made the peer-address mitigation unreachable, because a
`Request` carries no peer address, so that option could only ever be fed by a side channel. A caller
wiring the two obvious arguments got a limiter that 200 rotating `X-Forwarded-For` values at
`limit: 3` walked straight through. It is removed rather than kept as a second public entry point with
a security-relevant default; compose `clientIp` with `rateLimitKey` yourself if you need a key
outside the middleware, stating explicitly which of the two you want.

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
- `Deno.openKv()` is the one call with no test: it needs `--unstable-kv` (plus a writable path), and
  the repo's `deno test` grants only `--allow-read --allow-env`. Everything around it is covered —
  `denoKvBackend` consumes a `DenoKvLike` port, so it is tested against a fake handle (namespace key
  shape, `{ value: null }` treated as absent, `expireIn` pass-through, delete, and a limiter driven
  end to end through it), and so is the store logic on top.
