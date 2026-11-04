# AGENTS.md — ts-libs

TypeScript libraries on web standards, published to JSR as `@spy4x/*`. A Deno workspace: one
package per top-level directory, listed with what it holds in `README.md` ("Packages").
`CONTRIBUTING.md` has the repository rules, `docs/testing.md` the test tiers. The global agent
instructions own Git Flow, review, commits and cleanup; this file adds what holds in this repo.

## Commands

```bash
deno task check                    # format, lint, types, unit tier; 2-3 min, quiet unless it fails
deno task check:cold               # the same as CI runs it: CI=true and an empty DENO_DIR
deno task test net/                # one package's unit tests, seconds
deno task test net/ip.test.ts      # one file
deno task services:up && deno task test:integration   # the integration tier (Docker)
deno task llms                     # regenerate llms.txt and llms-full.txt
```

A plain `deno test` runs the unit tier only. `deno task check:all` is `check`, then the
integration tier.

## Runtime

New code, and the old functions you change anyway, runs unchanged on Deno, Node and Bun: web
standards and `@std/*`. A runtime call (`Deno.*`, `process`, `Bun.*`, `node:*`) goes behind an
adapter in `@spy4x/platform` (`platform/server/process.ts`, `runtime-fs.ts`, `serve.ts` and the
other `server/*` entries). Deno is the toolchain for building and testing this repo: no npm, pnpm,
Yarn or Bun commands in tasks, CI or docs.

## Adding a package

1. Add `"./<dir>"` to the `"workspace"` list in the root `deno.jsonc`.
2. Create `<dir>/deno.json` with `name` `@spy4x/<dir>`, the `version` every other package has, and
   `exports` listing exactly the entry points that exist.
3. Add the package's row to the table in `README.md` and its entry to `infra/jsr-metadata.json`,
   then run `deno task llms`. Create the package on jsr.io before its first release.

Rules for a package config:

- No `imports` block unless the package needs a specifier the root does not provide. Shared deps
  (arktype, `@std/*`, hono, postgres) live in the root import map, so every package resolves one
  copy.
- Sibling imports use the member name: `import { normalizeUrlShape } from "@spy4x/net"`.
- No package-level `lint` or `fmt` block: the root config is the single source.

Type-checking, formatting, linting and tests find files by walking the tree, so a new package needs
no other root change.

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

**Port the behaviour, not the dependency.** Prefer platform primitives (`URL`, `crypto`, `Intl`,
`fetch`) over a JS reimplementation of them, and `@std/*` over a bespoke helper.

## Releasing

Every package carries the same version, and all of them are released together. Since 1.0.0, an
exported name, parameter or return type changes only additively, or it waits for 2.0. That covers
an interface an app implements (`BillingProvider`, a store, the double an app writes for its
tests): a new member is optional, or it waits for 2.0 (#565).

1. One PR sets `version` in every `<dir>/deno.json` to the new version, and passes
   `deno task check:cold check publish:dry`.
2. After it merges, tag that merge commit on `main` with `v<version>` and push the tag without
   asking. Woodpecker's `publish` step runs `deno publish` with the `JSR_TOKEN` secret after the
   unit and integration steps pass.

A version already on JSR is skipped, so the `publish` step retries a failed or stalled
`deno publish` itself, three attempts of 10 minutes each; restart the pipeline only after all
three fail. Releases are cut in batches, never after every merge, at the times the global rule for
shared libraries allows.

## Pull requests

- One package per PR, so diffs stay disjoint.
- Commit scope: the package directory (`net`, `time`, `server`, …) or `deps`; none when repo-wide.

## Generated files

`llms.txt` and `llms-full.txt` are generated by `deno task llms`; never edit them by hand.
`llms.txt` lists every export for agents in other repositories, one line each: name, kind, import
specifier and summary, separated by tabs. A type that describes the parameters of the function or
class it is named after (`FooOptions` next to `foo`) has no line, and lines that are not exports
start with `#`. `llms-full.txt` joins every README. Adding, renaming or re-documenting an export,
changing an `exports` map or editing a README makes `deno task test` fail until you run the task
and commit the result. Parallel PRs conflict on the last line of `llms.txt`; run `deno task llms`
after the rebase.

## Checks

`deno task check` runs `fmt:check`, `lint`, `ts:check` and `test` in parallel and prints one line
per task; a failing task also prints its errors (`infra/scripts/check.ts`). It needs no
containers, so a package PR can be verified anywhere.

`deno task check:cold [task…]` runs the named tasks (default `check`) with `CI=true` and an empty
`DENO_DIR` under `.volumes/denodir/`, removed afterwards, and fails when the run rewrote
`deno.lock` (`infra/scripts/cold-check.ts`). Use it instead of a hand-written cache block. A cold
run that wants to rewrite the lockfile is a failure: run the task that needs the new dependency
once with network access and commit `deno.lock`.

## Tests

Unit tests use fakes only. An integration test (`*.integration.test.ts`) fails loudly instead of
skipping, takes a unique name for every schema, key and mail recipient, and cleans up in a
`finally`. How to write and run one: `docs/testing.md`.

## Code style

The global TS style applies, with two overrides: double quotes by default, backticks for
interpolated or multi-line strings (this overrides the global "backticks for strings" rule); and an
explicit `throw` on any missing required value, not only a missing env value. `deno fmt` is the
arbiter.

## Dependencies

**Pin exactly. Never `^`, never `~`, never a floating tag.** The lockfile is committed. A version
bump is its own commit with scope `deps`, and it states the reason. Pins live in the root
`deno.jsonc` import map, with two exceptions: `email/deno.json` pins `nodemailer`, and the
IndexedDB tests import `npm:fake-indexeddb@<version>` inline, so a bump of it edits each of them
(`grep -rl npm:fake-indexeddb@`).

Adding an import-map entry is a root-file change: it needs the issue number that needs the
dependency in the PR body. No speculative entries.
