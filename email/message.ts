/**
 * The message shape a transport sends, plus the pieces of rendering that are
 * library concerns rather than app concerns.
 *
 * What is **not** here is the point of the boundary: booking copy, confirmation
 * wording, guest/owner template pairs and any other domain text stay in the
 * application. A library that owns the transport also owns the timezone framing
 * and the ICS attachment plumbing, because those are the parts that go wrong in
 * every hand-rolled reimplementation — the templates built on top of them do not.
 */

import {
  formatInstantLong,
  formatInstantShort,
  isValidTimeZone,
  validTimeZoneOr,
  zonedDateTime,
} from "@spy4x/time/tz"
import { generateIcs, type IcsEvent, type IcsOptions } from "@spy4x/time/ics"
import { assertNoControlCharacters } from "./address.ts"

/** One attachment: text content plus the metadata the MIME part needs. */
export interface EmailAttachment {
  /** Filename as the recipient sees it. Non-ASCII is encoded per RFC 2231 by the transport. */
  filename: string
  /** Content as UTF-8 text. Binary attachments are out of scope — see the README. */
  content: string
  /** MIME content type, e.g. `text/calendar; charset=utf-8; method=REQUEST`. */
  contentType: string
}

/** Everything one send needs. The port takes this and nothing else. */
export interface EmailMessage {
  /** One or more recipients; a string may carry a display name (`"Jane <jane@example.com>"`). */
  to: string | readonly string[]
  /** Subject line. A CR or LF here is rejected, not folded. */
  subject: string
  /**
   * Plain-text body. At least one of `text` and `html` is required, and an empty
   * or whitespace-only value counts as absent: a message with neither is a caller
   * bug, and an empty `text/plain` alternative beside a real HTML one is a
   * rendering bug for every text-only client.
   */
  text?: string
  /**
   * HTML body. **Must already be escaped** — build it with `escapeHtml` and
   * `htmlWrap` from `@spy4x/email/html`. It is never synthesised from `text`:
   * `mig` sent `html: opts.html ?? opts.text` on every message, which mailed
   * plain text as HTML.
   */
  html?: string
  /** Attachments, in the order they should appear. Omitted entirely when empty. */
  attachments?: readonly EmailAttachment[]
}

/** The fields of an ICS attachment the caller must supply. */
export interface IcalAttachmentOptions {
  /** Calendar properties for `time/ics`: `prodid`, and a fixed `dtstamp` for reproducible output. */
  ics: IcsOptions
  /** Filename shown to the recipient. Defaults to `meeting.ics`. */
  filename?: string
}

/**
 * Validate a message before any transport sees it.
 *
 * The rejections are the ones that otherwise surface as a delivery surprise: a
 * header-injecting subject, a header-injecting attachment filename or content type,
 * an attachment with no MIME type, and a message with no body at all. `<` and `>` are allowed
 * in a subject — mail clients encode it, and rejecting them would reject ordinary
 * text like `Meeting <draft>`.
 *
 * @throws {TypeError} on a control character in `subject`, a filename or a
 * content type, on no recipients, on no usable body, or on an attachment missing
 * its type.
 */
export function assertSendableMessage(message: EmailMessage): void {
  const recipients = typeof message.to === "string" ? [message.to] : message.to
  if (recipients.length === 0 || recipients.every((value) => value.trim() === "")) {
    throw new TypeError("At least one recipient is required")
  }

  assertNoControlCharacters(message.subject, "Subject")
  if (!hasBody(message.text) && !hasBody(message.html)) {
    throw new TypeError("A message needs a text body, an html body, or both")
  }

  for (const attachment of message.attachments ?? []) {
    assertNoControlCharacters(attachment.filename, "Attachment filename")
    assertNoControlCharacters(attachment.contentType, "Attachment contentType")
    if (attachment.filename.trim() === "") {
      throw new TypeError("Attachment filename must not be empty")
    }
    if (attachment.contentType.trim() === "") {
      throw new TypeError(`Attachment ${attachment.filename} has no contentType`)
    }
  }
}

/**
 * True when a body field carries something worth sending.
 *
 * A whitespace-only body is absent: `text: ""` used to produce a `text/plain`
 * part containing nothing, which a text-only client shows as a blank mail.
 */
