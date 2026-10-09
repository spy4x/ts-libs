// Behaviour tests for the CalDAV write transport against a fake CalDAV server that honours
// `If-Match` and `If-None-Match`, and against a real outbox so the failure shapes are proven to fit.

import { expect } from "@std/expect"
import { describe, it } from "@std/testing/bdd"
import {
  createMemoryOutboxStore,
  createOutbox,
  createPromiseLock,
  type OutboxCommand,
  type SendFailure,
} from "../realtime/outbox.ts"
import { type CalDavObject, createCalDavClient } from "./client.ts"
import {
  type CalDavSendFailure,
  type CalDavWriteCommand,
  classifyCalDavError,
  createCalDavWriteTransport,
  objectUrl,
} from "./write.ts"
import { CalDavErrorCode } from "./client.ts"

const SERVER = "https://dav.example.com"
const CALENDAR = `${SERVER}/dav/cal/me/tasks/`

interface Task {
  version: number
  url: string
  etag: string | null
  ics: string
}

interface Seen {
  method: string
  url: string
  headers: Headers
  body: string | null
}

/** A CalDAV server in memory: objects by path, numbered etags, and a switch for each outage. */
function fakeServer() {
  const objects = new Map<string, { ics: string; etag: number }>()
  const seen: Seen[] = []
  const state = {
    down: false,
    status: 0, // when set, every request answers with it
    omitEtag: false,
    dropAnswerOnce: false, // applies the PUT, then loses the answer
  }
  let counter = 0
  const fakeFetch: typeof fetch = (input, init) => {
    const url = new URL(String(input))
    const method = init?.method ?? "GET"
    const headers = new Headers(init?.headers)
    seen.push({
      method,
      url: url.href,
      headers,
      body: typeof init?.body === "string" ? init.body : null,
    })
    if (state.down) return Promise.reject(new TypeError("offline"))
    if (state.status) return Promise.resolve(new Response("no", { status: state.status }))
    const path = url.pathname
    const found = objects.get(path)
    if (method === "GET") {
      return Promise.resolve(
        found
          ? new Response(found.ics, { headers: { ETag: `"${found.etag}"` } })
          : new Response(null, { status: 404 }),
      )
    }
    const ifMatch = headers.get("If-Match")
    const ifNoneMatch = headers.get("If-None-Match")
    if (ifNoneMatch === "*" && found) return Promise.resolve(new Response(null, { status: 412 }))
    if (ifMatch !== null && (!found || ifMatch !== `"${found.etag}"`)) {
      return Promise.resolve(new Response(null, { status: found ? 412 : 404 }))
    }
    if (method === "DELETE") {
      if (!found) return Promise.resolve(new Response(null, { status: 404 }))
      objects.delete(path)
      return Promise.resolve(new Response(null, { status: 204 }))
    }
    objects.set(path, { ics: String(init?.body), etag: ++counter })
    if (state.dropAnswerOnce) {
      state.dropAnswerOnce = false
      return Promise.reject(new TypeError("connection lost"))
    }
    const reply = new Headers()
    if (!state.omitEtag) reply.set("ETag", `"${counter}"`)
    return Promise.resolve(new Response(null, { status: 201, headers: reply }))
  }
  const client = createCalDavClient({
    serverUrl: SERVER,
    auth: { username: "me", password: "pw" },
    fetch: fakeFetch,
  })
  return { client, objects, seen, state }
}

const ics = (title: string) =>
  `BEGIN:VCALENDAR\r\nVERSION:2.0\r\nBEGIN:VTODO\r\nUID:a\r\nSUMMARY:${title}\r\nEND:VTODO\r\nEND:VCALENDAR\r\n`

