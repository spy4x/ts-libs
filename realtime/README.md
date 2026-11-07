# `@spy4x/realtime`

Transport mechanics for a realtime connection: a server-side connection
registry and an aggregate-keyed notify adapter, request and response frames
with typed errors, and a client transport with acknowledgements, request
correlation, heartbeat, jittered reconnect and a cursor-based sync handshake.

## Install

```bash
deno add jsr:@spy4x/realtime
```

Runs on: both halves: `./registry` and `./notify` on the server, `./client` in the browser.

## Modules

Each module's usage is in its module doc, shown by `deno doc` and on JSR.

- [`@spy4x/realtime`](mod.ts): Transport mechanics for a hint-only realtime connection.
- [`@spy4x/realtime/client`](client-transport.ts): Client transport.
- [`@spy4x/realtime/calls`](calls.ts): The calls port.
- [`@spy4x/realtime/page-lifecycle`](page-lifecycle.ts): Tells a host when its page has returned to the user, so a realtime transport can recover at once.
- [`@spy4x/realtime/registry`](registry.ts): Connection registry.
- [`@spy4x/realtime/operations`](operations.ts): One table of named operations, served by two adapters.
- [`@spy4x/realtime/notify`](notify.ts): One aggregate-keyed notify adapter, replacing nineteen per-handler files.
- [`@spy4x/realtime/cursor`](cursor.ts): Per-group monotonic cursors, and the gap rule that keeps a hint-only socket honest.
- [`@spy4x/realtime/outbox`](outbox.ts): An offline outbox for client commands.
- [`@spy4x/realtime/outbox-indexeddb`](outbox-indexeddb.ts): The durable `OutboxStore`.
- [`@spy4x/realtime/collections`](collections.ts): Offline-writable collections.
- [`@spy4x/realtime/read-cache`](read-cache.ts): A read cache in front of any list read.
- [`@spy4x/realtime/changes`](changes.ts): The cursor pull of ADR 002.
- [`@spy4x/realtime/sync-runner`](sync-runner.ts): Drives a flush of the offline outbox (or any async sync step) at the moments a browser gives a page.
- [`@spy4x/realtime/protocol`](codec.ts): Wire protocol for a hint-only socket.
- [`@spy4x/realtime/web-socket`](web-socket-adapter.ts): Adapter from the platform `WebSocket` to this package's `ManagedSocket` port.
- [`@spy4x/realtime/testing`](testing.ts): Deterministic test doubles.

## Compatibility

Deploy the server and the page together. Since 1.92.0, a `server.error` frame can carry `reason`
and `fields`, and every refused payload carries `fields`. A page on 1.91.0 or older rejects such a
frame whole, so its call waits for the request timeout instead of seeing the refusal. When a new
server meets a page that was open before the deploy, make that page reload.
