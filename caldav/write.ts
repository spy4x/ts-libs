/**
 * Sends an offline queue's writes to a CalDAV server, and reads the server's answers the way the
 * queue needs them: a create is guarded by `If-None-Match: *`, an update and a delete by
 * `If-Match: <etag>`, and every refusal becomes a failure the queue can act on.
 *
 * The result plugs into the outbox of `@spy4x/realtime/outbox`: `send`, `fetchServer` and
 * `classify` are three of its ports. This module does not import the outbox; its types are
 * structurally the same (a compile-time test keeps them so).
 *
 * The writer is the four object calls of a {@link CalDavClient}, so a server uses the client
 * itself and a browser app behind a relay passes an adapter that answers with the same results
 * and error codes.
 *
 * Retrying a create is safe: the object is named after the entity (`<entityId>.ics`), so a repeat
 * after a lost answer finds its own object. It counts as done when that object has the same UID as
 * the text being sent; the text itself may differ, as some servers reorder properties.
 *
 * A 401 or 403 is not a refusal of the write: the session may need signing in again, so the write
 * stays queued (`unreachable`). A created entity's id must be a plain file name (see
 * {@link isSafeEntityId}); an update or delete goes to the address `urlOf` gives, whatever the id.
 *
 * @module
 */

import {
  type CalDavClient,
  type CalDavError,
  CalDavErrorCode,
  type CalDavObject,
} from "./client.ts"
import { childUrl } from "./url.ts"

/** The object calls a write transport needs. A {@link CalDavClient} satisfies it. */
export type CalDavWriter = Pick<
  CalDavClient,
  "createObject" | "updateObject" | "deleteObject" | "getObject"
>

/** What the queue sends for one entry. Same shape as the outbox's `OutboxCommand`. */
export interface CalDavWriteCommand<P> {
  kind: "create" | "update" | "delete"
  entityId: string
  payload: P
  /** The version the write is based on; `0` for a create. */
  baseVersion: number
}

/**
 * How the queue reads a failed send. Same shape as the outbox's `SendFailure`:
 * `unreachable` keeps the entry and retries later; `version` means the object changed on the
 * server; `not-found` means it is gone; `already-exists` means a create found its address taken;
 * `rejected` is a refusal for good.
 */
export type CalDavSendFailure =
  | { kind: "unreachable" }
  | { kind: "version" }
  | { kind: "not-found" }
  | { kind: "already-exists" }
  | { kind: "rejected"; message: string }

/** The error {@link CalDavWriteTransport.send} throws; carries what the server answered. */
export class CalDavWriteError extends Error {
  constructor(readonly failure: CalDavSendFailure, readonly caused: CalDavError) {
    super(caused.message)
    this.name = "CalDavWriteError"
  }
}

/** What an app supplies to turn a queue entry into a CalDAV request. */
export interface CalDavWriteOptions<P, S> {
  writer: CalDavWriter
  /**
   * The calendar a new object goes into. May be path-only (`/dav/cal/me/tasks/`) when the writer
   * is a relay adapter; the addresses given to the writer then stay path-only.
   */
  calendarUrl(command: CalDavWriteCommand<P>): string
  /**
   * The address of an entity's object. For an entity created on this device it is
   * `objectUrl(calendarUrl, entityId)`; for one read from the server, the address the server gave.
   */
  urlOf(entityId: string): string
  /**
   * The etag the write is based on, from the app's copy of the server's state at
   * `command.baseVersion`. Without one nothing is sent: the write is a `version` conflict, so the
   * queue fetches the server's copy and the person chooses, and nothing is overwritten unseen.
   */
  etagOf(command: CalDavWriteCommand<P>): string | null | undefined
  /** The iCalendar text of a create or an update. */
  toIcs(command: CalDavWriteCommand<P>): string
  /** The app's entity for an object the server holds. Its `version` must move with the etag. */
  toEntity(object: CalDavObject, entityId: string): S
}

