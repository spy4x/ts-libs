/**
 * The write transport and a real outbox against Radicale and Stalwart 0.16: a task that was created
 * while the server's answer was lost, and then deleted, before the next send that works.
 *
 * Each server stores a task its own way (Radicale reorders the properties), so only a real server
 * shows whether the transport still recognises the text it sent. The connection loss is made in
 * the writer the transport is given: a create is either passed on and its answer dropped, or never
 * passed on at all.
 *
 * Isolation: Radicale gives every username its own principal, so each run logs in as a fresh one;
 * Stalwart gets a user created for the run over JMAP and deleted in a `finally`. The calendar each
 * run makes is deleted in a `finally` too.
 */

import { assert, assertEquals } from "@std/assert"
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
  waitForStalwart,
} from "@integration-testing"
import { uuidV7 } from "@spy4x/platform/universal/uuid"
import { createMemoryOutboxStore, createOutbox, createPromiseLock } from "../realtime/outbox.ts"
import { parseIcal, serializeIcal } from "@spy4x/time/ical"
import { newTodo, patchTodo } from "@spy4x/time/ical-tasks"
import {
  type CalDavClient,
  type CalDavError,
  CalDavErrorCode,
  type CalDavObject,
  type CalDavResult,
  createCalDavClient,
} from "./client.ts"
import { type CalDavWriter, createCalDavWriteTransport, objectUrl } from "./write.ts"

/** A login on one server, and how to give it back. */
interface Login {
  username: string
  password: string
  release: () => Promise<void>
}

/** What differs between the servers. */
interface Server {
  name: string
  settings: () => CalDavServerSettings
  /** Wait for a server that sets itself up after its port opens. */
  ready?: (settings: CalDavServerSettings) => Promise<void>
  login: (settings: CalDavServerSettings) => Promise<Login>
  /** The user's calendar home, as a path. */
  homePath: (username: string) => string
}

const SERVERS: Server[] = [
  {
    name: "Radicale",
    settings: radicaleSettings,
    login: () =>
      Promise.resolve({
        username: `it-caldav-write-${uniqueSuffix()}`,
        password: THROWAWAY_CREDENTIAL,
        release: () => Promise.resolve(),
      }),
    homePath: (username) => `/${username}/`,
  },
  {
    name: "Stalwart",
    settings: stalwartSettings,
    ready: waitForStalwart,
    login: async (settings) => {
      const user = await createStalwartUser(settings, `itcaldavwrite${uniqueSuffix()}`)
      return { ...user, release: () => deleteStalwartUser(settings, user) }
    },
    homePath: (username) => `/dav/cal/${encodeURIComponent(username)}/`,
  },
]

const TASKS_ORG_FIXTURE = new URL(
  "../time/testdata/ical/stalwart-tasksorg-date-due.ics",
  import.meta.url,
)
const NOW = new Date("2026-10-14T12:00:00Z")
const PRODID = "-//ts-libs//caldav write integration//EN"

/** The app's entity: what the outbox keeps of a server object. */
interface Task {
  version: number
  url: string
  etag: string | null
  ics: string
}

function output<T>(result: CalDavResult<T>, what: string): T {
  if (!result.success) throw new Error(`${what} failed: ${JSON.stringify(result.error)}`)
  return result.output
}

/** A task text as an app writes it, under the given UID. */
function todo(uid: string, summary: string): string {
  const made = newTodo({ summary }, { now: NOW, uid, prodid: PRODID })
  if (!made.success) throw new Error(made.error.message)
  return serializeIcal(made.output)
}

/** `ics` with another summary, as a second device would save it. */
function renamed(ics: string, summary: string): string {
  const parsed = parseIcal(ics)
  if (!parsed.success) throw new Error(`parse failed: ${parsed.error.message}`)
  const done = patchTodo(parsed.output, { summary }, { now: NOW })
  if (!done.success) throw new Error(`patch failed: ${done.error.message}`)
  return serializeIcal(parsed.output)
}

const LOST: CalDavError = { code: CalDavErrorCode.Network, message: "the connection dropped" }

/**
 * An outbox over the write transport and `client`. `losing` decides what happens to the next
 * create: `answer` sends it and drops the server's answer, `request` never sends it.
 */
function queue(client: CalDavClient, calendarUrl: string) {
  const state = { losing: undefined as undefined | "answer" | "request" }
  const calls: string[] = []
  const known = new Map<string, string>()
  const writer: CalDavWriter = {
    getObject(url) {
      calls.push("get")
      return client.getObject(url)
    },
    updateObject(url, ics, etag) {
      calls.push("update")
      return client.updateObject(url, ics, etag)
    },
    deleteObject(url, etag) {
      calls.push("delete")
      return client.deleteObject(url, etag)
    },
    async createObject(calendar, ics, options) {
      calls.push("create")
      const losing = state.losing
      state.losing = undefined
      if (losing === "request") return { success: false, output: null, error: LOST }
      const created = await client.createObject(calendar, ics, options)
      if (losing === "answer") {
        output(created, "the create whose answer is dropped")
        return { success: false, output: null, error: LOST }
      }
      return created
    },
  }
  const transport = createCalDavWriteTransport<string, Task>({
    writer,
    calendarUrl: () => calendarUrl,
    urlOf: (entityId) => objectUrl(calendarUrl, entityId),
    etagOf: (command) => known.get(command.entityId),
    toIcs: (command) => command.payload,
    toEntity(object: CalDavObject, entityId) {
      if (object.etag !== null) known.set(entityId, object.etag)
      return { version: 2, url: object.url, etag: object.etag, ics: object.data }
    },
  })
  const outbox = createOutbox<string, Task>({
    store: createMemoryOutboxStore(),
    ...transport,
    lock: createPromiseLock(),
    canSend: () => true,
  })
  return { outbox, state, calls }
}

