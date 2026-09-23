# AGENTS.md — ts-libs

Framework-agnostic TypeScript primitives and adapters for Deno, published to JSR. Read `README.md`
for scope and `LICENSE` for terms (MIT, © 2026 Anton Shubin). Global rules live in
`~/.dsh/AGENTS.md`; this file adds constraints and overrides them where they conflict.

This repo is a Deno workspace. Every package is built by a different agent in its own PR, owning
exactly one top-level directory.

## Package layout

| Directory       | Contents                                                                                                                                                                                                                |
| --------------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `platform/`     | types (arktype), helpers, rate-limit, fs, cqrs (command, query and event bus), cache, shared API and model types (api, request-info, model)                                                                             |
| `server/`       | auth, sign-in (session, cookie, TOTP, password hashing, guards), storage, crypto, db, kv (Redis), outbox, http (bounded-body, cors, bearer-auth), request-log, config, static, healthcheck, user-secrets, quota, export |
| `net/`          | url-shape, url-policy (SSRF guard), safe-fetch, bounded-body                                                                                                                                                            |
| `integrations/` | healthchecks, ntfy, webhooks                                                                                                                                                                                            |
| `time/`         | tz, ics                                                                                                                                                                                                                 |
| `ai/`           | chatCompletion, chatJson, JSON-from-fence recovery — planned, not built (#11, #76)                                                                                                                                      |
| `email/`        | address, html, message, sender, smtp transport, dkim-verify                                                                                                                                                             |
| `realtime/`     | hint-only websocket transport, registry, heartbeat, cursor sync                                                                                                                                                         |
| `validation/`   | arktype validate helpers, validation model                                                                                                                                                                              |

## Adding a package

`deno.jsonc` already lists **every** package directory in `"workspace"`. **Do not edit the workspace
array, and do not edit root `deno.jsonc` at all from a package PR.** Deno skips a listed member whose
directory does not exist yet — one `Skipping.` line on stderr per missing member, exit 0 — so a
package joins the workspace the moment you create its own config:

```bash
mkdir <dir>
cat > <dir>/deno.json <<'EOF'
{
  "name": "@ts-libs/<dir>",
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

- `name` is `@ts-libs/<directory>` — that is how sibling packages import you. The JSR publish scope is
  confirmed by issue #20.
- `version` starts at `0.1.0`. `exports` lists exactly the entry points that exist today; adding a
  file does not add an export.
- Do not add an `imports` block unless you need a specifier the root does not provide. Shared deps
  (arktype, `@std/*`, hono, postgres) live in the root import map so every package resolves one copy.
- Sibling imports use the member name: `import { normalizeUrlShape } from "@ts-libs/net"`.
- Do not add a package-level `lint`/`fmt` block: root config is the single source of truth.

Type-checking, formatting, linting and tests are discovered by walking the tree, so a new package is
covered without touching root config or `infra/scripts/type-check.ts`.

## Extraction rules

- **Source repos are read-only.** Never edit `offer-lens`, `roley`, `rostok`, `mig`, `caldav-mcp`,
  `template`, `preact-components` or any other repo you port from. They are design-intent sources.
- **Bugs are fixed here, at extraction time.** A bug found in a source repo is fixed in this repo,
  in the ported code, and named in the PR body (file, symptom, fix).
- **No module is published while it still carries a known bug.** If a security or correctness fix
  cannot land in this PR, the extracted code does not land either.
- **Port the behaviour, not the dependency.** Prefer platform primitives (`URL`, `crypto`, `Intl`,
  `fetch`) over a JS reimplementation of them, and prefer `@std/*` over a bespoke helper.
- Extraction order and wave barriers are recorded in issue #22. Respect them — wave 5
  (`server/auth`) must not run parallel to anything auth-adjacent.

## Branch-first workflow

Create the branch before any edit. Never commit to `main`.

```bash
git fetch origin
git checkout -b <type>/<short-kebab-slug> origin/main
```

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

- Push and open the PR immediately after the first commit; prefix the title with `[WIP]` while
  incomplete and drop the prefix when the work is done.
- Base every PR on `main`. One package per PR — keep diffs disjoint from other packages.
- Update the PR body after every significant change; state the decisions you made.
- Never self-review a diff you wrote. A passing verdict from a separate reviewer agent is the merge
  authority — merge on it without asking. Leave the PR open instead, and say so, when the gate
  fails or when a revert could not undo the change.

```bash
gh pr create --fill --base main
```

## Pre-commit checklist

```bash
deno task check
deno task check:cold              # CI emulation — the only real evidence
deno task check:cold check:all    # the same, plus the integration tier; needs the containers up
```

`check:cold` runs the named tasks (default `check`) with `CI=true` and an empty `DENO_DIR` that it
creates under `.volumes/denodir/` and removes again, pass or fail. It prints `cold <task>: exit=<n>`
after each task. Use it instead of a hand-written `DENO_DIR=$(mktemp -d …)` block: that form left
~2 000 files behind per run until a wave of parallel agents filled `/tmp`, and its `rm -rf -- "$D"`
makes an agent harness stop and ask a person before every run, because the variable could be empty.
For the same reason, never put a shell variable inside an `rm` path anywhere in this repo's
workflows — undo a throw-away checkout with `git checkout -- .`, `git clean` and
`git worktree remove`, or name the literal path.

A warm local run is not evidence: it hides `$HOME`, `DENO_DIR` and cache assumptions. Never assert a
path under `$HOME` in a test — resolve it through `import.meta.resolve` or an injected config. A test
that can silently skip when its dependency is missing must fail loudly instead.

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
| `deno task services:up`      | start the four integration services, wait until healthy    |
| `deno task services:down`    | stop them and drop their volumes                           |
| `deno task services:logs`    | logs of the four containers                                |
| `deno task publish:dry`      | `deno publish --dry-run` over the workspace; not run in CI |
| `deno task contract`         | regenerate `docs/1.0-contract.md` from `deno doc` (#77)    |
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
| Talks to     | fakes only                 | real Postgres, MinIO, Mailpit and Redis                            |
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
TS_LIBS_IT_SMTP_HOST             127.0.0.1
TS_LIBS_IT_SMTP_PORT             51025
TS_LIBS_IT_MAILPIT_URL           http://127.0.0.1:58025
TS_LIBS_IT_REDIS_HOST            127.0.0.1
TS_LIBS_IT_REDIS_PORT            56379
```

Every container that takes a credential uses `integration-test-only` as the user, password and
database name; Redis takes none. They hold throw-away data and listen on loopback only; the
literal is meant to be unmistakable if it ever turns up in a log. It is the one credential-shaped
string this repository commits.

## Code style

- No semicolons. 2-space indent. Double quotes by default, backticks for interpolated or multi-line
  strings. 100 column limit. Trailing commas where legal. `deno fmt` is the arbiter.
- Files: kebab-case `.ts`, `+main.ts` / `+lib.ts` for entry points, colocated `*.test.ts`.
- Imports: relative local first, then `jsr:` stdlib, then `npm:` only when unavoidable.
- `interface` for extensible object shapes, `enum` for finite constants (start at 1), `type` only for
  unions and intersections (a string-literal union of error codes is a `type`).
- Named exports. `async`/`await`. Explicit `throw` on a missing required value.
- JSDoc on any non-trivial function, class or interface over 10 lines.
- Tests: colocated, deterministic, behaviour-named — `it("rejects an expired token")`.

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
is its own commit with scope `deps`, and it states the reason.

Current pins (root `deno.jsonc`, the single source of truth):

```
arktype                          2.2.3
@std/assert                     1.0.19
@std/expect                     1.0.20
@std/testing/bdd                1.0.20
@std/path                        1.1.6
@std/encoding                   1.0.11
@std/crypto                      1.1.0
@std/ulid                        1.0.0
hono                            4.13.8
postgres                         3.4.7
otpauth                          9.5.2
qrcode                           3.1.0
@iuioiua/redis                   1.1.10
```

Adding an import-map entry is a root-file change: it needs the issue number that needs the
dependency in the PR body. No speculative entries.

## Hard rules

- **Deno is the only runtime.** No Node.js, npm, pnpm, Yarn or Bun commands anywhere — not in tasks,
  not in CI, not in docs. `npm:` specifiers run through Deno where unavoidable.
- Never commit a secret, token, credential, `.env` value or raw production URL.
- One logical change per commit. Keep commits small.
- Do not reformat or edit a directory another agent owns.
- Never self-review. A separate reviewer's green gate is the merge authority, not the author's own
  read of the diff.
