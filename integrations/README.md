# @ts-libs/integrations

Outbound integration clients and inbound webhook verification. Zero dependencies, no SDKs — every
client is a thin `fetch` wrapper with an injectable transport.

`webhooks.ts` is new: nothing in the extraction sweep had a webhook verifier. `ntfy.ts` and
`healthchecks.ts` moved in from `ops/notify/` when `ops/` was removed (`#67`); they were ported from
`rostok/scripts/backup/src/reporting.ts` and `mig/lib/notify.ts`. Slack and Mailchimp clients were
removed (`#68`): neither service is used, and the preference is open-source, self-hosted services.

## Entry points

| Export           | What it is                                                                |
| ---------------- | ------------------------------------------------------------------------- |
| `.` (`mod.ts`)   | Barrel.                                                                   |
| `./ntfy`         | `NtfyClient`, `ntfyConfigFromEnv`, `NotificationSeverity`, `NtfyPriority` |
| `./healthchecks` | `HealthchecksClient`, `healthchecksConfigFromEnv`, `HealthchecksOutcome`  |
| `./webhooks`     | `verifyWebhookRequest` — inbound HMAC-SHA256 verification                 |

## Contracts

### `HealthchecksClient` — dead-man's switch

```ts
const client = new HealthchecksClient({ pingUrl })
const result = await client.ping({ outcome: HealthchecksOutcome.Fail, body: "3 of 5 failed" })
```

`Success` pings the base URL, `Fail` pings `<url>/fail`, `Start` pings `<url>/start`. `urlFor`
exposes the mapping.

**Config.** `HEALTHCHECKS_PING_URL` through `healthchecksConfigFromEnv(read?)`; `null` when unset.
The constructor throws on an empty URL. Nothing is read at module scope.

**Result.** `{ ok: true, httpStatus, attempts, body, waitedMs }` or
`{ ok: false, code, message, status?, attempts, waitedMs }`, `code` being `"http_error"`,
`"network_error"` or `"timeout"`. The source resolved `void` and logged its failures, so a caller
could not tell a delivered ping from a dead endpoint.

**Retry policy.** 10 attempts, 60s doubling, capped at 5 minutes per wait, plus +/-20% jitter so
that many hosts pinging the same check after a shared outage do not retry in lockstep. Measured
schedule, not estimated: without jitter the waits run
`1 + 2 + 4 + 5 + 5 + 5 + 5 + 5 + 5 = 37.0 minutes` (2,220,000 ms across 9 retries), which fits
inside healthchecks.io's 1-hour grace window; with +/-20% jitter the same 9 waits range
`29.6-38.4 minutes` (1,776,000-2,304,000 ms), still comfortably inside the window and the 40-minute
total budget. Both the un-jittered figure and the jittered range are asserted by the suite,
including a test that constructs the client with no options at all — the settings that ship — and
confirms two instances get different delays. A 10-minute per-wait cap gives
`1 + 2 + 4 + 8 + 10 + 10 + 10 + 10 + 10 = 65.0 minutes` and overruns the very window the cap exists
to respect. `Retry-After` is honoured: the provider rate-limits with `429` and the source ignored
the header, hammering the endpoint on the failures it was retrying. A total budget bounds the whole
operation, set above the sum of the waits.

**No backup coupling.** Nothing here imports or references `BackupResult` or any backup type. A
notifier that only works while a backup runs is a notifier nobody can reuse.

### `NtfyClient` — failure-only push

```ts
const client = new NtfyClient({ baseUrl, topic, token })
const result = await client.notifyFailure("backup failed", "3 of 5 repositories failed")
```

**Failure-only by default.** `NotificationSeverity.Failure` is the gate; an `Info` push is a no-op
that still returns `{ ok: true, status: "skipped", reason: "below-gate", attempts: 0 }`, so the gate
is assertable. Callers that genuinely want success pushes pass `severity: Info`.

**Result.** `{ ok: true, status: "pushed", httpStatus, attempts, title, tags }`,
`{ ok: true, status: "skipped", … }`, or `{ ok: false, code, message, status?, attempts }`, `code`
being `"http_error"`, `"network_error"` or `"timeout"`. The source returned `void` and logged
failures, so a dropped push looked like a delivered one.

**Config.** `NTFY_URL` and `NTFY_TOPIC` are required; `NTFY_TOKEN` is optional because a
self-hosted ntfy on a private network may not use auth. Read through `ntfyConfigFromEnv(read?)`,
which returns `null` when incomplete.

