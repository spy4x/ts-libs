/**
 * Postgres `LISTEN`/`NOTIFY` with JSON payloads: one process announces that something changed,
 * and every process that listens on the channel hears it.
 *
 * It is a wake-up, not a queue. Postgres delivers a notification only to the connections that
 * listen at that moment, so one sent while a listener is down or reconnecting is lost. Send a
 * hint ("user 7's inbox changed"), keep the truth in a table, and let the listener read the table
 * when it hears a hint, when it starts and when it reconnects ({@link JsonListenerOptions.onListen}).
 *
 * Announce inside the transaction of the change: Postgres holds the notification until the
 * transaction commits and drops it when it rolls back, so a listener never hears about a change
 * that did not happen. Within one transaction Postgres also sends two identical notifications
 * (same channel, same payload) only once.
 *
 * @module
 */

import type { Type } from "arktype"
import { isArkErrors } from "@spy4x/validation"
import type { Sql, Transaction } from "./ports.ts"

/**
 * The longest payload, in UTF-8 bytes of its JSON text, {@link announceJson} sends. Postgres
 * refuses a payload of 8000 bytes or more with its default configuration, and that refusal would
 * abort the caller's transaction.
 */
export const MAX_NOTIFY_PAYLOAD_BYTES = 7999

/**
 * The longest channel name, in UTF-8 bytes. Postgres cuts a longer name short in `LISTEN` and
 * refuses it in `pg_notify`, so the two sides would disagree.
 */
export const MAX_NOTIFY_CHANNEL_BYTES = 63

/** The payload is over {@link MAX_NOTIFY_PAYLOAD_BYTES}. Nothing was sent. */
export class NotifyPayloadTooLargeError extends RangeError {
  constructor(
    /** The channel the payload was for. */
    readonly channel: string,
    /** The size of the payload's JSON text in UTF-8 bytes. */
    readonly bytes: number,
  ) {
    super(
      `the payload for channel ${channel} is ${bytes} bytes; ` +
        `Postgres takes at most ${MAX_NOTIFY_PAYLOAD_BYTES}`,
    )
    this.name = "NotifyPayloadTooLargeError"
  }
}

const encoder = new TextEncoder()

/** Throws a `RangeError` unless both `LISTEN` and `pg_notify` take `channel` as it is. */
function assertChannel(channel: string): void {
  const bytes = typeof channel === "string" ? encoder.encode(channel).length : 0
  if (bytes === 0 || bytes > MAX_NOTIFY_CHANNEL_BYTES || channel.includes("\0")) {
    throw new RangeError(
      `a channel name is 1 to ${MAX_NOTIFY_CHANNEL_BYTES} bytes long and holds no NUL character`,
    )
  }
}

/**
 * Sends `payload` as JSON to everyone listening on `channel`. Pass the transaction of the change
 * the payload is about, so the notification goes out when that change commits and never when it
 * rolls back:
 *
 * ```ts
 * await sql.begin(async (tx) => {
 *   await tx`UPDATE inboxes SET unread = unread + 1 WHERE user_id = ${userId}`
 *   await announceJson(tx, "inbox_changed", { userId })
 * })
 * ```
 *
 * Keep the payload a hint: Postgres takes at most {@link MAX_NOTIFY_PAYLOAD_BYTES} bytes. A larger
 * one is refused here, before anything is sent, so the transaction is still usable.
 *
 * @throws NotifyPayloadTooLargeError when the JSON text is over the limit.
 * @throws TypeError when `payload` has no JSON form (`undefined`, a function, a cycle, a `BigInt`).
 * @throws RangeError when `channel` is empty, longer than {@link MAX_NOTIFY_CHANNEL_BYTES} bytes
 * or holds a NUL character.
 */
export async function announceJson(
  sql: Sql | Transaction,
  channel: string,
  payload: unknown,
): Promise<void> {
  assertChannel(channel)
  const text = JSON.stringify(payload)
  if (typeof text !== "string") throw new TypeError(`the payload for ${channel} has no JSON form`)
  const bytes = encoder.encode(text).length
  if (bytes > MAX_NOTIFY_PAYLOAD_BYTES) throw new NotifyPayloadTooLargeError(channel, bytes)
  await sql`SELECT pg_notify(${channel}, ${text})`
}

/** Options of {@link listenJson}. */
export interface JsonListenerOptions<S extends Type> {
  /**
   * The arktype schema of a payload. A payload that is not JSON, or that the schema refuses, is
   * dropped: anyone who can reach the database can send on a channel, so the handler only ever
   * sees the schema's output.
   */
  schema: S
  /** Called with each payload the schema accepts. */
  onMessage: (message: S["infer"]) => void | Promise<void>
  /**
   * Called when `onMessage` or `onListen` throws or rejects. The error is never rethrown: it would
   * surface inside the database client's socket handler and could end the process. Default:
   * `console.error`.
   */
  onError?: (error: unknown) => void
  /**
   * Called each time the channel is subscribed: once at the start, and again after the
   * connection dropped and came back. Notifications sent in between are lost, so read the current
   * state here. It may be async. When it throws or rejects, also on the first subscription, the
   * error goes to `onError` and `listenJson` still resolves, so the channel stays subscribed and
   * the stop function is returned.
   */
  onListen?: () => void | Promise<void>
}

/**
 * Calls `onMessage` for every JSON payload announced on `channel` that `schema` accepts, and
 * resolves once the channel is subscribed, with a function that stops listening.
 *
 * ```ts
 * const stop = await listenJson(sql, "inbox_changed", {
 *   schema: type({ userId: "number.integer > 0", "+": "reject" }),
 *   onMessage: ({ userId }) => tellSocketsOf(userId),
 *   onListen: () => resyncEveryone(),
 * })
 * ```
 *
 * The client (postgres.js) keeps one connection of its own for listening and subscribes again
 * when that connection drops; this function adds nothing to that. After such a reconnect the
 * client's own `unlisten` no longer removes the handler, so the stop function also switches the
 * handler off itself: no `onMessage`, `onError` or `onListen` call starts after it was called.
 * The listening connection closes with `sql.end()`.
 *
 * @throws RangeError when `channel` is empty, longer than {@link MAX_NOTIFY_CHANNEL_BYTES} bytes
 * or holds a NUL character.
 */
export async function listenJson<S extends Type>(
  sql: Sql,
  channel: string,
  options: JsonListenerOptions<S>,
): Promise<() => Promise<void>> {
  assertChannel(channel)
  const { schema, onMessage } = options
  const onError = options.onError ??
    ((error: unknown) => console.error(`listenJson: the handler of ${channel} failed`, error))
  let stopped = false

  const subscription = await sql.listen(channel, (payload) => {
    if (stopped) return
    let value: unknown
    try {
      value = JSON.parse(payload)
    } catch {
      return
    }
    try {
      const message = schema(value)
      if (isArkErrors(message)) return
      const done = onMessage(message as S["infer"])
      if (done instanceof Promise) done.catch(onError)
    } catch (error) {
      onError(error)
    }
  }, () => {
    if (stopped || !options.onListen) return
    try {
      Promise.resolve(options.onListen()).catch(onError)
    } catch (error) {
      onError(error)
    }
  })

  return async () => {
    stopped = true
    await subscription.unlisten()
  }
}
