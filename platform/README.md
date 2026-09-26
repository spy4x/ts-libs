# `@spy4x/platform`

Universal, server and browser helpers extracted from seven repositories into one cohesive package.
No framework, no domain types, no validator.

```bash
deno add jsr:@spy4x/platform
```

```ts
import { formatDecimal, ok } from "@spy4x/platform"
import { makeStorage } from "@spy4x/platform/browser"
import { atomicWriteJson, denoFileSystem } from "@spy4x/platform/server"
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

| Module                      | Contents                                                                                                                                                                                                                       |
| --------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ |
| `universal/async`           | `sleep`, `debounce` (cancelable, unref'd), `backoffDelay` (capped, jittered backoff delay)                                                                                                                                     |
| `universal/concurrency`     | `AsyncMutex` (fair FIFO)                                                                                                                                                                                                       |
| `universal/axis`            | `niceStep`, `ticks`, `stepAxis`, `StepAxis`, `MAX_TICKS` — the one home for chart tick maths                                                                                                                                   |
| `universal/constants`       | `DEFAULT_DEBOUNCE_DELAY`, `DEFAULT_FLUSH_INTERVAL_MS`, `MIN_PASSWORD_LENGTH`                                                                                                                                                   |
| `universal/csv`             | `CsvCellValue`, `CsvColumn`, `csvField`, `csvRow`, `csvHeaderRow`, `toCsvText`, `CSV_BYTE_ORDER_MARK`, `toCsvBytes` — RFC 4180 writer with a formula-injection guard                                                           |
| `universal/errors`          | `ErrType`, `Err`, `ValidationError`, `ConnectionError`, `ServerError`, `PayloadError`, `StoreError`, `RequestError`, `ResponseError`, `connectionError`, `responseError`, `isSilentError`, `OperationState`, `OperationResult` |
| `universal/format-number`   | `round`, `formatDecimal`, `formatPct`                                                                                                                                                                                          |
| `universal/key-value-store` | `KeyValueStore` — a dependency-free port, the one home for it and for `browser/storage`'s deprecated `StorageLike` and `@spy4x/realtime`'s deprecated `KeyValueStore` alias (#71)                                              |
| `universal/money`           | `currencyDecimals`, `formatMoney`, `formatMoneyParts`, `moneyDecimalString`, `parseMoney` — money as a smallest-unit integer, parsed and formatted without a float step                                                        |
| `universal/result`          | `Result`, `ok`, `err`, `unwrap`, `unwrapOr`, `CommandEnvelope`                                                                                                                                                                 |
| `universal/schema`          | `InferSchema` — the only arktype type helper this package needs                                                                                                                                                                |
| `universal/text`            | `searchWords`, `search`, `filterRows`, `pluralize`, `convertToKebabCase`, `levenshtein`, `similarity`, `utf8ByteLength`                                                                                                        |
| `universal/time`            | `TimeFormatter`, `formatTime`, `timeAgo`, `getDaysOfWeek`, `isValidDate`, `normalizeCalendarDate`                                                                                                                              |
| `universal/time-constants`  | `ONE_MONTH_IN_MILLISECONDS` and friends                                                                                                                                                                                        |

The old one-line CSV splitter and `mapConcurrent` (formerly in `universal/concurrency`) were
removed in 1.0: `@std/csv` and `@std/async`'s `pooledMap` already cover them. `universal/csv` is now
a different module, a writer (1.3.0), because `@std/csv` has no formula-injection guard.

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

`stepAxis(min, max, step)` (1.4.0) is for a caller that has already chosen its step: it rounds the
bounds outward to multiples of the step and returns them with the ticks between them, rounded by the
same rule, so the first and last tick are exactly the bounds. It exists so `preact-components`'
`niceScale` can drop its own copy of the tick loop (#201). The same release fixed tick rounding for
a step with more than one significant digit: `ticks(0, 10, 4)` returned `[0, 3, 5, 8, 10]` and now
returns `[0, 2.5, 5, 7.5, 10]`.

### `./browser` → `browser.ts` (3 modules, 312 LOC)

Needs a DOM-ish runtime. **Nothing here reads a global at import time** — `getCookie`, `makeStorage`
and `downloadResponseAsFile` all take their DOM surface (`document`, `Storage`, the object-URL
factory, a timer) as a parameter, defaulting to the real global only when the caller passes none.

| Module             | Contents                                                                                                                          |
| ------------------ | --------------------------------------------------------------------------------------------------------------------------------- |
| `browser/cookie`   | `getCookie`                                                                                                                       |
| `browser/download` | `downloadResponseAsFile`, `DownloadOptions`, `DownloadDocument`, `ObjectUrlAdapter`, `TimerAdapter`                               |
| `browser/storage`  | `makeStorage`, `memoryStorage`, `StorageLike` (deprecated alias of `universal/key-value-store`'s `KeyValueStore`), `TypedStorage` |

`browser/cookie` fixes two bugs in the `getCookie` copies apps carried before it had a home here: it
splits `document.cookie` instead of building a `RegExp` from the cookie name (a name containing `.`
or `[` no longer over-matches or crashes), and it returns `null` when there is no `document` instead
of throwing.

`browser/download` moved here from `@spy4x/server/export-client`: it is a browser download
helper (`document`, an object URL) that has nothing to do with a server, and it pairs with the
download response `@spy4x/server/export` builds without either package importing the other.

`browser/base64` (`@std/encoding`'s `decodeBase64Url` covers it, and already used by
`platform/tokens.ts`) and `browser/dropdown` (an 11-line rule that is the dropdown component's own
business, in `preact-components`) were removed.

### `./server` → `server.ts` (7 modules)

Deno-only helpers. Every filesystem module takes a port (`FileSystemPort`, `ClockPort`, `TimerPort`)
instead of calling `Deno.*` directly, because the root `test` task grants `--allow-read --allow-env`
and **no `--allow-write`**. The decision logic — what to write, when to flush, which entry to skip —
is tested against an in-memory fake.

Only these touch `Deno` anyway: `denoFileSystem` and `denoByteReader` (`server/deno-fs.ts`),
`Deno.pid` as the temp-file uniquifier default in `server/throttled-saver.ts`, and the
`Deno.addSignalListener`/`Deno.removeSignalListener` defaults of `shutdownSignal`
(`server/shutdown-signal.ts`), which its tests replace with fakes. Of `denoFileSystem`'s **9
methods**, three are covered by `server/deno-fs.test.ts` under the read-only grant — `exists`,
`readText`, `readDir` (including its `isNotFound` mapping and the `NotADirectory` rethrow) — and the
`exists`/`readText`/`readDir` rethrow branches are reached via `ENOTDIR`. `denoByteReader` is
covered separately (chunk-size independence and a missing-file rethrow). **Not covered, and not
coverable under this grant:** `writeText`, `appendText`, `rename`, `mkdirp`, `lock` (which opens
`create: true, write: true`), and the successful branch of `remove` — the calls that actually need
`--allow-write`.

| Module                   | Contents                                               |
| ------------------------ | ------------------------------------------------------ |
| `server/atomic-json`     | `readJsonFile`, `tempPathFor`, `atomicWriteJson`       |
| `server/deno-fs`         | `denoFileSystem`, `denoByteReader` (the Deno adapters) |
| `server/file-lock`       | `FileLock`, `LockState`, `LockUnavailableError`        |
| `server/jsonl-logger`    | `JsonlLogger`, `formatLogLine`, `parseLogLines`        |
| `server/ports`           | the port interfaces, `systemClockPort`                 |
| `server/shutdown-signal` | `shutdownSignal`, `ShutdownSignalError`                |
| `server/throttled-saver` | `ThrottledJsonSaver`, `TimerPort`, `systemTimerPort`   |

`server/shutdown-signal` turns `SIGINT` and `SIGTERM` into one `AbortSignal` for a worker loop
(#187). It aborts once, on the first signal, with a `ShutdownSignalError` whose `signal` names it,
and removes every listener it added, so a second Ctrl+C ends the process the default way. A parent
`signal` option lets a caller that stops for another reason remove the listeners too. The listener
pair is injectable, so the tests fire fake signals. A listener whose removal throws does not stop
the others from being removed or the signal from aborting; the error goes to an `onError` option
(default `console.error`), because a throw from inside a signal callback would end the process
before the worker's cleanup finishes. The default list works on Windows with Deno 2.7.6 or later,
where `SIGTERM` fires on logoff and system shutdown.

`server/walk` (`@std/fs`'s `walk` covers it) and `server/hash-file` (`@std/crypto` already hashes a
stream, and nothing in this workspace called `sha256OfStream`) were removed, along with the
`platform/scripts/memory-probe.ts` script that measured `hash-file`'s buffering — a script is not a
module and would have shipped with the package.

Not in this package, deliberately: `types`, `config`, `uuid`, `rate-limit` (owned by `@spy4x/*`
template modules or issue #4), money/currency helpers (their own issue), and anything Preact- or
DOM-component-shaped.

### `./cqrs` → `cqrs/mod.ts` (4 modules)

An in-process command bus, query bus and event bus, ported from `template/libs/platform/cqrs`
(cross-checked against `financy/libs/shared/cqrs`, which differs only in comments — the two are the
same code). `~/sync/code/gb` was not present in this checkout, so it could not be compared; issue
#75 names it as a possible third source and this is recorded here in case a later PR finds one.

| Module             | Contents                                                           |
| ------------------ | ------------------------------------------------------------------ |
| `cqrs/command-bus` | `CommandBus` — one handler per command class                       |
| `cqrs/query-bus`   | `QueryBus` — same shape, kept a distinct type from the command bus |
| `cqrs/event-bus`   | `EventBus` — publish/subscribe, delivered on a microtask           |
| `cqrs/types`       | `Command`, `Query`, `Event` and their constructor/handler types    |

`EventBus.emit` isolates listeners from each other: the source's `for` loop let the first listener
that threw abort every listener after it, and the throw surfaced as an uncaught exception inside
the microtask `emit` schedules it on. Here a listener failure — a synchronous throw or a rejected
returned promise — is reported through a constructor-supplied `onListenerError` (`console.error` by
default) instead. `once` also used to leak a subscription when its listener threw, because the
source unsubscribed _after_ calling the listener; here the unsubscribe runs first.

### `./cache` → `cache/mod.ts` (1 module)

A JSON cache in front of a pluggable `ICacheStorage`, ported from `template/libs/platform/cache`
(cross-checked against `financy/libs/shared/cache`, which differs from the template only in using a
hardcoded `number` id instead of `string | number`, and lacking the date-reviving `JSON.parse`
reviver — template's is kept, made opt-in). `ICacheStorage`'s method names and meaning are unchanged
from the source: `server/kv`, a later unit of the same wave, implements it over Redis.

Four behaviour changes, all because this package ships to consumers it does not control, unlike an
app's own `libs/`:

- The date-reviving reviver (a property named `...At` holding an ISO string becomes a `Date`) is
  opt-in (`reviveIsoDatesEndingInAt`, passed via `CacheServiceOptions.reviver`), not applied to
  every cached value unconditionally. The unconditional version also fires on any field that merely
  ends in "At" without meaning a date.
- `set`/`wrap`'s TTL is named and typed as seconds throughout. The source's `ICacheService`
  interface named the parameter `ttlMs` while every implementation and caller treated it as seconds
  with no conversion — a caller trusting the interface's name and passing milliseconds would get a
  cache entry roughly 1000x longer-lived than intended.
- A TTL is validated and rounded up to a whole second before it reaches storage. Redis refuses a
  fractional or zero expiry — `SET … EX 0.2` and `SET … EX 0` are both errors, and `EXPIRE key 0`
  deletes the key immediately — so this is done here, once, rather than in every `ICacheStorage`.
- `wrap` coalesces an in-flight `fn()` call for a key: a caller that reads the cache while another
  caller's `fn()` for the same key is still running awaits that same call instead of starting its
  own. Two different keys never share a call.

No in-memory `ICacheStorage` ships from this package, matching the source: its own fake
(`MemoryCacheStorage`) lived in its test file, not as a library export, and stays that way here too.

An earlier draft of this section said `gb` re-verifies `redis.expiretime` on read, on top of its own
`buildMethods`-shaped registry. That could not be confirmed here — `~/sync/code/gb` was not present
in this checkout (see the `cqrs` section above) — so whoever next extracts from `gb`, if it turns
out to have one, should check for that re-verification and decide whether `server/kv` needs it too.

### `./signed-payload` → `signed-payload.ts` (1 module)

`createSignedPayloadCodec` signs and verifies a purpose-bound, versioned JSON payload with
HMAC-SHA-256: a pagination cursor, an unsubscribe link. The purpose, the version and an optional
expiry are signed with the payload, and an optional bound context (a user id, an email address) is
covered by the signature without being carried in the token. `verify` checks the signature before it
parses anything, validates the payload with an arktype schema, and returns a `Result` whose error is
a `SignedPayloadErrorCode`; it never throws for any token string. `sign` refuses what `verify` would
refuse. A separate subpath from `./tokens` because it needs arktype at runtime (#202).

### `./model`, `./api`, `./request-info` — the shared API, model and push types

Moved from `template/libs/platform/types/+index.ts` and its two request helpers, part of the
template's shared surface the 2026-09-23 decision in issue #77 moved into this package instead of
recopying it into every product. Three directories, split the same way `./browser` and `./server`
already are — by where the code can run:

| Directory       | Contents                                                                                                                                                                        |
| --------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `model/`        | `dateSchema`/`DateNullableSchema`, the `ImmutableBaseModelSchema`/`UndeletableBaseModelSchema`/`BaseModelSchema` tiers, and the Web Push wire schemas — universal, arktype only |
| `api/`          | `ApiError`, `ApiResult<T>`, `apiFetch` — browser-only, needs `fetch`                                                                                                            |
| `request-info/` | `RequestInfo`, `requestInfoFromContext` — server-only, needs Hono                                                                                                               |

**Six bugs fixed at extraction time**, three in the request helpers and three in `model/`:

- `apiFetch` (`api/api.ts`) built its request as `{ headers: { "content-type": ..., ...init.headers },
  ...init }`. Spreading `init` last meant a caller's own `headers` replaced the whole merged object
  instead of adding to it — passing `headers: { authorization }` silently dropped `content-type`.
  Fixed by merging into one `Headers` instance first, so the caller's headers add to the default, the
  caller's own `content-type` wins, and every other `init` field still reaches `fetch` unchanged.
- `apiFetch` also always sent `content-type: application/json`, even when `body` was a `FormData`
  (#132): the request reached the server without a multipart boundary and the caller had no way to
  remove the header. Fixed by applying the default only when `body` is a string or absent; a
  `FormData`, `URLSearchParams`, `Blob`, `ArrayBuffer`/typed array, stream, or explicit `null` body is
  left without a default so `fetch` sets its own.
- `requestInfoFromContext` (`request-info/request-info.ts`) read `X-Forwarded-For` off the request
  unconditionally, so any client could set its own value and have it logged as its IP. Fixed by
  routing it through `rate-limit/client-ip.ts`'s `clientIp`, which already carries this exact trust
  boundary for the rate limiter — untrusted by default, and a `trustedProxy` option the caller opts
  into behind a proxy that actually rewrites the header. `trustedProxy` also accepts a single
  `TrustedProxyHeader` name (`"cf-connecting-ip" | "x-forwarded-for" | "x-real-ip"`, re-exported from
  this module) instead of `true`, for a proxy that rewrites only one of the three — see
  `rate-limit/README.md`'s trust-boundary section for which header Traefik, Cloudflare and nginx
  each write. The helper also no longer imports the
  template's `APIContext`; it takes a plain, `Env`-generic Hono `Context` and reads `requestId` off
  the context variables defensively, matching how `rate-limit/hono.ts` stays app-agnostic. `ip`
  (and `userAgent`) stay unset when nothing identifies the client, exactly as the source left them
  — `clientIp`'s placeholder address is a made-up value, not a real one, and the source itself
  wrote `request.ip || null` into an audit row, so surfacing that placeholder here would have
  logged it as though it were real.
- `dateSchema` (`model/date.ts`) accepted an ISO date string whose calendar day did not exist —
  `"2026-02-30"` parsed to 2 March 2026 instead of being refused, because `new Date(...)` silently
  rolls an out-of-range day or month into the next one (#131). Fixed by refusing a string `new Date`
  cannot read, then rebuilding the date from the string's own `YYYY-MM-DD` digits and comparing it
  back against them; a year, or a year and month, parses as the source parsed it. A date written
  without dashes is refused, because V8 reads its digits as a year.
- `dateSchema` also accepted two ISO 8601 shapes that `new Date` reads as a different date, with no
  error (#136): an ordinal date (`"2024-005"`, 5 January, became 1 May) and a year with a sign
  (`"-0001-01-01"` became 2001, `"+0099-12-31"` became 1999). Both shapes are now refused, even
  where V8 happens to read them right (`"2024-001"`, `"+2024-01-01"`). `JSON.stringify` never
  writes an ordinal date, and writes a signed year only with six digits, which was already refused.
- `dateSchema` also read a date-time string with a time but no offset and no `Z`, such as
  `"2024-02-29T10:00:00"`, in the host's own time zone (#135): the same wire string parsed to a
  different instant on a laptop and on a UTC server. Fixed by refusing that shape, with its own
  message ("must name a time zone: …") rather than the calendar-date one. A date-only, year, or
  year-month string is unaffected — ECMA-262 already reads those as UTC regardless of host `TZ`.

**Every exported schema declares its type.** JSR refuses an exported constant whose type is only
inferred, so each schema in `model/` carries an explicit arktype `Type<…>` annotation (#141). The
annotation spells out what arktype infers: `dateSchema` is `Type<Date | ((In: string) => Out<Date>)>`,
a pipe from a string to a `Date`, and a field with a default is `Default<T, V>`, imported from
`arktype/internal/attributes.ts` because arktype's main entry point does not export it.
`model/types.test.ts` fails to compile if `DateType`, `BaseModel`, a push type, or the input a
schema accepts changes.

**The `"+": "reject"` decision splits by whether a schema is composed.** `model/base-model.ts`'s
three schemas declare it on none of them: an app is meant to `.and()` its own fields onto
`BaseModelSchema`, and arktype resolves `"+": "reject"` at intersection time by making every key
the left side does not already declare resolve to `never` on that side — declaring it there breaks
composition immediately, even inside `base-model.ts` itself (confirmed by constructing that
composition directly: `ParseError: Intersection at updatedAt of never and Date results in an
unsatisfiable type`). `model/push.ts`'s five wire schemas all declare it, at every object level
including the nested `keys`: none of them is ever composed further, they are the whole shape a
server receives from a browser it does not control, and nesting a `"+": "reject"` schema as another
object's _property_ (as `keys` sits inside `pushSubscriptionSchema`) does not carry the same hazard
as intersecting one in with `.and()` — confirmed the same way, by constructing it and reading the
result.

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

`ErrType` is the discriminant. `ValidationError` is **re-exported** from `@spy4x/validation`, not
redeclared: this package does not own a validation model.

## `KeyValueStore` has one home, in `universal/`

`browser/storage.ts`'s `StorageLike` and `@spy4x/realtime`'s `KeyValueStore` were identical
three-method duplicates (#71). The home is the new `universal/key-value-store.ts`, not either of
the two packages that used to carry a copy: it has no import of its own, so nothing that only needs
this shape (a browser store, a realtime cursor, a server-side fallback) pulls in anything else.

The first attempt at this made `@spy4x/platform` depend on `@spy4x/realtime` — a `import type`
only, but JSR still records a type-only import as a package dependency, and a second, unrelated #71
PR (`realtime/backoff.ts` importing `@spy4x/platform/universal/async`) turned that into a
publish-time circular dependency between the two packages. `platform/deno.json` exports the new
file as `./universal/key-value-store` precisely so `@spy4x/realtime` (and any other consumer) can
import it without going through the bare `@spy4x/platform` specifier, which would otherwise also
pull in `@spy4x/validation` through `universal/errors.ts`.

## Dependency on `@spy4x/validation`

`@spy4x/platform` depends on `@spy4x/validation` for exactly two things: the `ValidationError`
type (`universal/errors`) and the `validate(schema, value)` call behind
`makeStorage(..., { schema })`. There is **one** `validate` and **one** validation error envelope
(`type`, `message`, per-field `errors`, `description` and `details`) in the ecosystem, and it lives
there. `ErrType` is declared there too and re-exported from `universal/errors`, because
`@spy4x/validation` cannot import this package without a package cycle.

Consequences a consumer should know:

- **Peer dependency.** Both packages are workspace members, so `deno check` resolves
  `@spy4x/validation` with no `imports` entry here. Consuming from JSR or from a repo where
  `validation/` is absent means adding that member first — the import is not optional, and until it
  resolves `deno check` reports `TS2307: Import "@spy4x/validation" not a dependency` at
  `platform/universal/errors.ts` and `platform/browser/storage.ts`.
- This package ships **no** schema-parser adapter (no object exposing both a throwing parse and a
  non-throwing variant), no schema library of its own, and no second envelope. The source's
  `validate()` ran the parse twice (`gb/libs/shared/helpers.ts:147-185`); the bug is retired by not
  porting the function at all — `@spy4x/validation` parses once.
- Validation is applied on **write** as well as read in `makeStorage`. A value that fails its own
  schema on read is evicted, because a stored value that no longer matches is stale, not missing.
- **Strictness is the caller's schema's decision, never this package's.** `@spy4x/validation`
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
- `types`, `config`, `uuid` — still template modules; not re-extracted here.
- `rate-limit` — issue #4.
- Preact components and anything that renders markup.
