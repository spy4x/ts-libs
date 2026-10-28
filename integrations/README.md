# @spy4x/integrations

Outbound integration clients and inbound webhook verification. Zero dependencies, no SDKs — every
client is a thin `fetch` wrapper with an injectable transport.

`webhooks.ts` is new: nothing in the extraction sweep had a webhook verifier. `ntfy.ts` and
`healthchecks.ts` moved in from `ops/notify/` when `ops/` was removed (`#67`); they were ported from
`rostok/scripts/backup/src/reporting.ts` and `mig/lib/notify.ts`. Slack and Mailchimp clients were
removed (`#68`): neither service is used, and the preference is open-source, self-hosted services.

## Install

```bash
deno add jsr:@spy4x/integrations
```

Runs on: server (Deno).

## Entry points

| Export              | What it is                                                                     |
| ------------------- | ------------------------------------------------------------------------------ |
| `.` (`mod.ts`)      | Barrel.                                                                        |
| `./ntfy`            | `NtfyClient`, `ntfyConfigFromEnv`, `NotificationSeverity`, `NtfyPriority`      |
| `./healthchecks`    | `HealthchecksClient`, `healthchecksConfigFromEnv`, `HealthchecksOutcome`       |
| `./cloudflare`      | `purgeUrls` — Cloudflare cache purge by URL                                    |
| `./indexnow`        | `submitIndexNow` — tell search engines which pages changed                     |
| `./umami`           | `createUmamiLink`, `checkUmami`, `umamiLinkUrl` — self-hosted Umami links      |
| `./webhooks`        | `verifyWebhookRequest` — inbound HMAC-SHA256 verification, Stripe's layout too |
| `./push`            | `createWebPushSender`, `generateVapidKeyPair` — Web Push to a user's devices   |
| `./push-file-store` | `createFilePushSubscriptionStore` — push subscriptions in one JSON file        |
| `./push-reminders`  | `createReminderNotify`, `reminderPushMessage`, `reminderDeliveryOutcome`       |
| `./telegram`        | `TelegramClient`, `TelegramBot`, `createTelegramWebhookHandler`, polling       |

## Contracts

### `createWebPushSender` — Web Push

```ts
const { publicKey, keys } = await generateVapidKeyPair() // once; store `keys`, serve `publicKey`
const sender = await createWebPushSender({
  vapidKeys: keys,
  subject: "mailto:ops@example.com",
  store,
})
const result = await sender.send(user.id, { title: "Backup done", body: null, url: null })
```

`store` is the app's port: `listByUser(userId)` and `deleteByEndpoint(userId, endpoint)`, over
`platform/model`'s `PushSubscriptionJson`. `send` never throws and returns one delivery per
subscription. A 404 or 410 from the push service deletes that subscription; every other failure
keeps it, and so does a subscription with malformed keys, which is reported as such.

`sendTo(subscription, message, options?)` pushes to one given subscription (a welcome push to the
device that just subscribed, a test push from a settings page) and returns the same result with one
delivery. It never reads or writes the store. A 404 or 410 gives status `gone` with
`deleted: false`: there is no user to delete it for, so the caller removes the subscription.

Keys, encryption (RFC 8291) and VAPID signing come from `@negrel/webpush` and `@negrel/http-ece`;
the request is sent here, through the injectable `fetch` option, with `redirect: "manual"` and one
abort signal that also bounds the DNS check. The library's own `pushMessage` is not used: it follows
redirects and takes no signal. A 3xx answer is a failure and is never followed, so a push service
cannot send the payload to a private address. `safeFetch` was not used because it cannot carry a
request body. Endpoints must be public HTTPS addresses; the DNS check and the connection resolve
separately, so a DNS-rebinding race remains.

An app with no database keeps its subscriptions with `createFilePushSubscriptionStore({ fs, path })`
from `./push-file-store`: one JSON file, written atomically and readable by its owner only, at most
20 subscriptions per user, and a corrupt file is reported, never replaced. Its `state(name)` keeps a
small named value in the same file, such as the state of `@spy4x/platform/server/reminder-runner`.
A message may carry a `tag`: a notification with the same tag replaces the one on screen.

