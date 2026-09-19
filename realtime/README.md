# `@ts-libs/realtime`

Transport mechanics for a hint-only realtime connection: a server-side
connection registry and an aggregate-keyed notify adapter, and a client
transport with acknowledgements, heartbeat, jittered reconnect and a
cursor-based sync handshake.

Generated projects today ship a 55-line `wsHub` and an 87-line SPA client with
no acks, no heartbeat and no sync handshake. This package is that gap closed, as
a redesign rather than a port.

## The contract

The governing record is ADR 002 in `spy4x/template`
(`docs/decisions/002-realtime-transport-and-sync.md`), and this package
implements the transport half of it. Three rules, and everything below follows
from them:

1. **No mutations over the socket.** REST is the external application protocol.
   The socket carries liveness, a sync handshake and change hints.
   `ClientMessage` has no mutation frame and `ServerMessage` has none either —
   there is nothing to dispatch.
2. **A push carries a sequence.** A hint names a group, an aggregate and the
   `next_change_sequence` the change was committed at. It carries no entity
   payload.
3. **A gap triggers a pull.** A hint is applied only when its sequence is
   contiguous with the cursor the client already holds. Anything else — a
   dropped frame, a duplicate, a reorder — is discarded and the cursor is pulled
   over REST. Correctness lives in exactly one path, the cursor pull, which is
   the path that also runs when the socket is absent.

The test of any future change is ADR 002's own: _delete every line of WebSocket
code and the application must still converge to correct state._

### What "hint-only" buys

`financy`'s socket was the only mutation path, so the app did not work with the
socket down, and its pushes carried no sequence, so a missed frame silently
diverged local state. Here a dropped frame costs one redundant pull, a
duplicated hint costs nothing, and a reordered hint cannot move a cursor
backwards.

## Package location

This is a **top-level package, `realtime/`**, not a file inside `server/`.

`server/realtime.ts` would have avoided a root-config change, but `server/` is
claimed by other extraction issues (`#5 storage`, `#6 auth`, `#9 http`,
`#15 db`) and the repository rule is one package per PR with disjoint diffs;
three agents writing into one directory is how a rebase turns into a merge
conflict in shared files. The directory also does not exist yet, so this package
cannot reuse it without inventing it for someone else.

One line is therefore needed in the root `deno.jsonc` `workspace` array — after
`"./platform",`, before `"./server",`:

```jsonc
"./realtime",
```

Deno already discovers and runs this package's tests without that line, and
`infra/scripts/type-check.ts` walks the tree, so the line is what makes it a JSR
member and lets a sibling package import `@ts-libs/realtime`, not what makes the
checks pass.

## Ports

Nothing here imports a WebSocket library, a framework or Preact. A host adapts
its own objects once.

| Port                | Shape                                                                   | File                  |
| ------------------- | ----------------------------------------------------------------------- | --------------------- |
| `ManagedSocket`     | `state`, `send`, `close`, `onOpen`, `onMessage`, `onClose`              | `socket-port.ts`      |
| `SocketFactory`     | `(url) => ManagedSocket`                                                | `socket-port.ts`      |
| `Clock`             | `now`, `setTimeout`/`clearTimeout`, `setInterval`/`clearInterval`       | `clock.ts`            |
| `KeyValueStore`     | `getItem`, `setItem`, `removeItem` — satisfied by Web Storage `Storage` | `storage.ts`          |
| `MessageCodec`      | `encode`, `decode`                                                      | `codec.ts`            |
| `CursorPort`        | `syncRequest`, `apply`, optional `markSynced`                           | `client-transport.ts` |
| `UserFanout`        | `sendToUsers(userIds, message)`                                         | `notify.ts`           |
| `RecipientResolver` | `(change) => userIds`                                                   | `notify.ts`           |

Adapters a host writes — a browser `WebSocket` to `ManagedSocket`,
`localStorage` to `KeyValueStore`, `fetch` to the two sync calls — are each a
handful of lines and are the only place a platform primitive is named.

`UserFanout` deliberately exposes no broadcast. The registry has `sendToAll` for
a server-wide notice, but the notify path is only ever given `sendToUsers`, and
`AggregateNotifier` fails closed: an aggregate with no resolver produces zero
recipients.

## Server wiring

