/**
 * The glue between a reminder runner and a Web Push sender: the message a due reminder becomes,
 * and what counts as delivered.
 *
 * {@link createReminderNotify} is the `notify` of `createReminderRunner` in
 * `@spy4x/platform/server/reminder-runner`. For one reminder it answers:
 *
 *  - `"delivered"` when at least one device got the push, when the user has no device
 *    subscribed, or when every device that failed was refused by its push service for good (HTTP
 *    400, 401, 403 and the like). Trying again would change nothing.
 *  - a rejection, which the runner reads as "try again on the next tick", when no device got it
 *    and at least one failed for a reason that may pass: no answer from the push service (a
 *    timeout, a network error, and also a subscription the sender could not use), HTTP 408, 429
 *    or 5xx, or a store that could not be read. The error carries the sender's text, which holds
 *    no endpoint and no key.
 *
 * The message is always one the sender accepts: {@link reminderPushMessage} cuts a long title and
 * derives a tag of fixed length, and a URL that cannot be sent is refused when the notify
 * function is built, not an hour of failed ticks later.
 *
 * Web standards only: nothing here touches `Deno.*`.
 *
 * @example
 * ```ts
 * const runner = createReminderRunner({
 *   listTasks,
 *   notify: createReminderNotify({ sender, userId: "owner", url: "/" }),
 *   state: store.state("reminders"),
 *   zone: "Europe/Berlin",
 *   onError: (error, step) => console.error(`reminders: ${step} failed`, error),
 * })
 * ```
 * @module
 */
import { type } from "arktype"
import { type PushNotificationMessage, pushNotificationMessageSchema } from "@spy4x/platform/model"
import type { PushOptions, PushSendResult, WebPushSender } from "./push.ts"

/** The longest title `pushNotificationMessageSchema` takes, in UTF-16 code units. */
const MAX_TITLE_CHARS = 120
const ELLIPSIS = "…"

/** The parts of a `DueReminder` (`@spy4x/time/ical-tasks-reminders`) a push message is made of. */
export interface ReminderForPush {
  /** The task's title; may be empty. */
  summary: string
  /** What identifies this reminder: the same key always gives the same tag. */
  key: string
}

/** Options of {@link reminderPushMessage}. */
export interface ReminderPushMessageOptions {
  /** Where a click on the notification leads; `null` (the default) leaves it to the worker. */
  url?: string | null
  /** The title of a reminder whose task has none. Default `Reminder`. */
  untitled?: string
}

/** `text` cut to `max` UTF-16 code units, ending in an ellipsis, never inside a character. */
function cut(text: string, max: number): string {
  if (text.length <= max) return text
  let kept = ""
  for (
    const { segment } of new Intl.Segmenter(undefined, { granularity: "grapheme" }).segment(text)
  ) {
    if (kept.length + segment.length > max - ELLIPSIS.length) break
    kept += segment
  }
  return kept.trimEnd() + ELLIPSIS
}

function titleOf(summary: string, options: ReminderPushMessageOptions): string {
  return cut(summary.trim() || (options.untitled ?? "Reminder"), MAX_TITLE_CHARS)
}

/** The message without its tag, checked: the part that depends on the caller's options. */
function checked(
  message: { title: string; url: string | null; tag?: string },
): PushNotificationMessage {
  const parsed = pushNotificationMessageSchema(message)
  if (parsed instanceof type.errors) {
    throw new RangeError("the url or the untitled text cannot be part of a push message")
  }
  return parsed
}

/**
 * The push message of one reminder. The title is the task's summary, cut to the 120 characters a
 * message may have, on a character boundary. The tag is the SHA-256 of the reminder's key in hex:
 * 64 characters whatever the task's UID, and the same for the same reminder, so a reminder pushed
 * twice replaces itself on screen.
 *
 * @throws {RangeError} when `options.url` or `options.untitled` cannot be part of a message.
 */
export async function reminderPushMessage(
  reminder: ReminderForPush,
  options: ReminderPushMessageOptions = {},
): Promise<PushNotificationMessage> {
  const digest = await crypto.subtle.digest("SHA-256", new TextEncoder().encode(reminder.key))
  const tag = Array.from(new Uint8Array(digest), (byte) => byte.toString(16).padStart(2, "0"))
    .join("")
  return checked({ title: titleOf(reminder.summary, options), url: options.url ?? null, tag })
}

/**
 * What a sender's result means for a reminder runner: `"delivered"` when a device got the push,
 * when there was no device, or when nothing that failed can pass later; otherwise `"retry"`. See
 * the module documentation.
 */
export function reminderDeliveryOutcome(
  result: Pick<PushSendResult, "success" | "deliveries">,
): "delivered" | "retry" {
  const { deliveries } = result
  // No delivery and no success: the store could not be read. The payload is valid by construction.
  if (deliveries.length === 0) return result.success ? "delivered" : "retry"
  if (deliveries.some((delivery) => delivery.status === "sent")) return "delivered"
  const mayPass = deliveries.some((delivery) =>
    delivery.status === "failed" &&
    (delivery.httpStatus === undefined || delivery.httpStatus === 408 ||
      delivery.httpStatus === 429 || delivery.httpStatus >= 500)
  )
  return mayPass ? "retry" : "delivered"
}

/** Options of {@link createReminderNotify}. */
export interface ReminderNotifyOptions extends ReminderPushMessageOptions {
  /** The sender, from `createWebPushSender`. */
  sender: Pick<WebPushSender, "send">
  /** Whose devices get the reminders. */
  userId: string | number
  /** Urgency, time to live and topic of each push. */
  push?: PushOptions
}

/**
 * Builds the `notify` of a reminder runner: it pushes each reminder to every device of `userId`.
 * It resolves with `"delivered"`, or rejects when the reminder should be tried again; see the
 * module documentation for which is which.
 *
 * @throws {RangeError} when `url` or `untitled` cannot be part of a message.
 */
export function createReminderNotify(
  options: ReminderNotifyOptions,
): (reminder: ReminderForPush) => Promise<"delivered"> {
  const { sender, userId, push, ...message } = options
  // Checked once, here: a URL the sender refuses would otherwise fail on every tick.
  checked({ title: titleOf("", message), url: message.url ?? null })
  return async (reminder) => {
    const result = await sender.send(userId, await reminderPushMessage(reminder, message), push)
    if (reminderDeliveryOutcome(result) === "retry") {
      throw new Error(`no device got the reminder: ${result.error || "the sender failed"}`)
    }
    return "delivered"
  }
}