`./push-reminders` joins the sender to `@spy4x/platform/server/reminder-runner`:
`createReminderNotify({ sender, userId, url })` is the runner's `notify`. It cuts a long task title
to the 120 characters a message may have and tags the push with a hash of the reminder's key, so the
message is always one the sender accepts; a `url` too long to be pushed beside the longest title is
refused when the function is built. A reminder counts as delivered when at least one device got it,
when no device is subscribed, or when every device was gone and removed. It is tried again when no
device got it and a failure may pass (no answer, HTTP 408, 429 or 5xx, an unreadable store). When no
device got it and every push service refused for good (HTTP 400, 401, 403, 413, as after a change of
VAPID keys), the answer is `"drop"`: the runner reports the reminder once through its `onError` and
leaves it. `onDeviceFailure` is told how many devices of a reminder that is not tried again failed,
and with which HTTP status, never an endpoint or a push service's answer.

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
`"network_error"`, `"timeout"`, `"check_not_found"`, `"rate_limited"` or `"redirected"`. The source
resolved `void` and logged its failures, so a caller could not tell a delivered ping from a dead
endpoint.

**A 200 is not always a delivered ping.** healthchecks.io answers `200 OK (not found)` for a check
UUID it does not know and `200 OK (rate limited)` for a ping it ignored
([pinging API](https://healthchecks.io/docs/http_api/)). The client reads the first 64 bytes of a
2xx body, never more, and reports these as `check_not_found` (not retried: the URL is wrong) and
`rate_limited` (retried under the policy). Any other 2xx, including `OK` and `201 Created`, is a
success.

**The ping URL must be the final address.** Redirects are not followed: a 301, 302 or 303 would turn
the POST into a GET and drop the body. Any 3xx answer is `redirected` and is not retried.

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
being `"http_error"`, `"network_error"`, `"timeout"` or `"redirected"`. The source returned `void`
and logged failures, so a dropped push looked like a delivered one.

**The base URL must be the final address.** Redirects are not followed. Following a 301, 302 or 303
re-sends the push as a bodiless GET, which ntfy answers with its web app and a 200, so a lost push
would read as delivered; following it with the method kept would send the token to wherever
`Location` points. Any 3xx answer is `redirected`, is not retried, and its message names neither
the `Location` nor the base URL.

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
  space) and replaces everything else — Latin-1 accents, Cyrillic, CJK, emoji — with `?`. Each run
  of HT, LF and CR becomes one space, because `Headers.set` throws on a line break inside a value.
- A **message body** must be left alone. `mig` passed the body through the same sanitiser, so
  `Café ☕` reached ntfy as `Caf? ?` and every accented, Cyrillic, CJK and emoji payload was
  destroyed. Only headers are transliterated here.

`createAsciiHeaders` applies the transliteration to every value, so the failure cannot come back
through a new call site. Both halves are pinned by tests, including the body round-trip.

### Telegram bots — `./telegram`

```ts
const client = new TelegramClient({ token })
const bot = new TelegramBot({ client, conversations: { store } }) // store: get, set with TTL, del
  .command(`start`, (ctx) => ctx.reply(`Hi`, { reply_markup: menu }))
  .callback(`menu`, (ctx) => ctx.reply(`You chose ${ctx.args}`)) // data `menu:<args>`
  .command(`rename`, async (ctx) => {
    await ctx.conversation.start(`rename`)
    await ctx.reply(`New name?`)
  })
  .conversation(`rename`, {
    name: (ctx) => ({ step: `confirm`, data: { name: ctx.text } }),
    confirm: (ctx, data) => ({ done: true }),
  })

// Production: a webhook. Development: long polling until the signal aborts.
const webhook = createTelegramWebhookHandler({
  secretToken,
  onUpdate: (u) => bot.handleUpdate(u),
  onError,
})
await pollTelegramUpdates({ client, signal, onUpdate: (u) => bot.handleUpdate(u), onError })
```

- **Client.** Typed `getMe`, `sendMessage`, `editMessageText`, `deleteMessage`,
  `answerCallbackQuery`, `setWebhook`, `deleteWebhook` and `setMyCommands`, with parameters named
  as in the Bot API; `call(method, params)` reaches any other method. A result is
  `{ ok: true, result, attempts }` or `{ ok: false, code, message, status?, attempts }`, where
  `message` is Telegram's `description`. Redirects are refused, answers are read under a 5 MiB
  cap, and the token never appears in a result.
- **Retries.** 3 attempts, 1s doubling up to 30s, 60s in all; a 429's `retry_after` is honoured up to 30s.
  Telegram has no idempotency key, so a retry after a timeout can send a message twice: pass
  `retry: { maxAttempts: 1 }` where that is worse than losing it.
- **Webhook.** 405 for anything but `POST`; 401 when `X-Telegram-Bot-Api-Secret-Token` is missing
  or wrong, compared in constant time before the body is read; 413 over 1 MiB; 400 for a body
  arktype does not accept as an update. A handler that throws goes to `onError` and the answer is
  still 200, because any other status makes Telegram send the update again.
- **Routing.** A registered command wins (`/cancel` can always end a conversation), then a
  callback route by `prefix` or `prefix:`, then a running conversation, then the `text` handler.
  With `username` set, `/start@other_bot` reaches no handler, not even a conversation or the
  `text` handler. A button press the handler did not answer is answered after it, also when the
  handler threw, so its spinner stops; a press the bot cannot route to a chat (inline mode) gets
  an empty answer.
- **Conversations.** State is `{ name, step, data }` as JSON in the store passed in, one per person
  per chat, expiring after `ttlSec` (900 by default), so a restart or a second instance continues
  where the person left off. A step returns the next step, `{ done: true }`, or nothing to stay. A
  saved step that no longer exists is dropped.
- **Polling.** For development only. A failed call waits 1s, doubling up to 60s; an update whose
  handler threw still counts as read. Telegram refuses polling while a webhook is set, so call
  `deleteWebhook` first.
- **Not here.** Linking a Telegram account to a user, and any product's commands: those belong to
  the app.

### `purgeUrls` — Cloudflare cache purge

`purgeUrls({ token, zoneName | zoneId, urls, fetch?, requestTimeoutMs? })` purges absolute URLs from
a Cloudflare zone and returns `{ success, output, error }`. It never throws.

- **Zone.** Give exactly one of `zoneName` (looked up with `GET /zones?name=`; no match fails and
  names the zone; more than one match fails as ambiguous, so pass `zoneId` then) or `zoneId` (no
  lookup call). The token needs Zone Read only for the lookup, and Cache Purge.
- **Batches.** 30 URLs per `purge_cache` call, the API's limit. It stops at the first failed call
  and reports how many URLs were purged before it.
- **Timeout.** Each request runs under `AbortSignal.timeout(requestTimeoutMs)`, 10 s by default.
- **Failures.** An HTTP error, a `200` with `success: false`, a timeout and a transport error all
  fail. API failures carry Cloudflare's error codes and messages (at most 5, each cut to 200
  characters, control characters removed, the token replaced by `<REDACTED:TOKEN>`); transport
  failures carry only the error class. Answers are read under a 64 KiB cap. The token and headers
  never appear in `error` or `output`.
