# `@ts-libs/mcp`

Zero-dependency MCP (Model Context Protocol) core for Deno: a JSON-RPC 2.0 handler for
the tools lifecycle, a tool registry with JSON-Schema input validation, and two
transports — stdio and HTTP (including an SSE stream).

Extracted from `caldav-mcp` (`mcp.ts`, `main.ts`, `tools/*`). No SDK, no `npm:` runtime
dependency beyond `arktype` for validation.

```ts
import { McpHandler, startStdioTransport, stdinReader, stdoutWriter } from "@ts-libs/mcp"

const handler = new McpHandler({ serverInfo: { name: "my-server", version: "0.1.0" } })
handler.registerTool({
  name: "greet",
  description: "Greet someone",
  inputSchema: {
    type: "object",
    properties: { name: { type: "string" } },
    required: ["name"],
  },
}, (args) => ({ success: true, output: `hello ${args.name}` }))

await startStdioTransport({ handler, reader: stdinReader(), writer: stdoutWriter() })
```

## Protocol surface

| Method                      | Result                                                |
| --------------------------- | ----------------------------------------------------- |
| `initialize`                | `protocolVersion`, `capabilities.tools`, `serverInfo` |
| `notifications/initialized` | no-op acknowledgement                                 |
| `tools/list`                | `{ tools: ToolDefinition[] }`                         |
| `tools/call`                | `{ content, structuredContent, isError? }`            |
| anything else               | `-32601`                                              |

Error codes: `-32700` parse error, `-32600` invalid request, `-32601` method not found,
`-32602` invalid params (including unknown tools and failed input validation), `-32603`
internal error.

`handleMessage(raw: string)` never throws. A frame that is not JSON comes back as
`{"jsonrpc":"2.0","id":null,"error":{"code":-32700,"message":"Parse error"}}`; a frame
that is not a JSON-RPC request object comes back as `-32600`; a JSON array is `-32600`.

**Method allow-listing.** Dispatch is an explicit `switch`, not a lookup into a table of
handlers. There is no path from an unlisted method to a tool: an unknown method is
`-32601` and a name that is not in the registry is `-32602`. Neither can throw.

`tools/list` and `tools/call` before `initialize` are refused with `-32603`
(`requireInitialized: false` disables the check, for a transport that owns its own
handshake).

`tools/call` result semantics:

- the tool ran: `content[0].text` is `JSON.stringify({ success, output, error? })`.
  A handler that returns a `ToolOutcome` has it passed through; any other return value is
  wrapped as `{ success: true, output: <value> }`.
- the tool threw: same envelope with `success: false` **and** `isError: true`. A
  transport failure is therefore distinguishable from a valid empty result, which is the
  fix for the source's `catch { return { xml: "" } }` pattern. Only the thrown message is
  reported, never a stack trace.
- the tool is unknown or the arguments are invalid: `-32602`.

`initialize` always answers with this server's `protocolVersion`, whatever revision the
client asked for. See "Protocol version pin" below.

## Transports

### stdio

`startStdioTransport({ handler, reader, writer })` reads newline-delimited JSON-RPC
until the reader is exhausted, with a 64 KiB buffer and a streaming `TextDecoder`, so a
read boundary inside a message or inside a multi-byte character is reassembled. Messages
are handled in order: each response is awaited before more input is read. A final frame
without a trailing newline is flushed at EOF.

`reader` and `writer` are `{ read(buffer): number | null }` and `{ write(bytes): void }`.
Production wiring is `stdinReader()` / `stdoutWriter()`; tests pass in-memory
equivalents, so no test touches a real file descriptor. A reader failure **throws** —
that is a transport failure and must not look like "no data".

### HTTP

`createHttpTransport(options)` returns a `(request: Request) => Promise<Response>`:
`Deno.serve` calls it in production, tests call it with constructed `Request` objects.

| Route          | Auth   | Behaviour                                             |
| -------------- | ------ | ----------------------------------------------------- |
| `GET /health`  | none   | `{"status":"ok"}` — literally that body, nothing else |
| `POST /mcp`    | bearer | JSON-RPC; HTTP 200 even for a protocol error          |
| `GET /mcp`     | bearer | SSE stream                                            |
| `OPTIONS /mcp` | none   | preflight, allow-listed origins only                  |