/** The three outbox ports this module fills. */
export interface CalDavWriteTransport<P, S> {
  /** Sends one command. Throws {@link CalDavWriteError}. A delete of a missing object succeeds. */
  send(command: CalDavWriteCommand<P>, idempotencyKey: string): Promise<S | undefined>
  /** The server's object as it is now, or `null` when it is gone. Rejects when unreachable. */
  fetchServer(entityId: string): Promise<S | null>
  /** Reads what `send` threw; anything else is an unknown outcome, so `unreachable`. */
  classify(error: unknown): CalDavSendFailure
}

/**
 * Whether an entity id can name an object: letters, digits, `.`, `_`, `~` and `-`, and not `.` or
 * `..`. The same rule as the `name` of `CalDavClient.createObject`.
 */
export function isSafeEntityId(entityId: string): boolean {
  return /^[A-Za-z0-9._~-]+$/.test(entityId) && entityId !== "." && entityId !== ".."
}

/** The UID of an iCalendar text (lines unfolded, parameters ignored), or `null` when it has none. */
function uidOf(ics: string): string | null {
  const lines = ics.replace(/\r?\n[ \t]/g, "").split(/\r?\n/)
  for (const line of lines) {
    const match = /^UID(?:;[^:]*)?:(.*)$/i.exec(line)
    if (match) return match[1].trim()
  }
  return null
}

const PLACEHOLDER = "http://path.invalid"

/** The address {@link createCalDavWriteTransport} gives a created entity's object. */
export function objectUrl(calendarUrl: string | URL, entityId: string): string {
  // A path-only address (`/dav/cal/me/tasks/`) stays path-only, for apps whose server relay owns
  // the origin. The address is resolved against a placeholder origin to normalise dot segments,
  // backslashes and percent-encoded dots; anything that leaves the placeholder host or turns into a
  // `//` prefix (a protocol-relative address) is refused. `//host/...` itself is not a path and is
  // handled as before.
  if (typeof calendarUrl === "string" && /^\/(?!\/)/.test(calendarUrl)) {
    const base = new URL(calendarUrl, PLACEHOLDER)
    const child = childUrl(base, `${entityId}.ics`)
    const origin = new URL(PLACEHOLDER).origin
    if (base.origin !== origin || child.origin !== origin || child.pathname.startsWith("//")) {
      throw new RangeError("the calendar address is not a plain path")
    }
    return child.pathname
  }
  return childUrl(calendarUrl, `${entityId}.ics`).href
}

/** Reads a failed CalDAV call as the queue needs it. See the table in the module README. */
export function classifyCalDavError(error: CalDavError): CalDavSendFailure {
  switch (error.code) {
    case CalDavErrorCode.Conflict:
      return { kind: "version" }
    case CalDavErrorCode.NotFound:
      return { kind: "not-found" }
    case CalDavErrorCode.AlreadyExists:
      return { kind: "already-exists" }
    // The session may need signing in again; the write waits and nothing is lost.
    case CalDavErrorCode.Unauthorized:
    case CalDavErrorCode.Forbidden:
    case CalDavErrorCode.Network:
    case CalDavErrorCode.Timeout:
    case CalDavErrorCode.TooManyRedirects:
      return { kind: "unreachable" }
    case CalDavErrorCode.Server: {
      // 401, 403, 408 and 429 ask for a later try; any other 4xx is a refusal, a 5xx a busy server.
      const status = error.status
      const refused = status !== undefined && status >= 400 && status < 500 &&
        status !== 401 && status !== 403 && status !== 408 && status !== 429
      return refused ? { kind: "rejected", message: error.message } : { kind: "unreachable" }
    }
    default:
      return { kind: "rejected", message: error.message }
  }
}