- **Empty list.** An empty `urls` succeeds with `output: "nothing to purge"` and sends no request.
- **Fail open.** The caller decides what a failure means; a deploy script would normally log
  `error` and carry on.

### `submitIndexNow` — IndexNow

`submitIndexNow({ host, key, keyLocation?, urls, fetch?, requestTimeoutMs? })` posts up to 10,000
changed addresses to `https://api.indexnow.org/indexnow`, which shares them with every engine that
takes part, and returns `{ success, output, error }`. It never throws.

- **Checks first.** The key must be 8 to 128 letters, digits and dashes; every URL and the
  `keyLocation` must be `http`/`https` on `host`; more than 10,000 URLs is refused, not split. A
  refused call sends no request.
- **Answers.** `200`, and `202` (key not yet checked), succeed. Any other status fails with the
  status and IndexNow's meaning for it (`403`: the key file is missing or does not hold the key).
  The body is never read.
- **Timeout.** The request runs under `AbortSignal.timeout(requestTimeoutMs)`, 10 s by default.
- **Fail open.** Callers log `error` and carry on: a missed ping only delays crawling.

### `createUmamiLink`, `checkUmami`, `umamiLinkUrl` — Umami links

A self-hosted Umami (v3) counts every visit to a link's `<umami>/q/<slug>` and redirects it to the
link's `url`. A product makes one link per place it shares an address in, so Umami tells the
places apart. Each function returns `{ success, output, error }` and never throws.

- **`createUmamiLink({ baseUrl, token, id?, name, url, slug, teamId?, fetch?, requestTimeoutMs? })`**
  posts to `/api/links` with the token as `Authorization: Bearer` and returns the stored link
  (`id`, `name`, `url`, `slug`) as `output`. `baseUrl` is the instance, with its base path if any.
  Umami's limits are checked first: a name of 1 to 100 characters, an `http`/`https` url of at most
  500, and a slug of 8 to 100 letters, digits, `-` and `_`.
- **Idempotent with an `id`.** Pass a UUID as `id`, kept with the product's own row. A retry after
  a lost answer, or two creates at once, then make one link: when Umami refuses the create, the
  link is read back by its id, and one with the same slug and url counts as created.
