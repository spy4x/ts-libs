# `@ts-libs/platform`

Universal, server and browser helpers extracted from seven repositories into one cohesive package.
No framework, no domain types, no validator.

```bash
deno add jsr:@ts-libs/platform
```

```ts
import { formatDecimal, ok } from "@ts-libs/platform"
import { makeStorage } from "@ts-libs/platform/browser"
import { atomicWriteJson, denoFileSystem } from "@ts-libs/platform/server"
```

## Module map

Three subpaths, split by _where the code can run_ — the split the source repo lacked, where one
762-LOC `helpers.ts` mixed `globalThis.atob`, `self.location` and PBKDF2 and was imported by both
the browser and the API.

### `.` → `universal.ts` (11 modules, 906 LOC)

Runs in Deno, a browser, a worker and an SSR pass. The only host APIs touched are `Date`, `Intl`,
`Math`, `TextEncoder`, and the `setTimeout` / `clearTimeout` pair that `universal/async` uses (it
`unref`s the handle where the runtime provides one). No `crypto` calls and no DOM global: the
browser- and server-only halves are the other two subpaths.

| Module                     | Contents                                                                                                   |
| -------------------------- | ---------------------------------------------------------------------------------------------------------- |
| `universal/async`          | `sleep`, `debounce` (cancelable, unref'd)                                                                  |
| `universal/concurrency`    | `AsyncMutex` (fair FIFO)                                                                                   |
| `universal/axis`           | `niceStep`, `ticks` — the one home for chart tick maths                                                    |
| `universal/constants`      | `DEFAULT_DEBOUNCE_DELAY`, `DEFAULT_FLUSH_INTERVAL_MS`, `MIN_PASSWORD_LENGTH`                               |
| `universal/errors`         | `ErrType`, `Err`, `ValidationError`, `ConnectionError`, `ServerError`, `OperationState`, `OperationResult` |
| `universal/format-number`  | `round`, `formatDecimal`, `formatPct`                                                                      |
| `universal/result`         | `Result`, `ok`, `err`, `unwrap`, `unwrapOr`, `CommandEnvelope`                                             |
| `universal/schema`         | `InferSchema` — the only arktype type helper this package needs                                            |
| `universal/text`           | `search`, `pluralize`, `convertToKebabCase`, `levenshtein`, `similarity`, `utf8ByteLength`                 |
| `universal/time`           | `TimeFormatter`, `formatTime`, `timeAgo`, `getDaysOfWeek`, `isValidDate`, `normalizeCalendarDate`          |
| `universal/time-constants` | `ONE_MONTH_IN_MILLISECONDS` and friends                                                                    |

`universal/csv` and `mapConcurrent` (formerly in `universal/concurrency`) were removed: `@std/csv`
and `@std/async`'s `pooledMap` already cover them, and no app in this workspace imported either.

**`universal/axis` is the single home for the chart tick maths**, ported from and matched against
`preact-components/charts/scales.ts`. `preact-components` does not import it yet — that is a
pending PR in that repository, `spy4x/preact-components#123` — so today the two copies still exist
side by side; this module is written so that import can be a straight substitution once it lands.
`niceStep`/`ticks` deliberately match the reference on every case tested against it, including three
that used to differ from it here: reversed bounds are swapped rather than returned as given
(`ticks(10, 0)` equals `ticks(0, 10)`), a non-finite bound returns an empty axis instead of
throwing, and a tick target that is `0`, negative or `NaN` falls back to the default of `5` instead
of throwing. All three are deliberate: a chart's tick target and domain both come from data or
layout math that can transiently be bad, and a chart needs an empty or default-shaped axis to keep
rendering, not an exception that takes the rest of the component down. `niceStep`/`ticks` in
`axis.test.ts` pin all three against values taken from running the reference.

One case has no reference to copy: `ticksForStep`'s loop used to run `steps + 1` times while
`MAX_TICKS` capped only the output array, so `ticks(1_000_000, 2_000_000, 1e25)` never returned — an
absurd tick target makes the step many orders of magnitude smaller than the float precision at that
range's magnitude, so the output stops growing almost immediately while the loop still has `1e25`
iterations ahead of it. `preact-components/charts/scales.ts` has the exact same defect and does not
return either, so this is not a case of matching the reference. The fix bounds the loop itself at
`Math.min(steps + 1, MAX_TICKS)`, not just the output, and the decision for what an absurd target
should produce is a chart's, not the reference's: return whichever ticks distinguish themselves
within `MAX_TICKS` iterations — as few as one — rather than freeze the page. `MAX_TICKS` is exported
so `axis.test.ts` can assert against it, and a regression tripwire inside the loop throws fast if the
bound is ever weakened back to plain `steps + 1`, so a future revert of the fix fails a test instead
of hanging the suite.

### `./browser` → `browser.ts` (2 modules, 223 LOC)

Needs a DOM-ish runtime. **Nothing here reads a global at import time** — `makeStorage` and
`downloadResponseAsFile` both take their DOM surface (`Storage`, `document`, the object-URL
factory) as a parameter, defaulting to the real global only when the caller passes none.

| Module             | Contents                                                                            |
| ------------------ | ----------------------------------------------------------------------------------- |
| `browser/download` | `downloadResponseAsFile`, `DownloadOptions`, `DownloadDocument`, `ObjectUrlAdapter` |
| `browser/storage`  | `makeStorage`, `memoryStorage`, `StorageLike`, `TypedStorage`                       |

`browser/download` moved here from `@ts-libs/server/export-client`: it is a browser download
helper (`document`, an object URL) that has nothing to do with a server, and it pairs with the
download response `@ts-libs/server/export` builds without either package importing the other.

`browser/base64` (`@std/encoding`'s `decodeBase64Url` covers it, and already used by
`platform/tokens.ts`) and `browser/dropdown` (an 11-line rule that is the dropdown component's own
business, in `preact-components`) were removed.

### `./server` → `server.ts` (6 modules, 723 LOC)

Needs a filesystem. Every module takes a port (`FileSystemPort`, `ClockPort`, `TimerPort`) instead
of calling `Deno.*` directly, because the root `test` task grants `--allow-read --allow-env` and
**no `--allow-write`**. The decision logic — what to write, when to flush, which entry to skip — is
tested against an in-memory fake.

Only two objects in this subpath touch `Deno` anyway: `denoFileSystem`, `denoByteReader`
(`server/deno-fs.ts`), and `Deno.pid` as the temp-file uniquifier default in
`server/throttled-saver.ts`. Of `denoFileSystem`'s **9 methods**, three are covered by
`server/deno-fs.test.ts` under the read-only grant — `exists`, `readText`, `readDir` (including its
`isNotFound` mapping and the `NotADirectory` rethrow) — and the `exists`/`readText`/`readDir`
rethrow branches are reached via `ENOTDIR`. `denoByteReader` is covered separately (chunk-size
independence and a missing-file rethrow). **Not covered, and not coverable under this grant:**
`writeText`, `appendText`, `rename`, `mkdirp`, `lock` (which opens `create: true, write: true`), and
the successful branch of `remove` — the calls that actually need `--allow-write`.

| Module                   | Contents                                               |
| ------------------------ | ------------------------------------------------------ |
| `server/atomic-json`     | `readJsonFile`, `tempPathFor`, `atomicWriteJson`       |
| `server/deno-fs`         | `denoFileSystem`, `denoByteReader` (the Deno adapters) |
| `server/file-lock`       | `FileLock`, `LockState`, `LockUnavailableError`        |
| `server/jsonl-logger`    | `JsonlLogger`, `formatLogLine`, `parseLogLines`        |
| `server/ports`           | the port interfaces, `systemClockPort`                 |
| `server/throttled-saver` | `ThrottledJsonSaver`, `TimerPort`, `systemTimerPort`   |

`server/walk` (`@std/fs`'s `walk` covers it) and `server/hash-file` (`@std/crypto` already hashes a
stream, and nothing in this workspace called `sha256OfStream`) were removed, along with the
`platform/scripts/memory-probe.ts` script that measured `hash-file`'s buffering — a script is not a
module and would have shipped with the package.

Not in this package, deliberately: `cqrs`, `types`, `cache`, `config`, `uuid`, `rate-limit` (owned
by `@ts-libs/*` template modules or issue #4), money/currency helpers (their own issue), and
anything Preact- or DOM-component-shaped.

`cache` includes `gb`'s `publicAPICache` registry (`buildMethods` / `CacheTTL`) and its
`redis.expiretime` re-verification on read. `spy4x/template` already ships `libs/platform/cache`
with `CacheService` and `ICacheStorage`, so neither is duplicated here; the registry and the
expiretime re-check belong in that module.

## The error vocabulary and the result convention

Three shapes, three jobs. They are not interchangeable, and picking the wrong one is the most common
source of "why is this error a string" regret.

| Shape                         | Where it belongs                                             | Error type                |
| ----------------------------- | ------------------------------------------------------------ | ------------------------- |
| `Result<T, E>` / `ok` / `err` | inside a function body, failure expected and not exceptional | whatever the caller names |
| `OperationResult<T, E>`       | an operation whose failure the UI renders                    | a typed `AnyError`        |
| `CommandEnvelope<T>`          | a CLI command or job crossing a process boundary             | `string`                  |

```ts
const parsed = JSON.parse(raw) // throws: malformed input is a programming error
const result: Result<number> = tryParse(text) // returns: malformed input is expected
```

`ErrType` is the discriminant. `ValidationError` is **re-exported** from `@ts-libs/validation`, not
redeclared: this package does not own a validation model.

## Dependency on `@ts-libs/validation`

`@ts-libs/platform` depends on `@ts-libs/validation` for exactly two things: the `ValidationError`
type (`universal/errors`) and the `validate(schema, value)` call behind
`makeStorage(..., { schema })`. There is **one** `validate` and **one**
`{ description, details }` envelope in the ecosystem, and it lives there.

Consequences a consumer should know:

- **Peer dependency.** Both packages are workspace members, so `deno check` resolves
  `@ts-libs/validation` with no `imports` entry here. Consuming from JSR or from a repo where
  `validation/` is absent means adding that member first — the import is not optional, and until it
  resolves `deno check` reports `TS2307: Import "@ts-libs/validation" not a dependency` at
  `platform/universal/errors.ts` and `platform/browser/storage.ts`.
- This package ships **no** schema-parser adapter (no object exposing both a throwing parse and a
  non-throwing variant), no schema library of its own, and no second envelope. The source's
  `validate()` ran the parse twice (`gb/libs/shared/helpers.ts:147-185`); the bug is retired by not
  porting the function at all — `@ts-libs/validation` parses once.
- Validation is applied on **write** as well as read in `makeStorage`. A value that fails its own
  schema on read is evicted, because a stored value that no longer matches is stale, not missing.
- **Strictness is the caller's schema's decision, never this package's.** `@ts-libs/validation`
  deliberately does not call `configure({ onUndeclaredKey: ... })`, so nothing here reads or writes
  global arktype config either. A schema without that setting keeps an undeclared key, exactly as
  arktype defaults; a caller that wants unknown keys rejected writes
  `schema.onUndeclaredKey("reject")` on its own schema. Both halves are pinned by tests in
  `browser/storage.test.ts`.

## Servers, clocks and timers are injected

Nothing here reads `Date.now()` outside `systemClock` (and `systemClockPort` on the server side),
and nothing writes a file outside a `FileSystemPort`. That is what makes the suite deterministic and
what makes it runnable under the root test task's permission grant. Two consequences:

- `formatTime` and `timeAgo` need an explicit `timeZone` and `clock` to be reproducible. Use
  `new TimeFormatter({ timeZone, clock })` in tests; the one-off `formatTime(date, options)` accepts
  the same fields.
- `ThrottledJsonSaver.flush()` is the deterministic exit point. `markDirty()` may start a detached
  write, and `flush()` waits for it before deciding whether another write is needed.

## Out of scope

- Money and currency (see the dedicated issue).
- `cqrs`, `types`, `cache`, `config`, `uuid` — already template modules; not re-extracted.
- `rate-limit` — issue #4.
- Preact components and anything that renders markup.
