# AGENTS.md — ts-libs

Framework-agnostic TypeScript primitives and adapters for Deno, published to JSR. Read `README.md`
for scope and `LICENSE` for terms (MIT, © 2026 Anton Shubin). Global rules live in
`~/.dsh/AGENTS.md`; this file adds constraints and overrides them where they conflict.

This repo is a Deno workspace. Every package is built by a different agent in its own PR, owning
exactly one top-level directory.

## Package layout

| Directory       | Contents                                                                                                            |
| --------------- | ------------------------------------------------------------------------------------------------------------------- |
| `platform/`     | types (arktype), helpers, rate-limit, fs                                                                            |
| `server/`       | auth, storage, crypto, db, http (bounded-body, cors, bearer-auth), static, healthcheck, user-secrets, quota, export |
| `net/`          | url-shape, url-policy (SSRF guard), safe-fetch, bounded-body                                                        |
| `integrations/` | healthchecks, ntfy, webhooks                                                                                        |
| `time/`         | tz, ics                                                                                                             |
| `ai/`           | chatCompletion, chatJson, JSON-from-fence recovery                                                                  |
| `email/`        | smtp transport, dkim-verify                                                                                         |
| `realtime/`     | hint-only websocket transport, registry, heartbeat, cursor sync                                                     |
| `validation/`   | arktype validate helpers, validation model                                                                          |

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
- Never merge your own PR, and never merge a PR you authored. Human review merges it.

```bash
gh pr create --fill --base main
```

## Pre-commit checklist

```bash
deno task check
CI=true DENO_DIR=$(mktemp -d) deno task check   # CI emulation — the only real evidence
```

A warm local run is not evidence: it hides `$HOME`, `DENO_DIR` and cache assumptions. Never assert a
path under `$HOME` in a test — resolve it through `import.meta.resolve` or an injected config. A test
that can silently skip when its dependency is missing must fail loudly instead.

| Task                 | Does                                             |
| -------------------- | ------------------------------------------------ |
| `deno task check`    | all checks; the only command CI runs             |
| `deno task fmt`      | format (`fmt:check` in CI)                       |
| `deno task lint`     | lint (`lint:fix` to apply suggestions)           |
| `deno task ts:check` | `deno check` over every `.ts`/`.tsx` in the tree |
| `deno task test`     | run all tests                                    |
| `deno task fix`      | `lint --fix` then format                         |

If `deno task check` fails because the lockfile is stale, run the task that needs the new dependency
once with network access and commit the updated `deno.lock`. Never delete or hand-edit the lockfile.
`CI=true` makes Deno treat the lockfile as frozen — a cold run that wants to rewrite it is a failure,
not a warning to ignore.

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
hono                            4.13.8
postgres                         3.4.7
```

Adding an import-map entry is a root-file change: it needs the issue number that needs the
dependency in the PR body. No speculative entries.

## Hard rules

- **Deno is the only runtime.** No Node.js, npm, pnpm, Yarn or Bun commands anywhere — not in tasks,
  not in CI, not in docs. `npm:` specifiers run through Deno where unavoidable.
- Never commit a secret, token, credential, `.env` value or raw production URL.
- One logical change per commit. Keep commits small.
- Do not reformat or edit a directory another agent owns.
- Never merge your own PR.
