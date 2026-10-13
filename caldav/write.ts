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
 * after a lost answer finds its own object, known by its UID. It counts as done only when that
 * object holds the same content lines as the text being sent, in any order (Radicale stores the
 * properties reordered). Other text means an edit the queue merged into the waiting create, an
 * edit another device made after the create arrived, or both; nothing tells them apart, so nothing
 * is written and the failure is `version`: the queue fetches the server's copy and the person
 * chooses, with both texts kept.
 *
 * Deleting an entity whose create was never confirmed has no etag to go by. The outbox names the
 * texts that create was sent with (`ownCreates`), so the object is read first: gone means the
 * create never arrived and the delete is done; the same content lines as one of those texts (so
 * the same UID too) means the object is this device's own create, and it is deleted with the etag
 * just read;
 * anything else is another device's write, so nothing is deleted and the failure is `version`.
 *
 * A 401 is not a refusal of the write: the session may need signing in again, so the write stays
 * queued (`unreachable`). A 403 that names a condition (`need-privileges`,
 * `supported-calendar-component`, `valid-calendar-data`) is the server's refusal for good, so it
 * is `rejected` and the writes queued behind it go on.
 *
 * A 403 that names no condition can be either: Stalwart answers one, with no body, to a write into
 * a calendar shared read-only, and a proxy whose session ended answers one too. So after such a
 * 403 the transport asks the writer what this user may do at the address (`getPrivileges`: the
 * calendar for a create, the object for an update or delete). The write is `rejected` only when
 * the server answers with a list that holds no privilege to write (`all`, `write`,
 * `write-content`, `bind`, `unbind`). A question that fails, a server that gives no list, a list
 * that allows writing, or a writer without `getPrivileges` all leave the write queued. The
 * question is asked once per write that met such a 403; a flush stops at the first write that
 * stays queued, so that is at most once per flush. A created entity's
 * id must be a plain file name (see {@link isSafeEntityId}); an update or delete goes to the
 * address `urlOf` gives, whatever the id.
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
  "createObject" | "updateObject" | "deleteObject" | "getObject" | "getPrivileges"
>

/** What the queue sends for one entry. Same shape as the outbox's `OutboxCommand`. */
export interface CalDavWriteCommand<P> {
  kind: "create" | "update" | "delete"
  entityId: string
  payload: P
  /** The version the write is based on; `0` for a create. */
  baseVersion: number
  /**
   * Only on a delete of an entity that was created on this device and never confirmed by the
   * server: the payloads that create was sent with, as far as the outbox remembers them (it
   * forgets sends older than its last 20 steps). The outbox fills it. With it, a delete that has
   * no etag can still finish when the server holds this device's own create; a text missing from
   * it only leads to the conflict such a delete raised before.
   */
  ownCreates?: P[]
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
   * The one exception is a delete that carries `ownCreates`: answer no etag for it, and the
   * object is deleted when it is still this device's own create.
   */
  etagOf(command: CalDavWriteCommand<P>): string | null | undefined
  /** The iCalendar text of a create or an update. */
  toIcs(command: CalDavWriteCommand<P>): string
  /** The app's entity for an object the server holds. Its `version` must move with the etag. */
  toEntity(object: CalDavObject, entityId: string): S
}

/** The three outbox ports this module fills. */
export interface CalDavWriteTransport<P, S> {
  /**
   * Sends one command. Throws {@link CalDavWriteError}. A delete of a missing object succeeds,
   * also when the object is missing because the create never reached the server.
   */
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

/** Whether two iCalendar texts hold the same content lines (unfolded, blank ones dropped), in any order. */
function sameLines(a: string, b: string): boolean {
  const lines = (ics: string) =>
    ics.replace(/\r?\n[ \t]/g, "").split(/\r?\n/).filter((line) => line !== "").sort()
  const left = lines(a)
  const right = lines(b)
  return left.length === right.length && left.every((line, index) => line === right[index])
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
    case CalDavErrorCode.Forbidden:
      // A 403 that names a condition is a refusal no retry changes (RFC 4791 answers a missing
      // privilege or unacceptable data this way); kept as `unreachable` it would block the queue.
      // One that names nothing may come from a proxy; `send` asks the server before it gives up.
      return error.condition === undefined
        ? { kind: "unreachable" }
        : { kind: "rejected", message: error.message }
    // The session may need signing in again; the write waits and nothing is lost.
    case CalDavErrorCode.Unauthorized:
    case CalDavErrorCode.Network:
    case CalDavErrorCode.Timeout:
    case CalDavErrorCode.TooManyRedirects:
      return { kind: "unreachable" }
    case CalDavErrorCode.Server: {
      // 401, 408, 429 and a 403 without a condition ask for a later try; any other 4xx is a
      // refusal, a 5xx a busy server.
      const status = error.status
      const refused = status !== undefined && status >= 400 && status < 500 &&
        status !== 401 && status !== 408 && status !== 429 &&
        (status !== 403 || error.condition !== undefined)
      return refused ? { kind: "rejected", message: error.message } : { kind: "unreachable" }
    }
    default:
      return { kind: "rejected", message: error.message }
  }
}

