# AGENTS.md — ts-libs

Framework-agnostic TypeScript primitives and adapters for Deno, published to JSR. Read `README.md`
for scope, `CONTRIBUTING.md` for the repository rules and maintenance, and `LICENSE` for terms
(MIT, © 2026 Anton Shubin). The global agent instructions own Git Flow, worktrees, review and
cleanup; this file adds constraints and overrides them where they conflict.

This repo is a Deno workspace: one package per top-level directory.

## Package layout

| Directory       | Contents                                                                                                                                                                                                                                                         |
| --------------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `platform/`     | types (arktype), helpers, rate-limit, fs, cqrs (command, query and event bus), cache, shared API and model types (api, request-info, model)                                                                                                                      |
| `server/`       | auth, sign-in (session, cookie, TOTP, password hashing, guards), storage, crypto, db, kv (Redis), outbox, http (bounded-body, cors, bearer-auth), request-log, config, static, healthcheck, user-secrets, quota, export, env-age64 (per-value `.env` encryption) |
| `net/`          | url-shape, url-policy (SSRF guard), safe-fetch, bounded-body                                                                                                                                                                                                     |
| `integrations/` | healthchecks, ntfy, webhooks                                                                                                                                                                                                                                     |
| `time/`         | tz, ics                                                                                                                                                                                                                                                          |
| `billing/`      | provider-neutral payments (checkout, portal, webhook events), Stripe adapter                                                                                                                                                                                     |
| `email/`        | address, html, message, sender, smtp transport, dkim-verify                                                                                                                                                                                                      |
| `realtime/`     | hint-only websocket transport, registry, heartbeat, cursor sync                                                                                                                                                                                                  |
| `caldav/`       | CalDAV client, sync engine, IndexedDB store and write transport, WebDAV XML reader, CalDAV URL rules                                                                                                                                                             |
| `validation/`   | arktype validate helpers, validation model                                                                                                                                                                                                                       |
| `tasks/`        | the to-do model the CalDAV task apps share: model, view, quick-add, reminder-runner                                                                                                                                                                              |

## Adding a package

`deno.jsonc` already lists **every** package directory in `"workspace"`. **Do not edit the workspace
array.** Deno skips a listed member whose directory does not exist yet — one `Skipping.` line
on stderr per missing member, exit 0 — so a package joins the workspace the moment you create its own config:

```bash
mkdir <dir>
cat > <dir>/deno.json <<'EOF'
{
  "name": "@spy4x/<dir>",
  "version": "0.1.0",
  "exports": {
    ".": "./<entry>.ts"
  }
}
EOF
```

The `Skipping.` warning is expected and harmless. Do not "fix" it by creating stub directories, and
do not treat it as a failure — a scaffold that faked members would break every parallel extraction.

Rules for a package config:

