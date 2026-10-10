# `@spy4x/realtime`

Transport mechanics for a realtime connection: a server-side connection
registry and an aggregate-keyed notify adapter, request and response frames
with typed errors, and a client transport with acknowledgements, request
correlation, heartbeat, jittered reconnect and a cursor-based sync handshake.

Generated projects today ship a 55-line `wsHub` and an 87-line SPA client with
no acks, no heartbeat and no sync handshake. This package is that gap closed, as
a redesign rather than a port.

## Install

```bash
deno add jsr:@spy4x/realtime
```

Runs on: both halves: `./registry` and `./notify` on the server, `./client` in the browser.

## The contract

The governing record is ADR 002 in `spy4x/template`
(`docs/decisions/002-realtime-transport-and-sync.md`). Three rules, and
everything below follows from them. Where the ADR's wording is quoted, the file
and line are given, so a reader can check the citation rather than the summary.

1. **The socket carries request envelopes, and nothing about what they mean.**
   Besides liveness, the sync handshake and change hints, the socket carries
   `client.command` and `client.query` frames, answered by `server.result` or
   `server.error`. This package validates the envelope (arktype), correlates
   each answer to its request id, bounds how many requests one connection may
   have in flight, times requests out and rejects them when the socket drops.
   It never interprets a command or query name or payload, never authorizes and
   never dispatches: a host registers one dispatcher with `registry.onRequest`
   and maps names to its own buses. Authorization lives in that host code
   (ADR 002, Consequences), not in the transport. (ADR 002:50 requires exactly
   this; earlier versions of this package declined it. See _Divergence_ below.)
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
realtime updates". Earlier versions of this package declined that half of the
ADR: `ClientMessage` had no mutation frame, so it was hint-only by construction.
`spy4x/template#79` reverses the ruling, and this package now carries request
and response frames.

What still holds, and is the reason the change is additive rather than a second
application surface:

- **Correctness lives in the cursor pull.** A hint still carries a sequence and
  no entity payload; a gap still discards and pulls over REST (rules 2 and 3).
  A request's result is not a change feed: the client does not move a cursor on
  it.
- **No authorization or business logic here.** The registry hands every request
  to the host's dispatcher with the authenticated `userId` it was attached
  with; the ADR's prerequisite (authorization inside the CQRS handlers, not in
  route middleware) is the host's to meet, and this package gives a host nothing
  to bypass it with.
- **Closed, typed failures.** A client switches on `RealtimeRequestError.code`,
  one of `bad_request`, `unauthorized`, `forbidden`, `not_found`, `conflict`,
  `rate_limited`, `internal`, `timeout`. A dispatcher exception that is not a
  `RealtimeRequestError` is answered `internal` with a fixed message; its text
  goes to `onRequestError`, never to the client.
- **Bounded.** One connection may have `maxInFlightRequests` (default 16)
  unanswered requests; the next is answered `rate_limited` and takes no slot. A
  request id already in flight is answered `bad_request`, and so is a request
  frame that fails validation but has a readable `id`. A dispatcher that
  outlives `requestTimeoutMs` (default 10 s) is answered `timeout` and its
  `AbortSignal` is aborted, as it is when the connection closes. The limit
  counts _unanswered_ requests: a request answered `timeout` frees its slot
  while its dispatcher may still be running, so the limit bounds running work
  only for dispatchers that honour `signal`. An answer that cannot be encoded (a
  message over 1024 characters, a `BigInt` in the details) is replaced by a
  generic `internal` answer.
- **Idempotency is carried, not stored.** A `client.command` may carry an
  `idempotencyKey`, surfaced to the dispatcher as `context.idempotencyKey`.
  Remembering keys, replaying the first result and the 7-day sweep are the
  host's job ("Explicitly not implemented"). A query cannot carry one.
