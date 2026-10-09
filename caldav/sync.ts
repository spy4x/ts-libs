/**
 * Brings a device's copy of CalDAV calendars up to date with the server, and nothing else: the
 * transport (how the server is reached) and the store (where the copy lives) are ports, so a
 * browser app behind a relay and a server talking CalDAV directly share one engine. Signals,
 * wording and the storage engine stay with the caller.
 *
 * A refresh lists the calendars, skips each one whose change marker equals the marker its stored
 * objects came from, and for the others compares object etags with the stored ones: only new or
 * changed objects are written, and stored objects the server no longer lists are dropped.
 *
 * @module
 */

import { type CalDavCalendar, type CalDavClient, CalDavErrorCode } from "./client.ts"

/** The part of a calendar the engine reads. Extra fields travel through untouched. */
export interface SyncCalendar {
  /** The calendar's address, the key of its objects. */
  href: string
  /** The server's change marker (ctag or sync token). Unchanged marker, unchanged calendar. */
  changeMarker?: string
}

/** A calendar as the store keeps it: what the server listed, plus how far the copy is in step. */
export type StoredCalendar<C extends SyncCalendar = SyncCalendar> = C & {
  /** The `changeMarker` the stored objects were fetched under. */
  syncedMarker?: string
  /** Whether the stored objects include completed tasks. */
  completedLoaded: boolean
}

/** One calendar object: the raw iCalendar text and the version it came from. */
export interface SyncObject {
  href: string
  /** Exactly what the server sent, quotes included, or `null` when it sent none. */
  etag: string | null
  ics: string
}

/** An object's address and version, without its body. */
export interface SyncObjectVersion {
  href: string
  etag: string | null
}

/** What a transport call reports. `offline` means no answer at all, so the run stops asking. */
export type SyncTransportResult<T> =
  | { ok: true; data: T }
  | { ok: false; offline: boolean }

/** Options of the transport's object calls. */
export interface SyncListOptions {
  /** Whether completed tasks are wanted too. */
  includeCompleted: boolean
}

/** How the server is reached. A transport reports failures as values; it should not throw. */
export interface CalDavSyncTransport<C extends SyncCalendar = SyncCalendar> {
  listCalendars(): Promise<SyncTransportResult<C[]>>
  /** Every object of `calendar` with its body. */
  listObjects(calendar: C, options: SyncListOptions): Promise<SyncTransportResult<SyncObject[]>>
  /**
   * Optional pair that saves bandwidth: list only addresses and etags, then fetch the bodies of
   * the changed ones. Used only when both are present.
   */
  listVersions?(
    calendar: C,
    options: SyncListOptions,
  ): Promise<SyncTransportResult<SyncObjectVersion[]>>
  getObjects?(calendar: C, hrefs: string[]): Promise<SyncTransportResult<SyncObject[]>>
}

/** What a run changes in one calendar. */
export interface SyncChanges {
  /** New or changed objects. */
  upsert: SyncObject[]
  /** Addresses of stored objects the server no longer lists. */
  remove: string[]
}

/**
 * Where the copy lives. Each write that takes several parts is atomic, so an interrupted run
 * leaves the previous state. A generic keyed cache with a calendar-to-objects index can satisfy it.
 */
export interface CalDavSyncStore<C extends SyncCalendar = SyncCalendar> {
  listCalendars(): Promise<StoredCalendar<C>[]>
  /** The address and etag of every stored object of one calendar. */
  listVersions(calendarHref: string): Promise<SyncObjectVersion[]>
  /** Keeps exactly these calendars. A calendar missing from `calendars` loses its objects too. */
  replaceCalendars(calendars: StoredCalendar<C>[]): Promise<void>
  /** Stores `calendar` and applies `changes` to its objects, in one step. */
  applyChanges(calendar: StoredCalendar<C>, changes: SyncChanges): Promise<void>
}

/** What one {@link CalDavSync.refresh} found. */
export interface SyncOutcome {
  /** False when the calendar list got no answer: nothing was changed. */
  answered: boolean
  /** Addresses of the calendars whose objects could not be fetched this time. */
  failed: string[]
  /** Objects written (new or changed), over all calendars. */
  written: number
  /** Objects dropped, over all calendars. */
  removed: number
}

/** The engine made by {@link createCalDavSync}. */
export interface CalDavSync {
  /**
   * Brings the store up to date. Calls that overlap share one run. Rejects only when the store
   * does; a missing answer from the server is reported in the outcome.
   */
  refresh(): Promise<SyncOutcome>
  /**
   * Fetches one calendar including its completed tasks, and keeps including them in later
   * refreshes. Resolves false when the calendar is unknown or the server did not answer.
   */
  loadCompleted(calendarHref: string): Promise<boolean>
}

