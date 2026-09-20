# ts-libs

Framework-agnostic TypeScript reusable libraries. Deno-first, JSR-published.

No Preact, no app shells, no product domain. Everything here is a technical primitive or adapter
that is useful to more than one product.

## Scope

```
platform/     types (arktype), helpers, rate-limit, fs
server/       auth, storage, crypto, db, http (bounded-body, cors, bearer-auth), static,
              healthcheck, user-secrets, quota, export
net/          url-policy (SSRF guard), safe-fetch, bounded-body
integrations/ healthchecks, ntfy, webhooks
time/         tz, ics
ai/           chatCompletion, chatJson, JSON-from-fence recovery
email/        smtp transport, dkim-verify
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

## Relationship to other repos

- `spy4x/preact-components` — Preact + Tailwind layer. Independent package; no workspace coupling.
- `spy4x/template` — the SaaS app template, imports both.

## Naming policy

Three repos, not a monorepo. Publish pins exactly and commits lockfiles.