/** Wires the transport the way an app would: the app's cache is a map of entity to last etag. */
function setup() {
  const server = fakeServer()
  const known = new Map<string, { url: string; etag: string }>()
  const toEntity = (object: CalDavObject, entityId: string): Task => {
    if (object.etag !== null) known.set(entityId, { url: object.url, etag: object.etag })
    return {
      version: object.etag === null ? 1 : Number(object.etag.replaceAll(`"`, "")),
      url: object.url,
      etag: object.etag,
      ics: object.data,
    }
  }
  const transport = createCalDavWriteTransport<string, Task>({
    writer: server.client,
    calendarUrl: () => CALENDAR,
    urlOf: (id) => known.get(id)?.url ?? objectUrl(CALENDAR, id),
    etagOf: (command) => known.get(command.entityId)?.etag,
    toIcs: (command) => ics(command.payload),
    toEntity,
  })
  const send = (kind: CalDavWriteCommand<string>["kind"], id: string, title = "t", base = 1) =>
    transport.send({ kind, entityId: id, payload: title, baseVersion: base }, "key")
  const failureOf = async (work: Promise<unknown>): Promise<CalDavSendFailure> => {
    try {
      await work
    } catch (error) {
      return transport.classify(error)
    }
    throw new Error("expected the send to fail")
  }
  return { ...server, transport, known, send, failureOf }
}

describe("create", () => {
  it("puts the object under the entity's name with If-None-Match: * and returns its new etag", async () => {
    const { send, seen } = setup()
    const task = await send("create", "e1", "milk", 0)
    expect(seen[0].method).toBe("PUT")
    expect(seen[0].url).toBe(`${CALENDAR}e1.ics`)
    expect(seen[0].headers.get("If-None-Match")).toBe("*")
    expect(seen[0].headers.get("If-Match")).toBeNull()
    expect(task?.etag).toBe(`"1"`)
  })

  it("reads the etag back when the server sent none", async () => {
    const { send, state, seen } = setup()
    state.omitEtag = true
    const task = await send("create", "e1", "milk", 0)
    expect(seen.map((s) => s.method)).toEqual(["PUT", "GET"])
    expect(task?.etag).toBe(`"1"`)
  })

  it("counts a repeated create as done when the object is the one it sent", async () => {
    const { send, state, objects, failureOf } = setup()
    state.dropAnswerOnce = true
    expect(await failureOf(send("create", "e1", "milk", 0))).toEqual({ kind: "unreachable" })
    const task = await send("create", "e1", "milk", 0)
    expect(objects.size).toBe(1)
    expect(task?.etag).toBe(`"1"`)
  })

  it("reports an address taken by different content as already-exists", async () => {
    const { send, failureOf } = setup()
    await send("create", "e1", "milk", 0)
    expect(await failureOf(send("create", "e1", "bread", 0))).toEqual({ kind: "already-exists" })
  })
})

describe("update", () => {
  it("puts with If-Match set to the etag the write is based on", async () => {
    const { send, seen } = setup()
    await send("create", "e1", "milk", 0)
    const task = await send("update", "e1", "oat milk")
    expect(seen[1].headers.get("If-Match")).toBe(`"1"`)
    expect(seen[1].headers.get("If-None-Match")).toBeNull()
    expect(task?.etag).toBe(`"2"`)
  })

  it("reports a version conflict when the object changed on the server", async () => {
    const { send, objects, failureOf } = setup()
    await send("create", "e1", "milk", 0)
    objects.get(new URL(`${CALENDAR}e1.ics`).pathname)!.etag = 9
    expect(await failureOf(send("update", "e1", "oat milk"))).toEqual({ kind: "version" })
  })

  it("reports not-found when the object was deleted on the server", async () => {
    const { send, objects, failureOf } = setup()
    await send("create", "e1", "milk", 0)
    objects.clear()
    expect(await failureOf(send("update", "e1", "oat milk"))).toEqual({ kind: "not-found" })
  })

  it("refuses to send without an etag instead of overwriting blind", async () => {
    const { send, seen, failureOf } = setup()
    const failure = await failureOf(send("update", "never-seen"))
    expect(failure.kind).toBe("rejected")
    expect(seen.length).toBe(0)
  })
})

describe("delete", () => {
  it("deletes with If-Match and resolves nothing", async () => {
    const { send, seen, objects } = setup()
    await send("create", "e1", "milk", 0)
    expect(await send("delete", "e1")).toBeUndefined()
    expect(seen[1].method).toBe("DELETE")
    expect(seen[1].headers.get("If-Match")).toBe(`"1"`)
    expect(objects.size).toBe(0)
  })

  it("counts deleting what is already gone as success", async () => {
    const { send, objects } = setup()
    await send("create", "e1", "milk", 0)
    objects.clear()
    expect(await send("delete", "e1")).toBeUndefined()
  })

  it("reports a version conflict when the object changed on the server", async () => {
    const { send, objects, failureOf } = setup()
    await send("create", "e1", "milk", 0)
    objects.get(new URL(`${CALENDAR}e1.ics`).pathname)!.etag = 9
    expect(await failureOf(send("delete", "e1"))).toEqual({ kind: "version" })
    expect(objects.size).toBe(1)
  })
})

