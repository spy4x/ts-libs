# @ts-libs/ops

Operational clients: standalone outbound notifiers. Zero dependencies.

This package is owned by two issues. **`#16` created it and lists only the `notify/` entry points
below. `#18 ops/` must merge its own exports into `exports` in `ops/deno.json` and its own section
into this file — it must not replace either.** `#18` owns the backup contract, offline-backup, deploy
and age64 env.

## Entry points

| Export                  | What it is                                                  |
| ----------------------- | ----------------------------------------------------------- |
| `./notify`              | Barrel for everything below.                                |
| `./notify/healthchecks` | `HealthchecksClient`, `healthchecksConfigFromEnv`, outcomes |
| `./notify/ntfy`         | `NtfyClient`, `ntfyConfigFromEnv`, `NotificationSeverity`   |

Export targets are **package-relative** (`"./notify": "./notify/mod.ts"`), resolved against this
package directory. A repo-root-relative target (`"./ops/notify/mod.ts"`) resolves to
`ops/ops/notify/mod.ts` and makes every notifier unimportable by name — `deno publish --dry-run`
exits 1 with `TS2307`.

`#18` lists `./console`, `./env`, `./fs`, `./run-command`, `./hooks/install`, `./backup/types` and
`./backup/compose`. Those sets are disjoint, so whichever lands second must **union** the exports
rather than overwrite this file.

## `HealthchecksClient` — dead-man's switch

```ts
const client = new HealthchecksClient({ pingUrl })
const result = await client.ping({ outcome: HealthchecksOutcome.Fail, body: "3 of 5 failed" })
```

`Success` pings the base URL, `Fail` pings `<url>/fail`, `Start` pings `<url>/start`. `urlFor`
exposes the mapping.

**Config.** `HEALTHCHECKS_PING_URL` through `healthchecksConfigFromEnv(read?)`; `null` when unset.
The constructor throws on an empty URL. Nothing is read at module scope.

**Result.** `{ ok: true, httpStatus, attempts, body, waitedMs }` or
`{ ok: false, code, message, status?, attempts, waitedMs }`. The upstream resolved `void` and logged
its failures, so a caller could not tell a delivered ping from a dead endpoint.

**Retry policy.** 10 attempts, 60s doubling, capped at 5 minutes per wait. Measured schedule, not
estimated: waits run `1 + 2 + 4 + 5 + 5 + 5 + 5 + 5 + 5 = 37.0 minutes` (2,220,000 ms across 9
retries), which fits inside healthchecks.io's 1-hour grace window. A 10-minute per-wait cap gives
`1 + 2 + 4 + 8 + 10 + 10 + 10 + 10 + 10 = 65.0 minutes` and overruns the very window the cap exists
to respect. Both figures are asserted by the suite. `Retry-After` is honoured: the
provider rate-limits with `429` and the upstream ignored the header, hammering the endpoint on the
failures it was retrying. A total budget bounds the whole operation; it is set above the sum of the
waits, because a budget of exactly 10 minutes aborted after the 4th attempt and silently delivered 4
retries instead of the 10 the policy promises.

**Known debt: the retry core is a byte-identical copy, not shared code.** The reviewer accepted the
duplication **with an objection**, recorded here so the next person knows it is debt rather than a
settled design: the drift guard reads across a package boundary (`ops/notify/retry-drift.test.ts`
imports `../../integrations/retry.ts`), which is what makes `ops/notify/**` unlandable alone — #39 had
to merge before #50 for exactly this reason. A shared `libs/` module is the required end state, and
**a third copy will be rejected**. The duplication exists only because no shared ancestor directory
belongs to this issue; the mechanical guard keeps it honest in the meantime.

**No backup coupling.** Nothing here imports or references `BackupResult` or any backup type. A
notifier that only works while a backup runs is a notifier nobody can reuse.

## `NtfyClient` — failure-only push

```ts
const client = new NtfyClient({ baseUrl, topic, token })
const result = await client.notifyFailure("backup failed", "3 of 5 repositories failed")
```

**Failure-only by default.** `NotificationSeverity.Failure` is the gate; an `Info` push is a no-op
that still returns `{ ok: true, status: "skipped", reason: "below-gate", attempts: 0 }`, so the gate
is assertable. Callers that genuinely want success pushes pass `severity: Info`.

**Result.** `{ ok: true, status: "pushed", httpStatus, attempts, headers }`,
`{ ok: true, status: "skipped", … }`, or `{ ok: false, code, message, status?, attempts }`. The
returned `headers` are the headers as sent, so the transliteration is inspectable. The upstream
returned `void` and logged failures, so a dropped push looked like a delivered one.

**Config.** `NTFY_URL` and `NTFY_TOPIC` are required; `NTFY_TOKEN` is optional because a
self-hosted ntfy on a private network may not use auth. Read through `ntfyConfigFromEnv(read?)`,
which returns `null` when incomplete.