`/health` is a zero-information liveness signal: no version, no server name, no uptime,
no tool list. It is also outside the rate limiter so a probe cannot spend a client's
quota.

Request bodies are capped (`maxBodyBytes`, default 1 MiB) by `Content-Length` and again
by measured byte length, so a chunked body cannot slip past. Over the cap is 413.

## Auth contract

The token is read from `Authorization: Bearer <token>` (a bare `<token>` is also
accepted) and **from nowhere else**.

- `?api_key=` and any other query parameter are ignored. Query strings land in proxy and
  access logs; the source accepted them and this port does not.
- `X-Api-Key` is **not** accepted. It was a third source on the same endpoint, and a
  caller that needs a second header can wrap `createHttpTransport`. Accepting fewer
  places is the point.
- No token is read from `$env` at module scope, and `bearerTokenFromEnv(name, env)`
  takes the environment as a **required** argument — there is no `Deno.env` default, so
  importing this module can never read a credential as a side effect. An entry point
  calls `bearerTokenFromEnv("MCP_BEARER_TOKEN", Deno.env)` (throws when unset) and
  `createTokenVerifier(token)` (throws on an empty secret) at startup.
- `bearerTokenFromHeaders` returns `undefined` for a missing or blank header; there is no
  "no token configured means open" path in the verifier.
- The comparison is constant time: both sides are SHA-256 digested and compared with
  `@std/crypto`'s `timingSafeEqual`, so the digest width is fixed at 32 bytes regardless
  of the presented length. Neither the length nor a shared prefix of a guessed token can
  be probed by timing. An equal-length wrong token is covered by tests.
- A 401 carries `WWW-Authenticate: Bearer` and the body `{"error":"Unauthorized"}`.

**Redaction.** `formatLogLine(level, message, secrets)` replaces every known secret with
`<REDACTED:TOKEN>` and returns a line. The transport logs only through it, and the
auth-failure path is asserted to (a) emit a line and (b) contain no token value — a test
that only checked (b) would pass trivially when nothing is logged at all. The request
body is never logged: it is the one place a client may put a credential.

## Rate-limit contract

`MemoryRateLimitStore` is a fixed-window limiter behind the `RateLimitStore` port
(`check(key)`, `evict()`, `size`). The clock is injected — every test advances a manual
clock, none sleeps.

- Over the limit: HTTP 429, `Retry-After: <seconds>` (whole seconds, never `0`), body
  `{"error":"Rate limit exceeded"}`.
- Key resolution is `clientIp(request)`: the leftmost `x-forwarded-for` entry, then
  `x-real-ip`, then the literal `"unknown"`. Requests with no address are bucketed
  together rather than keyed per-request, so omitting the header cannot bypass the limit.
  `x-forwarded-for` is only trustworthy behind a proxy that overwrites it.
- The map is bounded two independent ways: an entry is swept when its window ended more
  than `ttlMs` ago (default `windowMs`), and the map is trimmed to `maxEntries` (default
  10 000) by evicting the least recently used key. The source's map grew forever under a
  source-rotating client.
- Auth is checked **before** the rate limit: an unauthenticated flood cannot spend an
  authenticated client's quota.
- Tradeoff: LRU eviction forgets an evicted key's count, so a deliberately rotating
  client can exceed the limit by starting fresh counters. Bounded memory was the
  requirement; per-key isolation under rotation needs a shared store.

**Issue #4 coordination.** `@ts-libs/platform/rate-limit` did not exist on `origin/main`
(`git show origin/main:platform/rate-limit/memory.ts` → `fatal: path ... does not exist`)
when this package landed, so the limiter is ported here **behind the same port shape**
(`check`/`evict`/`size`, injected clock, injected key resolver). Once #4 merges, delete
`rate-limit.ts` and import `@ts-libs/platform/rate-limit`: nothing else in this package
depends on the class, only on the `RateLimitStore` interface.

