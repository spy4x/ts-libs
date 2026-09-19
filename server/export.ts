/**
 * Versioned data-export envelopes and download responses.
 *
 * An account export is a read-only snapshot. It carries a format version and a
 * timestamp so an importer can migrate it, and it is served as a download rather
 * than inline JSON so a browser saves it instead of rendering it.
 *
 * This module knows nothing about any repository, database or user model: the
 * caller supplies a `user` value and a list of collections, each with the loader
 * that reads it. That keeps the envelope stable while products change shape.
 *
 * The filename's calendar day is the **local** day (`getFullYear`/`getMonth`/
 * `getDate`), not the UTC day. `toISOString().slice(0, 10)` — what the `northstar`
 * source used — normalises to UTC, so a user at UTC+05:00 downloading at 04:30
 * local on the 10th was handed `northstar-export-2026-03-09.json`, a day off from
 * the date they see. Positive offsets are therefore the dangerous ones, and the
 * offset is a property of the *server's* clock: a container running `TZ=UTC` names
 * the file for the server's day, not the user's, in either direction. There is no
 * fix for that beyond taking the user's timezone as input; what this module fixes
 * is the silent UTC shift, and it pins the local getters with a test.
 */

/** Format version of the envelope. Bump when a field changes meaning, not when one is added. */
export const EXPORT_VERSION = "1.0"

/** A named collection to include in the envelope. */
export interface ExportCollection<T = unknown> {
  /** Property name in the envelope, e.g. `snapshots`. */
  name: string
  /** Reads the collection for one user. Called once, in order, by {@link buildExportEnvelope}. */
  load: (userId: string) => Promise<T> | T
}

/** Input for {@link buildExportEnvelope}, all of it caller-supplied. */
export interface ExportInput<TUser = unknown> {
  /** Export format version, if the product overrides {@link EXPORT_VERSION}. */
  version?: string
  /** Stable user identifier the collections are scoped to. */
  userId: string
  /** Snapshot of the user record to embed. */
  user: TUser
  /** Collections to attach, in the order they should appear. */
  collections: readonly ExportCollection[]
  /** Clock, injected so a test can pin `exportedAt`. */
  now?: () => Date
}

/** The envelope written to the download. */
export interface ExportEnvelope<TUser = unknown> {
  exportedAt: string
  version: string
  user: TUser
  /** One property per {@link ExportCollection}, keyed by `name`. */
  [collection: string]: unknown
}

/**
 * Build the versioned export envelope.
 *
 * @param input User snapshot plus collection loaders.
 * @returns `{ exportedAt, version, user, ...collections }`.
 * @throws {TypeError} When two collections share a `name`, when a name collides
 * with `exportedAt`/`version`/`user`, or when `userId` is empty — all three
 * silently corrupt an export that a user is about to archive.
 */
export async function buildExportEnvelope<TUser>(
  input: ExportInput<TUser>,
): Promise<ExportEnvelope<TUser>> {
  const { version = EXPORT_VERSION, userId, user, collections, now } = input

  if (!userId) {
    throw new TypeError("buildExportEnvelope requires a non-empty userId")
  }

  const reserved = new Set(["exportedAt", "version", "user"])
  const seen = new Set<string>()
  for (const collection of collections) {
    if (reserved.has(collection.name)) {
      throw new TypeError(`export collection name "${collection.name}" is reserved`)
    }
    if (seen.has(collection.name)) {
      throw new TypeError(`duplicate export collection name "${collection.name}"`)
    }
    seen.add(collection.name)
  }

  const exportedAt = (now ?? (() => new Date()))()
  const envelope: ExportEnvelope<TUser> = {
    exportedAt: exportedAt.toISOString(),
    version,
    user,
  }

  for (const collection of collections) {
    envelope[collection.name] = await collection.load(userId)
  }

  return envelope
}

/**
 * Format the calendar day of a date as `YYYY-MM-DD` in **local** time.
 *
 * The local day is the one the user is living in, and it is the one a filename
 * should carry.
 */
export function formatLocalDate(date: Date): string {
  const year = String(date.getFullYear()).padStart(4, "0")
  const month = String(date.getMonth() + 1).padStart(2, "0")
  const day = String(date.getDate()).padStart(2, "0")
  return `${year}-${month}-${day}`
}

/**
 * Safety rules for a download filename segment.
 *
 * Anything outside the unreserved ASCII set becomes `-`, and runs of `-`, a
 * leading `.` and any remaining leading/trailing separator are stripped. The
 * leading-dot strip is not cosmetic: `..` on its own is a path segment, and a
 * filename is a path segment once it leaves this module.
 */
const SAFE_NAME = /[^A-Za-z0-9.-]+/g
/** Leading dots and separators, stripped before the trailing ones. */
const LEADING_SEPARATORS = /^[.-]+/

/**
 * Build `<name>-YYYY-MM-DD.json`, dropping anything that cannot be in a header.
 *
 * The result is safe to interpolate into `Content-Disposition`: CR/LF (header
 * injection), quotes, semicolons, path separators and non-ASCII are all replaced
 * with `-`, so no product name and no user input can add a header or a path.
 *
 * @throws {RangeError} When `date` is not a valid date, so a filename can never
 * contain `NaN`.
 */
export function exportFileName(name: string, date: Date): string {
  if (Number.isNaN(date.getTime())) {
    throw new RangeError("exportFileName requires a valid date")
  }
  const slug = name
    .trim()
    .replace(SAFE_NAME, "-")
    .replace(/-{2,}/g, "-")
    .replace(LEADING_SEPARATORS, "")
    .replace(/-+$/g, "")
  return `${slug || "export"}-${formatLocalDate(date)}.json`
}

/**
 * Build the response headers that make a browser download the body.
 *
 * `attachment` is what makes a browser save the body; without it a top-level
 * navigation renders raw JSON.
 *
 * @throws {RangeError} When `date` is not a valid date, so a filename can never
 * be built from `NaN`.
 */
export function exportDownloadHeaders(name: string, date: Date): Headers {
  if (Number.isNaN(date.getTime())) {
    throw new RangeError("exportDownloadHeaders requires a valid date")
  }
  const filename = exportFileName(name, date)
  const headers = new Headers({
    "Content-Type": "application/json; charset=utf-8",
    "Content-Disposition": `attachment; filename="${filename}"`,
  })
  return headers
}

/**
 * Serialise an envelope and build the download response in one step.
 *
 * The envelope is pretty-printed: an export is read by a human before it is read
 * by an importer.
 */
export function exportDownloadResponse(
  envelope: ExportEnvelope,
  options: { name: string; date: Date },
): Response {
  return new Response(JSON.stringify(envelope, null, 2), {
    headers: exportDownloadHeaders(options.name, options.date),
  })
}