```ts
import { AggregateNotifier, ConnectionRegistry, createSystemClock } from "@ts-libs/realtime"

const clock = createSystemClock()
const registry = new ConnectionRegistry({ clock })
const notifier = new AggregateNotifier({
  fanout: registry,
  resolvers: new Map([
    // Authorization lives in the resolver: it is the membership lookup, not a route middleware.
    ["invoice", (change) => membership.readGroupMemberIds(change.groupId)],
  ]),
  onUnknownAggregate: (change) => logger.warn("unhandled aggregate", change),
})

// From the upgrade handler: authenticate once at the upgrade, then attach.
registry.attach(userId, adaptSocket(await upgrade(request)))

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
import { ClientTransport, PersistentCursorStore, TransportStatus } from "@ts-libs/realtime"

const cursors = new PersistentCursorStore({
  storage: localStorage,
  clock: createSystemClock(),
})
const transport = new ClientTransport({
  url: `wss://${location.host}/api/ws`,
  socketFactory: (url) => adaptSocket(new WebSocket(url)),
  clock: createSystemClock(),
  cursors,
  pull: (gap) => api.get(`/api/groups/${gap.groupId}/changes?since=${gap.since}`),
  gate: async () => ({ allowed: (await fetch("/api/auth/me")).ok }),
})

transport.onChange((hint) => store.applyHint(hint))
transport.onError((error) => logger.warn(error))
transport.connect()
```

`onChange` fires only for hints contiguous with the stored cursor — those are
safe to apply. Everything else already went to `pull`, which is the
authoritative path and also the one a host keeps running on an interval when
`onSyncDegraded` fires.

## Fixed at port time

Each row is a bug in the source this package redesigns, with the test that now
pins the behaviour.

| Bug                                                                                                                                                                                                                                                                     | Source                                                                          | Fix here                                                                                                                                                                                                    |
| ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ------------------------------------------------------------------------------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| An unknown model broadcast to **every connected user** (`default:` → `Array.from(userBySocket.values())`, and `case tag:` doing the same)                                                                                                                               | `financy/apps/api/services/websockets.ts:1187-1198`                             | Unknown aggregate → zero recipients, `NotifyStatus.UnknownAggregate`, never a fan-out call (`notify.ts`)                                                                                                    |
| A throwing recipient lookup fell back to `sendToAll`                                                                                                                                                                                                                    | `financy/apps/api/services/websockets.ts:1147-1151`                             | Resolver failure → `NotifyStatus.Failed`, zero recipients, `onError` (`notify.ts`)                                                                                                                          |
| `SYNC_START` sent a hardcoded `0` (`p: [0]`, with a TODO to persist the checkpoint), so every connect re-downloaded everything                                                                                                                                          | `financy/apps/web/src/state/ws.ts:276-286`                                      | The handshake sends the persisted cursors, or an explicit `fromStart: true` for a genuinely cold client (`client-transport.ts`)                                                                             |
| Guards written as `return` inside a per-model `if` chain: inconsistent (an unknown op is rejected for `transaction` at `:347-358` and `userSettings` at `:1047-1058`, silently ignored for `user` at `:962-1002`) and scoped to the whole handler rather than the block | `financy/apps/api/services/websockets.ts:179-1059`                              | One exhaustive dispatcher: a frame that does not decode, or arrives in the wrong direction, is reported as malformed and never dispatched (`registry.ts`); hints go through one keyed adapter (`notify.ts`) |
| `syncedAt` in an in-memory signal, so it died with the tab                                                                                                                                                                                                              | `financy/apps/web/src/state/ws.ts:43,196`; `gb/apps/web/state/ws.ts:65,256-258` | Cursors and the sync time are persisted through an injected `KeyValueStore`; a pull that succeeds calls `markSynced()` (`cursor.ts`)                                                                        |

Two more differences worth naming, both in the registry: `gb` pinged every
socket and never looked for a pong, so a half-open socket stayed in the fan-out
forever — here a socket silent past `livenessTimeoutMs` is closed and reaped;
and `gb`'s `sendToAll` threw out of its loop on the first bad socket, truncating
the broadcast — here a throwing socket is reaped and the loop continues.

## Explicitly not implemented

- **The sync protocol.** Bootstrap, the pull endpoint, `authorization_revision`,
  the change log and the 7-day idempotency-key store are the server's job
  (`spy4x/template#11`, gaps 4 and 5). This package is the transport: it decides
  _when_ a pull is needed, and hands the cursor to whatever performs it.
- **A signals binding.** The client transport is deliberately signal-free, so it
  is testable without Preact. A binding over `onStatus`/`onChange` belongs in
  `preact-components`.
- **An SSE or long-poll transport.** The ports would accept one; building a
  second mechanism before there is a stream-shaped feed that justifies it is
  exactly what ADR 002 rules out.
- **A host socket adapter.** `apps/api` and `apps/spa` own those, because only
  they know their upgrade path and their cookie handling.

## Testing

```bash
deno test realtime/
```

No sleeps, no network, no extra permissions: `FakeClock` fires timers only when
a test advances it, `FakeSocket` is driven by the test as the peer, and
`MemoryKeyValueStore` stands in for storage. The suite runs under the
repository's `deno test --no-prompt --allow-read --allow-env`.

The doubles are exported from `@ts-libs/realtime/testing` so a host can test its
own wiring without inventing a second set.

Dependencies: arktype (the repository's only validator) for the wire schemas,
and `@std/*` in tests. No WebSocket library, no framework, no Preact, no
signals.
