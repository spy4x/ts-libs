# `@spy4x/platform`

Universal, server and browser helpers. No framework, no domain types, no validator.

```bash
deno add jsr:@spy4x/platform
```

Runs on: shared, with `./browser/*` for the browser and `./server/*` for Deno.

## Modules

Each module's usage is in its module doc, shown by `deno doc` and on JSR.

- [`@spy4x/platform`](universal.ts): Universal helpers only.
- [`@spy4x/platform/api`](api/mod.ts): The browser side of the API result convention.
- [`@spy4x/platform/browser`](browser.ts): Helpers that need a browser.
- [`@spy4x/platform/browser/build-env`](browser/build-env.ts): Reading build-time environment values in browser code.
- [`@spy4x/platform/browser/clipboard`](browser/clipboard.ts): Put text on the clipboard, with the legacy fallback an insecure origin still needs.
- [`@spy4x/platform/browser/cookie`](browser/cookie.ts): Read one cookie's value out of `document.cookie`.
- [`@spy4x/platform/browser/download`](browser/download.ts): Turn a `Response` body into a file the browser saves.
- [`@spy4x/platform/browser/embed`](browser/embed.ts): Helpers for a page that is framed by another site.
- [`@spy4x/platform/browser/geolocation`](browser/geolocation.ts): Ask the browser for the current position once, and route the answer to two callbacks.
- [`@spy4x/platform/browser/hotkeys`](browser/hotkeys.ts): Keyboard shortcuts.
- [`@spy4x/platform/browser/data-cache`](browser/data-cache.ts): A durable copy of the last data the server sent, so a page opens with it and shows it with no network.
- [`@spy4x/platform/browser/indexeddb`](browser/indexeddb.ts): The few IndexedDB plumbing pieces every durable browser store needs.
- [`@spy4x/platform/browser/last-sign-in`](browser/last-sign-in.ts): Remembers, in this browser, how a person last signed in.
- [`@spy4x/platform/browser/offline-shell`](browser/offline-shell.ts): App-shell cache for a service worker.
- [`@spy4x/platform/browser/passkey`](browser/passkey.ts): The browser half of passkeys.
- [`@spy4x/platform/browser/persistent-storage`](browser/persistent-storage.ts): Asks the browser not to evict this site's storage (IndexedDB, caches) when space runs low.
- [`@spy4x/platform/browser/push-notifications`](browser/push-notifications.ts): Web Push in a service worker.
- [`@spy4x/platform/browser/runtime-config`](browser/runtime-config.ts): Runtime configuration for a single-page app that is built once and configured at deploy time.
- [`@spy4x/platform/browser/signed-in-hint`](browser/signed-in-hint.ts): A small "this device was signed in" hint kept in `localStorage`, so an installed app can open offline to its last view instead of showing the sign-in page.
- [`@spy4x/platform/browser/storage`](browser/storage.ts): Typed `localStorage` / `sessionStorage` wrapper.
- [`@spy4x/platform/browser/testing`](browser/testing.ts): Test helpers for browser code.
- [`@spy4x/platform/cache`](cache/mod.ts): A JSON cache in front of a pluggable `ICacheStorage`.
- [`@spy4x/platform/cqrs`](cqrs/mod.ts): An in-process command bus, query bus and event bus.
- [`@spy4x/platform/keyset-cursor`](keyset-cursor.ts): Keyset pagination cursor.
- [`@spy4x/platform/model`](model/mod.ts): Arktype schemas for the shapes shared across products.
- [`@spy4x/platform/rate-limit`](rate-limit/mod.ts): Sliding-window rate limiting with a pluggable store.
- [`@spy4x/platform/rate-limit/client-ip`](rate-limit/client-ip.ts): Client IP extraction from the transport peer address and optional proxy headers.
- [`@spy4x/platform/rate-limit/hono`](rate-limit/hono.ts): Hono middleware factory over any limiter from `memory.ts`.
- [`@spy4x/platform/rate-limit/kv`](rate-limit/kv.ts): Shared-store limiter backend.
- [`@spy4x/platform/rate-limit/memory`](rate-limit/memory.ts): Sliding-window rate limiter with an injected clock and bounded memory.
- [`@spy4x/platform/request-info`](request-info/mod.ts): Request metadata for a log line or an error report, built from a Hono context.
- [`@spy4x/platform/server`](server.ts): Server helpers.
- [`@spy4x/platform/server/atomic-json`](server/atomic-json.ts): Atomic JSON persistence.
- [`@spy4x/platform/server/deno-fs`](server/deno-fs.ts): `denoFileSystem`, the `Deno`-backed implementation of `FileSystemPort`.
- [`@spy4x/platform/server/file-lock`](server/file-lock.ts): Exclusive file lock built on the port's lock primitive.
- [`@spy4x/platform/server/interval-runner`](server/interval-runner.ts): Runs a task again and again, and survives its failures.
- [`@spy4x/platform/server/jsonl-logger`](server/jsonl-logger.ts): Append-only JSONL event log.
- [`@spy4x/platform/server/ports`](server/ports.ts): The I/O ports every server helper in this package talks through.
- [`@spy4x/platform/server/process`](server/process.ts): The running process, on Deno, Node and Bun.
- [`@spy4x/platform/server/reminder-runner`](server/reminder-runner.ts): A reminder runner.
- [`@spy4x/platform/server/run-command`](server/run-command.ts): Run a child process and get its outcome back as a value, never as a throw.
- [`@spy4x/platform/server/serve`](server/serve.ts): Serve a fetch handler, such as a Hono app's `app.fetch`, and upgrade its requests to WebSockets, on Deno, Node and Bun.
- [`@spy4x/platform/server/runtime-fs`](server/runtime-fs.ts): `runtimeFileSystem`, a `FileSystemPort` for whichever runtime runs it, `nodeFileSystem`, the one for Node and Bun, and `fsError` and `isFsError`, which make and recognise a file-system error the same way on all three.
- [`@spy4x/platform/server/shutdown-signal`](server/shutdown-signal.ts): Turn operating-system signals (`SIGINT`, `SIGTERM`) into one `AbortSignal`, so a worker loop that already takes a signal stops cleanly on Ctrl+C or a container stop.
- [`@spy4x/platform/server/tcp`](server/tcp.ts): An outgoing TCP connection as a pair of web streams, on Deno, Node and Bun.
- [`@spy4x/platform/server/throttled-saver`](server/throttled-saver.ts): Throttled atomic JSON saver.
- [`@spy4x/platform/signed-payload`](signed-payload.ts): Signed payload codec.
- [`@spy4x/platform/tokens`](tokens.ts): Token primitives.
- [`@spy4x/platform/universal/async`](universal/async.ts): `sleep`, `debounce` (cancelable, unref'd) and `backoffDelay` (a capped, jittered backoff delay).
- [`@spy4x/platform/universal/axis`](universal/axis.ts): "Nice" axis scales for charts.
- [`@spy4x/platform/universal/bounded-integer`](universal/bounded-integer.ts): Reading a whole number from a query string or another text, within bounds.
- [`@spy4x/platform/universal/color`](universal/color.ts): Everything in `@spy4x/platform/universal/color-core`, plus `hexColor`, an arktype schema for a `#rrggbb` colour.
- [`@spy4x/platform/universal/color-core`](universal/color-core.ts): Hex colours and their WCAG 2.x contrast.
- [`@spy4x/platform/universal/concurrency`](universal/concurrency.ts): `AsyncMutex` — a fair async mutex for serialising async critical sections.
- [`@spy4x/platform/universal/constants`](universal/constants.ts): Shared numeric defaults used across this package.
- [`@spy4x/platform/universal/contact`](universal/contact.ts): The contact channels a website names.
- [`@spy4x/platform/universal/csv`](universal/csv.ts): RFC 4180 CSV writer and reader.
- [`@spy4x/platform/universal/error-reporter`](universal/error-reporter.ts): A small error reporter that posts Sentry's envelope format, which GlitchTip and Sentry accept.
- [`@spy4x/platform/universal/errors`](universal/errors.ts): The error vocabulary a store or a form reports with, the helpers that build it, and the `Result` used to return one.
- [`@spy4x/platform/universal/format-number`](universal/format-number.ts): Number formatting for display.
- [`@spy4x/platform/universal/honeypot`](universal/honeypot.ts): The server half of a honeypot form field.
- [`@spy4x/platform/universal/i18n`](universal/i18n.ts): Translations from flat JSON catalogs, with `Intl` doing the language work.
- [`@spy4x/platform/universal/ical-tasks-view`](universal/ical-tasks-view.ts): What a task list shows.
- [`@spy4x/platform/universal/is-record`](universal/is-record.ts): A type guard for a value of unknown shape read from JSON, such as an API answer.
- [`@spy4x/platform/universal/key-value-store`](universal/key-value-store.ts): The `KeyValueStore` port, on a subpath of its own so a consumer can import it without the bare `@spy4x/platform` specifier, which also pulls in `@spy4x/validation`.
- [`@spy4x/platform/universal/markdown`](universal/markdown.ts): Markdown to HTML that is safe to put on a public page, even when the Markdown came from someone the page's visitors should not have to trust (an operator in an admin panel, a user's note).
- [`@spy4x/platform/universal/metrics`](universal/metrics.ts): A labelled counter and its Prometheus text exposition.
- [`@spy4x/platform/universal/money`](universal/money.ts): Everything in `@spy4x/platform/universal/money-core`, plus `currencyCode`, an arktype schema for an ISO 4217 code.
- [`@spy4x/platform/universal/money-core`](universal/money-core.ts): Money as a whole number in its currency's smallest unit — `1250` means `€12.50`, `12345` means `¥12,345` because the yen has no minor unit, and `12345` means `12.345 KWD` because the Kuwaiti dinar has three.
- [`@spy4x/platform/universal/quick-add`](universal/quick-add.ts): Parse one quick-add line such as `Call Anna @phone #work tomorrow 3pm !high` into a title, tags, contexts, a due date and a priority, plus the position of every recognised token so a field can highlight them as the person types.
- [`@spy4x/platform/universal/result`](universal/result.ts): `Result` — the narrow success/failure sum used inside a function body, and the `{ success, output, error }` envelope used at a command boundary.
- [`@spy4x/platform/universal/schema`](universal/schema.ts): The one arktype type-level helper this package needs, plus the validation types it re-exports.
- [`@spy4x/platform/universal/seo`](universal/seo.ts): The canonical address, the structured data, the `sitemap.xml`, the RSS feed and the `llms.txt` a server-rendered site publishes.
- [`@spy4x/platform/universal/settings`](universal/settings.ts): Typed, versioned settings.
- [`@spy4x/platform/universal/shell`](universal/shell.ts): Quoting for a POSIX shell (`sh`, `bash`, `dash`, `zsh` in `sh` mode), for the one place a value must pass through a shell.
- [`@spy4x/platform/universal/sort`](universal/sort.ts): Multi-column sort rules for a table.
- [`@spy4x/platform/universal/srcset`](universal/srcset.ts): The attributes of a responsive `<img>` or `<picture>`, from the widths an image is stored at, such as the AVIF and WebP variants `processImage` of `@spy4x/server/images` makes.
- [`@spy4x/platform/universal/statistics`](universal/statistics.ts): Small statistics helpers.
- [`@spy4x/platform/universal/text`](universal/text.ts): Small, dependency-free text helpers.
- [`@spy4x/platform/universal/time`](universal/time.ts): Calendar-date helpers.
- [`@spy4x/platform/universal/time-constants`](universal/time-constants.ts): Time unit constants, derived so that one unit is always an exact multiple of the one below it.
- [`@spy4x/platform/universal/uuid`](universal/uuid.ts): UUID version 7 ids and UUID validators.
- [`@spy4x/platform/validation/predicates`](validation/predicates.ts): Reusable arktype predicates for untrusted text, ported from `mig/routes/api/_validators.ts`.
