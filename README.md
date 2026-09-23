# ts-libs

Framework-agnostic TypeScript reusable libraries. Deno-first; publishing to JSR is planned (#78).

No Preact, no app shells, no product domain. Everything here is a technical primitive or adapter
that is useful to more than one product.

## Scope

```
platform/     types (arktype), helpers, rate-limit, fs, cqrs (command, query and event bus), cache,
              shared API and model types (api, request-info, model)
server/       auth, sign-in (session, cookie, TOTP, password hashing, guards), storage, crypto,
              db, kv (Redis), outbox, http (bounded-body, cors, bearer-auth), request-log,
              config, static, healthcheck, user-secrets, quota, export
net/          url-shape, url-policy (SSRF guard), safe-fetch, bounded-body
integrations/ healthchecks, ntfy, webhooks
time/         tz, ics
ai/           chatCompletion, chatJson, JSON-from-fence recovery — planned, not built (#11, #76)
email/        address, html, message, sender, smtp transport, dkim-verify
realtime/     hint-only websocket transport, registry, heartbeat, cursor sync
validation/   arktype validate helpers, validation model
```

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
  repository imports `@ts-libs/*` yet.

## Naming policy

Three repos, not a monorepo. Publish pins exactly and commits lockfiles.