/** Builds the engine over a transport and a store. */
export function createCalDavSync<C extends SyncCalendar>(
  transport: CalDavSyncTransport<C>,
  store: CalDavSyncStore<C>,
): CalDavSync {
  let running: Promise<SyncOutcome> | undefined

  /** Fetches `calendar`, writes the difference. Resolves the counts, or the failure. */
  async function syncObjects(
    calendar: StoredCalendar<C>,
    completed: boolean,
  ): Promise<{ ok: true; written: number; removed: number } | { ok: false; offline: boolean }> {
    const options = { includeCompleted: completed }
    const stored = new Map(
      (await store.listVersions(calendar.href)).map((v) => [v.href, v.etag]),
    )
    const isCurrent = (version: SyncObjectVersion) =>
      version.etag !== null && stored.get(version.href) === version.etag

    let versions: SyncObjectVersion[]
    let upsert: SyncObject[]
    if (transport.listVersions && transport.getObjects) {
      const listed = await transport.listVersions(calendar, options)
      if (!listed.ok) return listed
      versions = listed.data
      const wanted = versions.filter((v) => !isCurrent(v)).map((v) => v.href)
      upsert = []
      if (wanted.length > 0) {
        const fetched = await transport.getObjects(calendar, wanted)
        if (!fetched.ok) return fetched
        upsert = fetched.data
      }
    } else {
      const listed = await transport.listObjects(calendar, options)
      if (!listed.ok) return listed
      versions = listed.data
      upsert = listed.data.filter((object) => !isCurrent(object))
    }
    const present = new Set(versions.map((v) => v.href))
    const remove = [...stored.keys()].filter((href) => !present.has(href))
    await store.applyChanges(
      { ...calendar, syncedMarker: calendar.changeMarker, completedLoaded: completed },
      { upsert, remove },
    )
    return { ok: true, written: upsert.length, removed: remove.length }
  }

  async function run(): Promise<SyncOutcome> {
    const outcome: SyncOutcome = { answered: false, failed: [], written: 0, removed: 0 }
    const listed = await transport.listCalendars()
    if (!listed.ok) return outcome
    outcome.answered = true
    const before = new Map((await store.listCalendars()).map((c) => [c.href, c]))
    const next = listed.data.map((calendar): StoredCalendar<C> => ({
      ...calendar,
      syncedMarker: before.get(calendar.href)?.syncedMarker,
      completedLoaded: before.get(calendar.href)?.completedLoaded ?? false,
    }))
    await store.replaceCalendars(next)
    for (const calendar of next) {
      const unchanged = calendar.changeMarker !== undefined &&
        calendar.changeMarker === calendar.syncedMarker
      if (unchanged) continue
      const result = await syncObjects(calendar, calendar.completedLoaded)
      if (result.ok) {
        outcome.written += result.written
        outcome.removed += result.removed
        continue
      }
      outcome.failed.push(calendar.href)
      // No answer at all: the rest would fail the same way.
      if (result.offline) break
    }
    return outcome
  }

  return {
    refresh: () =>
      running ??= run().finally(() => {
        running = undefined
      }),
    async loadCompleted(calendarHref) {
      const calendar = (await store.listCalendars()).find((c) => c.href === calendarHref)
      if (!calendar) return false
      return (await syncObjects(calendar, true)).ok
    },
  }
}

/** Options of {@link createClientTransport}. */
export interface ClientTransportOptions {
  /** The calendar home to list calendars under, from `client.discover()`. */
  homeUrl: string
  /** The component to sync, such as `VTODO`. */
  component: string
}

/**
 * A transport over a {@link CalDavClient}, for code that talks CalDAV directly (a server). A
 * calendar's `href` is its absolute URL and its change marker is its ctag, else its sync token.
 * `Network` and `Timeout` errors count as offline; any other error is an answer the server gave.
 */
export function createClientTransport(
  client: CalDavClient,
  options: ClientTransportOptions,
): CalDavSyncTransport<SyncCalendar & { displayName: string }> {
  const toCalendar = (calendar: CalDavCalendar) => ({
    href: calendar.url,
    displayName: calendar.displayName,
    changeMarker: calendar.ctag ?? calendar.syncToken,
  })
  return {
    async listCalendars() {
      const result = await client.listCalendars(options.homeUrl)
      if (!result.success) return failure(result.error.code)
      return { ok: true, data: result.output.map(toCalendar) }
    },
    async listObjects(calendar, { includeCompleted }) {
      const result = await client.listObjects(calendar.href, {
        component: options.component,
        includeCompleted,
      })
      if (!result.success) return failure(result.error.code)
      return {
        ok: true,
        data: result.output.map((o) => ({ href: o.url, etag: o.etag, ics: o.data })),
      }
    },
  }
}

function failure(code: CalDavErrorCode): { ok: false; offline: boolean } {
  return {
    ok: false,
    offline: code === CalDavErrorCode.Network || code === CalDavErrorCode.Timeout,
  }
}
