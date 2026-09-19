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
