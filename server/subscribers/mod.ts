/**
 * Double opt-in mailing lists: signed confirm and unsubscribe links that keep the address out of
 * the URL, a store port with the replay rule, and the subscribe, confirm and unsubscribe flows. The
 * app keeps its wording, pages and routes.
 *
 * `createSubscriptionCrypto`, `CONFIRM_TTL_MS`, the `SubscriberStore` port, the flows
 * `requestSubscription`, `previewConfirmation`, `confirmSubscription`, `previewUnsubscribe` and
 * `unsubscribe`, `unsubscribeTokenFrom`, `UNSUBSCRIBE_FORM_MAX_BYTES` and `TOKEN_PAGE_HEADERS`;
 * `sendIssue` and the `SendLog` port; `createMemorySubscriberStore` and `createMemorySendLog` in
 * `server/subscribers/memory`, `createFileSendLog` in `server/subscribers/file`; `createPostgresSubscriberStore`,
 * `createPostgresSendLog` and `SUBSCRIBERS_POSTGRES_SCHEMA` in `server/subscribers/postgres`.
 *
 * A double opt-in mailing list. A visitor enters an address, gets a confirm link, and joins the list
 * only after clicking it. Every mail after that carries an unsubscribe link that holds no address.
 * The app keeps its wording, layout, pages and routes: the flows hand it a `SubscriberMail` (`confirm`
 * or `welcome`, the address and the link) and the app builds and sends the mail.
 *
 * ```ts
 * import {
 *   confirmSubscription,
 *   createSubscriptionCrypto,
 *   type FlowDeps,
 *   requestSubscription,
 *   TOKEN_PAGE_HEADERS,
 *   unsubscribe,
 *   unsubscribeTokenFrom,
 * } from "@spy4x/server/subscribers"
 * import { createMemorySubscriberStore } from "@spy4x/server/subscribers/memory"
 * import { createMemoryRateLimiter } from "@spy4x/platform/rate-limit/memory"
 *
 * const deps: FlowDeps = {
 *   crypto: createSubscriptionCrypto({ secret: requiredEnv("SUBSCRIBERS_SECRET") }),
 *   store: createMemorySubscriberStore(),
 *   links: {
 *     confirm: (token) => `${baseUrl}/subscribe/confirm?token=${encodeURIComponent(token)}`,
 *     unsubscribe: (token) => `${baseUrl}/unsubscribe?token=${encodeURIComponent(token)}`,
 *   },
 *   sendMail: (mail) => sender.send(buildMail(mail)), // the app's wording; a SendResult is fine
 *   limits: {
 *     client: createMemoryRateLimiter({ limit: 3, windowMs: 3600_000 }),
 *     recipient: createMemoryRateLimiter({ limit: 3, windowMs: 86_400_000 }),
 *   },
 * }
 *
 * // POST /api/subscribe
 * const outcome = await requestSubscription(body.email, deps, { clientKey })
 * return new Response(null, { status: outcome.status })
 *
 * // POST /unsubscribe: the on-page form and a mail client's one-click POST alike
 * const token = await unsubscribeTokenFrom(request)
 * const result = token ? await unsubscribe(token, deps, { clientKey }) : { state: "not-recognised" }
 * return render(result, { headers: TOKEN_PAGE_HEADERS })
 * ```
 *
 * **Links.** A confirm link (version 2) carries the address and its issue time, binds the address as
 * the signed context, and expires after three days. An unsubscribe link (version 2) carries the
 * row's 16-byte keyed `subscriberKey` and binds the address as context, so it costs one store lookup
 * and one HMAC, and the URL holds no address. Both are `@spy4x/platform/signed-payload` tokens. One
 * secret serves every purpose, kept apart by purpose labels and HMAC message prefixes.
 *
 * **Rotating the secret.** Put the new secret in `secret` and the old one first in `previousSecrets`.
 *
 * - Unsubscribe links mailed before the rotation keep working: they verify under `previousSecrets`.
 * - A stored subscriber key is an opaque lookup id and keeps the secret it was made under. When you
 *   mail a listed subscriber, mint the link with the row's key, `unsubscribeToken(row.email, row.key)`,
 *   so a link minted after the rotation still finds a row keyed under the old secret. Without the
 *   key argument the token carries the key under the new secret, which only rows added since the
 *   rotation have. The welcome mail of `confirmSubscription` is such a row.
 * - A row with no key (antonshubin.com's rows) cannot be found by any version 2 link. Backfill each
 *   such row's key once, with `subscriberKey(row.email)`, before mailing it a version 2 link. `add`
 *   answering `"known"` never fills a missing key.
 * - A pending confirm link stops working: unsubscribe marks are keyed by the current secret alone, so
 *   an old confirm link could not be matched against an unsubscribe recorded before the rotation. The
 *   visitor asks for a new one.
 * - `sentMarks(email, issue)` returns the sent mark under every secret, current first. A send log
 *   records the first and skips a recipient that has any of them, so an issue resumed after a
 *   rotation does not mail anyone twice.
 *
 * **Pages that open a link only preview.** `previewConfirmation` and `previewUnsubscribe` read the
 * token and change nothing, so a mail scanner that follows every link subscribes and unsubscribes no
 * one. The page asks for a click, and that POST calls `confirmSubscription` or `unsubscribe`. A
 * one-click unsubscribe POST (RFC 8058) carries the token on the query string with an unrelated
 * body; `unsubscribeTokenFrom` reads the query first, then a form body capped at 4 KiB. Serve every
 * such page with `TOKEN_PAGE_HEADERS`: `no-store` keeps a page that shows an address out of caches,
 * and `strict-origin` keeps the token out of the `Referer` other sites receive.
 *
 * **The replay rule.** A confirm link works for three days and can be clicked again and again. Without
 * a record, confirm, unsubscribe, confirm again would put the address back. `remove` records each
 * unsubscribe as a keyed mark, never the address, and `add` answers `"replay"` for a link issued at or
 * before it. Records older than three days are pruned, since every link they could refuse has expired.
 *
 * **What the answers reveal.** `requestSubscription` neither reads nor writes the store, so a listed
 * address and a new one cost the same and get the same 200 and the same mail. Over the per-recipient
 * limit it still answers 200 and sends nothing. Every log line is free of addresses: a relay's or a
 * store's error is redacted in any letter case before it is logged, and only its name and message are
 * logged, never its stack.
 *
 * **Rate limits.** `limits.client` counts every subscribe request and every unsubscribe request that
 * carries a version 1 link, the only one that scans the list. Version 2 unsubscribe links are never
 * limited: a mail provider's one-click POSTs share a few addresses. `limits.recipient` is keyed on the
 * `subscriberKey`, so many clients cannot flood one inbox with confirm mails.
 *
 * **Compatibility with antonshubin.com.** Under the same secret, the site's unsubscribe and sent marks
 * match byte for byte, so its data files keep working. Its unsubscribe links (version 1) verify, by a
 * scan of the list, only with `legacyTokens: true`; without it they are not recognised and never read
 * the store. Its version 1 confirm links stop working at the switch; they expire within three days
 * anyway.
 *
 * **Stores.** `SubscriberStore` offers one method per intent, so each adapter can make it atomic.
 * `describeSubscriberStoreContract` in `store-contract.test.ts` is the contract every adapter runs.
 * `add` and `remove` for one address must not overlap, or a replayed confirm link can slip in between
 * the mark and the row: a Postgres adapter takes a row lock or an advisory lock on the address.
 *
 * **File store.** `createFileSubscriberStore({ path })` from `@spy4x/server/subscribers/file` keeps the
 * list in a JSON file and the unsubscribe marks in `<path>.unsubscribed`. Every change runs under an
 * in-process queue and `<path>.lock` (it retries `lockAttempts` times, `lockRetryMs` apart, then throws
 * `LockUnavailableError`), so two processes never lose a write; each write is a temp file and a
 * rename. A list that does not parse is never treated as empty: its first text is kept in
 * `<path>.invalid`, the file is left as it is, and every call throws `SubscriberFileError` until a
 * person repairs it. A damaged marks file is never overwritten without a copy: `remove` first keeps
 * its text in `<path>.unsubscribed.invalid.<ms>` (a new name each time, with a suffix if that name
 * exists), throws if the copy cannot be written, then writes a new record holding every mark it
 * could still read, so an unsubscribe always works. `add` throws `SubscriberFileError` while the marks
 * file is damaged. Once an unsubscribe has replaced the record, the marks that could not be read (all
 * of them, for text that does not parse) stop being checked, so a replayed confirm link for those
 * addresses gets in again; restore them from the copy if that matters. A mark with an unreadable time
 * counts as damage, and the other marks in the file are kept. `LockUnavailableError` is re-exported
 * from the same entry. The site's `subscribers.json` and `.unsubscribed` load unchanged; new rows
 * carry a `key`. Rows the site wrote have none, so run `await store.backfillKeys(crypto)`
 * once before mailing them a version 2 unsubscribe link: it is idempotent and returns how many rows
 * it changed.
 *
 * **Postgres store.** `SUBSCRIBERS_POSTGRES_SCHEMA` from `@spy4x/server/subscribers/postgres` is the
 * DDL to copy into your migration: `subscribers` (primary key `(list_id, email)`, unique
 * `(list_id, key)`), `subscriber_unsubscribes` (marks, never addresses) and `subscriber_sends` (the
 * send log). `createPostgresSubscriberStore(sql, { listId })` and `createPostgresSendLog(sql, { listId })`
 * serve one list each, so several lists can share the tables.
 *
 * - `add` and `remove` each run in one transaction that takes `pg_advisory_xact_lock` on the list and
 *   address first, so a replayed confirm link racing an unsubscribe can never bring the address back.
 *   Other addresses do not wait for each other.
 * - When two unsubscribes of one address are recorded, the later time is kept.
 * - `lock` takes a session-scoped `pg_try_advisory_lock` on a connection it reserves with
 *   `sql.reserve()` and gives back on `release`, so two locks never share a session (advisory locks are
 *   re-entrant within one). A crashed holder loses its connection and the lock with it. The send holds
 *   that connection throughout, so the pool needs at least two connections. `lock` never waits for
 *   another holder, but it does wait for a free pool connection.
 * - Advisory locks belong to the whole database, so every key includes `current_schema()`: two apps
 *   in separate schemas of one database, even with the same list id, never block each other.
 * - A second address with an existing `key` on the same list throws instead of being stored.
 *
 * **Sending an issue.** `sendIssue` mails one issue to the list, one mail each, and remembers who got
 * it in a `SendLog`. Render the letter once with `renderLetter`, leave `UNSUBSCRIBE_PLACEHOLDER` where
 * the link goes, and pass it with the rows of `store.list()`.
 *
 * ```ts
 * import { sendIssue } from "@spy4x/server/subscribers"
 * import { createFileSendLog } from "@spy4x/server/subscribers/file"
 *
 * const result = await sendIssue({
 *   issue: post.slug, // the id the log remembers, part of every sent mark
 *   subject: post.title,
 *   letter, // from renderLetter(), once
 *   subscribers: await deps.store.list(),
 *   crypto: deps.crypto,
 *   unsubscribeLink: deps.links.unsubscribe,
 *   sender,
 * }, createFileSendLog({ path: `data/newsletter-log.json` }))
 * // { status: "sent", sent, failed, skipped } | "already-sent" | "in-progress" | "no-subscribers"
 * ```
 *
 * - The first run records the audience, the marks of everyone on the list then. A rerun after a
 *   partial failure mails only the audience members the log does not list as reached. A subscriber
 *   who joined later never gets an old issue. A run after a clean one answers `already-sent` and mails
 *   nobody.
 * - A mark goes into the log only after the relay accepted that mail, so a crash costs at most the
 *   one mail in flight. A log write that fails stops the run and throws: carrying on could mail
 *   someone twice.
 * - The run holds the log's send lock, and a second call answers `in-progress` instead of waiting.
 *   The file log locks `<path>.lock`, held by the OS, so a crashed run frees it, and the lock covers
 *   the whole file: one issue sends at a time.
 * - Each link is minted with the row's stored key, so it survives a rotation. Marks are read under the
 *   current and every previous secret, and written under the current one, so a rotation between runs
 *   does not mail anyone twice.
 * - A link that cannot be built and a send that throws each count as one failure, and the run goes
 *   on. A row that is not a bare address is logged and counted as skipped, so it cannot keep the issue
 *   open forever. The log names a row by its number, and a relay error is
 *   redacted before it is logged. The send log holds marks, never addresses.
 * - An empty list answers `no-subscribers` and records nothing: it usually means the store could not
 *   be read.
 *
 * `describeSendLogContract` in `send-log-contract.test.ts` is the contract every adapter runs. The
 * file log reads and writes antonshubin.com's `newsletter-log.json` unchanged. During a send it
 * appends each recipient to `<path>.journal` rather than rewriting the file per mail; the next write
 * of the file folds the journal in and removes it. A file that does not
 * parse, or is not an array, is left alone and every call throws, so a corrupt log stops a send
 * instead of allowing a second one.
 *
 * **Guarantees:**
 *
 * - Relay-error redaction is case-insensitive, so a mail server that echoes `JANE@EXAMPLE.COM` for
 *   `jane@example.com` does not put the address in the log; store and link-building errors are
 *   redacted too. `sendIssue` logs the row number, never the address.
 * - A version 2 unsubscribe link costs one lookup; the version 1 scan, one HMAC per subscriber, runs
 *   only with `legacyTokens: true` and is rate-limited per client.
 * - Version 2 links carry their issue time, so shortening the TTL cannot make an older link look
 *   newer and let a replay through.
 * - A per-recipient limit stops many clients flooding one address with subscribe requests.
 * - The file store keeps a damaged `.unsubscribed` file under its own name before writing, and
 *   refuses `add` meanwhile, so a replayed confirm link cannot get in; the new record keeps every
 *   mark it could still read.
 *
 * @module
 */

