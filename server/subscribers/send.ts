import { parseBareAddress } from "@spy4x/email/address"
import { fillUnsubscribe, type Letter } from "@spy4x/email/letter"
import type { EmailSender } from "@spy4x/email/sender"
import type { SubscriptionCrypto } from "./crypto.ts"
import { redactAddress } from "./redact.ts"
import type { SendLog, SendLogEntry } from "./send-log.ts"
import type { Subscriber } from "./store.ts"

/** Where a send writes. Every line is free of addresses: a row is named by its number only. */
export interface SendIssueLog {
  info(...args: unknown[]): void
  error(...args: unknown[]): void
}

/** Everything {@link sendIssue} needs for one issue. */
export interface SendIssueInput {
  /** The issue's id in the {@link SendLog}, such as a post slug. It is part of every sent mark, so
   * a changed id makes the log forget who was mailed. */
  issue: string
  subject: string
  /** The rendered letter with `UNSUBSCRIBE_PLACEHOLDER` where each recipient's link goes. Render
   * it once: `sendIssue` fills in the link per recipient. */
  letter: Letter
  /** Everyone on the list now, such as `SubscriberStore.list()`. */
  subscribers: readonly Subscriber[]
  crypto: Pick<SubscriptionCrypto, "sentMarks" | "unsubscribeToken">
  /** Builds the app's absolute unsubscribe URL around a token. */
  unsubscribeLink(token: string): string
  sender: EmailSender
  /** Defaults to `console`. */
  log?: SendIssueLog
  /** Clock in Unix milliseconds, for the log's timestamps. Defaults to `Date.now`. */
  now?: () => number
}

/**
 * What a {@link sendIssue} run did.
 *
 * - `sent`: the run went through the audience. `skipped` counts members already mailed and people
 *   outside the audience, `failed` the mails that were not accepted. Rerun while `failed` is above
 *   zero: only the missed recipients are mailed.
 * - `already-sent`: an earlier run closed the issue, or the log has a legacy entry for it. Nothing
 *   was sent.
 * - `in-progress`: another run holds the send lock. Nothing was sent.
 * - `no-subscribers`: the list is empty. Nothing was recorded, because an empty list usually means
 *   the store could not be read, and recording the issue would block the real send later.
 */
export type SendIssueResult =
  | { status: "sent"; sent: number; failed: number; skipped: number }
  | { status: "already-sent"; entry: SendLogEntry }
  | { status: "in-progress" }
  | { status: "no-subscribers" }

/**
 * Mails one issue to the list, one mail each, with the recipient's own unsubscribe link in the body
 * and in the one-click `List-Unsubscribe` header.
 *
 * The first run records the audience, the marks of everyone on the list then. A rerun after a
 * partial failure mails only the audience members the log does not list as reached, and a
 * subscriber who joined later never gets an old issue. A repeated run after a clean one mails
 * nobody. A mark is recorded only after the relay accepted the mail, so a crash costs at most the
 * one mail in flight. After a secret rotation the log is read under the current and every previous
 * secret (`SubscriptionCrypto.sentMarks`) and written under the current one.
 *
 * The whole run holds the log's send lock, and a second call that finds it held answers
 * `in-progress` instead of waiting. A row that is not a bare address, a link that cannot be built
 * and a send that throws each cost that one mail and count as failed; the run goes on. A log write
 * that fails stops the run and throws, because carrying on could mail someone twice.
 *
 * The log names each row by its number and redacts the address from every relay error.
 */
export async function sendIssue(input: SendIssueInput, log: SendLog): Promise<SendIssueResult> {
  const lock = await log.lock(input.issue)
  if (lock === undefined) return { status: "in-progress" }
  try {
    return await sendLocked(input, log)
  } finally {
    await lock.release()
  }
}

async function sendLocked(input: SendIssueInput, log: SendLog): Promise<SendIssueResult> {
  const { issue, crypto, subscribers } = input
  const out = input.log ?? console
  const now = input.now ?? Date.now

  const previous = await log.find(issue)
  if (previous && (previous.recipients === undefined || previous.completedAt)) {
    return { status: "already-sent", entry: previous }
  }
  if (subscribers.length === 0) return { status: "no-subscribers" }

  const rows = await Promise.all(subscribers.map(async (row, index) => {
    const to = parseBareAddress(row.email)
    return { row, index, to, marks: to === null ? [] : await crypto.sentMarks(to, issue) }
  }))
  const entry = await log.start({
    issue,
    subject: input.subject,
    audience: rows.flatMap(({ marks }) => marks.slice(0, 1)),
    at: new Date(now()),
  })
  const audience = new Set(entry.audience)
  const recipients = new Set(entry.recipients)

  let sent = 0
  let failed = 0
  let skipped = 0
  for (const { row, index, to, marks } of rows) {
    const label = `row ${index + 1}`
    if (to === null) {
      failed++
      out.error(`  ✗ ${label}: not a bare address, skipped`)
      continue
    }
    if (marks.some((mark) => recipients.has(mark)) || !marks.some((mark) => audience.has(mark))) {
      skipped++
      continue
    }
    try {
      const link = input.unsubscribeLink(await crypto.unsubscribeToken(to, row.key))
      const { html, text } = fillUnsubscribe(input.letter, link)
      const result = await input.sender.send({
        to,
        subject: input.subject,
        html,
        text,
        listUnsubscribe: { url: link, oneClick: true },
      })
      if (!result.ok) {
        failed++
        out.error(`  ✗ ${label}: ${redactAddress(result.error, to)}`)
        continue
      }
    } catch (err) {
      failed++
      const message = err instanceof Error ? err.message : String(err)
      out.error(`  ✗ ${label}: ${redactAddress(message, to)}`)
      continue
    }
    sent++
    out.info(`  ✓ ${label}`)
    // Outside the try: a log that cannot record stops the run, it never turns into a failed mail.
    await log.record(issue, marks[0])
    recipients.add(marks[0])
  }

  await log.finish({ issue, failed, at: new Date(now()) })
  return { status: "sent", sent, failed, skipped }
}