**Retry policy.** 5 attempts, 3s apart, honouring `Retry-After`, bounded by attempts and total
elapsed time.

## Header safety — the trap this package exists to carry

`Headers.set` rejects code points the platform will not accept in a header value, and the rejection
surfaces from inside `fetch` as an opaque `TypeError: Value is not a valid ByteString`. Two
different needs follow, and `mig` conflated them:

- A **header value** must be transliterated to printable ASCII. `toAsciiHeaderValue` maps the
  characters that matter for readability (`—` → `-`, `“` → `"`, `…` → `...`, non-breaking space →
  space) and replaces everything else — Latin-1 accents, Cyrillic, CJK, emoji — with `?`. Allowed
  header whitespace (HT, LF, CR, space) is preserved.
- A **message body** must be left alone. `mig` passed the body through the same sanitiser, so
  `Café ☕` reached ntfy as `Caf? ?` and every accented, Cyrillic, CJK and emoji payload was
  destroyed. Only headers are transliterated here.

`createAsciiHeaders` applies the transliteration to every value, so the failure cannot come back
through a new call site. Both halves are pinned by tests, including the body round-trip.

## Injectable transport

- **`fetcher?: typeof fetch`** — defaults to `globalThis.fetch`. No test performs a real request;
  the suite runs under `--allow-read --allow-env` with no `--allow-net`.
- **`sleep?: Sleeper`, `clock?: Clock`, `backoff?: BackoffFn`, `onDelay`** — backoff and elapsed
  time are injectable, so no test sleeps and none asserts on wall-clock time.
- **Secrets are constructor parameters**, never read from `$env` at module scope and never logged.

## Out of scope

- **Backup contract, offline-backup, deploy, age64 env, type-check** — `#18 ops/`, which extends this
  package's `exports` rather than replacing them.
- **Email, SMTP, webhooks, Slack, Mailchimp** — `@ts-libs/integrations`.
- **Gatus, VictoriaMetrics and the rest of the shared platform.** These clients talk to a provider;
  they do not run one.

# `@ts-libs/ops`

