/**
 * The CalDAV client against Radicale and Stalwart 0.16 (#417).
 *
 * The same contract runs on both servers: discovery from the bare host and from a DAV path, a
 * calendar made and listed, a task created, a task written the way Tasks.org writes it and then
 * patched, a stale etag refused, open tasks listed without completed ones, and a delete that needs
 * the current etag. A recording `fetch` checks that no request left the server's origin.
 *
 * Isolation: Radicale gives every username its own principal, so each run logs in as a fresh one;
 * Stalwart gets a user created for the run over JMAP and deleted in a `finally`. The calendar each
 * run makes is deleted in a `finally` too.
 */

import { assert, assertEquals, assertExists } from "@std/assert"
import { describe, it } from "@std/testing/bdd"
import {
  type CalDavServerSettings,
  createStalwartUser,
  deleteStalwartUser,
  radicaleSettings,
  requireReachable,
  stalwartSettings,
  THROWAWAY_CREDENTIAL,
  uniqueSuffix,
} from "@integration-testing"
import { parseIcal, serializeIcal } from "@spy4x/time/ical"
import { newTodo, patchTodo, readTodo, TodoStatus } from "@spy4x/time/ical-tasks"
import {
  type CalDavClient,
  CalDavErrorCode,
  type CalDavResult,
  createCalDavClient,
} from "./client.ts"

/** A login on one server, and how to give it back. */
interface Login {
  username: string
  password: string
  release: () => Promise<void>
}

/** What differs between the servers; everything else in the contract is the same. */
interface Server {
  name: string
  settings: () => CalDavServerSettings
  login: (settings: CalDavServerSettings) => Promise<Login>
  /** A DAV path to start discovery from, besides the bare host. */
  davPath: (username: string) => string
  /** The calendar home discovery must find, as a path. */
  homePath: (username: string) => string
}

const SERVERS: Server[] = [
  {
    name: "Radicale",
    settings: radicaleSettings,
    login: () =>
      Promise.resolve({
        username: `it-caldav-${uniqueSuffix()}`,
        password: THROWAWAY_CREDENTIAL,
        release: () => Promise.resolve(),
      }),
    davPath: (username) => `/${username}/`,
    homePath: (username) => `/${username}/`,
  },
  {
    name: "Stalwart",
    settings: stalwartSettings,
    login: async (settings) => {
      const user = await createStalwartUser(settings, `itcaldav${uniqueSuffix()}`)
      return { ...user, release: () => deleteStalwartUser(settings, user) }
    },
    davPath: () => "/dav/cal/",
    homePath: (username) => `/dav/cal/${encodeURIComponent(username)}/`,
  },
]

const TASKS_ORG_FIXTURE = new URL(
  "../time/testdata/ical/stalwart-tasksorg-date-due.ics",
  import.meta.url,
)
const NOW = new Date("2026-10-08T12:00:00Z")
const PRODID = "-//ts-libs//caldav integration//EN"

function output<T>(result: CalDavResult<T>, what: string): T {
  if (!result.success) throw new Error(`${what} failed: ${JSON.stringify(result.error)}`)
  return result.output
}

function failureCode<T>(result: CalDavResult<T>): CalDavErrorCode {
  assert(!result.success, `expected a failure, got ${JSON.stringify(result.output)}`)
  return result.error.code
}

/** Parse, patch and serialise a VTODO, failing the test on any refusal. */
function patched(ics: string, patch: Parameters<typeof patchTodo>[1]): string {
  const parsed = parseIcal(ics)
  if (!parsed.success) throw new Error(`parse failed: ${parsed.error.message}`)
  const done = patchTodo(parsed.output, patch, { now: NOW })
  if (!done.success) throw new Error(`patch failed: ${done.error.message}`)
  return serializeIcal(parsed.output)
}

