# ts-libs

[![status](https://ci.antonshubin.com/api/badges/10/status.svg)](https://ci.antonshubin.com/repos/spy4x/ts-libs)

Modern TypeScript built on web standards — `fetch`, Web Crypto, `ReadableStream`, ES modules —
published to [JSR](https://jsr.io/@spy4x) as eight framework-agnostic packages. Every package is
tested on Deno; a package with no `Deno.*` dependency in its sources (`@spy4x/time`,
`@spy4x/validation`) also runs in a browser or any other modern JS runtime, untested there.

No Preact, no app shells, no product domain. Everything here is a technical primitive or adapter
that is useful to more than one product. Each package below has its own one-line install and a short
usage example.

## Packages

"Runs on" says where a package's code can run: **server** means Deno on the back end, **browser**
means a front-end bundle, **shared** means both.

| Package               | Runs on                                                                           | What it holds                                                                                                                                                                                                                                                                                                                                        |
| --------------------- | --------------------------------------------------------------------------------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `@spy4x/validation`   | shared                                                                            | arktype `validate` with one result shape, and the form-validation state model                                                                                                                                                                                                                                                                        |
| `@spy4x/platform`     | shared, with `./browser/*` for the browser and `./server/*` for Deno              | helpers (`.`), command, query and event bus (`./cqrs`), cache with `wrap()` (`./cache`), API result and `apiFetch` (`./api`), model schemas (`./model`), tokens and ULIDs (`./tokens`), rate limiting and its Hono middleware (`./rate-limit`), request metadata (`./request-info`), browser storage and download, atomic JSON files and a file lock |
| `@spy4x/server`       | server                                                                            | sign-in (session, cookie, TOTP, password hashing, guards), accounts with password, email-code and OAuth providers, Postgres access and migrations, Redis key-value store, outbox, field encryption, typed config, request logging, file storage (local and S3), CORS, bearer auth, static files, health check, quota, age64 env-file encryption      |
| `@spy4x/net`          | server                                                                            | outbound requests to URLs a user supplied: URL shape check, SSRF guard, redirect-safe `fetch`, size-capped body readers                                                                                                                                                                                                                              |
| `@spy4x/integrations` | server                                                                            | ntfy and healthchecks.io clients, inbound webhook signature check, retry backoff                                                                                                                                                                                                                                                                     |
| `@spy4x/time`         | shared                                                                            | IANA time-zone arithmetic on `Intl`, iCalendar (`.ics`) writer                                                                                                                                                                                                                                                                                       |
| `@spy4x/email`        | server                                                                            | SMTP sender, address parsing, HTML mail wrapper, DKIM signature checker for incoming mail                                                                                                                                                                                                                                                            |
| `@spy4x/realtime`     | both halves: `./registry` and `./notify` on the server, `./client` in the browser | hint-only WebSocket transport: connection registry, heartbeat, reconnect, cursor-based sync                                                                                                                                                                                                                                                          |

`ai/` (chat completion, JSON recovery) is planned, not built (#11, #76).

Each package's own `README.md` lists its entry points. `docs/1.0-contract.md` lists the entry points
the template imports, whose names and signatures are frozen at 1.0.

### `@spy4x/email`

```bash
deno add jsr:@spy4x/email
```

```ts
import { createSmtpSender } from "@spy4x/email/smtp"

const sender = createSmtpSender({
  host: "smtp.example.com",
  port: 587,
  user: "user@example.com",
  pass: Deno.env.get("SMTP_PASSWORD") ?? "",
  from: "Booking <booking@example.com>",
})
const result = await sender.send({
  to: ["guest@example.com"],
  subject: "Booking confirmed",
  text: "Your meeting is booked.",
})
if (!result.ok) console.error(result.error)
```

### `@spy4x/integrations`

```bash
deno add jsr:@spy4x/integrations
```

```ts
import { NtfyClient } from "@spy4x/integrations/ntfy"

const client = new NtfyClient({ baseUrl: "https://ntfy.example.com", topic: "deploys" })
await client.notifyFailure("deploy failed", "3 of 5 services failed to restart")
```

### `@spy4x/net`

```bash
deno add jsr:@spy4x/net
```

```ts
import { validatePublicUrl } from "@spy4x/net/url-policy"

async function fetchUserSuppliedUrl(userInput: string) {
  const safeUrl = await validatePublicUrl(userInput) // throws on a private/loopback/link-local target
  return fetch(safeUrl)
}
```

### `@spy4x/platform`

```bash
deno add jsr:@spy4x/platform
```

```ts
import { CommandBus } from "@spy4x/platform/cqrs"
import { apiFetch } from "@spy4x/platform/api"

const bus = new CommandBus()
```

### `@spy4x/realtime`

```bash
deno add jsr:@spy4x/realtime
```

```ts
import {
  ClientTransport,
  createSystemClock,
  createWebSocketFactory,
  PersistentCursorStore,
} from "@spy4x/realtime"

const cursors = new PersistentCursorStore({ storage: localStorage, clock: createSystemClock() })
const transport = new ClientTransport({
  url: `wss://${location.host}/api/ws`,
  socketFactory: createWebSocketFactory(),
  clock: createSystemClock(),
  cursors,
  pull: (gap) => fetch(`/api/groups/${gap.groupId}/changes?since=${gap.since}`).then(() => {}),
  gate: () => fetch("/api/auth/me").then((r) => ({ allowed: r.ok })),
})
transport.onChange((hint) => console.log(`${hint.groupId} moved to ${hint.sequence}`))
transport.connect()
```

### `@spy4x/server`

```bash
deno add jsr:@spy4x/server
```

```ts
import { createPasswordHasher } from "@spy4x/server/sign-in"

const hasher = createPasswordHasher({ pepper: Deno.env.get("PASSWORD_PEPPER") ?? "" })
const hash = await hasher.hash("correct horse battery staple")
const check = await hasher.verify("correct horse battery staple", hash)
```

### `@spy4x/time`

```bash
deno add jsr:@spy4x/time
```

```ts
import { formatDateTimeLong, zonedDateTime } from "@spy4x/time/tz"

const instant = zonedDateTime("2026-08-28", "10:00", "Europe/Berlin")
formatDateTimeLong("2026-08-28", "10:00", "Europe/Berlin") // "Friday, 28 August 2026 at 10:00"
```

### `@spy4x/validation`

```bash
deno add jsr:@spy4x/validation
```

```ts
import { type } from "arktype"
import { validate } from "@spy4x/validation"

const userSchema = type({ name: "1 <= string <= 10" })
const { error, data } = validate(userSchema, { name: "Ann" })
if (error) console.error(error.description)
else console.log(data.name)
```

## Rules

- **arktype only.** No zod. Sources that carry zod are ported, not copied — schemas are rewritten
  at extraction time. No `{parse, safeParse}` adapter: that would institutionalise a second
  validator.
- **Deno is the only runtime for building and testing this repo.** No Node.js, npm, pnpm, Yarn or
  Bun commands. `npm:` specifiers run through Deno where unavoidable. What a published package
  itself runs on at the consumer's end is the "Runs on" column above.
- **Source repos are read-only.** Bugs in the repos this code is extracted from are fixed _here_,
  at extraction time. No module is published while it still carries a known bug.
- **MIT.**

## Tests

Two tiers. `deno task test` is the unit tier: fakes only, no network, no Docker, and it is part of
`deno task check`. `deno task test:integration` is the integration tier: files named
`*.integration.test.ts`, run against a real Postgres, a real S3-compatible store, a real mail
server and a real Redis, all started by `deno task services:up`. An integration test whose service
is missing fails with the address and the command that starts it — it never skips. `AGENTS.md` has
the details.

## Relationship to other repos

- `spy4x/preact-components` — Preact + Tailwind layer. Independent package; no workspace coupling.
- `spy4x/template` — the SaaS app template; it will import both once #78 publishes them. No other
  repository imports `@spy4x/*` yet.

## Naming policy

Three repos, not a monorepo. Publish pins exactly and commits lockfiles.

## Maintaining

**CI.** The badge above links the Woodpecker pipeline at `ci.antonshubin.com` (repo id `10`). Its
pipeline and publish logs are public and were checked for secret values before the badge was added
(no token, password or connection string with embedded credentials appears in the most recent push
build or the most recent tag/publish build — see the PR that added this section for the exact
commands run).

**JSR package metadata** (description, linked GitHub repository, runtime-compatibility flags) is
config, not something clicked in the JSR UI: it lives in `infra/jsr-metadata.json` and is applied by
`deno task jsr:metadata`, which calls JSR's package API (`PATCH
https://api.jsr.io/scopes/spy4x/packages/<package>`). To apply it for real:

1. Sign in at [jsr.io](https://jsr.io), go to your user settings, and create a personal access
   token scoped to the `spy4x` scope with permission to update packages.
2. Export it and run the task: `JSR_API_TOKEN=<token> deno task jsr:metadata`.
3. `deno task jsr:metadata -- --dry-run` prints the exact requests without sending them and needs
   no token — use it to review a change to `infra/jsr-metadata.json` before applying it.

**Provenance** (JSR's cryptographically signed proof that a version was built from this repo's
source, via Sigstore) is not something this repo's Woodpecker pipeline can produce: JSR only issues
a provenance statement for a publish that runs through GitHub Actions' native OIDC integration
(`jsr publish`/`deno publish` from a GitHub Actions workflow), not from a self-hosted CI system.
Adding it would mean running the release publish from GitHub Actions instead of Woodpecker, which
is a bigger change than this task's scope — the exact shape, for whenever that trade-off is made:

1. A workflow at `.github/workflows/publish.yml`, triggered on the same `v*` tag Woodpecker's
   `publish` step reacts to today, running `deno publish` (no `--no-provenance` flag) with
   `permissions: { id-token: write }` and no `JSR_TOKEN` secret — OIDC replaces the token.
2. Each package's page on JSR needs its "Link repository" setting pointed at `spy4x/ts-libs`
   (the `githubRepository` field `jsr:metadata` already sets) — JSR checks the workflow's identity
   against that link before it will attach a provenance statement.

Made by Anton Shubin · [antonshubin.com/tools](https://antonshubin.com/tools/ts-libs)
