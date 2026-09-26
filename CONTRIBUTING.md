# Contributing to ts-libs

How this repository is built, tested and released. The pitch and the package list are in
[README.md](README.md); agent-specific rules are in [AGENTS.md](AGENTS.md).

Each package's own `README.md` lists its entry points.
[`docs/1.0-contract.md`](docs/1.0-contract.md) lists the entry points the template imports, whose
names and signatures are frozen at 1.0.

## Rules

- **arktype only.** No zod. Sources that carry zod are ported, not copied — schemas are rewritten
  at extraction time. No `{parse, safeParse}` adapter: that would institutionalise a second
  validator.
- **Deno is the only runtime for building and testing this repo.** No Node.js, npm, pnpm, Yarn or
  Bun commands. `npm:` specifiers run through Deno where unavoidable. What a published package
  itself runs on at the consumer's end is the "Runs on" column of the
  [package table](README.md#packages).
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

These public repositories import `@spy4x/*` from JSR. None shares a workspace with this repo; each
pins an exact version.

- `spy4x/preact-components` — Preact + Tailwind layer. Imports `@spy4x/platform`, `@spy4x/time`
  and `@spy4x/validation` at 1.4.0.
- `spy4x/template` — the SaaS app template. Imports `@spy4x/platform`, `@spy4x/server` and
  `@spy4x/validation` at 1.4.0, and runs the `@spy4x/server` env-age64 CLI for its `env:*` tasks.
- `spy4x/antonshubin.com` — imports `@spy4x/email` and `@spy4x/platform` at 1.4.0, and runs the
  `@spy4x/server` 1.2.0 env-age64 CLI for its `env:*` tasks.
- `spy4x/financy` — imports `@spy4x/platform` and `@spy4x/server` at 1.3.0, and runs the
  `@spy4x/server` 1.2.0 env-age64 CLI for its `env:*` tasks.
- `spy4x/mig` — the meeting scheduler. Imports `@spy4x/platform` and `@spy4x/time` at 1.3.0.
- `spy4x/rostok` — imports `@spy4x/server` at 1.2.0 in its CLI, and runs its env-age64 CLI for its
  encrypt and decrypt tasks.
- `spy4x/dotfiles` — runs the `@spy4x/server` 1.2.0 env-age64 CLI for its `env:*` tasks.

## Naming policy

Three repos, not a monorepo. Publish pins exactly and commits lockfiles.

## Maintaining

**CI.** The CI badge at the top of [README.md](README.md) links the Woodpecker pipeline at
`ci.antonshubin.com` (repo id `10`). Its pipeline and publish logs are public and were checked for
secret values before the badge was added (no token, password or connection string with embedded credentials appears in the most recent push
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
