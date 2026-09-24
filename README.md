# ts-libs

Framework-agnostic TypeScript reusable libraries. Deno-first, published to [JSR](https://jsr.io/@spy4x).

No Preact, no app shells, no product domain. Everything here is a technical primitive or adapter
that is useful to more than one product.

## Packages

Eight packages on JSR under `@spy4x`, all at the same version. "Runs on" says where a package's code
can run: **server** means Deno on the back end, **browser** means a front-end bundle, **shared**
means both.

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

```bash
deno add jsr:@spy4x/server jsr:@spy4x/platform jsr:@spy4x/validation
```

```ts
import { validate } from "@spy4x/validation"
import { CommandBus } from "@spy4x/platform/cqrs"
import { apiFetch } from "@spy4x/platform/api"
import { SessionManager } from "@spy4x/server/sign-in"
import { createSql } from "@spy4x/server/db/postgres"
import { validatePublicUrl } from "@spy4x/net/url-policy"
import { NtfyClient } from "@spy4x/integrations/ntfy"
import { zonedDateTime } from "@spy4x/time/tz"
import { createSmtpSender } from "@spy4x/email/smtp"
import { ClientTransport } from "@spy4x/realtime/client"
```

Each package's own `README.md` lists its entry points. `docs/1.0-contract.md` lists the entry points
the template imports, whose names and signatures are frozen at 1.0.

## Rules

- **arktype only.** No zod. Sources that carry zod are ported, not copied — schemas are rewritten
  at extraction time. No `{parse, safeParse}` adapter: that would institutionalise a second
  validator.
- **Deno is the only runtime.** No Node.js, npm, pnpm, Yarn or Bun commands. `npm:` specifiers run
  through Deno where unavoidable.
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