/** The privileges of which one is needed to add, change or delete an object (RFC 3744 §3). */
const WRITE_PRIVILEGES = new Set(["all", "write", "write-content", "bind", "unbind"])

/** A 403 that names no `DAV:error` condition, as the client or a relay adapter reports it. */
function isBareForbidden(error: CalDavError): boolean {
  if (error.condition !== undefined) return false
  return error.code === CalDavErrorCode.Forbidden ||
    (error.code === CalDavErrorCode.Server && error.status === 403)
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

  /**
   * The error for a write the server refused. A 403 without a condition does not say who refused:
   * the server for good, or a proxy whose session ended. So the server is asked what this user may
   * do at `url`. Only an answer that lists no write privilege makes the refusal final; a failed
   * question, a server that does not say, or a user who may write leaves the write queued.
   */
  async function refused(error: CalDavError, url: string): Promise<CalDavWriteError> {
    if (isBareForbidden(error) && writer.getPrivileges) {
      const asked = await writer.getPrivileges(url)
      const held = asked.success ? asked.output : null
      if (held !== null && !held.some((privilege) => WRITE_PRIVILEGES.has(privilege))) {
        return new CalDavWriteError({
          kind: "rejected",
          message: "This account may read this calendar but not change it.",
        }, error)
      }
    }
    return new CalDavWriteError(classifyCalDavError(error), error)
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
        // Checked before any request: an address that is not a plain path (or not a URL) is a
        // refusal for good, never `unreachable`, which would keep the queue retrying in silence.
        let objectAddress: string
        try {
          objectAddress = objectUrl(calendar, command.entityId)
        } catch {
          const error: CalDavError = {
            code: CalDavErrorCode.InvalidArgument,
            message: "The calendar address is not valid, so this item cannot be saved.",
          }
          throw new CalDavWriteError(classifyCalDavError(error), error)
        }
        const created = await writer.createObject(calendar, ics, { name })
        if (created.success) {
          return await settled(created.output.url, created.output.etag, ics, command.entityId)
        }
        if (created.error.code === CalDavErrorCode.AlreadyExists) {
          // A repeat of a create whose answer was lost finds its own object, known by its UID.
          const existing = await writer.getObject(objectAddress)
          if (existing.success) {
            const uid = uidOf(ics)
            if (uid !== null && uid === uidOf(existing.output.data)) {
              // Only the same content means the create arrived as it is now.
              if (sameLines(existing.output.data, ics)) {
                return options.toEntity(existing.output, command.entityId)
              }
              // The texts differ: an edit made here since the first try, one made on another
              // device since the create arrived, or both. No etag says which, so nothing is
              // written: the queue fetches the server's copy and the person chooses.
              const error: CalDavError = {
                code: CalDavErrorCode.Conflict,
                message: "This item is already on the server with other text.",
              }
              throw new CalDavWriteError(classifyCalDavError(error), error)
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
        throw await refused(created.error, calendar)
      }
      const url = options.urlOf(command.entityId)
      let etag = options.etagOf(command)
      if (!etag && command.kind === "delete" && command.ownCreates?.length) {
        // The create was never confirmed, so no etag is known; the server's copy says what to do.
        const existing = await writer.getObject(url)
        if (!existing.success) {
          // The create never arrived: nothing to delete, and nothing was changed on the server.
          if (existing.error.code === CalDavErrorCode.NotFound) return undefined
          throw new CalDavWriteError(classifyCalDavError(existing.error), existing.error)
        }
        const theirs = existing.output
        // The same content lines include the same UID line.
        const own = command.ownCreates.some((payload) =>
          sameLines(
            options.toIcs({ ...command, kind: "create", payload, baseVersion: 0 }),
            theirs.data,
          )
        )
        // Only the copy just read counts, and it is deleted with its own etag: a change made
        // between this read and the delete is refused by the server (`If-Match`). A copy that is
        // not this device's create, or that came without an etag, falls through to the conflict.
        if (own) etag = theirs.etag
      }
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
          throw await refused(deleted.error, url)
        }
        return undefined
      }
      const ics = options.toIcs(command)
      const updated = await writer.updateObject(url, ics, etag)
      if (!updated.success) {
        throw await refused(updated.error, url)
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