for (const server of SERVERS) {
  describe(`caldav client against ${server.name}`, () => {
    it("discovers, writes safely and lists open tasks, never leaving the server's origin", async () => {
      const settings = server.settings()
      await requireReachable(settings.address)
      const login = await server.login(settings)
      const seen: string[] = []
      const recording: typeof fetch = (input, init) => {
        seen.push(input instanceof Request ? input.url : String(input))
        return fetch(input, init)
      }
      const connect = (serverUrl: string): CalDavClient =>
        createCalDavClient({
          serverUrl,
          auth: { username: login.username, password: login.password },
          fetch: recording,
        })
      const client = connect(settings.baseUrl)
      let calendarUrl: string | undefined
      try {
        // Discovery from the bare host and from a DAV path finds the same home.
        const home = `${settings.baseUrl}${server.homePath(login.username)}`
        const bare = output(await client.discover(), "discovery from the bare host")
        assertEquals(bare.homeUrls, [home])
        const fromPath = connect(`${settings.baseUrl}${server.davPath(login.username)}`)
        assertEquals(output(await fromPath.discover(), "discovery from a DAV path").homeUrls, [
          home,
        ])

        // A calendar made under the home is listed with its name, components and a change tag.
        const made = output(
          await client.makeCalendar(home, {
            displayName: `zz caldav probe ${uniqueSuffix()}`,
            components: ["VTODO"],
          }),
          "makeCalendar",
        )
        calendarUrl = made.url
        const listed = output(await client.listCalendars(home), "listCalendars")
          .find((calendar) => calendar.url === made.url)
        assertExists(listed, "the new calendar is not listed")
        assert(listed.displayName.startsWith("zz caldav probe"), listed.displayName)
        assertEquals(listed.components, ["VTODO"])
        assert(listed.ctag || listed.syncToken, "neither a ctag nor a sync token")

        // A task created by the client comes back with an etag and is listed as open.
        const fresh = newTodo({ summary: "created by the client" }, {
          now: NOW,
          uid: crypto.randomUUID(),
          prodid: PRODID,
        })
        if (!fresh.success) throw new Error(fresh.error.message)
        const created = output(
          await client.createObject(made.url, serializeIcal(fresh.output)),
          "createObject",
        )
        assertExists(created.etag ?? output(await client.getObject(created.url), "get").etag)

        // A task written the way Tasks.org writes it: a plain PUT under its own name.
        const rawUrl = `${made.url}${Date.now()}${uniqueSuffix()}.ics`
        const put = await fetch(rawUrl, {
          method: "PUT",
          headers: {
            Authorization: `Basic ${btoa(`${login.username}:${login.password}`)}`,
            "Content-Type": "text/calendar; charset=utf-8",
            "If-None-Match": "*",
          },
          body: await Deno.readTextFile(TASKS_ORG_FIXTURE),
        })
        await put.body?.cancel()
        assertEquals(put.status, 201)

        const read = output(await client.getObject(rawUrl), "getObject of the raw task")
        assertExists(read.etag)
        const renamed = patched(read.data, { summary: "patched by the client" })
        const updated = output(await client.updateObject(rawUrl, renamed, read.etag), "update")
        const current = updated.etag ?? output(await client.getObject(rawUrl), "get").etag
        assertExists(current)
        assert(current !== read.etag, "the etag did not change after the update")

        // The etag read before the update is stale now: both writes are refused as Conflict.
        assertEquals(
          failureCode(await client.updateObject(rawUrl, renamed, read.etag)),
          CalDavErrorCode.Conflict,
        )
        assertEquals(
          failureCode(await client.deleteObject(rawUrl, read.etag)),
          CalDavErrorCode.Conflict,
        )

        // Completing the task drops it from the default listing, but not from the full one.
        const completed = output(
          await client.updateObject(
            rawUrl,
            patched(renamed, { status: TodoStatus.Completed }),
            current,
          ),
          "complete",
        )
        const open = output(await client.listObjects(made.url, { component: "VTODO" }), "open")
        assertEquals(open.map((object) => object.url), [created.url])
        const all = output(
          await client.listObjects(made.url, { component: "VTODO", includeCompleted: true }),
          "all",
        )
        assertEquals(all.map((object) => object.url).sort(), [created.url, rawUrl].sort())
        const done = all.find((object) => object.url === rawUrl)!
        assertEquals(summaryOf(done.data), "patched by the client")

        // A delete with the current etag removes the task.
        const etag = completed.etag ?? done.etag
        assertExists(etag)
        output(await client.deleteObject(rawUrl, etag), "delete")
        assertEquals(failureCode(await client.getObject(rawUrl)), CalDavErrorCode.NotFound)
      } finally {
        try {
          if (calendarUrl) output(await client.deleteCalendar(calendarUrl), "deleteCalendar")
        } finally {
          await login.release()
        }
      }
      const origins = new Set(seen.map((url) => new URL(url).origin))
      assertEquals([...origins], [settings.baseUrl])
    })
  })
}

/** The SUMMARY of the VTODO in `ics`, failing the test when it does not parse. */
function summaryOf(ics: string): string | undefined {
  const parsed = parseIcal(ics)
  if (!parsed.success) throw new Error(`parse failed: ${parsed.error.message}`)
  return readTodo(parsed.output)?.summary
}