export {
  CONFIRM_TTL_MS,
  type ConfirmTokenResult,
  createSubscriptionCrypto,
  type SubscriptionCrypto,
  type SubscriptionCryptoOptions,
  type UnsubscribeLookup,
} from "./crypto.ts"
export type {
  AddSubscriberInput,
  AddSubscriberResult,
  RemoveSubscriberInput,
  Subscriber,
  SubscriberStore,
} from "./store.ts"
export {
  type ConfirmOutcome,
  type ConfirmPreview,
  confirmSubscription,
  type FlowDeps,
  type FlowRequest,
  type MailOutcome,
  previewConfirmation,
  previewUnsubscribe,
  requestSubscription,
  type SubscribeRequestOutcome,
  type SubscriberLimits,
  type SubscriberLog,
  type SubscriberMail,
  unsubscribe,
  type UnsubscribeOutcome,
  type UnsubscribePreview,
} from "./flows.ts"
export {
  TOKEN_PAGE_HEADERS,
  UNSUBSCRIBE_FORM_MAX_BYTES,
  unsubscribeTokenFrom,
  type UnsubscribeTokenOptions,
} from "./http.ts"
export { sendIssue, type SendIssueInput, type SendIssueLog, type SendIssueResult } from "./send.ts"
export type {
  FinishSendInput,
  SendLock,
  SendLog,
  SendLogEntry,
  StartSendInput,
} from "./send-log.ts"