- **A dropped socket or a timeout has an unknown outcome.** Pending calls
  reject with `ConnectionLostError` when the socket drops, and with
  `RequestTimeoutError` when the client's own timeout (default 15 s, longer than
  the server's so the server's typed `timeout` normally arrives first) expires.
  Neither is a server answer: the command may have run. Resending with the same
  idempotency key is the safe retry.
- **The message unions grew.** `ClientMessage` and `ServerMessage` gained the
  four request kinds. That is a protocol extension: code that switches
  exhaustively over `kind` without a `default` needs the new cases. `send` and
  `request` keep their parameter types but refuse request frames at runtime
  (`send` returns `false`, `request` rejects): use `command` and `query`.

The test of any future change is still ADR 002:72-74: delete every line of
WebSocket code and the application must still converge through the cursor pull.

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

### Requests

```ts
import { RealtimeRequestError } from "@spy4x/realtime"

// One dispatcher per registry. The library does not know what a name means.
registry.onRequest(async ({ userId, kind, name, payload, idempotencyKey, signal }) => {
  const bus = kind === "command" ? commandBus : queryBus
  const handler = handlers.get(name)
  if (!handler) throw new RealtimeRequestError("not_found", `unknown ${kind}: ${name}`)
  // Authorize inside the handler with `userId`; validate `payload` with the handler's own schema.
  return await handler({ userId, payload, idempotencyKey, signal })
})
```

The registry options `maxInFlightRequests`, `requestTimeoutMs` and
`onRequestError` are described in _Divergence_ above.

## Operations table and HTTP call handler (`@spy4x/realtime/operations`)