- **`checkUmami({ baseUrl, fetch?, requestTimeoutMs? })`** asks `/api/heartbeat`, with no token,
  whether the instance answers, so a redirect can skip Umami while it is down.
- **`umamiLinkUrl(baseUrl, slug)`** is the link's public address, `<baseUrl>/q/<slug>`.
- **Secrets.** The token never appears in `error` or `output`: Umami's message is cleaned
  (control characters removed, the token replaced by `<REDACTED:TOKEN>`, cut to 200 characters),
  and a transport failure names only the error class. Answers are read under a 64 KiB cap.
- **Timeout.** Each request runs under `AbortSignal.timeout(requestTimeoutMs)`, 10 s by default.

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
  verified. Pinned by `` rejects a forgery signed with the HMAC key `null` `` and
  ``does not throw `DataError: Key length is zero` for an empty or absent secret``.
- The body must be the raw bytes off the wire. Parsing and re-serialising JSON changes the hash.

Headers default to `X-Signature-256` and `X-Signature-Timestamp`, both overridable, and the
`algorithm` prefix is configurable (`sha256=<hex>` is accepted as well as a bare hex digest).

`combinedHeader` reads the timestamp and the signatures from one header instead, as Stripe sends
them:

```ts
const result = await verifyWebhookRequest(raw, request.headers, {
  secret,
  combinedHeader: {
    name: "Stripe-Signature",
    pairSeparator: ",",
    timestampKey: "t",
    signatureKey: "v1",
  },
})
```

Every `v1` pair is a candidate and one match passes, because a sender rolling its secret signs with
both. Other keys (Stripe's test-only `v0`) are ignored, so they can never stand in for `v1`. A part
without `=`, a second timestamp, a signature that is not 64 hex characters, more than eight
signatures or a header over 1024 characters rejects the delivery. All candidates are verified with
no early exit.

`signedSeparator` (default `"."`) is what joins the timestamp and the body in the signed string.
Paddle sends `Paddle-Signature: ts=<ts>;h1=<hex>` and signs `<ts>:<body>`, so it is read with
`{ name: "Paddle-Signature", pairSeparator: ";", timestampKey: "ts", signatureKey: "h1",
signedSeparator: ":" }`.

`toleranceSeconds` must be a finite number above 0. `NaN` or `Infinity` would accept a replay from
any time, so such a value, 0 or a negative one makes `verifyWebhookRequest` throw a `RangeError`.

**This is not a drop-in verifier for GitHub or Slack.** Neither signs `<timestamp>.<raw body>`:

| provider | its actual scheme                                                                | this module                                 |
| -------- | -------------------------------------------------------------------------------- | ------------------------------------------- |
| GitHub   | `X-Hub-Signature-256: sha256=<hmac-of-body>`, no timestamp, no replay protection | needs an adapter: sign the body alone       |
| Slack    | `X-Slack-Signature: v0=<hmac-of-"v0:<ts>:<body>">`                               | needs an adapter: the signed string differs |
| Stripe   | `Stripe-Signature: t=<ts>,v1=<hmac-of-"<ts>.<body>">`                            | supported with `combinedHeader`             |
| Paddle   | `Paddle-Signature: ts=<ts>;h1=<hmac-of-"<ts>:<body>">`                           | supported with `combinedHeader`             |
| generic  | `<ts>.<raw body>`                                                                | supported directly                          |

What is worth reusing regardless of provider is the part that is easy to get wrong: signing the raw
bytes, comparing with `crypto.subtle.verify`, failing closed on an unusable secret, and refusing a
stale or future-dated timestamp. A provider with a different signed-string construction needs a thin
adapter that builds that string; the verification here is the reusable half.

## Injectable transport

Read the sections below before writing a _unit_ test that touches the network. It cannot: the unit
suite runs under `--allow-read --allow-env` with no `--allow-net`. The integration tier is the one
exception — see below.

- **`fetcher?: typeof fetch`** — defaults to `globalThis.fetch`. No unit test in this package
  performs a real request.
- **`sleep?: (ms: number) => Promise<void>` and `clock?: () => number`** — the retry loop measures
  its budget through the injected clock and waits through the injected sleeper. Unit tests supply a
  recording timer plus a manual clock, so nothing sleeps and nothing asserts on wall-clock time.
- **`backoff?: BackoffFn` and `random?: RandomSource`** — the delay computation, and the source its
  jitter draws from (`Math.random` unless a caller injects another, so two processes with jitter
  enabled do not compute the same "random" delay). `onDelay` observes every requested delay, which
  is how a test asserts _"asked for exactly 2 seconds"_ without waiting for them.
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