for (const server of SERVERS) {
  describe(`caldav write transport against ${server.name}`, () => {
    it("finishes the delete of a task whose create was never confirmed, and never deletes another device's edit", async () => {
      const settings = server.settings()
      await server.ready?.(settings)
      await requireReachable(settings.address)
      const login = await server.login(settings)
      const client = createCalDavClient({
        serverUrl: settings.baseUrl,
        auth: { username: login.username, password: login.password },
        // The test containers answer on plain http: on this machine.
        allowHttp: new URL(settings.baseUrl).protocol === "http:",
      })
      let calendarUrl: string | undefined
      try {
        const made = output(
          await client.makeCalendar(`${settings.baseUrl}${server.homePath(login.username)}`, {
            displayName: `zz caldav write ${uniqueSuffix()}`,
            components: ["VTODO"],
          }),
          "makeCalendar",
        )
        const calendar = calendarUrl = made.url
        const exists = async (id: string) => {
          const read = await client.getObject(objectUrl(calendar, id))
          if (read.success) return true
          assertEquals(read.error.code, CalDavErrorCode.NotFound)
          return false
        }

        // The create arrived and its answer was lost: the delete removes the task, with no card.
        // Run for a plain task and for one written by Tasks.org, which has an alarm.
        const texts = [
          todo(uuidV7(), "added, answer lost"),
          await Deno.readTextFile(TASKS_ORG_FIXTURE),
        ]
        for (const text of texts) {
          const { outbox, state, calls } = queue(client, calendar)
          const id = uuidV7()
          state.losing = "answer"
          assertEquals(
            (await outbox.submit({ kind: "create", entityId: id, payload: text })).kind,
            "queued",
          )
          assert(await exists(id), "the create did not reach the server")
          await outbox.submit({ kind: "delete", entityId: id, payload: text, version: 0 })
          assertEquals(outbox.entries(), [])
          assertEquals(calls, ["create", "get", "delete"])
          assert(!await exists(id), "the task is still on the server")
        }

        // The create never arrived: the delete is done after one read, and nothing is written.
        {
          const { outbox, state, calls } = queue(client, calendar)
          const id = uuidV7()
          const text = todo(uuidV7(), "added, never sent")
          state.losing = "request"
          await outbox.submit({ kind: "create", entityId: id, payload: text })
          assert(!await exists(id), "the create reached the server")
          await outbox.submit({ kind: "delete", entityId: id, payload: text, version: 0 })
          assertEquals(outbox.entries(), [])
          assertEquals(calls, ["create", "get"])
        }

        // Another device edited the task after the create arrived: a conflict, and the edit stays.
        {
          const { outbox, state, calls } = queue(client, calendar)
          const id = uuidV7()
          const text = todo(uuidV7(), "added, answer lost")
          state.losing = "answer"
          await outbox.submit({ kind: "create", entityId: id, payload: text })
          const url = objectUrl(calendar, id)
          const stored = output(await client.getObject(url), "the stored task")
          assert(stored.etag, "the server gave no etag")
          output(
            await client.updateObject(url, renamed(stored.data, "edited elsewhere"), stored.etag),
            "the other device's edit",
          )
          await outbox.submit({ kind: "delete", entityId: id, payload: text, version: 0 })
          const [entry] = outbox.entries()
          assertEquals([entry.kind, entry.status, entry.conflict?.reason], [
            "delete",
            "conflict",
            "version",
          ])
          assert(!calls.includes("delete"), "a delete was sent")
          const kept = output(await client.getObject(url), "the task after the conflict")
          assert(kept.data.includes("edited elsewhere"), kept.data)
        }
      } finally {
        try {
          if (calendarUrl) output(await client.deleteCalendar(calendarUrl), "deleteCalendar")
        } finally {
          await login.release()
        }
      }
    })
  })
}

/**
 * A calendar shared read-only, on Stalwart 0.16: it answers a guest's write with a 403 that has no
 * body and no header but `Date`, which is also what a proxy whose session ended may send. Radicale
 * is left out: the test container lets every login write everywhere, so it never refuses.
 */