/** Builds the `send`, `fetchServer` and `classify` ports of an outbox over CalDAV. */
export function createCalDavWriteTransport<P, S>(
  options: CalDavWriteOptions<P, S>,
): CalDavWriteTransport<P, S> {
  const { writer } = options

  /** The entity for a write that succeeded; the etag is read back when the server sent none. */
  async function settled(
    url: string,
    etag: string | null,
    ics: string,
    entityId: string,
  ): Promise<S> {
    let object: CalDavObject = { url, etag, data: ics }
    if (etag === null) {
      // The write is done: a failed read-back must not make the queue repeat it.
      const read = await writer.getObject(url)
      if (read.success) object = read.output
    }
    return options.toEntity(object, entityId)
  }

  return {
    async send(command) {
      if (command.kind === "create") {
        // Only a create turns the id into a file name; an update or delete goes to `urlOf`.
        if (!isSafeEntityId(command.entityId)) {
          const error: CalDavError = {
            code: CalDavErrorCode.InvalidArgument,
            message: "the entity id is not a plain file name",
          }
          throw new CalDavWriteError(classifyCalDavError(error), error)
        }
        const ics = options.toIcs(command)
        const calendar = options.calendarUrl(command)
        const name = `${command.entityId}.ics`
        const created = await writer.createObject(calendar, ics, { name })
        if (created.success) {
          return await settled(created.output.url, created.output.etag, ics, command.entityId)
        }
        if (created.error.code === CalDavErrorCode.AlreadyExists) {
          // A repeat of a create whose answer was lost finds its own object: that is success.
          // Compared by UID, because a server may store the text with its properties reordered.
          const url = objectUrl(calendar, command.entityId)
          const existing = await writer.getObject(url)
          if (existing.success) {
            const uid = uidOf(ics)
            if (uid !== null && uid === uidOf(existing.output.data)) {
              return options.toEntity(existing.output, command.entityId)
            }
            // Another task holds the name. `already-exists` would let the outbox offer "Keep
            // mine" as an update with the etag of that task, overwriting it; a refusal cannot be
            // turned into one. A fresh file name is not used: a repeat after a lost answer
            // would take the name again and leave a duplicate.
            const error: CalDavError = {
              code: CalDavErrorCode.InvalidArgument,
              message:
                "This task cannot be saved: its file name is already used by a different task.",
            }
            throw new CalDavWriteError(classifyCalDavError(error), error)
          } else if (existing.error.code !== CalDavErrorCode.NotFound) {
            // The answer is unknown, not a taken address: try again later.
            throw new CalDavWriteError(classifyCalDavError(existing.error), existing.error)
          }
        }
        throw new CalDavWriteError(classifyCalDavError(created.error), created.error)
      }
      const url = options.urlOf(command.entityId)
      const etag = options.etagOf(command)
      if (!etag) {
        // Nothing says which version of the object the person edited. Writing with an etag read
        // now would overwrite what another device changed since, so no request goes out: the
        // queue sees a version conflict, fetches the server's copy and lets the person choose.
        const error: CalDavError = {
          code: CalDavErrorCode.Conflict,
          message: "This item may have changed on the server, and the app cannot tell how.",
        }
        throw new CalDavWriteError(classifyCalDavError(error), error)
      }
      if (command.kind === "delete") {
        const deleted = await writer.deleteObject(url, etag)
        // Already gone is the state the person asked for.
        if (!deleted.success && deleted.error.code !== CalDavErrorCode.NotFound) {
          throw new CalDavWriteError(classifyCalDavError(deleted.error), deleted.error)
        }
        return undefined
      }
      const ics = options.toIcs(command)
      const updated = await writer.updateObject(url, ics, etag)
      if (!updated.success) {
        throw new CalDavWriteError(classifyCalDavError(updated.error), updated.error)
      }
      return await settled(updated.output.url, updated.output.etag, ics, command.entityId)
    },

    async fetchServer(entityId) {
      const read = await writer.getObject(options.urlOf(entityId))
      if (read.success) return options.toEntity(read.output, entityId)
      if (read.error.code === CalDavErrorCode.NotFound) return null
      throw new CalDavWriteError(classifyCalDavError(read.error), read.error)
    },

    classify(error) {
      return error instanceof CalDavWriteError ? error.failure : { kind: "unreachable" }
    },
  }
}
