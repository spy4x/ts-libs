# `@spy4x/realtime`

Transport mechanics for a hint-only realtime connection: a server-side
connection registry and an aggregate-keyed notify adapter, and a client
transport with acknowledgements, heartbeat, jittered reconnect and a
cursor-based sync handshake.

Generated projects today ship a 55-line `wsHub` and an 87-line SPA client with
no acks, no heartbeat and no sync handshake. This package is that gap closed, as
a redesign rather than a port.

## The contract

The governing record is ADR 002 in `spy4x/template`
(`docs/decisions/002-realtime-transport-and-sync.md`). Three rules, and
everything below follows from them. Where the ADR's wording is quoted, the file
and line are given, so a reader can check the citation rather than the summary.

1. **No mutations over the socket.** REST is the external application protocol;
   the socket carries liveness, a sync handshake and change hints.
   `ClientMessage` has no mutation frame and `ServerMessage` has none either —
   there is nothing here to validate, authorize or dispatch. (See _Divergence_
   below: this is ADR 001's rule, which ADR 002 supersedes for `apps/spa`. It is
   what issue #19 requires and what the extraction inventory targets.)
2. **A push carries a sequence.** ADR 002:60-61 — "Servers push committed
   changes over the socket, stamped with the per-group `next_change_sequence`
   they were committed at." A hint names a group and that sequence, and no entity
   payload.
3. **A gap triggers a pull.** ADR 002:63-66 — "A client applies a pushed change
   only when its sequence is contiguous with the cursor the client already holds.
   On any gap it discards the payload and pulls from its cursor over REST.
   Correctness therefore lives in exactly one path - the cursor pull - which is
   also the path that runs when the socket is absent." Dropped frame, reconnect
   gap, reorder, duplicate delivery: each degrades to a redundant pull, never to
   divergent state.

The test of any future change is ADR 002:72-74: _delete every line of WebSocket
code and the application must still converge to correct state._

### Where this package diverges from ADR 002, and why

ADR 002:50 says "`apps/spa` speaks WebSocket for all mutations, queries and
realtime updates", and ADR 002:132-134 makes moving authorization into the CQRS
handlers a prerequisite for that. ADR 002:63-65 also implies a push _carries_ a
payload, since a gap means discarding "the payload".

This package does neither: there is no mutation frame, and a hint carries no
data. It is the stricter position — ADR 001:64 ("REST is external application
protocol"), the extraction inventory's target ("Target is a few hundred lines of
hint-only transport", `docs/financy-extraction-inventory.md:52`) and the design
doc's steady state (`sync.hint { groupId, sequence }` … "The hint carries no
payload", `docs/design/realtime-websockets.md:90-91`) — chosen because issue #19
schedules it that way and because it is the shape that satisfies ADR 002's own
governing test trivially.

The divergence is deliberate and load-bearing, not an oversight: widening this
protocol to carry mutations means the socket becomes a second application surface
with its own authorization path, which is a new ADR, not a flag on this one. A
host cannot do it by accident — `ClientMessage` has no frame kind for it.

**Ruling (architecture owner, at review of this change): hint-only stands.** The
recorded reasoning, so a later reader does not have to re-litigate it:

- Issue #19 and the extraction inventory both ask for hint-only, and the
  inventory's own target column describes it (`:52-53`).
- Mutating over a socket that carries no sequence and has no gap detection is
  precisely the divergence bug this package exists to eliminate — ADR 002:63-66
  makes the cursor pull the only correctness path, and a mutation frame would
  put a second, weaker application path beside it.
- Widening the protocol needs an ADR amendment **plus** the auth-into-CQRS
  handlers work ADR 002:132-134 calls "a prerequisite, not a follow-up"; both are
  outside issue #19's scope.

The divergent text is ADR 002:50, quoted above, and it is named here rather than
quietly ignored: this package implements the sync contract the ADR fixes and
declines the mutation transport the ADR also describes.

### What "hint-only" buys

`financy`'s socket was the only mutation path, so the app did not work with the
socket down, and its pushes carried no sequence, so a missed frame silently
diverged local state. Here a dropped frame costs one redundant pull, a
duplicated hint costs nothing, and a reordered hint cannot move a cursor
backwards.

## Package location

This is a **top-level package, `realtime/`**, not a file inside `server/`
(ruling recorded when the member was registered, `93708f8` / PR #38).

`server/realtime.ts` is what the design doc's boundary recommendation suggests —
"Put the connection registry and the message protocol in `libs/server/realtime`
and mount it from `apps/api`" (`docs/design/realtime-websockets.md:62-64`) — but
that is a _template_ path, not this repository's. Here the analogous home is the
`server/` package, which is claimed by four other extraction issues (`#5
storage`, `#6 auth`, `#9 http`, `#15 db`), is a Wave 2/3 target while this issue
is Wave 4 "scheduled alone", and is where this package would collide: the
repository rule is one package per PR with disjoint diffs.

The name follows the same doc's naming rule — it "names the capability rather
than the transport" (`:66-70`) — so `realtime/`, not `ws/` or `ws-api/`. The
registry and the message protocol live together in it, as the boundary
recommendation asks; only the directory differs.

**Future path if the maintainer later consolidates:** re-export this package from
`server/` (or from a future `server/realtime/` subpath) without moving a line of
it, since it imports nothing from this repository and its entry points are already
declared in `realtime/deno.json`.

The workspace member line landed in `deno.jsonc` (between `./platform` and
`./server`):

```jsonc
"./realtime",
```

That registration is load-bearing for tooling, measured both ways on this
package's 19 files: unlisted, `deno fmt --check realtime/` exits 1 on 18 of them,
because Deno then resolves the package's own config and does not inherit the root
`fmt` block; listed, path-scoped `deno fmt --check realtime/` and
`deno lint realtime/` both exit 0 with the root config applied. The pathless
`deno task check` was green either way, which is why the missing line was easy to
miss and why it is worth this paragraph.

This supersedes `apps/api/services/wsHub.ts` — the 55-line stub whose whole model
is `Map<clientId, { userId, socket }>`, with no heartbeat, no liveness deadline,
no acks and one `broadcastToUser` — and the 87-line SPA client that ships with it
"with no acks, no heartbeat and no sync handshake" (issue #19).

## Ports

Nothing here imports a WebSocket library, a framework or Preact. A host adapts
its own objects once — except the browser `WebSocket` itself, which this
package now adapts (see below).

| Port                | Shape                                                                                                                                                                               | File                  |
| ------------------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | --------------------- |
| `ManagedSocket`     | `state`, `send`, `close`, `onOpen`, `onMessage`, `onClose`, optional `bufferedAmount`                                                                                               | `socket-port.ts`      |
| `SocketFactory`     | `(url) => ManagedSocket`                                                                                                                                                            | `socket-port.ts`      |
| `Clock`             | `now`, `setTimeout`/`clearTimeout`, `setInterval`/`clearInterval`                                                                                                                   | `clock.ts`            |
| `KeyValueStore`     | `getItem`, `setItem`, `removeItem` — satisfied by Web Storage `Storage`; a deprecated alias of `@spy4x/platform/universal/key-value-store`'s `KeyValueStore`, the actual home (#71) | `storage.ts`          |
| `MessageCodec`      | `encode`, `decode`                                                                                                                                                                  | `codec.ts`            |
| `CursorPort`        | `syncRequest`, `cursorFor`, `apply`, optional `markSynced`                                                                                                                          | `client-transport.ts` |
| `UserFanout`        | `sendToUsers(userIds, message)`                                                                                                                                                     | `notify.ts`           |
| `RecipientResolver` | `(change) => userIds`                                                                                                                                                               | `notify.ts`           |

Adapters a host writes — `localStorage` to `KeyValueStore`, `fetch` to the two
sync calls — are each a handful of lines and are the only place a platform
primitive is named. The one exception is `ManagedSocket` over a browser
`WebSocket`: this package ships `adaptWebSocket` and `createWebSocketFactory`
(`web-socket-adapter.ts`), because the mapping from the platform's `readyState`
(0-3) to this package's `SocketState` (1-4) is exactly the kind of bug a host
would silently reproduce — see "Fixed after ship" below.

`UserFanout` deliberately exposes no broadcast. The registry has `sendToAll` for
a server-wide notice, but the notify path is only ever given `sendToUsers`, and
`AggregateNotifier` fails closed: an aggregate with no resolver produces zero
recipients.

## Server wiring

```ts
import { AggregateNotifier, ConnectionRegistry, createSystemClock } from "@spy4x/realtime"

const clock = createSystemClock()
const registry = new ConnectionRegistry({
  clock,
  // Defaults shown; override per deployment. See "Fixed after ship" below (issue #65, finding 5).
  maxConnectionsPerUser: 20,
  maxMessageBytes: 64 * 1024,
  maxBufferedBytes: 1_000_000,
})
const notifier = new AggregateNotifier({
  fanout: registry,
  resolvers: new Map([
    // Authorization lives in the resolver: it is the membership lookup, not a route middleware.
    ["invoice", (change) => membership.readGroupMemberIds(change.groupId)],
  ]),
  onUnknownAggregate: (change) => logger.warn("unhandled aggregate", change),
})

// From the upgrade handler: authenticate once at the upgrade, then attach. `attach` returns `null`
// — and has already closed the socket — once the user is at `maxConnectionsPerUser`.
const handle = registry.attach(userId, adaptSocket(await upgrade(request)))
if (!handle) logger.warn("refused a socket: user already at the connection cap", { userId })

// From the worker that drains outbox_events, after the commit that stamped the sequence.
await notifier.notify({
  groupId,
  aggregate: "invoice",
  sequence: nextChangeSequence,
})
```

`registry.attach` owns heartbeats, liveness deadlines, orphan cleanup and
fan-out; the host never tracks sockets itself. `registry.onFrame` is where a
`client.sync` handshake is answered (the sync protocol is not part of this
package, see below).

## Client wiring

```ts
import {
  ClientTransport,
  createWebSocketFactory,
  PersistentCursorStore,
  TransportStatus,
} from "@spy4x/realtime"

const cursors = new PersistentCursorStore({
  storage: localStorage,
  clock: createSystemClock(),
})
const transport = new ClientTransport({
  url: `wss://${location.host}/api/ws`,
  socketFactory: createWebSocketFactory(),
  clock: createSystemClock(),
  cursors,
  pull: (gap) => api.get(`/api/groups/${gap.groupId}/changes?since=${gap.since}`),
  gate: async () => ({ allowed: (await fetch("/api/auth/me")).ok }),
})

transport.onChange((hint) => store.applyHint(hint))
transport.onError((error) => logger.warn(error))
transport.connect()
```

Every hint that is not a duplicate — a genuine gap and a merely-contiguous one
alike — is pulled before anything moves, and `onChange` fires only once that
pull has actually succeeded (issue #65, finding 1: a hint carries no payload,
so its arrival alone was never proof the client held the data). `pull` is
therefore the one path a failure can be seen on, and it is also the one a host
keeps running on an interval when `onSyncDegraded` fires.

Properties a caller should know, each pinned by a test:

- **The durable position moves only once a fetch has succeeded.** A hint that
  triggers a failing `pull` leaves the stored cursor untouched, so the next
  delivery of the same hint (or the next reconnect) tries again.
- **A reconnect always pulls every group the client already holds a cursor
  for**, once, unconditionally — not only when a later hint happens to reveal
  a gap, which in a quiet group might never happen.
- **The reconnect backoff resets only once the connection has proven itself —
  a message _and_ a minimum amount of time open, not either alone.** A single
  inbound frame is not proof of health: a server that sends one byte and drops
  satisfies "a message arrived" for free, on every attempt, which is exactly
  what let a reconnect storm through until issue #65's follow-up review caught
  it. The counter resets only once a message has arrived _and_ the socket has
  stayed open for at least `minHealthyMs` (default: `backoff.baseMs`) — a
  server that accepts a connection and drops it, with or without sending
  anything first, produces a growing delay between attempts instead of a
  reconnect every few hundred milliseconds forever.
- **A hint is decided as soon as it arrives, even while the handshake is
  unacknowledged.** The handshake is not serialised behind the cursor chain, so a
  hint is not held for up to `handshakeAttempts × handshakeAckTimeout`. Its cursor
  snapshot is simply taken later, which can only make it fresher.
- **`clear()` and `keys()` read durable state first.** A fresh instance that calls
  `clear()` before anything else still removes every cursor and the sync time
  that the stored group index lists. It does not scan for a cursor key that
  predates or bypasses that index — `KeyValueStore` has no way to enumerate its
  own keys — so a genuinely orphaned `realtime:cursor:*` entry can survive
  `clear()`. This is a real, pre-existing limitation, not a hypothetical one:
  reproduced by seeding `realtime:cursor:g2` without listing `g2` in
  `realtime:groups`.
- **`advanceTo(groupId, 0)` records a cursor of `0` for a group the client has not
  seen**, so a pull that reports an empty group stays distinguishable from a cold
  start. For a group that already has a cursor, `advanceTo` is monotonic and a
  lower — or negative — value is refused.

## Fixed at port time

Each row is a bug in the source this package redesigns, with the test that now
pins the behaviour.

| Bug                                                                                                                                                                                                                                                                     | Source                                                                                                                                                       | Fix here                                                                                                                                                                                                                                                                                                                                                                                                                                               |
| ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------ | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ |
| An unknown model broadcast to **every connected user** (`default:` → `Array.from(userBySocket.values())`, and `case tag:` doing the same)                                                                                                                               | `financy/apps/api/services/websockets.ts:1187-1198`                                                                                                          | Unknown aggregate → zero recipients, `NotifyStatus.UnknownAggregate`, never a fan-out call (`notify.ts`)                                                                                                                                                                                                                                                                                                                                               |
| A throwing recipient lookup fell back to `sendToAll`                                                                                                                                                                                                                    | `financy/apps/api/services/websockets.ts:1147-1151`                                                                                                          | Resolver failure → `NotifyStatus.Failed`, zero recipients, `onError` (`notify.ts`)                                                                                                                                                                                                                                                                                                                                                                     |
| `SYNC_START` sent a hardcoded `0` (`p: [0]`, with a TODO to persist the checkpoint), so every connect re-downloaded everything                                                                                                                                          | `financy/apps/web/src/state/ws.ts:276-286`                                                                                                                   | The handshake sends the persisted cursors, or an explicit `fromStart: true` for a genuinely cold client (`client-transport.ts`)                                                                                                                                                                                                                                                                                                                        |
| Guards written as `return` inside a per-model `if` chain: inconsistent (an unknown op is rejected for `transaction` at `:347-358` and `userSettings` at `:1047-1058`, silently ignored for `user` at `:962-1002`) and scoped to the whole handler rather than the block | `financy/apps/api/services/websockets.ts:179-1059`                                                                                                           | `registry.ts:293-323` dispatches on frame kind with one `if` chain and a single terminal `reportMalformed` call: every handled branch returns, so a frame that does not decode, or arrives in the wrong direction, can only reach that report and is never dispatched. (The `switch` in this package is `client-transport.ts`'s inbound path, with a `default` that reports a wrong-direction frame.) Hints go through one keyed adapter (`notify.ts`) |
| `syncedAt` in an in-memory signal, so it died with the tab                                                                                                                                                                                                              | `financy/apps/web/src/state/ws.ts:43,196`; `gb/apps/web/state/ws.ts:65,79,256-258` — `:65` declares the field, `:79` initialises it, `:256-258` overwrite it | Cursors and the sync time are persisted through an injected `KeyValueStore`; a pull that succeeds calls `markSynced()` (`cursor.ts`)                                                                                                                                                                                                                                                                                                                   |

Two more differences worth naming, both in the registry: `gb` pinged every
socket and never looked for a pong, so a half-open socket stayed in the fan-out
forever — here a socket silent past `livenessTimeoutMs` is closed and reaped;
and `gb`'s `sendToAll` threw out of its loop on the first bad socket, truncating
the broadcast — here a throwing socket is reaped and the loop continues.

## Fixed after ship

An audit of this package (issue #65) found five problems the tests above did
not catch, because no real `WebSocket` had ever been used against it. Each is
now fixed, with a colocated test that fails if the fix is reverted, and an
integration test (`web-socket-adapter.integration.test.ts`) that runs the real
adapter against a real local server. The backoff fix below went through two
rounds: the first shipped version reset the counter on any inbound message,
which a review caught still storming against a peer that sends one frame and
drops — the row describes the fix that shipped, not the first attempt.

| Bug                                                                                                                                                                                                                                                                               | Fix                                                                                                                                                                                                                            |
| --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ |
| A hint carries no payload, so its arrival alone was never proof the client held the data — the cursor advanced (and persisted) on arrival regardless                                                                                                                              | Every non-duplicate hint is pulled before anything moves; `cursors.apply` — the one thing that persists — runs only once that pull has succeeded (`client-transport.ts`, `#applyHint`)                                         |
| A gap opened while reconnecting surfaced only if a later hint happened to reveal it, which in a quiet group could be never                                                                                                                                                        | A reconnect (not the first connect) pulls every group the client already holds a cursor for, once, unconditionally (`#pullAfterReconnect`)                                                                                     |
| The reconnect backoff reset the moment a socket opened — or, after the first fix, the moment any single message arrived, which a peer that sends one byte and drops satisfies for free — so a bad peer caused a reconnect every few hundred milliseconds forever                  | The counter resets only once a message has arrived _and_ the socket has stayed open for at least `minHealthyMs` (`#tryResetBackoff`, checked from both `#handleMessage` and a timer armed in `#handleOpen`)                    |
| No adapter shipped for a real `WebSocket`; the obvious one-liner (`return ws.readyState`) reads the platform's 0-3 `readyState` against this package's 1-4 `SocketState` and gets every state wrong, so an open socket reads as `Connecting` and every `send` is silently refused | `web-socket-adapter.ts` ships `adaptWebSocket` / `createWebSocketFactory` with an explicit translation table, and `send` throws on a state it actually checked rather than trusting the native socket's inconsistent behaviour |
| The registry enforced no limits: one user id was measured holding 50 000 sockets, a single 6.9 MB frame was decoded and validated before anything measured it, and nothing slowed delivery to a socket whose peer had stopped reading                                             | `ConnectionRegistry` gained `maxConnectionsPerUser`, `maxMessageBytes` (measured before decoding) and `maxBufferedBytes` (a send is skipped, not queued, past it)                                                              |

`testing.ts`'s `FakeSocket` also changed: `close()` now moves to `Closing`
immediately and only reaches `Closed` — firing the close handlers — on a later
microtask, the way a real `WebSocket` does. It used to close synchronously,
which every other suite in this package (and a host testing its own wiring)
inherited without knowing it.

## Explicitly not implemented

- **The sync protocol.** Bootstrap, the pull endpoint, `authorization_revision`,
  the change log and the 7-day idempotency-key store are the server's job
  (`spy4x/template#11`, gaps 4 and 5). This package is the transport: it decides
  _when_ a pull is needed, and hands the cursor to whatever performs it.
- **A signals binding.** The client transport is deliberately signal-free, so it
  is testable without Preact. A binding over `onStatus`/`onChange` belongs in
  `preact-components`.
- **An SSE or long-poll transport.** The name is the design doc's, chosen so
  "adding SSE or long-polling later does not make the name a lie"
  (`docs/design/realtime-websockets.md:68`); the reason it is not built is ADR
  002:76-82 ("One mechanism") — no second, lower-guarantee lane before a
  stream-shaped feed justifies one. The ports would accept such a transport; this
  package does not ship one.
- **A server upgrade adapter.** `apps/api` owns wrapping its own framework's
  upgraded socket (Hono's, `Deno.upgradeWebSocket`'s, or another's) into
  `ManagedSocket` for `registry.attach`, because only the host knows its
  upgrade path and its cookie handling. The _client_ side is different: a
  browser `WebSocket` has exactly one shape, so this package now ships that
  adapter itself (`web-socket-adapter.ts`; see "Fixed after ship" below).
- **Hint coalescing.** The design doc leaves it open whether a group under rapid
  writes should emit at most one hint per client per interval
  (`docs/design/realtime-websockets.md:131-132`). `AggregateNotifier` sends one
  hint per committed change; a host that wants coalescing can batch before
  calling it, and the client is unaffected because it pulls the latest state
  either way. Deliberately not built on speculation.

### Undeclared keys are rejected by this package, not by the validator

A frame carrying an undeclared property is refused on both `decode` and `encode`, so
"no mutations over the socket" is a property of the protocol rather than of the frame
kinds `codec.ts` happens to declare. The check is this package's own: each parsed
frame is compared against an explicit declared-key allow-list using **own-property**
membership (`Object.keys` plus the allow-list), on the frame and on every handshake
cursor, with a plain-object check so nothing can be read through a prototype chain.

The validator cannot do this alone, and its strict option does not close it either:

- arktype's default is `onUndeclaredKey: "ignore"` — extra properties are accepted and
  _preserved_ on the parsed value, so a hint carrying `payload` decoded, survived
  `encode` and reached a host's `onFrame`.
- `@ark/schema@0.56.2` decides declaredness with `k in this.propsByKey`
  (`out/structure/structure.js`), and `in` walks the prototype chain. All twelve
  `Object.prototype` member names — `__proto__`, `constructor`, `toString`, `valueOf`,
  `hasOwnProperty`, `isPrototypeOf`, `propertyIsEnumerable`, `toLocaleString`,
  `__defineGetter__`, `__defineSetter__`, `__lookupGetter__`, `__lookupSetter__` — are
  therefore read as _declared_, and `@ark/util@0.56.2/out/flatMorph.js` starts its morph
  target from `{}`, so they survive onto the parsed value, own and enumerable.
  Measured: 12 of 12 passed both `decode` and `encode` and reached `onFrame`, with **or
  without** `"+": "reject"` on the schemas.

That last measurement is why the schemas carry **no** undeclared-key marker: with the
allow-list in place, removing the marker leaves the whole suite green, so it would be a
line no test can distinguish. One mechanism, and it is the one with tests.

Own-property membership is the right test because it is the only thing that can travel:
JSON serialises own enumerable properties only, and `JSON.parse` never produces an
inherited one. The dependency's behaviour is documented rather than patched — this
package does not fork arktype; the guard is a handful of lines next to the schemas it
protects, and mutating it reddens nine tests.

The rule is exported as `findUndeclaredKey` so it can be pinned on its own, because it
must stay a _declared-set_ check rather than a prototype-name blacklist. A blacklist
would reject a legitimate key whose name happens to exist on `Object.prototype`, and
would accept nothing else it is supposed to: the test "accepts a declared key whose name
also exists on `Object.prototype`" (with `toString` and `__proto__` passed as declared)
fails against that rewrite, and no frame in this protocol declares such a key today, so
no wire-level test could hold the property. Two acceptance tests pin it — one with an
explicit declared list, one deriving the list from a synthetic arktype schema whose
declared keys include `toString`. Measured: rewriting the predicate as a blacklist
reddens six tests, while _adding_ a blacklist beside the allow-list reddens exactly those
two and nothing else in the suite, which is what makes them non-redundant.

## Testing

```bash
deno task test               # unit tier, the whole workspace (root task; see repo AGENTS.md)
deno task test:integration   # integration tier, the whole workspace
```

Scoped to just this package:

```bash
deno test --no-prompt --allow-read --allow-env --ignore='**/*.integration.test.ts' realtime/
deno test --no-prompt --allow-read --allow-env --allow-net realtime/*.integration.test.ts
```

The unit tier has no sleeps, no network, no extra permissions: `FakeClock`
fires timers only when a test advances it, `FakeSocket` is driven by the test
as the peer, and `MemoryKeyValueStore` stands in for storage.

The integration tier (`web-socket-adapter.integration.test.ts`) runs the real
adapter against a real WebSocket server the test itself starts on `127.0.0.1`
with an ephemeral port (`Deno.serve({ port: 0 })`, `Deno.upgradeWebSocket`). It
needs `--allow-net` and no container — nothing it does reaches past loopback —
and every server and socket it opens is closed before the test ends, so
Deno's resource and op sanitizers stay on.

The doubles are exported from `@spy4x/realtime/testing` so a host can test its
own wiring without inventing a second set.

Dependencies: arktype (the repository's only validator) for the wire schemas,
and `@std/*` in tests. No WebSocket library, no framework, no Preact, no
signals. `web-socket-adapter.ts` is the one file that names the platform
`WebSocket` type, and only as a type — it constructs one only in
`createWebSocketFactory`, which a browser client calls, and in the
integration test, which is Deno-only.