describe("caldav write transport against Stalwart, on a calendar shared read-only", () => {
  it("makes a guest's refused write a rejected conflict, sends the write behind it, and keeps the owner's task", async () => {
    const settings = stalwartSettings()
    await waitForStalwart(settings)
    await requireReachable(settings.address)
    const users: Awaited<ReturnType<typeof createStalwartUser>>[] = []
    const allowHttp = new URL(settings.baseUrl).protocol === "http:"
    const clientOf = (user: { username: string; password: string }) =>
      createCalDavClient({ serverUrl: settings.baseUrl, auth: user, allowHttp })
    const homeOf = (username: string) =>
      `${settings.baseUrl}/dav/cal/${encodeURIComponent(username)}/`
    let cleanup: undefined | (() => Promise<unknown>)
    try {
      const owner = await createStalwartUser(settings, `itcaldavowner${uniqueSuffix()}`)
      users.push(owner)
      const guest = await createStalwartUser(settings, `itcaldavguest${uniqueSuffix()}`)
      users.push(guest)
      const asOwner = clientOf(owner)
      const asGuest = clientOf(guest)
      const calendarOf = async (client: CalDavClient, username: string) =>
        output(
          await client.makeCalendar(homeOf(username), {
            displayName: `zz caldav share ${uniqueSuffix()}`,
            components: ["VTODO"],
          }),
          "makeCalendar",
        ).url
      const shared = await calendarOf(asOwner, owner.username)
      const own = await calendarOf(asGuest, guest.username)
      cleanup = () => Promise.all([asOwner.deleteCalendar(shared), asGuest.deleteCalendar(own)])

      // The owner lets the guest read the calendar, and nothing else.
      const basic = btoa(
        String.fromCharCode(...new TextEncoder().encode(`${owner.username}:${owner.password}`)),
      )
      const acl = await fetch(shared, {
        method: "ACL",
        headers: { Authorization: `Basic ${basic}`, "Content-Type": "application/xml" },
        body:
          `<?xml version="1.0" encoding="utf-8"?><D:acl xmlns:D="DAV:"><D:ace><D:principal><D:href>/dav/pal/${
            encodeURIComponent(guest.username)
          }/</D:href></D:principal><D:grant><D:privilege><D:read/></D:privilege></D:grant></D:ace></D:acl>`,
      })
      await acl.body?.cancel()
      assert(acl.ok, `sharing the calendar failed with ${acl.status}`)

      const text = todo("shared-task", "the owner's task")
      output(await asOwner.createObject(shared, text, { name: "shared-task.ics" }), "owner's task")
      const taskUrl = objectUrl(shared, "shared-task")
      const stored = output(await asGuest.getObject(taskUrl), "the guest's read")
      assert(stored.etag, "the server gave no etag")

      // What the transport has to tell apart: the refusal names nothing.
      const refused = await asGuest.updateObject(taskUrl, renamed(text, "guest"), stored.etag)
      assert(!refused.success, "the guest's write was accepted")
      assertEquals(
        [refused.error.code, refused.error.status, refused.error.condition],
        [CalDavErrorCode.Forbidden, 403, undefined],
      )
      const held = output(await asGuest.getPrivileges!(taskUrl), "the guest's privileges")
      assert(held !== null && held.includes("read"), JSON.stringify(held))
      assert(!held.some((name) => ["all", "write", "write-content"].includes(name)), `${held}`)
      const full = output(await asOwner.getPrivileges!(taskUrl), "the owner's privileges")
      assert(full?.includes("write-content"), JSON.stringify(full))

      // The guest's queue: an edit of the owner's task, a new task in the shared calendar,
      // and behind them a new task in the guest's own calendar.
      const known = new Map([["shared-task", stored.etag]])
      const mineId = uuidV7()
      const urlOf = (id: string) => objectUrl(id === mineId ? own : shared, id)
      const transport = createCalDavWriteTransport<string, Task>({
        writer: asGuest,
        calendarUrl: (command) => command.entityId === mineId ? own : shared,
        urlOf,
        etagOf: (command) => known.get(command.entityId),
        toIcs: (command) => command.payload,
        toEntity: (object) => ({
          version: 2,
          url: object.url,
          etag: object.etag,
          ics: object.data,
        }),
      })
      let online = false
      const outbox = createOutbox<string, Task>({
        store: createMemoryOutboxStore(),
        ...transport,
        lock: createPromiseLock(),
        canSend: () => online,
      })
      await outbox.submit({
        kind: "update",
        entityId: "shared-task",
        payload: renamed(text, "the guest's edit"),
        version: 1,
      })
      const addedId = uuidV7()
      await outbox.submit({ kind: "create", entityId: addedId, payload: todo(uuidV7(), "added") })
      await outbox.submit({ kind: "create", entityId: mineId, payload: todo(uuidV7(), "mine") })
      online = true
      await outbox.flush()

      assertEquals(
        outbox.entries().map((entry) => [entry.entityId, entry.status, entry.conflict?.reason]),
        [["shared-task", "conflict", "rejected"], [addedId, "conflict", "rejected"]],
      )
      output(await asGuest.getObject(urlOf(mineId)), "the write queued behind the refused ones")
      const kept = output(await asOwner.getObject(taskUrl), "the owner's task")
      assert(kept.data.includes("the owner's task"), kept.data)
    } finally {
      try {
        await cleanup?.()
      } finally {
        for (const user of users) await deleteStalwartUser(settings, user)
      }
    }
  })
})
