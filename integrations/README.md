# @ts-libs/integrations

Outbound integration clients and inbound webhook verification. Zero dependencies, no SDKs — every
client is a thin `fetch` wrapper with an injectable transport.

Ported from `roley` (`slack.service.ts`, `mailchimp.service.ts`) and extended at extraction time.
The webhook verifier is new: nothing in the extraction sweep had one.

## Entry points

| Export         | What it is                                                  |
| -------------- | ----------------------------------------------------------- |
| `.` (`mod.ts`) | Barrel.                                                     |
| `./slack`      | `SlackClient`, `slackConfigFromEnv`                         |
| `./mailchimp`  | `MailchimpClient`, `emailHash`, `md5Hex`, `basicAuthHeader` |
| `./webhooks`   | `verifyWebhookRequest` — inbound HMAC-SHA256 verification   |

## Contracts

### `SlackClient`

```ts
const slack = new SlackClient({ webhookUrl })
const result = await slack.send({ blocks: [...] })
```

`send` returns a discriminated result, never a bare boolean:

- `{ ok: true, httpStatus, attempts }` — Slack answered `2xx`.
- `{ ok: false, code, message, status?, responseBody?, attempts }` — `code` is one of
  `invalid_payload`, `http_error`, `network_error`. There is no `not_configured` code: an
  unconfigured client is rejected at construction, so the "not configured" case cannot be forgotten
  in a branch.

`responseBody` carries Slack's own reason (`invalid_payload`, `no_service`) truncated to 500
characters.

**The webhook URL never appears in a result.** Its last path segment _is_ the credential, and
`fetch` puts the whole URL in its error text (`Invalid URL: 'https://…/services/T/B/token'`). Every
transport failure is therefore reported through `describeTransportError`, which returns the error's
class name and `transport failure (url withheld)` — never the URL. The same helper covers
`MailchimpClient` (a caller-supplied API host) and `ops/notify/healthchecks` (the ping URL carries the
check's capability key). Pinned by
`SlackClient.send ... never returns the webhook URL, so the token in it cannot leak`.

**Config.** `SLACK_WEBHOOK_URL`. Read through `slackConfigFromEnv(read?)`, which returns `null` when
unset — the caller decides whether that is fatal. Nothing reads `$env` at module scope and the
constructor throws on an empty URL, because a client that fails silently at first send is how a
revoked webhook goes unnoticed for a week.

**Failure semantics.** 429 and 5xx retry, honouring `Retry-After`. Every other non-2xx fails
immediately: a malformed Block Kit payload cannot become valid by being sent again. Transport throws
retry. `send` never throws and never writes to the console.

### `MailchimpClient`

```ts
const client = new MailchimpClient({ apiKey, username, listId, serverPrefix })
const result = await client.putContact({ email, emailBefore, firstName, lastName })
```

`putContact` resolves membership first (`GET /lists/{list}/members/{hash}`, checking `emailBefore`
when given) and then `PATCH`es an existing member or `POST`s a new one. A `Member Exists` 400 on that
`POST` — two concurrent signups for one address — is reconciled with a single `PATCH`, so neither
caller fails.

Result variants:

- `{ ok: true, status: "upserted", method, httpStatus, change, attempts }`
- `{ ok: true, status: "skipped-disabled", reason, attempts: 0 }`
- `{ ok: false, code, message, status?, attempts }`

`searchContact` returns `{ ok: true, exists: true, status }`, `{ ok: true, exists: false }` for the
documented 404, or a typed failure. A 404 is a miss, not an error.

**Config.** `MAILCHIMP_API_KEY`, `MAILCHIMP_API_USERNAME`, `MAILCHIMP_LIST_ID`,
`MAILCHIMP_SERVER_PREFIX` through `mailchimpConfigFromEnv(read?)`, which returns `null` when any is
missing. The constructor throws on blank credentials rather than degrading to a disabled no-op.

**Failure semantics.** 429 and 5xx retry with `Retry-After` support; other 4xx fail immediately.
Nothing is written to the console on success or failure — the upstream logged `console.error` on the
success path, which made a working deployment indistinguishable from a broken one.

**Environment contract.** `MAILCHIMP_API_USERNAME` is the account name Mailchimp pairs with the key.
The API ignores it, so any non-empty string works (`"anystring"` is the convention); the upstream
called it `MAILCHIMP_API_SALT`, which suggested a secret it never was.

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

Headers default to `X-Signature-256` and `X-Signature-Timestamp`, both overridable, so a
GitHub-shaped sender (`X-Hub-Signature-256: sha256=<hex>`) works unchanged.

## Injectable transport

Read the three sections below before writing a test that touches the network. It cannot.

- **`fetcher?: typeof fetch`** — defaults to `globalThis.fetch`. No test in this package performs a
  real request, and the suite runs under `--allow-read --allow-env` with no `--allow-net`.
- **`sleep?: (ms: number) => Promise<void>` and `clock?: () => number`** — the retry loop measures its
  budget through the injected clock and waits through the injected sleeper. Tests supply a recording
  timer plus a manual clock, so nothing sleeps and nothing asserts on wall-clock time.
- **`backoff?: BackoffFn`** — the delay computation. `onDelay` observes every requested delay, which
  is how a test asserts _"asked for exactly 2 seconds"_ without waiting for them.
- **Console silence is asserted, not assumed.** `integrations/console.test.ts` installs a
  process-wide capture _before_ importing the modules and drives every path of both clients —
  upsert, API rejection, disabled skip, empty address, lookup hit, 404 miss, 5xx, transport throw,
  invalid payload — asserting nothing is logged. A per-suite capture only covers that suite's
  branches, which is how a restored 4xx `console.error` survived a green run.
- **Secrets are constructor parameters.** No module reads `$env` at import time and no secret is
  logged. The `*ConfigFromEnv(read?)` helpers take a reader, so a test injects a fake environment.

## Retry policy

The retry mechanism is `retry.ts`, **copied byte-for-byte** into `ops/notify/retry.ts` because the
two packages are owned by different issues and must stay file-disjoint.
`ops/notify/retry-drift.test.ts` reads both files and fails if the bytes differ, so the duplication
cannot silently diverge.

Transient statuses are `429` and `5xx`; every other `4xx` is permanent. `Retry-After` in the
delay-seconds form wins over the computed backoff, then the same per-wait ceiling applies, so a
provider asking for a day cannot pin a process for a day. The HTTP-date form is ignored: it needs a
wall clock, and a skewed client clock would turn a hint into a multi-hour stall. Attempts and total
elapsed time are both capped.

## Out of scope

- **Block Kit payloads and handler registration.** The payloads are domain-bound. So is
  `initX()` → `eventBus.register(DomainEvent, Handler)`; that is 1:1 with the application's CQRS
  event handlers and stays in the application. This package ships the client, not the wiring.
- **A webhook router.** `verifyWebhookRequest` verifies. Routing, idempotency and retry queues are
  the caller's job.
- **Backup, deploy and any `ops/` concern.** Those live in `@ts-libs/ops`.
- **Email and SMTP**, `server/email`.