- `name` is `@spy4x/<directory>` — that is how sibling packages import you, and the name it has on
  JSR (`jsr:@spy4x/<directory>`, #78). Create the package on jsr.io before its first release.
- `version` is the workspace's release version (see "Releasing"). `exports` lists exactly the entry
  points that exist today; adding a file does not add an export.
- Do not add an `imports` block unless you need a specifier the root does not provide. Shared deps
  (arktype, `@std/*`, hono, postgres) live in the root import map so every package resolves one copy.
- Sibling imports use the member name: `import { normalizeUrlShape } from "@spy4x/net"`.
- Do not add a package-level `lint`/`fmt` block: root config is the single source of truth.

Type-checking, formatting, linting and tests are discovered by walking the tree, so a new package is
covered without touching root config or `infra/scripts/type-check.ts`.

## What belongs in this library

Code belongs here when it has no UI, a server or a page could use it, and a future project can
reuse it, even if only one app uses it today: date and time, formatting, parsing, validation,
security, networking, integrations. A Preact component, icon, design token or signals helper goes
to `spy4x/preact-components` instead. What disqualifies code: business wording, one app's data
model, or a renamed copy of something generic that already exists. Before adding a function, search
both libraries for one that does the same job under another name, and extend it rather than adding
a second one.

A domain model that a family of the owner's apps shares is welcome, and it lives in a package named
for that domain, never under a general name in `platform/` or `time/`: the to-do model that the
CalDAV task apps share goes to a `tasks` package (#600).

Code flows both ways. An app feeds this library and `spy4x/preact-components` with anything a
future project could reuse, and every app, old or new, imports from them instead of keeping its own
copy. Each app tracks that switch in an issue of its own. Because apps import from here, removing an
export breaks them: move every app that imports it onto a replacement, or back onto its own copy,
before the export goes.

## Extraction rules

- **Source repos are read-only.** Never edit `offer-lens`, `roley`, `rostok`, `mig`, `caldav-mcp`,
  `seed`, `preact-components` or any other repo you port from. They are design-intent sources.
- **Bugs are fixed here, at extraction time.** A bug found in a source repo is fixed in this repo,
  in the ported code, and named in the PR body (file, symptom, fix).
- **No module is published while it still carries a known bug.** If a security or correctness fix
  cannot land in this PR, the extracted code does not land either.
- **Port the behaviour, not the dependency.** Prefer platform primitives (`URL`, `crypto`, `Intl`,
  `fetch`) over a JS reimplementation of them, and prefer `@std/*` over a bespoke helper.
- Extraction order and wave barriers are recorded in issue #22. Respect them — wave 5
  (`server/auth`) must not run parallel to anything auth-adjacent.

## Releasing

Every package carries the same version, and all of them are released together. After 1.0.0, an
exported name, parameter or return type changes only additively, or it waits for 2.0
(`docs/1.0-contract.md`, #77). That covers an interface an app implements (`BillingProvider`, a
store, the double an app writes for its tests): a new member is optional, or it waits for 2.0
(#565).

1. One PR sets `version` in every `<dir>/deno.json` to the new version, and passes
   `deno task check:cold publish:dry`.
2. After it merges, tag `main` with `v<version>` and push the tag. Woodpecker's `publish` step runs
   `deno publish` with the `JSR_TOKEN` secret, after the unit and integration steps pass.

A publish cannot be undone: JSR never deletes a version, so tag only the merged bump commit on
`main`. Once that PR merges with a green gate, push the tag without asking. A version that is
already on JSR is skipped, so the `publish` step retries a failed or stalled `deno publish`
itself, three attempts of 10 minutes each (#683); restart the pipeline only after all three fail.

Releases are cut in batches (#683), never after every merge, at the times the global rule for
shared libraries allows ("Autonomy" in the global agent rules).

## Branches

Types: `feat/`, `fix/`, `refactor/`, `chore/`, `docs/`, `style/`, `perf/`, `ci/`.

## Commit convention (Angular)

```
<type>(<scope>): <short summary>
```

- Types: `feat`, `fix`, `refactor`, `chore`, `docs`, `style`, `perf`, `ci`
- Scope: the package directory (`net`, `time`, `server`, …) or `deps`; omit when repo-wide
- Summary: imperative, lowercase, no trailing period, ≤ 50 chars, hard cap 72
- Body only when the why is not obvious from the title. No AI attribution.

```
feat(net): add url-shape normaliser
fix(server): reject a replayed magic-link token
chore(deps): pin postgres to 3.4.7
docs: document the workspace member rule
```

## PR discipline

- One package per PR — keep diffs disjoint from other packages.
- Update the PR body after every significant change; state the decisions you made.

## Generated files

`docs/1.0-contract.md` (`deno task contract`), `llms.txt` and `llms-full.txt` (`deno task llms`) are
generated. Never edit them by hand. Adding, renaming or re-documenting an export, changing an
`exports` map or editing a README makes `deno task test` fail until you run the command and commit
the result. `llms.txt` lists the exports for agents in other repositories, one line each: name,
kind, import specifier and summary, separated by tabs. A type that describes the parameters of
a function or class it is named after (`FooOptions` next to `foo` or `createFoo`) has no line, and
the lines that are not exports start with `#`. `llms-full.txt` joins every README. Parallel PRs
that touch an export conflict on the last line of `llms.txt`; resolve it by running
`deno task llms` after the rebase.

## Pre-commit checklist

```bash
deno task check
deno task check:cold              # CI emulation — the only real evidence
deno task check:cold check:all    # the same, plus the integration tier; needs the containers up
```

`check:cold` runs the named tasks (default `check`) with `CI=true` and an empty `DENO_DIR` that it
creates under `.volumes/denodir/` and removes again, pass or fail. It prints `cold <task>: exit=<n>`
after each task. Use it instead of a hand-written `DENO_DIR=$(mktemp -d …)` block, which leaves
files behind and puts a variable in an `rm` path. Never put a shell variable inside an `rm` path
anywhere in this repo's workflows — undo a throw-away checkout with `git checkout -- .`,
`git clean` and `git worktree remove`, or name the literal path.

| Task                         | Does                                                       |
| ---------------------------- | ---------------------------------------------------------- |
| `deno task check`            | format, lint, types and the unit tier; needs no containers |
| `deno task check:all`        | `check`, then the integration tier                         |
| `deno task check:cold`       | the named tasks as CI runs them: `CI=true`, empty cache    |
| `deno task fmt`              | format (`fmt:check` in CI)                                 |
| `deno task lint`             | lint (`lint:fix` to apply suggestions)                     |
| `deno task ts:check`         | `deno check` over every `.ts`/`.tsx` in the tree           |
| `deno task test`             | the unit tier — every test except `*.integration.test.ts`  |
| `deno task test:integration` | the integration tier — only `*.integration.test.ts`        |
| `deno task services:up`      | start the eight integration services, wait until healthy   |
| `deno task services:down`    | stop them and drop their volumes                           |
| `deno task services:logs`    | logs of the eight containers                               |
| `deno task publish:dry`      | `deno publish --dry-run` over the workspace; CI runs it    |
| `deno task contract`         | regenerate `docs/1.0-contract.md` from `deno doc` (#77)    |
| `deno task llms`             | regenerate `llms.txt` and `llms-full.txt` (#297)           |
| `deno task fix`              | `lint --fix` then format                                   |

If `deno task check` fails because the lockfile is stale, run the task that needs the new dependency
once with network access and commit the updated `deno.lock`. Never delete or hand-edit the lockfile.
`CI=true` does not freeze the lockfile — Deno rewrites it and still exits 0 — so `check:cold` compares
`deno.lock` before and after the run and fails when it changed. A cold run that wants to rewrite the
lockfile is a failure, not a warning to ignore.

## Test tiers

Two tiers, agreed in issue #74. They differ in what they are allowed to touch, not in how carefully
they are written.

|              | Unit tier                  | Integration tier                                                   |
| ------------ | -------------------------- | ------------------------------------------------------------------ |
| File name    | `*.test.ts`                | `*.integration.test.ts`                                            |
| Task         | `deno task test`           | `deno task test:integration`                                       |
| Talks to     | fakes only                 | real Postgres, MinIO, Garage, Mailpit, Redis x2                    |
| Permissions  | `--allow-read --allow-env` | the above plus `--allow-net` and a narrow `--allow-write=.volumes` |
| Needs Docker | no                         | yes                                                                |

The suffix is the only thing that puts a file in a tier: `deno task test` ignores `**/*.integration.test.ts`
and `deno task test:integration` runs nothing else. Both tiers are formatted, linted and type-checked
by `deno task check` — only the _running_ is split.

`deno task check` stays free of containers so a package PR can be verified anywhere.
`deno task check:all` runs both tiers in order, unit first.

### Running the integration tier

```bash
deno task services:up          # Postgres, MinIO, Mailpit and Redis; returns when all are healthy
deno task test:integration
deno task services:down        # when you are done with them for the day
```

The containers are defined in `infra/compose.integration.yml` under the fixed compose project name
`ts-libs-it`. Every published port is bound to `127.0.0.1` and sits in the 5xxxx range so it cannot
collide with anything already running. Images are pinned to an exact tag, like every other
dependency.

### Writing one

Import the harness from `@integration-testing` (it lives in `infra/testing/`, which is not a
workspace member, so nothing test-only can ever be published):

```ts
import { postgresSettings, requireReachable, uniqueIdentifier } from "@integration-testing"

const settings = postgresSettings()
await requireReachable(settings.address) // fails loudly when the container is not there
const schema = uniqueIdentifier("it_db") // unique per run
```

Three rules, and a test that breaks one breaks somebody else's run:

- **Fail loudly, never skip.** Call `requireReachable` before touching a service. There is no
  `ignore`, no early `return` and no `try`/`catch` that turns a missing container into a pass.
- **Isolate every global name.** Several worktrees run this tier against the same containers at the
  same time. Take a fresh suffix — `uniqueIdentifier`, `uniqueKeyPrefix`, `uniqueRecipient` — for
  every schema, object key and mail recipient, and never truncate a shared table or delete every
  message in the mailbox.
- **Clean up in a `finally`.** Drop the schema, delete the object, delete the mail, delete your own
  prefixed Redis keys — never `FLUSHDB` or `FLUSHALL`, which wipe every other run's keys. A test
  that failed still cleans up.

A test that needs a real folder on disk, not a fake filesystem, calls `createScratchFolder(prefix)`
from `@integration-testing`: it creates `.volumes/it/<prefix>_<suffix>` and returns its absolute
path, inside the tier's own `--allow-write=.volumes` grant. Remove it again with
`removeScratchFolder(path)` in the test's `finally`. `Deno.makeTempDir()` stays refused in this
tier — it writes outside `.volumes`.

Addresses come from one environment variable each, defaulting to the compose file. CI sets them to
the Woodpecker service host names.

```
TS_LIBS_IT_POSTGRES_URL          postgres://…@127.0.0.1:55432/…
TS_LIBS_IT_S3_ENDPOINT           http://127.0.0.1:59000
TS_LIBS_IT_S3_ACCESS_KEY_ID      integration-test-only
TS_LIBS_IT_S3_SECRET_ACCESS_KEY  integration-test-only
TS_LIBS_IT_S3_BUCKET             ts-libs-integration
TS_LIBS_IT_S3_REGION             us-east-1
TS_LIBS_IT_GARAGE_ENDPOINT       http://127.0.0.1:53900   (key and bucket fixed, see the harness)
TS_LIBS_IT_SMTP_HOST             127.0.0.1
TS_LIBS_IT_SMTP_PORT             51025
TS_LIBS_IT_MAILPIT_URL           http://127.0.0.1:58025
TS_LIBS_IT_REDIS_HOST            127.0.0.1
TS_LIBS_IT_REDIS_PORT            56379
TS_LIBS_IT_REDIS_AUTH_HOST       127.0.0.1   (the Redis started with a password)
TS_LIBS_IT_REDIS_AUTH_PORT       56380
TS_LIBS_IT_RADICALE_URL          http://127.0.0.1:55232
TS_LIBS_IT_STALWART_URL          http://127.0.0.1:58080   (JMAP admin and DAV)
```

Every container that takes a credential uses `integration-test-only` as the user, password and
database name; the plain Redis takes none, and the second Redis (`redis-auth`) uses it as its
password. They hold throw-away data and listen on loopback only; the literal is meant to be
unmistakable if it ever turns up in a log. It is the one credential-shaped
string this repository commits.

## Code style

The global TS style applies, with two overrides: double quotes by default, backticks for
interpolated or multi-line strings (this overrides the global "backticks for strings" rule); and an
explicit `throw` on any missing required value, not only a missing env value. `deno fmt` is the
arbiter.

## Validation

**arktype only. No zod, no valibot, no hand-rolled validator, no `{ parse, safeParse }` adapter.**
An adapter would institutionalise a second validator; schemas from a source repo are rewritten at
extraction time, not wrapped.

```ts
import { type } from "arktype"

const retryOptions = type({ attempts: "number", backoffMs: "number" })
export type RetryOptions = typeof retryOptions.infer
```

## Dependencies

**Pin exactly. Never `^`, never `~`, never a floating tag.** The lockfile is committed. A version bump
is its own commit with scope `deps`, and it states the reason. The root `deno.jsonc` import map is
the only list of pins; read it there.

Adding an import-map entry is a root-file change: it needs the issue number that needs the
dependency in the PR body. No speculative entries.

## Hard rules

- **Deno is the only runtime.** No Node.js, npm, pnpm, Yarn or Bun commands anywhere — not in tasks,
  not in CI, not in docs. `npm:` specifiers run through Deno where unavoidable.
- Never commit a secret, token, credential, `.env` value or raw production URL.
- One logical change per commit. Keep commits small.
- Do not reformat or edit a directory another agent owns.
