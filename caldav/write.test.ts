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

  it("counts a repeated create as done when the object is the one it sent", async () => {
    const { send, state, objects, failureOf } = setup()
    state.dropAnswerOnce = true
    expect(await failureOf(send("create", "e1", "milk", 0))).toEqual({ kind: "unreachable" })
    const task = await send("create", "e1", "milk", 0)
    expect(objects.size).toBe(1)
    expect(task?.etag).toBe(`"1"`)
  })

  it("counts a repeated create as done when the server stored the text with properties reordered", async () => {
    const { send, state, objects, failureOf } = setup()
    state.dropAnswerOnce = true
    await failureOf(send("create", "e1", "milk", 0))
    const stored = objects.get(new URL(`${CALENDAR}e1.ics`).pathname)!
    stored.ics = stored.ics.replace("UID:e1\r\nSUMMARY:milk", "SUMMARY:milk\r\nUID;X-A=b:e1")
    expect(stored.ics).not.toBe(ics("milk", "e1"))
    const task = await send("create", "e1", "milk", 0)
    expect(task?.etag).toBe(`"1"`)
    expect(objects.size).toBe(1)
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

  it("reports not-found for an update with no known etag when the object is not on the server", async () => {
    const { send, seen, failureOf } = setup()
    expect(await failureOf(send("update", "never-seen"))).toEqual({ kind: "not-found" })
    expect(seen.map((s) => s.method)).toEqual(["GET"])
  })

  it("reads the object first when the etag is unknown and updates with the etag it returns", async () => {
    const { send, seen, state, known } = setup()
    state.omitEtag = true
    await send("create", "e1", "milk", 0)
    known.clear()
    state.omitEtag = false
    seen.length = 0
    const task = await send("update", "e1", "oat milk")
    expect(seen.map((s) => s.method)).toEqual(["GET", "PUT"])
    expect(seen[1].headers.get("If-Match")).toBe(`"1"`)
    expect(task?.etag).toBe(`"2"`)
  })

  it("reads the object first when the etag is unknown and deletes with the etag it returns", async () => {
    const { send, seen, objects, known } = setup()
    await send("create", "e1", "milk", 0)
    known.clear()
    seen.length = 0
    expect(await send("delete", "e1")).toBeUndefined()
    expect(seen.map((s) => s.method)).toEqual(["GET", "DELETE"])
    expect(seen[1].headers.get("If-Match")).toBe(`"1"`)
    expect(objects.size).toBe(0)
  })

  it("treats a delete with no known etag as done when the object is already gone", async () => {
    const { send, seen } = setup()
    expect(await send("delete", "never-seen")).toBeUndefined()
    expect(seen.map((s) => s.method)).toEqual(["GET"])
  })

  it("keeps an update or delete queued when the read for a missing etag fails", async () => {
    const { send, state, seen, failureOf } = setup()
    state.down = true
    expect(await failureOf(send("update", "e1"))).toEqual({ kind: "unreachable" })
    expect(await failureOf(send("delete", "e1"))).toEqual({ kind: "unreachable" })
    expect(seen.map((s) => s.method)).toEqual(["GET", "GET"])
  })
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
  it("is never asked to update or delete when no etag is known and the read gives none", async () => {
    const { transport } = scriptedWriter({
      getObject: (url) =>
        Promise.resolve({
          success: true,
          output: { url: String(url), etag: null, data: "" },
          error: null,
        }),
    })
    for (const kind of ["update", "delete"] as const) {
      const error = await transport.send(
        { kind, entityId: "e1", payload: "x", baseVersion: 1 },
        "k",
      )
        .catch((caught) => caught)
      expect(transport.classify(error).kind).toBe("rejected")
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
})