export function hasBody(value: string | undefined): value is string {
  return value !== undefined && value.trim() !== ""
}

/**
 * Render an instant as the recipient's own clock reads it, with the zone spelled
 * out: `"Friday, 28 August 2026 at 04:00 (America/New_York)"`.
 *
 * This is `mig`'s per-recipient framing — the guest sees the booking in the
 * guest's zone, the host in the host's — with the zone name appended so a reader
 * comparing two mails can tell which clock each line means.
 *
 * @throws {RangeError} when `fallbackTz` is not an IANA zone. `mig` handed
 * `validTimeZoneOr`'s fallback straight to `Intl`, which throws a bare
 * `RangeError` from inside a formatter; failing here names the misconfiguration.
 */
export function frameInstantLong(
  instant: Date,
  recipientTz: string | undefined,
  fallbackTz: string,
): string {
  const zone = resolveZone(recipientTz, fallbackTz)
  return `${formatInstantLong(instant, zone)} (${zone})`
}

/** {@link frameInstantLong} without the zone name, for a subject line: `"Fri 28 Aug 04:00"`. */
export function frameInstantShort(
  instant: Date,
  recipientTz: string | undefined,
  fallbackTz: string,
): string {
  return formatInstantShort(instant, resolveZone(recipientTz, fallbackTz))
}

/**
 * Frame a `YYYY-MM-DD` + `HH:MM` wall clock written in `sourceTz` for a recipient
 * in `recipientTz`, falling back to the zone the wall clock was written in.
 *
 * The conversion from wall clock to instant is `time/tz`'s job and is consumed
 * here rather than reimplemented — a second `zonedDateTime` is exactly the
 * off-by-one-hour DST bug `time/tz` already documents and fixes.
 *
 * @throws {RangeError} when `sourceTz` is not an IANA zone.
 */
export function frameWallClockLong(
  date: string,
  time: string,
  sourceTz: string,
  recipientTz?: string,
): string {
  return frameInstantLong(instantAt(date, time, sourceTz), recipientTz, sourceTz)
}

/** {@link frameWallClockLong} without the zone name, for a subject line. */
export function frameWallClockShort(
  date: string,
  time: string,
  sourceTz: string,
  recipientTz?: string,
): string {
  return frameInstantShort(instantAt(date, time, sourceTz), recipientTz, sourceTz)
}

/**
 * Build the ICS attachment for an event.
 *
 * The calendar body comes from `@spy4x/time/ics` — a second ICS writer is
 * exactly the duplication this port exists to avoid — and the MIME type's
 * `method` parameter is read back out of the generated document instead of being
 * derived a second time from the event status. That makes it impossible for the
 * `Content-Type` to announce `REQUEST` for a body that says `CANCEL`.
 */
export function icalAttachment(event: IcsEvent, options: IcalAttachmentOptions): EmailAttachment {
  const content = generateIcs(event, options.ics)
  const method = /^METHOD:(.+)$/m.exec(content)?.[1].trim()

  return {
    filename: options.filename ?? "meeting.ics",
    content,
    contentType: method === undefined
      ? "text/calendar; charset=utf-8"
      : `text/calendar; charset=utf-8; method=${method}`,
  }
}

/** Validate `sourceTz`, then hand the conversion to `time/tz`. */
function instantAt(date: string, time: string, sourceTz: string): Date {
  if (!isValidTimeZone(sourceTz)) {
    throw new RangeError(`sourceTz is not an IANA zone: ${JSON.stringify(sourceTz)}`)
  }
  return zonedDateTime(date, time, sourceTz)
}

/**
 * The recipient's zone when it is usable, the fallback otherwise.
 *
 * Both halves are validated: an unknown `recipientTz` falls back to the zone the
 * message was authored in, while an unknown fallback is a caller error that must
 * not reach `Intl` as a `RangeError` from inside a formatter.
 */
function resolveZone(recipientTz: string | undefined, fallbackTz: string): string {
  if (!isValidTimeZone(fallbackTz)) {
    throw new RangeError(`Timezone is not an IANA zone: ${JSON.stringify(fallbackTz)}`)
  }
  return validTimeZoneOr(recipientTz, fallbackTz)
}
