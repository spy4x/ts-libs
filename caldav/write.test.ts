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
  type CalDavWriter,
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
    refused: new Set<string>(), // paths whose writes answer 403 with a DAV:error condition
    afterGet: undefined as undefined | (() => void), // runs once a GET has been answered
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
    if (method !== "GET" && state.refused.has(path)) {
      return Promise.resolve(new Response(REFUSAL, { status: 403 }))
    }
    const found = objects.get(path)
    if (method === "GET") {
      const answer = found
        ? new Response(found.ics, { headers: { ETag: `"${found.etag}"` } })
        : new Response(null, { status: 404 })
      state.afterGet?.()
      return Promise.resolve(answer)
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

/** What RFC 4791 answers a write the calendar will never take: a 403 that names the condition. */
const REFUSAL =
  '<?xml version="1.0" encoding="utf-8"?><D:error xmlns:D="DAV:"><C:supported-calendar-component xmlns:C="urn:ietf:params:xml:ns:caldav"/></D:error>'

const ics = (title: string, uid = "a") =>
  `BEGIN:VCALENDAR\r\nVERSION:2.0\r\nBEGIN:VTODO\r\nUID:${uid}\r\nSUMMARY:${title}\r\nEND:VTODO\r\nEND:VCALENDAR\r\n`

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
    toIcs: (command) => ics(command.payload, command.entityId),
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

  it("counts a repeated create as done, without writing again, when the server holds the text it sent", async () => {
    const { send, state, objects, seen, failureOf } = setup()
    state.dropAnswerOnce = true
    expect(await failureOf(send("create", "e1", "milk", 0))).toEqual({ kind: "unreachable" })
    const task = await send("create", "e1", "milk", 0)
    expect(objects.size).toBe(1)
    expect(task?.etag).toBe(`"1"`)
    expect(seen.map((s) => s.method)).toEqual(["PUT", "PUT", "GET"])
  })

  it("reports a version conflict and writes nothing when a repeated create carries an edit made since the first try", async () => {
    const { send, state, objects, seen, failureOf } = setup()
    state.dropAnswerOnce = true
    // The server stored "milk", but the answer was lost; the retry carries the corrected title.
    expect(await failureOf(send("create", "e1", "milk", 0))).toEqual({ kind: "unreachable" })
    expect(await failureOf(send("create", "e1", "bread", 0))).toEqual({ kind: "version" })
    expect(objects.get(new URL(`${CALENDAR}e1.ics`).pathname)).toEqual({
      ics: ics("milk", "e1"),
      etag: 1,
    })
    expect(seen.map((s) => s.method)).toEqual(["PUT", "PUT", "GET"])
  })

  it("reports a version conflict and keeps the server's copy when another device edited the task before the retry", async () => {
    const { send, state, objects, seen, failureOf } = setup()
    state.dropAnswerOnce = true
    await failureOf(send("create", "e1", "milk", 0))
    const path = new URL(`${CALENDAR}e1.ics`).pathname
    const elsewhere = ics("milk", "e1").replace("SUMMARY:milk", "SUMMARY:milk\r\nSTATUS:COMPLETED")
    objects.set(path, { ics: elsewhere, etag: 77 })
    // No edit on this device: the retry carries the text it first sent.
    expect(await failureOf(send("create", "e1", "milk", 0))).toEqual({ kind: "version" })
    expect(objects.get(path)).toEqual({ ics: elsewhere, etag: 77 })
    expect(seen.map((s) => s.method)).toEqual(["PUT", "PUT", "GET"])
  })

  it("counts a repeated create as done when the server stored the same lines in another order", async () => {
    const { send, state, objects, seen, failureOf } = setup()
    state.dropAnswerOnce = true
    await failureOf(send("create", "e1", "milk", 0))
    const stored = objects.get(new URL(`${CALENDAR}e1.ics`).pathname)!
    stored.ics = stored.ics.replace("UID:e1\r\nSUMMARY:milk", "SUMMARY:milk\r\nUID:e1")
    expect(stored.ics).not.toBe(ics("milk", "e1"))
    const task = await send("create", "e1", "milk", 0)
    expect(task?.etag).toBe(`"1"`)
    expect(task?.ics).toBe(stored.ics)
    expect(seen.map((s) => s.method)).toEqual(["PUT", "PUT", "GET"])
  })

  it("counts a repeated create as done when the server folded the UID line", async () => {
    const { send, state, objects, failureOf } = setup()
    state.dropAnswerOnce = true
    await failureOf(send("create", "e1", "milk", 0))
    const stored = objects.get(new URL(`${CALENDAR}e1.ics`).pathname)!
    stored.ics = stored.ics.replace("UID:e1\r\n", "UID:e\r\n 1\r\n")
    const task = await send("create", "e1", "milk", 0)
    expect(task?.etag).toBe(`"1"`)
    expect(objects.size).toBe(1)
  })

  it("refuses a create whose file name is held by an object with another UID, leaving it untouched", async () => {
    const { send, objects, seen, failureOf } = setup()
    const path = new URL(`${CALENDAR}e1.ics`).pathname
    objects.set(path, { ics: ics("milk", "other"), etag: 7 })
    const failure = await failureOf(send("create", "e1", "milk", 0))
    expect(failure.kind).toBe("rejected")
    expect(objects.get(path)).toEqual({ ics: ics("milk", "other"), etag: 7 })
    expect(seen.map((s) => s.method)).toEqual(["PUT", "GET"])
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

  it("updates and deletes an object whose entity id is a UID that is not a file name", async () => {
    const { send, seen, objects, known } = setup()
    const path = "/dav/cal/me/tasks/from-phone.ics"
    const uid = "8a1c2f@google.com"
    objects.set(path, { ics: ics("from phone", uid), etag: 7 })
    known.set(uid, { url: `${SERVER}${path}`, etag: `"7"` })
    const task = await send("update", uid, "edited")
    expect(seen[0].method).toBe("PUT")
    expect(seen[0].url).toBe(`${SERVER}${path}`)
    expect(seen[0].headers.get("If-Match")).toBe(`"7"`)
    expect(objects.get(path)!.ics).toContain("SUMMARY:edited")
    expect(await send("delete", uid)).toBeUndefined()
    expect(seen[1].method).toBe("DELETE")
    expect(objects.size).toBe(0)
    expect(task?.etag).toBe(`"1"`)
  })

  for (const kind of ["update", "delete"] as const) {
    it(`answers version and sends nothing for a ${kind} with no known etag, leaving another device's edit untouched`, async () => {
      const { send, seen, objects, known, failureOf } = setup()
      await send("create", "e1", "milk", 0)
      known.clear()
      const path = new URL(`${CALENDAR}e1.ics`).pathname
      objects.set(path, { ics: ics("edited on the phone", "e1"), etag: 50 })
      seen.length = 0
      expect(await failureOf(send(kind, "e1", "oat milk"))).toEqual({ kind: "version" })
      expect(seen).toEqual([])
      expect(objects.get(path)).toEqual({ ics: ics("edited on the phone", "e1"), etag: 50 })
    })
  }
})

/** A writer that records the names it is given and answers as scripted. */
function scriptedWriter(
  answers: Partial<CalDavWriter> = {},
  toIcs = (command: CalDavWriteCommand<string>) => ics(command.payload, command.entityId),
) {
  const names: string[] = []
  const fail = (code: CalDavErrorCode) => ({
    success: false as const,
    output: null,
    error: { code, message: "scripted" },
  })
  const writer: CalDavWriter = {
    createObject: (_calendar, _ics, options) => {
      names.push(options?.name ?? "")
      return Promise.resolve(fail(CalDavErrorCode.AlreadyExists))
    },
    getObject: () => Promise.resolve(fail(CalDavErrorCode.Network)),
    updateObject: () => Promise.reject(new Error("must not be called")),
    deleteObject: () => Promise.reject(new Error("must not be called")),
    ...answers,
  }
  const transport = createCalDavWriteTransport<string, Task>({
    writer,
    calendarUrl: () => CALENDAR,
    urlOf: (id) => objectUrl(CALENDAR, id),
    etagOf: () => null,
    toIcs,
    toEntity: () => {
      throw new Error("unused")
    },
  })
  return { transport, names }
}

describe("a writer that does not check anything itself", () => {
  it("is never asked to read, update or delete when no etag is known: the answer is version", async () => {
    const { transport } = scriptedWriter({
      getObject: () => Promise.reject(new Error("must not be called")),
    })
    for (const kind of ["update", "delete"] as const) {
      const error = await transport.send(
        { kind, entityId: "e1", payload: "x", baseVersion: 1 },
        "k",
      )
        .catch((caught) => caught)
      expect(transport.classify(error).kind).toBe("version")
    }
  })

  it("never creates under an entity id that is not a plain file name", async () => {
    const { transport, names } = scriptedWriter()
    const bad = [
      "../x",
      "a/b",
      "..",
      ".",
      "",
      "%2e%2e",
      "é",
      "a b",
      "x?y",
      "a\\b",
      "8a1c2f@google.com",
    ]
    for (const entityId of bad) {
      const error = await transport.send(
        { kind: "create", entityId, payload: "x", baseVersion: 0 },
        "k",
      ).catch((caught) => caught)
      expect(transport.classify(error).kind, entityId).toBe("rejected")
    }
    expect(names).toEqual([])
    // A plain name does reach the writer.
    await transport.send({ kind: "create", entityId: "ok-1", payload: "x", baseVersion: 0 }, "k")
      .catch(() => {})
    expect(names).toEqual(["ok-1.ics"])
  })

  it("refuses a repeated create when neither text has a UID, as it cannot tell the objects apart", async () => {
    const noUid = "BEGIN:VCALENDAR\r\nBEGIN:VTODO\r\nSUMMARY:x\r\nEND:VTODO\r\nEND:VCALENDAR\r\n"
    const { transport } = scriptedWriter({
      getObject: (url) =>
        Promise.resolve({
          success: true as const,
          output: { url: String(url), etag: `"3"`, data: noUid },
          error: null,
        }),
    }, () => noUid)
    const error = await transport.send(
      { kind: "create", entityId: "e1", payload: "x", baseVersion: 0 },
      "k",
    ).catch((caught) => caught)
    expect(transport.classify(error).kind).toBe("rejected")
  })

  it("reads a repeated create whose follow-up read lost the connection as unreachable", async () => {
    const { transport } = scriptedWriter()
    const error = await transport.send(
      { kind: "create", entityId: "e1", payload: "x", baseVersion: 0 },
      "k",
    ).catch((caught) => caught)
    expect(transport.classify(error)).toEqual({ kind: "unreachable" })
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

describe("delete of a task whose create the server never confirmed", () => {
  const PATH = new URL(`${CALENDAR}e1.ics`).pathname

  /** A transport whose create of `e1` was sent as "milk"; `arrived` says whether it got there. */
  async function lostCreate(arrived: boolean) {
    const t = setup()
    if (arrived) t.state.dropAnswerOnce = true
    else t.state.status = 503
    expect(await t.failureOf(t.send("create", "e1", "milk", 0))).toEqual({ kind: "unreachable" })
    t.state.status = 0
    t.seen.length = 0
    const remove = (ownCreates: string[] = ["milk"]) =>
      t.transport.send(
        { kind: "delete", entityId: "e1", payload: "milk", baseVersion: 1, ownCreates },
        "key",
      )
    return { ...t, remove }
  }

  it("deletes the object with the etag just read when it is the text this device sent", async () => {
    const { remove, seen, objects } = await lostCreate(true)
    expect(await remove()).toBeUndefined()
    expect(seen.map((s) => s.method)).toEqual(["GET", "DELETE"])
    expect(seen[1].headers.get("If-Match")).toBe(`"1"`)
    expect(objects.size).toBe(0)
  })

  it("is done, sending nothing that changes the server, when the create never arrived", async () => {
    const { remove, seen, objects } = await lostCreate(false)
    expect(await remove()).toBeUndefined()
    expect(seen.map((s) => s.method)).toEqual(["GET"])
    expect(objects.size).toBe(0)
  })

  it("reports a version conflict and deletes nothing when another device edited the task", async () => {
    const { remove, seen, objects, failureOf } = await lostCreate(true)
    objects.set(PATH, { ics: ics("rival", "e1"), etag: 2 })
    expect(await failureOf(remove())).toEqual({ kind: "version" })
    expect(seen.map((s) => s.method)).toEqual(["GET"])
    expect(objects.get(PATH)?.ics).toContain("rival")
  })

  it("reports a version conflict and deletes nothing when a different task sits at the address", async () => {
    const { remove, seen, objects, failureOf } = await lostCreate(false)
    objects.set(PATH, { ics: ics("milk", "someone-else"), etag: 2 })
    expect(await failureOf(remove())).toEqual({ kind: "version" })
    expect(seen.map((s) => s.method)).toEqual(["GET"])
    expect(objects.size).toBe(1)
  })

  it("deletes the object when it is any one of the texts the create was sent with", async () => {
    const { remove, objects } = await lostCreate(false)
    objects.set(PATH, { ics: ics("oat milk", "e1"), etag: 3 })
    expect(await remove(["milk", "oat milk"])).toBeUndefined()
    expect(objects.size).toBe(0)
  })

  it("deletes the object when the server stored the sent lines in another order", async () => {
    const { remove, objects } = await lostCreate(true)
    objects.get(PATH)!.ics =
      "BEGIN:VCALENDAR\r\nVERSION:2.0\r\nBEGIN:VTODO\r\nSUMMARY:milk\r\nUID:e1\r\nEND:VTODO\r\nEND:VCALENDAR\r\n"
    expect(await remove()).toBeUndefined()
    expect(objects.size).toBe(0)
  })

  it("goes by the server's text as it is now: changed onwards is a conflict, changed back is deleted with the new etag", async () => {
    const { remove, seen, objects, failureOf } = await lostCreate(true)
    // Another device changed the task since: the older text this device sent no longer counts.
    objects.set(PATH, { ics: ics("rival", "e1"), etag: 4 })
    expect(await failureOf(remove(["milk", "oat milk"]))).toEqual({ kind: "version" })
    expect(objects.size).toBe(1)
    // It changed the task back: the copy is the sent text again, under an etag of its own.
    objects.set(PATH, { ics: ics("milk", "e1"), etag: 5 })
    expect(await remove(["milk", "oat milk"])).toBeUndefined()
    expect(seen[seen.length - 1].headers.get("If-Match")).toBe(`"5"`)
    expect(objects.size).toBe(0)
  })

  it("reports a version conflict and deletes nothing when the task changes between the read and the delete", async () => {
    const { remove, seen, objects, state, failureOf } = await lostCreate(true)
    state.afterGet = () => {
      state.afterGet = undefined
      objects.set(PATH, { ics: ics("rival", "e1"), etag: 6 })
    }
    expect(await failureOf(remove())).toEqual({ kind: "version" })
    expect(seen.map((s) => s.method)).toEqual(["GET", "DELETE"])
    expect(seen[1].headers.get("If-Match")).toBe(`"1"`)
    expect(objects.get(PATH)?.ics).toContain("rival")
  })

  it("stays queued when the server cannot be read", async () => {
    const { remove, objects, state, failureOf } = await lostCreate(true)
    state.down = true
    expect(await failureOf(remove())).toEqual({ kind: "unreachable" })
    expect(objects.size).toBe(1)
  })

  it("reports a version conflict and sends no delete when the read gives no etag", async () => {
    const calls: string[] = []
    const never = () => Promise.reject(new Error("not expected"))
    const transport = createCalDavWriteTransport<string, Task>({
      writer: {
        createObject: never,
        updateObject: never,
        deleteObject: () => {
          calls.push("delete")
          return never()
        },
        getObject: (url) => {
          calls.push("get")
          const object: CalDavObject = { url: String(url), etag: null, data: ics("milk", "e1") }
          return Promise.resolve({ success: true, output: object, error: null })
        },
      },
      calendarUrl: () => CALENDAR,
      urlOf: (id) => objectUrl(CALENDAR, id),
      etagOf: () => undefined,
      toIcs: (command) => ics(command.payload, command.entityId),
      toEntity: (object) => ({ version: 1, url: object.url, etag: object.etag, ics: object.data }),
    })
    let failure: CalDavSendFailure | undefined
    try {
      await transport.send(
        { kind: "delete", entityId: "e1", payload: "milk", baseVersion: 1, ownCreates: ["milk"] },
        "key",
      )
    } catch (error) {
      failure = transport.classify(error)
    }
    expect(failure).toEqual({ kind: "version" })
    expect(calls).toEqual(["get"])
  })
})

describe("answers", () => {
  const statuses: [number, SendFailure["kind"]][] = [
    [500, "unreachable"],
    [503, "unreachable"],
    [408, "unreachable"],
    [429, "unreachable"],
    [401, "unreachable"],
    [403, "unreachable"],
    [404, "not-found"],
    [400, "rejected"],
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

  it("reads a 403 that names a DAV:error condition on an update as rejected", async () => {
    const { send, state, failureOf } = setup()
    await send("create", "e1", "milk", 0)
    state.refused.add(new URL(`${CALENDAR}e1.ics`).pathname)
    expect(await failureOf(send("update", "e1", "x"))).toEqual({
      kind: "rejected",
      message: "the server forbids this",
    })
  })

  it("reads a 403 with a condition that a relay reports as a plain server error as rejected", () => {
    const failure = classifyCalDavError({
      code: CalDavErrorCode.Server,
      message: "x",
      status: 403,
      condition: "need-privileges",
    })
    expect(failure).toEqual({ kind: "rejected", message: "x" })
  })

  it("reads a 401 or 403 that a relay reports as a plain server error as unreachable", () => {
    for (const status of [401, 403]) {
      const failure = classifyCalDavError({ code: CalDavErrorCode.Server, message: "x", status })
      expect(failure, `${status}`).toEqual({ kind: "unreachable" })
    }
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

  it("deletes a task whose create's answer was lost, with no conflict, once the connection is back", async () => {
    const { outbox, state, objects } = queue()
    state.dropAnswerOnce = true
    await outbox.submit({ kind: "create", entityId: "e1", payload: "milk" })
    expect(objects.size).toBe(1)
    state.down = true
    await outbox.submit({ kind: "delete", entityId: "e1", payload: "milk", version: 0 })
    expect(outbox.entries().map((entry) => entry.kind)).toEqual(["delete"])
    state.down = false
    await outbox.flush()
    expect(objects.size).toBe(0)
    expect(outbox.entries()).toEqual([])
  })

  it("empties the queue, changing nothing on the server, for a deleted task whose create never arrived", async () => {
    const { outbox, state, objects, seen } = queue()
    state.status = 503
    await outbox.submit({ kind: "create", entityId: "e1", payload: "milk" })
    state.status = 0
    state.down = true
    await outbox.submit({ kind: "delete", entityId: "e1", payload: "milk", version: 0 })
    expect(outbox.entries().map((entry) => entry.kind)).toEqual(["delete"])
    state.down = false
    seen.length = 0
    await outbox.flush()
    expect(seen.map((s) => s.method)).toEqual(["GET"])
    expect(objects.size).toBe(0)
    expect(outbox.entries()).toEqual([])
  })

  it("shows a deleted task that another device edited after the lost create as a conflict, and deletes nothing", async () => {
    const { outbox, state, objects } = queue()
    state.dropAnswerOnce = true
    await outbox.submit({ kind: "create", entityId: "e1", payload: "milk" })
    const path = new URL(`${CALENDAR}e1.ics`).pathname
    objects.set(path, { ics: ics("rival", "e1"), etag: 9 })
    await outbox.submit({ kind: "delete", entityId: "e1", payload: "milk", version: 0 })
    const [entry] = outbox.entries()
    expect([entry.kind, entry.status, entry.conflict?.reason]).toEqual([
      "delete",
      "conflict",
      "version",
    ])
    expect(entry.conflict?.server?.ics).toContain("rival")
    expect(objects.get(path)?.ics).toContain("rival")
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

  it("shows an edit with no known etag as a conflict with the server's copy and does not overwrite it", async () => {
    const { outbox, objects, known, state } = queue()
    await outbox.submit({ kind: "create", entityId: "e1", payload: "milk" })
    known.clear()
    const path = new URL(`${CALENDAR}e1.ics`).pathname
    objects.set(path, { ics: ics("edited on the phone", "e1"), etag: 50 })
    state.down = true
    await outbox.submit({ kind: "update", entityId: "e1", payload: "oat milk", version: 1 })
    state.down = false
    await outbox.flush()
    const [entry] = await outbox.entries()
    expect(entry.status).toBe("conflict")
    expect(entry.conflict?.reason).toBe("version")
    expect(entry.conflict?.server?.ics).toContain("edited on the phone")
    expect(objects.get(path)!.ics).toContain("edited on the phone")
  })

  it("shows an edit made after a create's answer was lost as a conflict with the server's copy, and keepMine puts the edit on the server", async () => {
    const { outbox, state, objects } = queue()
    state.dropAnswerOnce = true
    await outbox.submit({ kind: "create", entityId: "e1", payload: "milk" })
    const path = new URL(`${CALENDAR}e1.ics`).pathname
    expect(objects.get(path)!.ics).toBe(ics("milk", "e1"))
    state.down = true
    await outbox.submit({ kind: "update", entityId: "e1", payload: "bread", version: 0 })
    state.down = false
    await outbox.flush()
    const [entry] = await outbox.entries()
    expect([entry.status, entry.conflict?.reason, entry.payload]).toEqual([
      "conflict",
      "version",
      "bread",
    ])
    expect(entry.conflict?.server?.ics).toBe(ics("milk", "e1"))
    expect(objects.get(path)!.ics).toBe(ics("milk", "e1"))
    await outbox.keepMine(entry)
    expect(objects.get(path)!.ics).toBe(ics("bread", "e1"))
    expect(await outbox.entries()).toEqual([])
  })

  it("makes a write refused with a 403 condition a rejected conflict and sends the writes queued behind it", async () => {
    const { outbox, state, objects } = queue()
    state.down = true
    await outbox.submit({ kind: "create", entityId: "e1", payload: "milk" })
    await outbox.submit({ kind: "create", entityId: "e2", payload: "bread" })
    state.down = false
    state.refused.add(new URL(`${CALENDAR}e1.ics`).pathname)
    await outbox.flush()
    const entries = await outbox.entries()
    expect(entries.map((entry) => [entry.entityId, entry.status, entry.conflict?.reason])).toEqual([
      ["e1", "conflict", "rejected"],
    ])
    expect([...objects.keys()]).toEqual([new URL(`${CALENDAR}e2.ics`).pathname])
  })

  for (const status of [401, 403]) {
    it(`keeps an offline edit pending when the server answers ${status}`, async () => {
      const { outbox, state } = queue()
      await outbox.submit({ kind: "create", entityId: "e1", payload: "milk" })
      state.down = true
      await outbox.submit({ kind: "update", entityId: "e1", payload: "oat milk", version: 1 })
      state.down = false
      state.status = status
      await outbox.flush()
      const [entry] = await outbox.entries()
      expect(entry.status).toBe("pending")
      state.status = 0
      await outbox.flush()
      expect(await outbox.entries()).toEqual([])
    })
  }
})

describe("a path-only calendar address", () => {
  it("objectUrl keeps a path-only address path-only and encodes the file name", () => {
    expect(objectUrl("/dav/cal/me/tasks/", "e1")).toBe("/dav/cal/me/tasks/e1.ics")
    expect(objectUrl("/dav/cal/me/tasks", "a b")).toBe("/dav/cal/me/tasks/a%20b.ics")
  })

  it("objectUrl still resolves an absolute address against its host", () => {
    expect(objectUrl(CALENDAR, "e1")).toBe(`${CALENDAR}e1.ics`)
    expect(objectUrl(new URL(CALENDAR), "e1")).toBe(`${CALENDAR}e1.ics`)
  })

  it("hands the writer only paths for a create, a repeated create, an update and a delete", async () => {
    const urls: string[] = []
    const stored = new Map<string, string>()
    const ok = <T>(output: T) => Promise.resolve({ success: true as const, output, error: null })
    const writer: CalDavWriter = {
      createObject: (calendar, text, options) => {
        urls.push(String(calendar))
        const url = `${calendar}${options?.name}`
        if (stored.has(url)) {
          return Promise.resolve({
            success: false as const,
            output: null,
            error: { code: CalDavErrorCode.AlreadyExists, message: "taken" },
          })
        }
        stored.set(url, text)
        return ok({ url, etag: `"1"`, data: text })
      },
      getObject: (url) => {
        urls.push(String(url))
        return ok({ url: String(url), etag: `"1"`, data: stored.get(String(url)) ?? "" })
      },
      updateObject: (url, text) => {
        urls.push(String(url))
        return ok({ url: String(url), etag: `"2"`, data: text })
      },
      deleteObject: (url) => {
        urls.push(String(url))
        return ok(null)
      },
    }
    const calendar = "/dav/cal/me/tasks/"
    const transport = createCalDavWriteTransport<string, Task>({
      writer,
      calendarUrl: () => calendar,
      urlOf: (id) => objectUrl(calendar, id),
      etagOf: () => `"1"`,
      toIcs: (command) => ics(command.payload, command.entityId),
      toEntity: (object) => ({ version: 1, url: object.url, etag: object.etag, ics: object.data }),
    })
    const command = (kind: CalDavWriteCommand<string>["kind"]) => ({
      kind,
      entityId: "e1",
      payload: "milk",
      baseVersion: 1,
    })
    await transport.send(command("create"), "k")
    await transport.send(command("create"), "k")
    await transport.send(command("update"), "k")
    await transport.send(command("delete"), "k")
    expect(urls.length).toBe(5)
    expect(urls.every((url) => url.startsWith("/dav/cal/me/tasks/"))).toBe(true)
  })

  for (
    const address of [
      "/.//h/",
      "/a/..//h/",
      "/a/%2e%2e/%2e%2e//h/",
      "/\\h/x/",
      "//h/x/",
    ]
  ) {
    it(`objectUrl refuses ${address} instead of returning an address on another host`, () => {
      expect(() => objectUrl(address, "e1")).toThrow()
    })
  }

  it("objectUrl normalises dot segments inside a path and never starts with //", () => {
    expect(objectUrl("/a/../b/./c/", "e1")).toBe("/b/c/e1.ics")
  })

  for (const address of ["/a/..//other.example/x/", "/\\other.example/x/", "not a url"]) {
    it(`a create with the address ${address} sends no request and is rejected, not left pending`, async () => {
      const calls: string[] = []
      const record = (name: string) => () => {
        calls.push(name)
        return Promise.reject(new Error("must not be called"))
      }
      const transport = createCalDavWriteTransport<string, Task>({
        writer: {
          createObject: record("createObject"),
          getObject: record("getObject"),
          updateObject: record("updateObject"),
          deleteObject: record("deleteObject"),
        },
        calendarUrl: () => address,
        urlOf: (id) => id,
        etagOf: () => `"1"`,
        toIcs: (command) => ics(command.payload, command.entityId),
        toEntity: () => {
          throw new Error("unused")
        },
      })
      const error = await transport
        .send({ kind: "create", entityId: "e1", payload: "milk", baseVersion: 0 }, "k")
        .catch((caught) => caught)
      expect(transport.classify(error).kind).toBe("rejected")
      expect(calls).toEqual([])
    })
  }
})