**Retry policy.** 5 attempts, 3s doubling plus +/-20% jitter (2.4-3.6s, 4.8-7.2s, 9.6-14.4s,
12-15s), honouring `Retry-After`, bounded by attempts and total elapsed time. The jitter exists so
many callers hitting the same endpoint at once do not retry at the same instant; a test constructs
the client with no options at all and confirms two instances get different delays.

**The base URL never appears in a result.** It can carry a token in its path, and `fetch` puts the
whole URL in its error text. Every transport failure is reported through `describeTransportError`,
which returns the error's class name and `transport failure (url withheld)` — never the URL. The
same helper covers `HealthchecksClient` (the ping URL carries the check's capability key).

### Header safety — the trap `ntfy.ts` carries a fix for

`Headers.set` rejects code points the platform will not accept in a header value, and the rejection
surfaces from inside `fetch` as an opaque `TypeError: Value is not a valid ByteString`. Two
different needs follow, and `mig`'s source conflated them:

- A **header value** must be transliterated to printable ASCII. `toAsciiHeaderValue` maps the
  characters that matter for readability (`—` → `-`, `"` → `"`, `…` → `...`, non-breaking space →
  space) and replaces everything else — Latin-1 accents, Cyrillic, CJK, emoji — with `?`. Allowed
  header whitespace (HT, LF, CR, space) is preserved.
- A **message body** must be left alone. `mig` passed the body through the same sanitiser, so
  `Café ☕` reached ntfy as `Caf? ?` and every accented, Cyrillic, CJK and emoji payload was
  destroyed. Only headers are transliterated here.

`createAsciiHeaders` applies the transliteration to every value, so the failure cannot come back
through a new call site. Both halves are pinned by tests, including the body round-trip.

### `verifyWebhookRequest`

```ts
const raw = new Uint8Array(await request.arrayBuffer())
const result = await verifyWebhookRequest(raw, request.headers, { secret })
if (!result.ok) return new Response(null, { status: 401 })
const payload = JSON.parse(new TextDecoder().decode(result.body))
```

- HMAC-SHA256 over `<timestamp seconds>.<raw body>`, compared with `crypto.subtle.verify` —
  constant-time in the platform's HMAC. No `===` touches the digest.
- A timestamp participates in the signature and is checked against an injected clock, so a captured
  delivery cannot be replayed after the window. A missing or unparseable timestamp is a rejection,
  not "no replay protection needed".
- Fail-closed on **every** unusable secret, not just the empty string. `""`, `" "`, `null`,
  `undefined`, a number and a missing config object all return the typed
  `{ ok: false, reason: "invalid_secret" }`. Nothing throws: a zero-length HMAC key raises
  `DataError: Key length is zero`, which is a crash on an untrusted request rather than a 401, and
  the values that did _not_ throw produced a usable key, so a body signed with the same falsy value
  verified. Pinned by `rejects a forgery signed with the HMAC key \`null\``and`does not throw \`DataError: Key length is zero\` for an empty or absent secret`.
- The body must be the raw bytes off the wire. Parsing and re-serialising JSON changes the hash.

Headers default to `X-Signature-256` and `X-Signature-Timestamp`, both overridable, and the
`algorithm` prefix is configurable (`sha256=<hex>` is accepted as well as a bare hex digest).

**This is not a drop-in verifier for GitHub, Slack or Stripe.** None of them signs
`<timestamp>.<raw body>` with the timestamp in a header:

| provider | its actual scheme                                                                | this module                                  |
| -------- | -------------------------------------------------------------------------------- | -------------------------------------------- |
| GitHub   | `X-Hub-Signature-256: sha256=<hmac-of-body>`, no timestamp, no replay protection | needs an adapter: sign the body alone        |
| Slack    | `X-Slack-Signature: v0=<hmac-of-"v0:<ts>:<body>">`                               | needs an adapter: the signed string differs  |
| Stripe   | `Stripe-Signature: t=<ts>,v1=<hmac-of-"<ts>.<body>">`                            | equivalent scheme, different header encoding |
| generic  | `<ts>.<raw body>`                                                                | supported directly                           |

What is worth reusing regardless of provider is the part that is easy to get wrong: signing the raw
bytes, comparing with `crypto.subtle.verify`, failing closed on an unusable secret, and refusing a
stale or future-dated timestamp. A provider with a different signed-string construction needs a thin
adapter that builds that string; the verification here is the reusable half.

## Injectable transport

Read the sections below before writing a _unit_ test that touches the network. It cannot: the unit
suite runs under `--allow-read --allow-env` with no `--allow-net`. The integration tier is the one
exception — see below.

- **`fetcher?: typeof fetch`** — defaults to `globalThis.fetch`. No unit test in this package performs
  a real request.
- **`sleep?: (ms: number) => Promise<void>` and `clock?: () => number`** — the retry loop measures its
  budget through the injected clock and waits through the injected sleeper. Unit tests supply a
  recording timer plus a manual clock, so nothing sleeps and nothing asserts on wall-clock time.
- **`backoff?: BackoffFn` and `random?: RandomSource`** — the delay computation, and the source its
  jitter draws from (`Math.random` unless a caller injects another, so two processes with jitter
  enabled do not compute the same "random" delay). `onDelay` observes every requested delay, which is
  how a test asserts _"asked for exactly 2 seconds"_ without waiting for them.
- **`requestTimeoutMs?: number`** — bounds one request via `AbortSignal.timeout()`. Defaults to
  `DEFAULT_REQUEST_TIMEOUT_MS` (10s, `retry.ts`) and is clamped to whatever `totalBudgetMs` has left
  for the attempt about to run, so a generous per-request timeout can never itself outrun the budget
  it is nested inside. A timed-out request reports `code: "timeout"`, distinct from the generic
  `"network_error"` a transport throw gets.
- **Console silence is asserted, not assumed.** `integrations/console.test.ts` installs a
  process-wide capture _before_ importing the modules and drives every path of both clients —
  delivered, below-gate skip, 4xx, 5xx retried to success, transport throw — asserting nothing is
  logged. A per-suite capture only covers that suite's branches, which is how a restored 4xx
  `console.error` survived a green run in the clients this replaced.
- **Secrets are constructor parameters.** No module reads `$env` at import time and no secret is
  logged. The `*ConfigFromEnv(read?)` helpers take a reader, so a test injects a fake environment.

### Integration tier

`ntfy.integration.test.ts` and `healthchecks.integration.test.ts` (`deno task test:integration`) run
the real client against a real HTTP server the test itself starts on `127.0.0.1` with
`Deno.serve({ port: 0 })` — no container, nothing reachable outside loopback. They exist because a
fake `fetch` that always resolves synchronously cannot prove a timeout actually bounds a hanging
request: these tests start a server that never answers and assert the call still returns, with
`code: "timeout"`, inside the configured budget, and a server that fails twice before succeeding to
prove a retry actually recovers over a real socket.

## Retry policy

The retry mechanism is `retry.ts`, shared by `ntfy.ts`, `healthchecks.ts` and `webhooks.ts`'s
callers. It used to exist twice — a byte-identical copy lived in `ops/notify/retry.ts`, guarded by
a test that compared the two files — because the two packages were owned by different issues and
had to stay file-disjoint. That constraint went away with `ops/` (`#67`): the ops copy and its drift
test are deleted, and this is now the only copy in the repo.

Transient statuses are `429` and `5xx`; every other `4xx` is permanent. `Retry-After` in the
delay-seconds form wins over the computed backoff, then the same per-wait ceiling applies, so a
provider asking for a day cannot pin a process for a day. The HTTP-date form is ignored: it needs a
wall clock, and a skewed client clock would turn a hint into a multi-hour stall. Attempts and total
elapsed time are both capped.

**Every request is bounded, and the budget is real.** `totalBudgetMs` used to bound only when the
_next retry_ could be scheduled; a request itself had no timeout and could hang forever. Every
attempt now runs under `AbortSignal.timeout()`, clamped to whatever `totalBudgetMs` has left, so the
budget bounds the whole operation, not just the gaps between attempts. `NtfyClient`'s and
`HealthchecksClient`'s shipped policies both use `jitterRatio: 0.2`, and jitter draws from a real
random source (`Math.random` by default) instead of a formula of `attempt` and `retryAfterMs`: two
processes retrying the same call, with no options overridden, no longer compute the identical
delay — the "settings that ship" tests in `ntfy.test.ts` and `healthchecks.test.ts` construct a
client with no `retry` or `random` override at all and assert exactly that.

## Out of scope

- **Block Kit payloads, event-bus wiring and any other domain-bound glue.** This package ships
  clients, not the wiring around them.
- **A webhook router.** `verifyWebhookRequest` verifies. Routing, idempotency and retry queues are
  the caller's job.
- **Backup, deploy, env tooling.** `ops/` was removed from ts-libs (`#67`); a project built from the
  template gets the equivalent scripts from its own `infra/scripts/`.
- **Email and SMTP**, `server/email`.