describe("answers", () => {
  const statuses: [number, SendFailure["kind"]][] = [
    [500, "unreachable"],
    [503, "unreachable"],
    [408, "unreachable"],
    [429, "unreachable"],
    [403, "rejected"],
    [413, "rejected"],
    [422, "rejected"],
  ]
  for (const [status, kind] of statuses) {
    it(`reads a ${status} on an update as ${kind}`, async () => {
      const { send, state, failureOf } = setup()
      await send("create", "e1", "milk", 0)
      state.status = status
      expect((await failureOf(send("update", "e1", "x"))).kind).toBe(kind)
    })
  }

  it("reads a lost connection as unreachable", async () => {
    const { send, state, failureOf } = setup()
    await send("create", "e1", "milk", 0)
    state.down = true
    expect(await failureOf(send("update", "e1", "x"))).toEqual({ kind: "unreachable" })
  })

  it("keeps the server's message in a rejection", () => {
    const failure = classifyCalDavError({
      code: CalDavErrorCode.UidConflict,
      message: "another object has this UID",
    })
    expect(failure).toEqual({ kind: "rejected", message: "another object has this UID" })
  })

  it("reads an error it did not throw as unreachable", () => {
    const { transport } = setup()
    expect(transport.classify(new Error("boom"))).toEqual({ kind: "unreachable" })
  })
})

describe("fetchServer", () => {
  it("returns the server's object, or null when it is gone", async () => {
    const { transport, send, objects } = setup()
    await send("create", "e1", "milk", 0)
    expect((await transport.fetchServer("e1"))?.etag).toBe(`"1"`)
    objects.clear()
    expect(await transport.fetchServer("e1")).toBeNull()
  })

  it("rejects when the server cannot be reached", async () => {
    const { transport, state } = setup()
    state.down = true
    await expect(transport.fetchServer("e1")).rejects.toThrow()
  })
})

describe("with the outbox", () => {
  function queue() {
    const t = setup()
    const outbox = createOutbox<string, Task>({
      store: createMemoryOutboxStore(),
      // The outbox's own command type must fit the transport's parameter.
      send: (command: OutboxCommand<string>, key) => t.transport.send(command, key),
      fetchServer: t.transport.fetchServer,
      classify: (error): SendFailure => t.transport.classify(error),
      lock: createPromiseLock(),
      canSend: () => !t.state.down,
    })
    return { ...t, outbox }
  }

  it("sends a create made offline when the connection is back", async () => {
    const { outbox, state, objects } = queue()
    state.down = true
    expect(await outbox.submit({ kind: "create", entityId: "e1", payload: "milk" })).toEqual({
      kind: "queued",
    })
    state.down = false
    await outbox.flush()
    expect(objects.size).toBe(1)
  })

  it("shows a task changed elsewhere as a conflict with the server's copy, and keepMine wins", async () => {
    const { outbox, objects, known, state } = queue()
    await outbox.submit({ kind: "create", entityId: "e1", payload: "milk" })
    state.down = true
    await outbox.submit({
      kind: "update",
      entityId: "e1",
      payload: "oat milk",
      version: 1,
    })
    objects.get(new URL(`${CALENDAR}e1.ics`).pathname)!.etag = 9
    objects.get(new URL(`${CALENDAR}e1.ics`).pathname)!.ics = ics("rival")
    state.down = false
    await outbox.flush()
    const [entry] = await outbox.entries()
    expect(entry.status).toBe("conflict")
    expect(entry.conflict?.reason).toBe("version")
    expect(entry.conflict?.server?.ics).toContain("rival")
    known.set("e1", { url: `${CALENDAR}e1.ics`, etag: `"9"` })
    await outbox.keepMine(entry)
    expect(objects.get(new URL(`${CALENDAR}e1.ics`).pathname)!.ics).toContain("oat milk")
  })
})
