/**
 * The slice of Mailpit's HTTP API an integration test needs: find the mail that was
 * just sent, read its body, delete it again.
 *
 * Plain `fetch` against a documented JSON API — no client library, for the same
 * reason the rest of the repository owns its small adapters.
 *
 * Mailpit accepts a message over SMTP and indexes it a moment later, so a test that
 * asks once right after `send()` resolves finds nothing. {@link waitForMail} polls
 * for a bounded time and then fails with the address it searched for; it never
 * returns "no mail" as a pass.
 */

import type { MailpitSettings } from "./services.ts"

/** One row of a Mailpit listing. Only the fields a test reads are described. */
export interface MailpitSummary {
  /** Mailpit's own id, the handle for reading and deleting the message. */
  ID: string
  Subject: string
  From: MailpitAddress | null
  To: MailpitAddress[]
}

/** A mailbox as Mailpit reports it. */
export interface MailpitAddress {
  Name: string
  Address: string
}

/** A whole message, as `GET /api/v1/message/{id}` returns it. */
export interface MailpitMessage extends MailpitSummary {
  /** Plain-text part, empty when the message carries none. */
  Text: string
  /** HTML part, empty when the message carries none. */
  HTML: string
}

/** How long {@link waitForMail} keeps asking. Mailpit indexes in milliseconds. */
const POLL_ATTEMPTS = 50
const POLL_INTERVAL_MS = 100

async function readJson<T>(response: Response, what: string): Promise<T> {
  if (!response.ok) {
    const detail = await response.text().catch(() => "")
    throw new Error(`Mailpit ${what} failed with HTTP ${response.status}: ${detail.slice(0, 200)}`)
  }
  return await response.json() as T
}

/**
 * Search Mailpit and return the matching summaries.
 *
 * `query` is Mailpit's own search syntax; `to:someone@ts-libs.test` is the one an
 * isolated test wants, because its recipient is unique to the run.
 */
export async function searchMail(
  settings: MailpitSettings,
  query: string,
): Promise<MailpitSummary[]> {
  const url = new URL("/api/v1/search", settings.baseUrl)
  url.searchParams.set("query", query)
  const body = await readJson<{ messages: MailpitSummary[] }>(await fetch(url), "search")
  return body.messages
}

/**
 * Wait until exactly one message addressed to `recipient` has arrived, and return it
 * in full.
 *
 * Fails with the recipient and the number of attempts when nothing arrives: an
 * integration test that cannot find its own mail has found a bug or a broken
 * environment, and either way it must go red.
 */
export async function waitForMail(
  settings: MailpitSettings,
  recipient: string,
): Promise<MailpitMessage> {
  for (let attempt = 0; attempt < POLL_ATTEMPTS; attempt++) {
    const found = await searchMail(settings, `to:${recipient}`)
    if (found.length > 0) return await readMail(settings, found[0].ID)
    await new Promise((resolve) => setTimeout(resolve, POLL_INTERVAL_MS))
  }
  throw new Error(
    `No mail for ${recipient} arrived at Mailpit (${settings.baseUrl}) within ` +
      `${(POLL_ATTEMPTS * POLL_INTERVAL_MS) / 1000}s.`,
  )
}

/** Read one message in full, including its text and HTML parts. */
export async function readMail(
  settings: MailpitSettings,
  id: string,
): Promise<MailpitMessage> {
  const url = new URL(`/api/v1/message/${encodeURIComponent(id)}`, settings.baseUrl)
  return await readJson<MailpitMessage>(await fetch(url), `message ${id}`)
}

/**
 * Delete the given messages, and only those.
 *
 * Mailpit's `DELETE /api/v1/messages` with an empty id list deletes *everything*, so
 * an empty list returns early instead: a cleanup step must never wipe the mailbox a
 * parallel run is reading.
 */
export async function deleteMail(settings: MailpitSettings, ids: readonly string[]): Promise<void> {
  if (ids.length === 0) return
  const response = await fetch(new URL("/api/v1/messages", settings.baseUrl), {
    method: "DELETE",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ IDs: [...ids] }),
  })
  if (!response.ok) {
    const detail = await response.text().catch(() => "")
    throw new Error(`Mailpit delete failed with HTTP ${response.status}: ${detail.slice(0, 200)}`)
  }
  await response.body?.cancel().catch(() => {})
}