Deploy, git-hook and backup tooling as a **library with ports**, extracted from
`rostok` and `antonshubin.com` (issue #18).

## Why it lives here

`ops/` lives in this repository, with three constraints:

1. `@rostok/cli` keeps its **CLI** — an argument parser and command wiring are not
   library concerns. `jsr:@rostok/cli@1.0.3` is the published CLI; nothing
   CLI-only is duplicated here.
2. This package takes the **shared contract and the clients** — the
   `BackupConfig` contract, the hook installer, the deploy helpers — as a library
   with **ports**. No `Deno.args`, no `Deno.exit`, no `prompt()`, no TTY handling.
3. Every external process, filesystem write and network call goes through an
   injected port, because the workspace test task grants only `--allow-read` and
   `--allow-env`. The real adapters (`createDenoCommandRunner`,
   `createDenoFileSystem`, `systemEnv`) are thin and untested by design; the
   decision logic is tested against the fakes in `testing/`.

## Entry points

| Entry point                   | Contents                                                                                                                                              |
| ----------------------------- | ----------------------------------------------------------------------------------------------------------------------------------------------------- |
| `@ts-libs/ops/console`        | `Logger`, `createLogger`, `LogLevel`, `Clock`, `LogSink`                                                                                              |
| `@ts-libs/ops/run-command`    | `CommandRunner`, `runCommand`, `mustRun`, `CommandError`, argv builders                                                                               |
| `@ts-libs/ops/env`            | `EnvReader`, `createEnvReader`, `readEnvVar`, `absPath`, `substituteEnvVars`, `rewriteEnvValues`                                                      |
| `@ts-libs/ops/fs`             | `FileSystem`, `createDenoFileSystem`, `FileStat`, `DirEntry`, `isNotFound`                                                                            |
| `@ts-libs/ops/remote`         | `restartRemoteContainer`, `buildSshArgv`, name/path validation                                                                                        |
| `@ts-libs/ops/deploy`         | rsync/compose argv builders, `buildDeployPlan`, `deploy`, marker script generation, `parseDeployResults`, remote checksums, service worker cache bump |
| `@ts-libs/ops/hooks/install`  | `installHooks`, `resolveGitCommonDir`, `DEFAULT_HOOKS`                                                                                                |
| `@ts-libs/ops/backup/types`   | `BackupConfig`, `BackupStatus`, `isMissingContainerError`                                                                                             |
| `@ts-libs/ops/backup/compose` | `manageComposeStack` with the `up -d` fallback                                                                                                        |
| `@ts-libs/ops/offline-backup` | the external-drive cold-backup mechanics — see `ops/offline-backup/README.md`                                                                         |
| `@ts-libs/ops` (`.`)          | `mod.ts`: a barrel re-exporting the entries above except `offline-backup`                                                                             |

Those eleven entries are exactly what `ops/deno.json` exports; the five
`offline-backup` modules are reachable through the one `./offline-backup` barrel
and **not** as individual subpaths. `testing/` (`FakeCommandRunner`,
`FakeFileSystem`) is test support: not an entry point, and not exported.

## Rules this package follows

- **argv, never a shell string.** Commands are arrays: `ssh`/`rsync`/`docker`
  arguments are never joined into a string, and there is no `bash -c` in the
  package outside two doc comments.
- **The one piece of real shell text is generated, validated and quoted.**
  `deploy.ts`'s stack script is the exception, and it is treated as text, not as
  argv: it goes to `bash -s` on **stdin** (never `-c`), the app directory arrives
  as `$1`, and every value that comes from configuration is (a) refused unless it
  is a docker project name or a relative path and (b) single-quoted through
  `shellQuote` where it is interpolated. Both layers exist because the first
  version of this file asserted the property while only the app directory was
  actually kept out of the script: the reviewer of #50 ran `$(echo PWNED-*)` from
  a stack name, and the deploy reported `DEPLOY_SUCCESS` anyway.
- **Secrets never reach argv.** Env files are named by path (`--env-file`); a
  secret-shaped key **or value** in a remote env is refused before anything runs
  (`assertNoSecretEnvKeys`, value-shape rules included, with `allowEnvKeys` as the
  explicit escape hatch); and `runCommand` refuses any argv that contains a value
  the caller also passed in the child's environment. argv is readable by every
  process on the box; this is not a stylistic preference.
- **The command port is total.** `runCommand` converts a runner rejection — a
  missing binary, a `cwd` that does not exist — into `{ success: false, error }`,
  so a caller branching on `success` cannot be surprised by a launch failure. See
  "The adapter boundary" below for what that leaves untested.
- **The remote side is shell input, and is treated as such.** ssh joins its
  command arguments and hands the result to the remote login shell, so every
  remote argument is validated, the destination is validated _and_ preceded by
  `--` (a `SSH_ADDRESS` of `-oProxyCommand=…` would otherwise be local code
  execution), and container names must match docker's charset.
- **One logging convention**: `console.ts`. `ConsoleLogger`'s trick of replacing
  the global `console` methods to capture output is not reentrant and is not
  ported; `Logger.records()` is how offline-backup keeps its log file.
- **Nothing reads the environment at module scope**, so every module can be
  imported by a test, a CLI or another library without a populated environment.

## Not ported, and why

- `rostok/scripts/backup/src/{operations,config,reporting}.ts` — not a framework:
  no extension point, module-scope env reads, homelab semantics in the core
  (a `chown` for Syncthing, `HOME=/home/$USER`, a stack name regexed out of a
  path, restic retention 7/4/3) and 6 tests in total.
- `scripts/encryption/*` and `cli/age.ts` — template's `infra/scripts/env/age.ts`
  (age64, atomic writes, symlink refusal, mode bits) is stricter and is the
  sanctioned scheme.
- `ops/healthcheck.ts` — delivered as `server/healthcheck.ts` by #35.
- `rostok/scripts/ansible/inventory.ts`, `rostok/scripts/ssh/+main.ts`,
  `antonshubin.com/scripts/optimize-screenshots.ts` — CLIs and one-shot repo
  scripts with no library surface, or with dependencies this package does not want.

## Notes for a reviewer

- `ops/deno.json` lists only entry points that exist; add one when you add a file.
- `ops/notify/**` belongs to #16 (`integrations`) and is not touched here. If that
  PR lands after this one, **merge** the `exports` maps and append its README
  section rather than replacing either file.

## The adapter boundary

Two adapters touch the platform, and both are deliberately thin:
`createDenoCommandRunner` (`run-command.ts`) and `createDenoFileSystem` (`fs.ts`).

**Behind the port and tested**: argv assembly (`buildInvocation`, including the
`sudo` prefix), the stdin policy (`stdinModeFor`, including the refusal of
`sudo` + `stdin` text), multi-byte stream decoding (`decodeChunks`), the launch
failure → `{success: false}` conversion (`runCommand`, driven from a fake that
rejects), and the secret-in-argv rule.

**Inside the adapter, not tested here**: that `Deno.Command` actually spawns,
that `clearEnv` clears and `env` merges the inherited environment, `cwd`
handling, live `onOutput` chunking, `status.success` mapping, stdin piping into a
real child, and the `FileInfo` → `FileStat` mapping (`denoStat`, including
`lstat` not following a symlink and the `mode` bits). The workspace test task is
`deno test --no-prompt --allow-read --allow-env`, so reaching them needs
`--allow-run` and `--allow-write`, a root-config change this package does not own.

To exercise them without changing CI:

```bash
deno test --allow-run --allow-read --allow-env ops/run-command.integration.test.ts
deno test --allow-write --allow-read --allow-env ops/fs.integration.test.ts
```

Those two files are not in this PR: adding them means either granting the flags in
CI or shipping tests that CI cannot run, and neither is a decision a package PR
should take on its own. Until then the mapping above is the honest statement of
what is verified and what is assumed.