An app lists what it can do once, in one table, and two adapters serve it: the socket and plain
HTTP. A command is then reachable with or without a socket, and the two ways in cannot drift
([ADR 003](https://github.com/spy4x/template/blob/main/docs/decisions/003-swappable-transport-and-local-data.md)).

```ts
import {
  createCallHandler,
  createOperationDispatcher,
  type Operations,
  RealtimeRequestError,
} from "@spy4x/realtime"

const operations: Operations<Actor> = {
  "note.create": {
    kind: "command",
    // Validate the payload and authorize the actor here: neither adapter knows what a name means.
    handle: ({ actor, payload, idempotencyKey, signal }) =>
      commandBus.dispatch(new CreateNote(actor, parseNote(payload), idempotencyKey), { signal }),
  },
  "note.list": {
    kind: "query",
    handle: ({ actor, payload }) => queryBus.dispatch(new ListNotes(actor, parseFilter(payload))),
  },
}

// Turns the app's own errors into typed ones. Anything it returns `null` for is `internal`.
const mapError = (error: unknown) =>
  error instanceof NoteNotFound ? new RealtimeRequestError("not_found", error.message) : null
```

Mounted in Hono, beside the socket:

```ts
const call = createCallHandler(operations, {
  basePath: "/api/call",
  // The handler reads no cookie and checks no `Origin`: the app's session gate does.
  authenticate: async (request) => actorFromSession(await readSession(request)),
  userIdOf: (actor) => actor.userId,
  mapError,
  onError: (error, { name, requestId }) => logger.error("call failed", { name, requestId, error }),
})
// After the middleware every REST route has: the session gate and the `Origin` check.
app.post("/api/call/:name", (c) => call(c.req.raw))

registry.onRequest(
  createOperationDispatcher(operations, {
    // Read the session again for every request, so a revoked one stops at once.
    authenticate: async ({ socketId }) => actorFromSession(await readSessionOfSocket(socketId)),
    userIdOf: (actor) => actor.userId,
    mapError,
  }),
)
```

Both adapters pass a call through the same gate, in this order, and `handle` runs only after all
four steps:

1. `authenticate` returned an actor. `null` is answered `unauthorized`.
2. The call is bound to that actor's user (below). Otherwise `unauthorized`.
3. The name is an operation of the table. Over the socket it must also be of the frame's kind.
   Otherwise `not_found`. Names every object inherits (`constructor`, `__proto__`) are not
   operations.
4. A command carries an idempotency key of 1 to 256 characters. Otherwise `bad_request`.

Authentication comes first, so a caller who is nobody learns nothing about which names exist.

### A call is bound to one user

A cookie can change under a running page: another tab signs out and someone else signs in. So the
page sends the id of the user it was started for in the `X-Realtime-User` header, and
`createCallHandler` refuses a call whose session belongs to anyone else. Over the socket the
registry already knows which user a socket was attached for, and `createOperationDispatcher`
compares the actor with that.

The check is exported for an app's list routes and its socket handshake:

```ts
import { isBoundToUser, REALTIME_USER_HEADER } from "@spy4x/realtime"

if (!isBoundToUser(request.headers.get(REALTIME_USER_HEADER), session.userId)) {
  return unauthorized()
}
```

It fails closed: no id, an empty one, one over 128 characters, or `"07"` for user `7` is refused.

### The HTTP wire

`POST <basePath>/<name>` with `Content-Type: application/json`. The body is the payload; an empty
body is a call with no payload. `Idempotency-Key` is required on a command and ignored on a query.
`X-Realtime-User` is required on every call.

Success is `200` with `{ "result": <value> }`. An operation that returns nothing answers
`"result": null`. Failure is `{ "error": { "code", "message", "details"? } }`, where `code` is the
socket's code and the status follows from it (`CALL_ERROR_STATUS`):

| Code           | Status | When                                                                |
| -------------- | ------ | ------------------------------------------------------------------- |
| `bad_request`  | 400    | no idempotency key on a command, a body that is not valid JSON      |
| `bad_request`  | 405    | a method other than `POST` (with `Allow: POST`)                     |
| `bad_request`  | 408    | a body that stops arriving (`bodyTimeoutMs`, 10 seconds by default) |
| `bad_request`  | 413    | a body over the cap (`maxBodyBytes`, 64 KiB by default)             |
| `bad_request`  | 415    | a `Content-Type` that is not `application/json`                     |
| `unauthorized` | 401    | nobody is signed in, or the session belongs to another user         |
| `forbidden`    | 403    | thrown by an operation                                              |
| `not_found`    | 404    | an unknown name, or a path that is not one name under the base path |
| `conflict`     | 409    | thrown by an operation                                              |
| `rate_limited` | 429    | thrown by an operation                                              |
| `internal`     | 500    | anything unexpected; the message is always `internal error`         |
| `timeout`      | 504    | thrown by an operation                                              |

The body is read only after the call passed the gate, so a refused caller costs no parsing. The
handler never throws: every failure is a JSON answer, sent with `Cache-Control: no-store`.

An error that is not a `RealtimeRequestError`, and that `mapError` does not know, is answered
`internal` with a generic message and handed to `onError` (HTTP) or the registry's
`onRequestError` (socket). The same holds for a `RealtimeRequestError` whose code is `internal`:
its message and details stay on the server.

The handler has no timer of its own: a call lasts as long as the operation, or until the caller
goes away (`signal`). It does no rate limiting either; put the app's limiter in front.

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
  a gap, which in a quiet group might never happen. The first open pulls
  them too, as soon as the handshake has been acknowledged or has failed
  (a lost acknowledgement does not mean the server did not adopt the socket, and
  such a socket still receives hints): the server sends hints only to a socket it
  has adopted, so a change made between the app's start-up read and that moment
  would otherwise reach the page by no hint. A cold client (no cursor yet) has
  nothing to pull here. It subscribes to `onHandshakeAcknowledged`, which fires
  after the first acknowledgement (`{ reconnect: false }`) and after each
  reconnect's (`{ reconnect: true }`), never for a failed handshake or a stopped
  transport, and runs its own full read there. The transport does not
  de-duplicate, so an app that also pulls on its own first open pulls twice,
  which is harmless.
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

### When the app returns

A phone that backgrounds the app freezes its timers and may kill its socket, so the transport can be
waiting out a long backoff, or hold a socket that is already dead. `transport.resume()` fixes both:
while reconnecting it drops the wait and reconnects at once (the reconnect pulls every group from its
cursor, and the attempt count is kept so the open still counts as a reconnect); a connect attempt
still under way is abandoned and repeated; while open it pings, so a dead socket is found after one
pong deadline. Calling it several times in one tick is safe. A transport that was never started or has stopped stays so. `watchPageResume` from
`@spy4x/realtime/page-lifecycle` calls a function when the page becomes visible, the browser goes
online, or a page is restored from the back-forward cache:

```ts
import { watchPageResume } from "@spy4x/realtime/page-lifecycle"

const stop = watchPageResume(() => transport.resume())
```

### Commands and queries

```ts
try {
  const group = await transport.command("group.rename", { groupId, title }, {
    idempotencyKey: crypto.randomUUID(), // resend with the same key after a drop
  })
  const list = await transport.query("group.list", undefined, { timeoutMs: 5_000 })
} catch (error) {
  if (error instanceof RealtimeRequestError) {
    switch (error.code) { // closed set: bad_request, unauthorized, forbidden, not_found,
      case "conflict": // conflict, rate_limited, internal, timeout
        break
    }
  } else if (error instanceof RequestTimeoutError || error instanceof ConnectionLostError) {
    // No answer, or the socket dropped or was never open: the command may have run.
  }
}
```

`transport.pendingCalls` counts calls still waiting. `requestTimeoutMs` (default
15 s) sets the default timeout; `send` and `request` remain liveness and
handshake only.

## Calls port (`@spy4x/realtime/calls`)

A store should not know whether its calls travel over the socket or over HTTP. It takes a
`CallPort`: `command(name, payload, { idempotencyKey, signal? })` and
`query(name, payload, { signal? })`. Every module throws the same two errors:
`RealtimeRequestError` (the server answered; `code` is one of the closed set, `details` is what
the server sent) and `ConnectionLostError` (the server could not be reached, so a command may or
may not have run).

| Piece                                          | Does                                                                                             |
| ---------------------------------------------- | ------------------------------------------------------------------------------------------------ |
| `createHttpCallPort({ baseUrl, userId, ... })` | `POST <baseUrl>/<name>` with `fetch`. Always works.                                              |
| `createSocketCallPort(transport)`              | Adapts a `ClientTransport`; `isAvailable()` is true while the socket is open.                    |
| `createComposedCallPort({ socket, http })`     | Socket while it is open, HTTP otherwise and after a lost socket (see below).                     |
| `withUnauthorizedHook(port, hook)`             | Calls `hook` once when a call is answered `unauthorized`. The HTTP port takes it as an option.   |
| `sendCommand`, `sendQuery`, `isRetryable`      | Send a call again when the outcome is unknown: one idempotency key per command, waits that grow. |

### HTTP wire contract

- Request: `POST <baseUrl>/<name>`, `Content-Type: application/json`, body = the payload as JSON
  (no body at all when there is none; the handler passes `undefined` to the operation, as the
  socket does), header `Idempotency-Key` on commands, header `X-Realtime-User` with the id of the
  user the page was started for. The name is one path segment (URL-encoded). The HTTP handler
  refuses a command without `Idempotency-Key` with `bad_request`, so a keyless command only works
  over the socket.
- Success: every 2xx carries `{ "result": <value> }`; `null` for an operation that returns nothing.
- Failure: a non-2xx with `{ "error": { "code", "message", "details"? } }`; `code` is the same
  string the socket uses.
- `ConnectionLostError`: `fetch` failed, no answer within `timeoutMs` (default 15 s), a 5xx with no
  readable error body, a bare 404 or 429 (a proxy answers them while a container is replaced; a
  real not-found or rate limit of ours carries the error body), or a 2xx that is not `{ result }`.
- Any other 4xx with no readable error body gets the code of its status: 401 `unauthorized`, 403
  `forbidden`, 408 `timeout`, 409 `conflict`, else `bad_request`.

### An app with HTTP only

```ts
import { createHttpCallPort, sendCommand, sendQuery } from "@spy4x/realtime/calls"

const calls = createHttpCallPort({
  baseUrl: "/api/call",
  userId: session.userId, // the user this page was started for
  onUnauthorized: () => signOut(),
})

const group = await sendCommand<{ id: string }>(calls, "group.create", { name: "Home" })
const list = await sendQuery<{ groups: unknown[] }>(calls, "group.list")
```

### An app with both

```ts
import {
  createComposedCallPort,
  createHttpCallPort,
  createSocketCallPort,
  withUnauthorizedHook,
} from "@spy4x/realtime/calls"

const http = createHttpCallPort({ baseUrl: "/api/call", userId: session.userId })
const calls = withUnauthorizedHook(
  createComposedCallPort({ socket: createSocketCallPort(transport), http }),
  () => signOut(), // one hook for both modules
)
```

A socket call that fails with `ConnectionLostError` is sent again over HTTP with the same
idempotency key. A command without a key is not: the socket may have delivered it before it
dropped. A server answer (`unauthorized`, `conflict`, a socket `RequestTimeoutError`) is never
asked again over the other module; `sendCommand` decides whether to try again.

`sendCommand` makes one key per command and sends every try with it. Tries: `attempts` (default 4);
the wait before repeat `n` is `delayMs * 2 ** (n - 1)` (default 1 s), capped at `maxDelayMs` and
jittered by `backoffDelay`. `unauthorized` is never retried.

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

| Bug                                                                                                                                                                                                                                                                               | Fix                                                                                                                                                                                                                                                                           |
| --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| A hint carries no payload, so its arrival alone was never proof the client held the data — the cursor advanced (and persisted) on arrival regardless                                                                                                                              | Every non-duplicate hint is pulled before anything moves; `cursors.apply` — the one thing that persists — runs only once that pull has succeeded (`client-transport.ts`, `#applyHint`)                                                                                        |
| A gap opened while reconnecting surfaced only if a later hint happened to reveal it, which in a quiet group could be never                                                                                                                                                        | A reconnect pulls every group the client already holds a cursor for, once, unconditionally (`#pullHeldCursors`); the first open does the same once its handshake is answered or has failed, and `onHandshakeAcknowledged` tells an app with no cursor yet when to pull (#399) |
| The reconnect backoff reset the moment a socket opened — or, after the first fix, the moment any single message arrived, which a peer that sends one byte and drops satisfies for free — so a bad peer caused a reconnect every few hundred milliseconds forever                  | The counter resets only once a message has arrived _and_ the socket has stayed open for at least `minHealthyMs` (`#tryResetBackoff`, checked from both `#handleMessage` and a timer armed in `#handleOpen`)                                                                   |
| No adapter shipped for a real `WebSocket`; the obvious one-liner (`return ws.readyState`) reads the platform's 0-3 `readyState` against this package's 1-4 `SocketState` and gets every state wrong, so an open socket reads as `Connecting` and every `send` is silently refused | `web-socket-adapter.ts` ships `adaptWebSocket` / `createWebSocketFactory` with an explicit translation table, and `send` throws on a state it actually checked rather than trusting the native socket's inconsistent behaviour                                                |
| The registry enforced no limits: one user id was measured holding 50 000 sockets, a single 6.9 MB frame was decoded and validated before anything measured it, and nothing slowed delivery to a socket whose peer had stopped reading                                             | `ConnectionRegistry` gained `maxConnectionsPerUser`, `maxMessageBytes` (measured before decoding) and `maxBufferedBytes` (a send is skipped, not queued, past it)                                                                                                             |

`testing.ts`'s `FakeSocket` also changed: `close()` now moves to `Closing`
immediately and only reaches `Closed` — firing the close handlers — on a later
microtask, the way a real `WebSocket` does. It used to close synchronously,
which every other suite in this package (and a host testing its own wiring)
inherited without knowing it.

## Offline outbox (`@spy4x/realtime/outbox`)

A client queue for commands written while the connection was down, sent in order when it is back.
It knows nothing about what an entity is: the payload is a type parameter, the entity id a string
the caller picks, and everything else is a port.

```ts
import { createMemoryOutboxStore, createOutbox, createWebLock } from "@spy4x/realtime/outbox"

const outbox = createOutbox<NotePayload, Note>({
  store: createMemoryOutboxStore(), // tests; browsers use createIndexedDbOutboxStore, one per user
  lock: createWebLock(navigator.locks, `outbox:${userId}`),
  canSend: () => socketIsOpen() && pageUserIs(userId),
  send: (command, key) => callOverSocket(command, key), // resolves the server's entity
  fetchServer: (id) => readEntity(id), // null when it is gone
  classify: (error) => ({ kind: "unreachable" }), // map your errors to a SendFailure
  cache: { put: saveToLocalCache, remove: removeFromLocalCache },
})
await outbox.submit({ kind: "update", entityId: id, payload, version: 3 })
await outbox.flush() // after a reconnect and after a pushed hint
```

The rules it keeps, each one a lost edit found in a product that wrote the queue by hand:

- **One entry per entity.** A later edit replaces the waiting one; create then delete before any
  send sends nothing. Once a send of the create was started, even before a later edit, the delete
  is sent.
- **A fresh key after an unknown outcome.** An entry whose send may have reached the server gets a
  new idempotency key when it is edited again, so the server does not answer the old key and drop
  the new text.
- **Clear only while the key matches.** After a send, an entry is removed, or marked a conflict,
  only if the queue still holds it under the key that was sent. An edit another tab made in the
  meantime stays queued.
- **One writer at a time.** Every step runs under the lock: `createPromiseLock()` for one tab,
  `createWebLock(navigator.locks, name)` for every tab of one browser. Name the lock for the user.
- **Never as someone else.** `canSend()` is checked before every entry; a queue is not sent while
  the page is signed in as another user.
- **Conflicts wait for a person.** A stale, gone or refused write is marked, never applied over
  the other side; `keepMine(entry)` sends it again on the server's version (only for a stale
  write: a gone or refused one has no server version), `useTheirs(entry)` drops it. Both take the
  entry the person saw and do nothing once the queue holds a different one, so a stale screen in
  another tab cannot delete a newer edit.

A created entity starts at version one: after an attempted create, a delete is sent against that
version. `send` runs under the lock, so it must settle or time out.

`submit` answers how the change ended: `sent` (with the server's entity), `queued` (it goes out
later), `dropped` (created and deleted before any send), `failed` or `conflict`. A refusal of a
change that stands alone answers `failed` and queues nothing, because the person is looking at the
screen and the app shows the refusal itself. A change that joined a write still queued from earlier
(an edit made offline, then another made right after the connection came back) is never dropped
with it: the refused entry stays queued as a conflict, exactly as a refusal found by `flush` would,
and `submit` answers `{ kind: "conflict", reason }`. Show the conflict from `entries()` and let the
person settle it with `keepMine` or `useTheirs`.

`withdraw(entityId)` takes back the latest change to an entity, for example the "Undo" of a delete
made offline. When that change was merged into an earlier waiting write (an edit, then a delete),
only the delete is taken back: the edit stays queued, with its key and its `attempted` flag as they
were, so a send that may already have happened is repeated idempotently. Each withdraw takes back
one more change (edit, edit, delete, then two withdraws leave the first edit queued), and a write
whose send was started is never taken back. Only the last 20 changes can be taken back: an entity
edited offline more often keeps a bounded entry, and a withdraw past the 20th answers `false` (a
forgotten step whose send was started still counts as possibly on the server). Otherwise the entry
is removed and never sent. It answers `false`, changing nothing, when there is nothing to take back or
it cannot be: the entry's send was already started (the server may have it, so only an online
restore is safe) or it is a conflict (use `keepMine` or `useTheirs`). A withdraw asked during a send
waits for it. A create that was deleted before any send leaves nothing queued, so there is nothing
to withdraw: submit the create again.

### Durable store (`@spy4x/realtime/outbox-indexeddb`)

`createIndexedDbOutboxStore({ name })` keeps the queue in plain IndexedDB, so a write made offline
survives a closed tab and a restart. `createMemoryOutboxStore` is still the store for tests and
servers; one contract suite runs against both, so they behave alike. Name the database for the
user (`outbox:${userId}`), as the lock is named. Ask the browser not to evict it with
`requestPersistentStorage` from `@spy4x/platform/browser/persistent-storage`.

## Read cache (`@spy4x/realtime/read-cache`)

The offline-readable level of ADR 003: a copy of a list read, kept on the device, that answers when
the server cannot be reached. One cache per signed-in user, over `createDataCache`.

```ts
import { cachedRead, createReadCache, readCopy } from "@spy4x/realtime/read-cache"

const cache = createReadCache({ name: `reads:${userId}` }) // or undefined: no local data

const copy = await readCopy<Group[]>(cache, `groups`) // paint at once; undefined when none
const { value, fresh, savedAt } = await cachedRead(cache, `groups`, () => fetchGroups())
// fresh: the server answered now. Not fresh: a copy taken at `savedAt` (epoch ms).

await cache.clear() // sign-out, or a start that finds no session: every copy of this user
```

- Every answer replaces the copy under its key. A read that cannot reach the server
  (`ConnectionLostError`, or the `TypeError` a failed `fetch` rejects with) answers from the copy,
  or throws the connection error when there is none. A `TypeError` thrown by your own `read`
  function counts as unreachable too.
- `clear()` finishes the instance: it stores nothing more, so a read still in flight at sign-out
  cannot write its answer back. A new user needs a new cache.
- Any other error is thrown and the copy stays. `unauthorized` and `forbidden` therefore neither
  return nor replace it.
- A device that cannot save does not fail the read; the answer is returned and the copy is not
  updated. `readCopy` never rejects.
- `cachedRead(undefined, key, read)` only calls `read`, so a store has one code path and an app
  without local data touches no IndexedDB.
- Run the full read inside `read` (all pages), so the copy is the whole list. Search and filters
  then run over the list the store holds. `cache.get` / `cache.set` let a layer on top (the
  offline-writable collection) read and update a copy directly.

## Sync runner (`@spy4x/realtime/sync-runner`)

Sends the outbox at the moments a browser gives a page: on start, when the browser goes online,
when the tab becomes visible, when the window gains focus, when a page returns from the
back-forward cache, and on `kick()`. It does not use Background Sync (Safari has none): a write
queued while the app is closed is sent the next time the app opens.

- One run at a time. A kick during a run schedules exactly one more run, however many arrive.
- A flush that throws, or answers `"unreachable"`, is retried after `backoffDelay` (1 s doubling to
  60 s, jittered). Any wake-up above cancels the wait and runs at once.
- Optional `pollIntervalMs` (off by default): while the page is visible and online, a run that
  completed is followed by another that long after it ended, so a tab left open sees remote
  changes. A hidden or offline page does not poll; the wake-up that returns the person runs at
  once and restarts the interval. A failing run keeps its backoff, and polling resumes after the
  next success. `isOnline` defaults to `navigator.onLine`. A value that is not a positive, finite
  number of at most 2 147 483 647 ms (the longest timer delay) throws a `RangeError`.
- `stop()` removes every listener and timer.
- `getState()` and `subscribe()` give `{ running, lastError, failures, nextRetryAt }` for a UI. No
  Preact in this package: bind it to a signal in the app.

`Outbox.flush` stops silently at the first write it cannot send; `flushOutbox(outbox)` turns "a
write is still pending after the flush" into the `"unreachable"` that asks for a retry.

### Wiring an offline-first PWA

```ts
import { createDataCache } from "@spy4x/platform/browser/data-cache"
import { requestPersistentStorage } from "@spy4x/platform/browser/persistent-storage"
import { installOfflineShell } from "@spy4x/platform/browser/offline-shell" // in the service worker
import { createIndexedDbOutboxStore } from "@spy4x/realtime/outbox-indexeddb"
import { createOutbox, createWebLock } from "@spy4x/realtime/outbox"
import { createSyncRunner, flushOutbox } from "@spy4x/realtime/sync-runner"

const outbox = createOutbox<NotePayload, Note>({
  store: createIndexedDbOutboxStore({ name: `outbox:${userId}` }),
  lock: createWebLock(navigator.locks, `outbox:${userId}`),
  // canSend, send, fetchServer, classify, cache: as in the outbox example above
})
const cache = createDataCache<Note>({ name: `data:${userId}`, getId: (n) => n.id })

await outbox.reload() // the queue left by the last visit
const runner = createSyncRunner({ flush: flushOutbox(outbox) })
runner.start()
void requestPersistentStorage()
```

The UI side lives in `spy4x/preact-components`: `createOnlineStatus` (`@spy4x/preact-signals`)
for an offline badge, `SWUpdater` and `startUpdates` (`@spy4x/preact-system`) for the "new version"
prompt, and the `serviceWorker()` Vite plugin (`@spy4x/preact-theme/vite`) to build the worker that
calls `installOfflineShell`. Bind `runner.subscribe` to a signal for a "syncing" or "retrying at"
indicator.

## Explicitly not implemented

- **The sync protocol.** Bootstrap, the pull endpoint, `authorization_revision`,
  the change log and the 7-day idempotency-key store are the server's job
  (`spy4x/template#11`, gaps 4 and 5). This package carries an
  `idempotencyKey` on a command and stores none. This package is the transport: it decides
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

Almost all of the unit tier has no sleeps, no network, no extra permissions: `FakeClock`
fires timers only when a test advances it, `FakeSocket` is driven by the test
as the peer, and `MemoryKeyValueStore` stands in for storage. The one exception is
`clock.test.ts`, which exercises `createSystemClock` — the adapter over the real platform
timers — and so waits on a handful of short real `setTimeout`s to prove a callback fires or a
handle actually cancels it; every other suite in this tier stays on `FakeClock` and sleeps
nothing.

The integration tier (`web-socket-adapter.integration.test.ts`) runs the real
adapter against a real WebSocket server the test itself starts on `127.0.0.1`
with an ephemeral port (`Deno.serve({ port: 0 })`, `Deno.upgradeWebSocket`). It
needs `--allow-net` and no container — nothing it does reaches past loopback —
and every server and socket it opens is closed before the test ends, so
Deno's resource and op sanitizers stay on.

The doubles are exported from `@spy4x/realtime/testing` so a host can test its
own wiring without inventing a second set.

Dependencies: arktype (the repository's only validator) for the wire schemas,
`@spy4x/platform` (`universal/time`, `#71`) for the plain instant source
`clock.ts`'s `Clock` extends, `@spy4x/net` (`bounded-body`) for the capped body read in
`operations.ts`, and `@std/*` in tests. No WebSocket library, no
framework, no Preact, no signals. `web-socket-adapter.ts` is the one file that
names the platform `WebSocket` type, and only as a type — it constructs one
only in `createWebSocketFactory`, which a browser client calls, and in the
integration test, which is Deno-only.