## CORS

`allowedOrigins` is an exact-match allowlist, empty by default, which forbids every
cross-origin request. There is no `"*"` mode and no code path emits
`Access-Control-Allow-Origin: *` — the source put a wildcard on an endpoint that takes a
bearer credential, which lets any page the operator visits spend that credential. A
non-allow-listed `Origin` is refused with 403 before auth runs. The SSE stream emits no
CORS header at all: it is only reached after the origin check passed.

## SSE

Implemented, not stubbed. `GET /mcp` (bearer-authenticated) opens
`text/event-stream`, sends `event: endpoint` / `data: <endpointPath>`, then a
`: heartbeat <ms>` comment frame per heartbeat tick (default 15 s). The stream closes on
`request.signal` abort, when the heartbeat producer is stopped, or on a write failure —
it does not hang open. The heartbeat is a `HeartbeatProducer` port, so tests drive ticks
by hand instead of waiting on a timer.

## `inputSchema` validation

`inputSchema` stays the wire contract, because MCP clients read JSON Schema and arktype 2
does not emit it. At registration the supported subset of the schema is compiled **into an
arktype type** and arktype validates. There is no hand-rolled validator and no zod.

Supported node keywords: `type` (`object`/`string`/`number`/`integer`/`boolean`/`array`/
`null`), `enum`, `description`, `properties`, `required`, `additionalProperties`, `items`.
Any other keyword — `pattern`, `format`, `minimum`, `oneOf`, `anyOf`, `allOf`, `$ref`, … —
makes `compileInputSchema` **throw at registration**, so a constraint can never be
silently ignored. `validateAgainstSchema` catches that and reports `-32602` for a schema
that reached it anyway.

- `required` is enforced; an optional property may be omitted.
- `additionalProperties: false` rejects an undeclared argument by name (arktype treats
  undeclared keys as optional, so the check is explicit); `true` or absent accepts them,
  which is JSON Schema's default.
- `enum` members are emitted as parenthesised literals, so a member whose name collides
  with an arktype keyword (`"string"`) is matched as a value, not as a type.

A tool author who would rather write the arktype schema directly passes
`arkTypeValidator(type({ … }))` as the fourth argument of `invokeTool`, or wraps
`registry.register` in their own registrar. They must still supply `inputSchema` for
`tools/list`.

## Deliberately absent

- The official `npm:@modelcontextprotocol/sdk`. The value of this package is a
  zero-dependency core small enough to read in one sitting; `offer-lens`'s SDK-based
  server is the comparison, not the source.
- The MCP **resources** and **prompts** APIs, and `logging` / `completion`. Only `tools`
  is advertised in `capabilities`. Adding a method is adding a `switch` case.
- The **CalDAV tool bindings** (`tools/{todos,events,calendars}.ts` in
  `caldav-mcp`). `ToolRegistry` is the registration layer they attach to; they belong to
  `@ts-libs/caldav` (#13).
- Any HTTP framework. The transport is `Request` → `Response`; `hono` is available in the
  root import map but the route surface is four routes and a `URL` check.

## Protocol version pin

`MCP_PROTOCOL_VERSION` is `2024-11-05`. A client that sends another revision in
`initialize` still receives `2024-11-05` back, with no error and no downgrade: MCP makes
version agreement the client's decision, so the client compares the returned revision and
either proceeds or disconnects. This server implements exactly the `2024-11-05` tools
lifecycle — `initialize` → `notifications/initialized` → `tools/list` → `tools/call` — and
advertises nothing it does not implement. Bumping this constant is the one edit needed
when the revision moves, together with its test in `handler.test.ts`.

## Testing

Colocated `*.test.ts`, 127 assertion steps. Deterministic by construction: injected clock
(rate limiter), injected reader/writer (stdio), injected heartbeat producer (SSE), and
`Request` objects constructed in-process (HTTP). No sockets, no real stdio, no `sleep`,
no environment reads. The root test task runs with `--allow-read --allow-env` only, and
this package needs nothing more.

```bash
deno task test
```
