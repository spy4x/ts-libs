// Behaviour tests for the CalDAV client against a scripted fake server: where credentials go,
// how redirects are handled, which writes are refused, and how each failure is reported.

import { assert, assertEquals, assertMatch } from "@std/assert"
import { describe, it } from "@std/testing/bdd"
import {
  type CalDavClientOptions,
  CalDavErrorCode,
  type CalDavResult,
  createCalDavClient,
} from "./client.ts"

const SERVER = "https://dav.example.com"
const HOME = `${SERVER}/dav/cal/user%40example.com/`
const INBOX = `${HOME}1.0%20%2F%20Inbox/`
const TASK = `${INBOX}3715224104002452840.ics`
const AUTH = { username: "user@example.com", password: "s3cret:é" }
const BASIC = `Basic ${
  btoa(String.fromCharCode(...new TextEncoder().encode("user@example.com:s3cret:é")))
}`

const fixture = (name: string) => Deno.readTextFile(new URL(`./testdata/${name}`, import.meta.url))

/** One request the fake server saw. */
interface Seen {
  method: string
  url: string
  headers: Headers
  body: string | null
  signal: AbortSignal | null
}

type Handler = (request: Seen) => Response | Promise<Response>

/** A client whose `fetch` records every request and answers through `handler`. */
function setup(handler: Handler, options: Partial<CalDavClientOptions> = {}) {
  const seen: Seen[] = []
  const fakeFetch: typeof fetch = async (input, init) => {
    // A fetch that follows redirects itself would carry the request to another origin unseen.
    if (init?.redirect !== "manual") throw new Error("the client must follow redirects itself")
    const request: Seen = {
      method: init?.method ?? "GET",
      url: String(input),
      headers: new Headers(init?.headers),
      body: typeof init?.body === "string" ? init.body : null,
      signal: init?.signal ?? null,
    }
    seen.push(request)
    return await handler(request)
  }
  const client = createCalDavClient({ serverUrl: SERVER, auth: AUTH, fetch: fakeFetch, ...options })
  return { client, seen }
}

const multistatus = (body: string) =>
  new Response(body, { status: 207, headers: { "Content-Type": "application/xml" } })

const redirect = (status: number, location: string) =>
  new Response(null, { status, headers: { Location: location } })

function output<T>(result: CalDavResult<T>): T {
  assert(result.success, `expected success, got ${JSON.stringify(result.error)}`)
  return result.output
}

function failure<T>(result: CalDavResult<T>) {
  assert(!result.success, `expected a failure, got ${JSON.stringify(result.output)}`)
  return result.error
}

const ICS =
  "BEGIN:VCALENDAR\r\nVERSION:2.0\r\nBEGIN:VTODO\r\nUID:a\r\nEND:VTODO\r\nEND:VCALENDAR\r\n"

describe("credentials", () => {
  it("sends Basic credentials, UTF-8 encoded, to the server's origin", async () => {
    const { client, seen } = setup(() => new Response(ICS, { headers: { ETag: `"1"` } }))
    output(await client.getObject(TASK))
    assertEquals(seen[0].headers.get("Authorization"), BASIC)
  })

  it("refuses a URL on another host, port or scheme before sending anything", async () => {
    const { client, seen } = setup(() => new Response(ICS))
    for (
      const url of [
        "https://evil.example.org/dav/cal/x.ics",
        "https://dav.example.com:8443/dav/cal/x.ics",
        "http://dav.example.com/dav/cal/x.ics",
      ]
    ) {
      assertEquals(failure(await client.getObject(url)).code, CalDavErrorCode.OutsideServer, url)
      assertEquals(
        failure(await client.deleteObject(url, `"1"`)).code,
        CalDavErrorCode.OutsideServer,
      )
      assertEquals(
        failure(await client.listObjects(url, { component: "VTODO" })).code,
        CalDavErrorCode.OutsideServer,
      )
    }
    assertEquals(seen.length, 0)
  })

  it("never follows a cross-origin redirect and reports its target", async () => {
    const { client, seen } = setup(() => redirect(302, "https://evil.example.org/steal"))
    const error = failure(await client.getObject(TASK))
    assertEquals(error.code, CalDavErrorCode.CrossOriginRedirect)
    assertEquals(error.target, "https://evil.example.org/steal")
    assertEquals(error.status, 302)
    assertEquals(seen.map((request) => new URL(request.url).origin), [SERVER])
  })

  it("follows a same-origin redirect with credentials, keeping the method and body", async () => {
    const { client, seen } = setup((request) =>
      request.url.endsWith("/old/")
        ? redirect(307, "/dav/cal/user%40example.com/")
        : multistatus(`<?xml version="1.0"?><D:multistatus xmlns:D="DAV:"/>`)
    )
    output(await client.listCalendars(`${SERVER}/old/`))
    assertEquals(seen.map((request) => [request.method, request.url]), [
      ["PROPFIND", `${SERVER}/old/`],
      ["PROPFIND", HOME],
    ])
    assertEquals(seen[1].headers.get("Authorization"), BASIC)
    assertEquals(seen[1].body, seen[0].body)
  })

  it("stops after maxRedirects same-origin redirects", async () => {
    const { client, seen } = setup(() => redirect(301, "/loop"), { maxRedirects: 2 })
    assertEquals(failure(await client.getObject(TASK)).code, CalDavErrorCode.TooManyRedirects)
    assertEquals(seen.length, 3)
  })

  it("refuses a principal href on another origin without requesting it", async () => {
    const { client, seen } = setup(() =>
      multistatus(
        `<D:multistatus xmlns:D="DAV:"><D:response><D:href>/</D:href><D:propstat><D:prop><D:current-user-principal><D:href>https://evil.example.org/p/</D:href></D:current-user-principal></D:prop><D:status>HTTP/1.1 200 OK</D:status></D:propstat></D:response></D:multistatus>`,
      )
    )
    assertEquals(failure(await client.discover()).code, CalDavErrorCode.OutsideServer)
    assert(seen.every((request) => new URL(request.url).origin === SERVER))
  })

  it("refuses a listing whose object href is on another origin", async () => {
    const { client } = setup(() =>
      multistatus(
        `<D:multistatus xmlns:D="DAV:" xmlns:C="urn:ietf:params:xml:ns:caldav"><D:response><D:href>https://evil.example.org/x.ics</D:href><D:propstat><D:prop><D:getetag>"1"</D:getetag><C:calendar-data>${ICS}</C:calendar-data></D:prop><D:status>HTTP/1.1 200 OK</D:status></D:propstat></D:response></D:multistatus>`,
      )
    )
    assertEquals(
      failure(await client.listObjects(INBOX, { component: "VTODO" })).code,
      CalDavErrorCode.OutsideServer,
    )
  })

  it("refuses a serverUrl carrying credentials or another scheme", () => {
    for (const serverUrl of ["https://u:p@dav.example.com", "ftp://dav.example.com", "nope"]) {
      let thrown = false
      try {
        createCalDavClient({ serverUrl, auth: AUTH })
      } catch (error) {
        thrown = error instanceof TypeError
      }
      assert(thrown, serverUrl)
    }
  })

  it("refuses a URL argument carrying a username or password before sending anything", async () => {
    const { client, seen } = setup(() => new Response(ICS))
    const url = "https://u:p@dav.example.com/dav/cal/x.ics"
    assertEquals(failure(await client.getObject(url)).code, CalDavErrorCode.InvalidArgument)
    assertEquals(
      failure(await client.deleteObject(url, `"1"`)).code,
      CalDavErrorCode.InvalidArgument,
    )
    assertEquals(seen.length, 0)
  })

  it("refuses a server href carrying a username or password", async () => {
    const { client } = setup(() =>
      multistatus(
        `<D:multistatus xmlns:D="DAV:" xmlns:C="urn:ietf:params:xml:ns:caldav"><D:response><D:href>https://u:p@dav.example.com/x.ics</D:href><D:propstat><D:prop><D:getetag>"1"</D:getetag><C:calendar-data>${ICS}</C:calendar-data></D:prop><D:status>HTTP/1.1 200 OK</D:status></D:propstat></D:response></D:multistatus>`,
      )
    )
    assertEquals(
      failure(await client.listObjects(INBOX, { component: "VTODO" })).code,
      CalDavErrorCode.Malformed,
    )
  })

  it("never follows a same-origin redirect whose Location carries credentials", async () => {
    const { client, seen } = setup(() => redirect(302, "https://u:p@dav.example.com/other.ics"))
    assertEquals(failure(await client.getObject(TASK)).code, CalDavErrorCode.Server)
    assertEquals(seen.length, 1)
  })

  it("refuses a limit that is not a positive integer", () => {
    const bad: Partial<CalDavClientOptions>[] = [
      { maxResponseBytes: 0 },
      { maxResponseBytes: Number.NaN },
      { timeoutMs: -1 },
      { timeoutMs: Infinity },
      { maxRedirects: -1 },
      { maxRedirects: 1.5 },
    ]
    for (const options of bad) {
      let thrown = false
      try {
        createCalDavClient({ serverUrl: SERVER, auth: AUTH, ...options })
      } catch (error) {
        thrown = error instanceof TypeError
      }
      assert(thrown, JSON.stringify(options))
    }
  })
})

describe("discover", () => {
  it("finds the principal and home from the bare host through .well-known", async () => {
    const principal = await fixture("stalwart-propfind-principal.xml")
    const { client, seen } = setup((request) => {
      const path = new URL(request.url).pathname
      if (path === "/.well-known/caldav") return redirect(307, "/dav/cal")
      if (path === "/dav/cal") return multistatus(principal)
      return multistatus(
        principal.replace("<D:href>/dav/cal/</D:href>", `<D:href>${path}</D:href>`),
      )
    })
    assertEquals(output(await client.discover()), {
      principalUrl: `${SERVER}/dav/pal/user%40example.com/`,
      homeUrls: [HOME],
    })
    assertEquals(seen.map((request) => new URL(request.url).pathname), [
      "/.well-known/caldav",
      "/dav/cal",
      "/dav/pal/user%40example.com/",
    ])
  })

  it("starts from the configured path, the address Tasks.org uses, before .well-known", async () => {
    const principal = await fixture("stalwart-propfind-principal.xml")
    const { client, seen } = setup(() => multistatus(principal), {
      serverUrl: `${SERVER}/dav/cal/`,
    })
    assertEquals(output(await client.discover()).homeUrls, [HOME])
    assertEquals(new URL(seen[0].url).pathname, "/dav/cal/")
  })

  it("falls back to the server URL when .well-known is missing", async () => {
    const principal = await fixture("radicale-propfind-principal.xml")
    const { client, seen } = setup((request) => {
      const path = new URL(request.url).pathname
      if (path === "/.well-known/caldav") return new Response("no", { status: 404 })
      if (path === "/") return multistatus(principal)
      return multistatus(
        `<multistatus xmlns="DAV:" xmlns:C="urn:ietf:params:xml:ns:caldav"><response><href>${path}</href><propstat><prop><C:calendar-home-set><href>${path}</href></C:calendar-home-set></prop><status>HTTP/1.1 200 OK</status></propstat></response></multistatus>`,
      )
    })
    assertEquals(output(await client.discover()), {
      principalUrl: `${SERVER}/user%40example.com/`,
      homeUrls: [`${SERVER}/user%40example.com/`],
    })
    assertEquals(seen.length, 3)
  })

  it("reports a cross-origin .well-known redirect over an earlier 404 when nothing works", async () => {
    // The configured path is tried first and answers 404; the redirect is the useful failure.
    const { client, seen } = setup(
      (request) =>
        new URL(request.url).pathname === "/.well-known/caldav"
          ? redirect(301, "https://caldav.example.net/")
          : new Response("", { status: 404 }),
      { serverUrl: `${SERVER}/dav/` },
    )
    const error = failure(await client.discover())
    assertEquals(error.code, CalDavErrorCode.CrossOriginRedirect)
    assertEquals(error.target, "https://caldav.example.net/")
    assertEquals(seen.map((request) => new URL(request.url).pathname), [
      "/dav/",
      "/.well-known/caldav",
    ])
  })

  it("stops at wrong credentials instead of trying the next starting point", async () => {
    const { client, seen } = setup(() => new Response("", { status: 401 }))
    assertEquals(failure(await client.discover()).code, CalDavErrorCode.Unauthorized)
    assertEquals(seen.length, 1)
  })
})

describe("listCalendars", () => {
  it("returns only calendars, with ctag, sync token and components (Stalwart)", async () => {
    const { client, seen } = setup(async () =>
      multistatus(await fixture("stalwart-propfind-home.xml"))
    )
    const calendars = output(await client.listCalendars(HOME))
    assertEquals(calendars.length, 5)
    assertEquals(calendars[1], {
      url: INBOX,
      displayName: "1.0 / Inbox",
      components: ["VTODO", "VEVENT"],
      ctag: `"5542"`,
      syncToken: "urn:stalwart:davsync:15a6",
    })
    assertEquals(seen[0].headers.get("Depth"), "1")
    for (
      const name of ["calendar-color", "getctag", "sync-token", "supported-calendar-component-set"]
    ) {
      assert(seen[0].body?.includes(name), name)
    }
  })

  it("reads a colour and an escaped display name (Radicale)", async () => {
    const body = (await fixture("radicale-propfind-home.xml")).replace(
      "<ICAL:calendar-color /><ICAL:calendar-order />",
      "<ICAL:calendar-order />",
    ).replace(
      "</displayname>",
      "</displayname><ICAL:calendar-color>#3366FFFF</ICAL:calendar-color>",
    )
    const { client } = setup(() => multistatus(body), { serverUrl: SERVER })
    const [inbox] = output(await client.listCalendars(`${SERVER}/user%40example.com/`))
    assertEquals(inbox.displayName, `Inbox & "Later"`)
    assertEquals(inbox.color, "#3366FFFF")
    assertEquals(inbox.components, ["VTODO"])
  })
})

describe("listObjects", () => {
  it("reports a 207 whose only entry is the calendar itself at 404 as NotFound", async () => {
    const path = new URL(INBOX).pathname
    const { client } = setup(() =>
      multistatus(
        `<D:multistatus xmlns:D="DAV:"><D:response><D:href>${path}</D:href><D:status>HTTP/1.1 404 Not Found</D:status></D:response></D:multistatus>`,
      )
    )
    const error = failure(await client.listObjects(INBOX, { component: "VTODO" }))
    assertEquals([error.code, error.status], [CalDavErrorCode.NotFound, 404])
    assertEquals(failure(await client.listCalendars(INBOX)).code, CalDavErrorCode.NotFound)
  })

  it("refuses an invalid time range without throwing or sending", async () => {
    const { client, seen } = setup(() => multistatus('<D:multistatus xmlns:D="DAV:"/>'))
    const result = await client.listObjects(INBOX, {
      component: "VTODO",
      timeRange: { start: new Date("nope") },
    })
    assertEquals(failure(result).code, CalDavErrorCode.InvalidArgument)
    assertEquals(seen.length, 0)
  })

  it("reads a server etag that is not one quoted entity tag as null", async () => {
    const { client } = setup(() =>
      multistatus(
        `<D:multistatus xmlns:D="DAV:" xmlns:C="urn:ietf:params:xml:ns:caldav">${
          ["*", "abc", `"1", "2"`].map((etag, index) =>
            `<D:response><D:href>${
              new URL(INBOX).pathname
            }${index}.ics</D:href><D:propstat><D:prop><D:getetag>${etag}</D:getetag><C:calendar-data>${ICS}</C:calendar-data></D:prop><D:status>HTTP/1.1 200 OK</D:status></D:propstat></D:response>`
          ).join("")
        }</D:multistatus>`,
      )
    )
    const objects = output(await client.listObjects(INBOX, { component: "VTODO" }))
    assertEquals(objects.map((object) => object.etag), [null, null, null])
  })

  it("lists open tasks only by default, asking the server to drop completed ones", async () => {
    const { client, seen } = setup(async () =>
      multistatus(await fixture("stalwart-calendar-query.xml"))
    )
    output(await client.listObjects(INBOX, { component: "VTODO" }))
    assertMatch(seen[0].body!, /<N0:prop-filter name="COMPLETED"><N0:is-not-defined\/>/)
    output(await client.listObjects(INBOX, { component: "VTODO", includeCompleted: true }))
    assert(!seen[1].body!.includes("prop-filter"), seen[1].body!)
    output(await client.listObjects(INBOX, { component: "VEVENT" }))
    assert(!seen[2].body!.includes("prop-filter"), seen[2].body!)
  })

  it("returns each object's own href and its etag decoded, never rebuilt from the UID", async () => {
    const { client } = setup(async () => multistatus(await fixture("stalwart-calendar-query.xml")))
    const objects = output(await client.listObjects(INBOX, { component: "VTODO" }))
    const first = objects[0]
    assertEquals(first.url, TASK)
    assertEquals(first.etag, `"2636778518"`)
    assert(first.data.startsWith("BEGIN:VCALENDAR"))
    // The second object's file name differs from its UID; its address is the href as sent.
    assert(
      objects.some((object) => object.url.endsWith("/19c80b2b-eec7-4386-a9aa-87cc4530412c.ics")),
    )
  })

  it("lists an empty calendar as an empty list when Stalwart answers 404 for the collection", async () => {
    const { client, seen } = setup(async (request) =>
      request.method === "REPORT"
        ? multistatus(await fixture("stalwart-calendar-query-empty.xml"))
        : multistatus(await fixture("stalwart-propfind-calendar-depth0.xml"))
    )
    assertEquals(output(await client.listObjects(INBOX, { component: "VTODO" })), [])
    assertEquals(seen.map((request) => [request.method, request.headers.get("Depth")]), [
      ["REPORT", "1"],
      ["PROPFIND", "0"],
    ])
  })

  it("reports Forbidden when the collection's own entry is a 403, without a second request", async () => {
    const { client, seen } = setup(async (request) =>
      request.method === "REPORT"
        ? multistatus(
          (await fixture("stalwart-calendar-query-empty.xml")).replace(
            "404 Not Found",
            "403 Forbidden",
          ),
        )
        : multistatus(await fixture("stalwart-propfind-calendar-depth0.xml"))
    )
    assertEquals(
      failure(await client.listObjects(INBOX, { component: "VTODO" })).code,
      CalDavErrorCode.Forbidden,
    )
    assertEquals(seen.map((request) => request.method), ["REPORT"])
  })

  it("lists a calendar as empty when its own entry is a 410, as it does for a 404", async () => {
    const { client } = setup(async (request) =>
      request.method === "REPORT"
        ? multistatus(
          (await fixture("stalwart-calendar-query-empty.xml")).replace("404 Not Found", "410 Gone"),
        )
        : multistatus(await fixture("stalwart-propfind-calendar-depth0.xml"))
    )
    assertEquals(output(await client.listObjects(INBOX, { component: "VTODO" })), [])
  })

  it("lists [] with one request when the only entry is a missing child, not the calendar", async () => {
    const { client, seen } = setup(async (request) =>
      request.method === "REPORT"
        ? multistatus(
          (await fixture("stalwart-calendar-query-empty.xml")).replace(
            "Inbox/</D:href>",
            "Inbox/gone.ics</D:href>",
          ),
        )
        : multistatus(await fixture("stalwart-propfind-calendar-depth0.xml"))
    )
    assertEquals(output(await client.listObjects(INBOX, { component: "VTODO" })), [])
    assertEquals(seen.map((request) => request.method), ["REPORT"])
  })

  it("reports a calendar that does not exist as NotFound when Stalwart answers its REPORT like an empty one", async () => {
    const { client } = setup(async (request) =>
      request.method === "REPORT"
        ? multistatus(await fixture("stalwart-calendar-query-empty.xml"))
        : new Response(null, { status: 404 })
    )
    assertEquals(
      failure(await client.listObjects(INBOX, { component: "VTODO" })).code,
      CalDavErrorCode.NotFound,
    )
  })

  it("reports a collection that is not a calendar as NotFound, not as an empty list", async () => {
    const { client } = setup(async (request) =>
      request.method === "REPORT"
        ? multistatus(await fixture("stalwart-calendar-query-empty.xml"))
        : multistatus(
          (await fixture("stalwart-propfind-calendar-depth0.xml")).replace(
            "<A:calendar/>",
            "",
          ),
        )
    )
    assertEquals(
      failure(await client.listObjects(INBOX, { component: "VTODO" })).code,
      CalDavErrorCode.NotFound,
    )
  })

  it("reports a missing calendar as NotFound, never as an empty list", async () => {
    const { client } = setup(() => new Response("", { status: 404 }))
    assertEquals(
      failure(await client.listObjects(INBOX, { component: "VTODO" })).code,
      CalDavErrorCode.NotFound,
    )
  })

  it("reports a non-multistatus answer as Malformed", async () => {
    const { client } = setup(() => multistatus("<html>not dav</html>"))
    assertEquals(
      failure(await client.listObjects(INBOX, { component: "VTODO" })).code,
      CalDavErrorCode.Malformed,
    )
  })
})

describe("getObjects", () => {
  it("asks for the hrefs as sent and separates found from missing objects", async () => {
    const { client, seen } = setup(() =>
      multistatus(
        `<D:multistatus xmlns:D="DAV:" xmlns:C="urn:ietf:params:xml:ns:caldav"><D:response><D:href>${
          new URL(TASK).pathname
        }</D:href><D:propstat><D:prop><D:getetag>&quot;7&quot;</D:getetag><C:calendar-data>${ICS}</C:calendar-data></D:prop><D:status>HTTP/1.1 200 OK</D:status></D:propstat></D:response><D:response><D:href>${
          new URL(INBOX).pathname
        }gone.ics</D:href><D:status>HTTP/1.1 404 Not Found</D:status></D:response></D:multistatus>`,
      )
    )
    const result = output(await client.getObjects(INBOX, [TASK, `${INBOX}gone.ics`]))
    assertEquals(result.objects.map((object) => [object.url, object.etag]), [[TASK, `"7"`]])
    assertEquals(result.missing, [`${INBOX}gone.ics`])
    assert(
      seen[0].body!.includes(
        "/dav/cal/user%40example.com/1.0%20%2F%20Inbox/3715224104002452840.ics",
      ),
    )
  })
})

describe("writes", () => {
  it("creates under a fresh UUID name with If-None-Match: *", async () => {
    const { client, seen } = setup(() =>
      new Response(null, { status: 201, headers: { ETag: `"9"` } })
    )
    const written = output(await client.createObject(INBOX, ICS))
    assertMatch(
      written.url,
      /^https:\/\/dav\.example\.com\/dav\/cal\/user%40example\.com\/1\.0%20%2F%20Inbox\/[0-9a-f-]{36}\.ics$/,
    )
    assertEquals(written.etag, `"9"`)
    assertEquals(seen[0].method, "PUT")
    assertEquals(seen[0].headers.get("If-None-Match"), "*")
    assertEquals(seen[0].headers.get("If-Match"), null)
    assertEquals(seen[0].headers.get("Content-Type"), "text/calendar; charset=utf-8")
    assertEquals(seen[0].body, ICS)
  })

  it("refuses * and etag lists, which would make a guarded write blind, before any request", async () => {
    const { client, seen } = setup(() => new Response(null, { status: 204 }))
    for (const etag of ["*", `"1", "2"`, `"1,2"`, "W/", "abc", `W/abc`]) {
      assertEquals(
        failure(await client.updateObject(TASK, ICS, etag)).code,
        CalDavErrorCode.InvalidArgument,
        etag,
      )
      assertEquals(
        failure(await client.deleteObject(TASK, etag)).code,
        CalDavErrorCode.InvalidArgument,
        etag,
      )
    }
    assertEquals(seen.length, 0)
  })

  it("reports an empty or invalid ETag header as null", async () => {
    for (const header of ["", "*", "abc"]) {
      const { client } = setup(() => new Response(ICS, { status: 200, headers: { ETag: header } }))
      assertEquals(output(await client.getObject(TASK)).etag, null, header)
    }
  })

  it("returns the address a same-origin redirect led to", async () => {
    const moved = `${INBOX}moved.ics`
    const { client } = setup((request) =>
      request.url === moved
        ? new Response(request.method === "GET" ? ICS : null, {
          status: request.method === "GET" ? 200 : 201,
          headers: { ETag: `"2"` },
        })
        : redirect(307, moved)
    )
    assertEquals(output(await client.getObject(TASK)).url, moved)
    assertEquals(output(await client.createObject(INBOX, ICS)).url, moved)
    assertEquals(output(await client.updateObject(TASK, ICS, `"1"`)).url, moved)
  })

  it("reports an etag the server did not send as null", async () => {
    const { client } = setup(() => new Response(null, { status: 204 }))
    assertEquals(output(await client.updateObject(TASK, ICS, `"1"`)).etag, null)
  })

  it("sends If-Match exactly as received, quotes and W/ included", async () => {
    const { client, seen } = setup(() => new Response(null, { status: 204 }))
    for (const etag of [`"2636778518"`, `W/"abc"`, `"a b"`]) {
      output(await client.updateObject(TASK, ICS, etag))
      output(await client.deleteObject(TASK, etag))
    }
    assertEquals(seen.map((request) => request.headers.get("If-Match")), [
      `"2636778518"`,
      `"2636778518"`,
      `W/"abc"`,
      `W/"abc"`,
      `"a b"`,
      `"a b"`,
    ])
    assertEquals(seen.map((request) => request.method), [
      "PUT",
      "DELETE",
      "PUT",
      "DELETE",
      "PUT",
      "DELETE",
    ])
  })

  it("refuses an update or delete without an etag before any request", async () => {
    const { client, seen } = setup(() => new Response(null, { status: 204 }))
    for (const etag of ["", "  ", undefined, null, `"1"\r\nX-Evil: 1`, ` "1"`]) {
      const missing = etag as unknown as string
      assertEquals(
        failure(await client.updateObject(TASK, ICS, missing)).code,
        CalDavErrorCode.InvalidArgument,
        JSON.stringify(etag),
      )
      assertEquals(
        failure(await client.deleteObject(TASK, missing)).code,
        CalDavErrorCode.InvalidArgument,
        JSON.stringify(etag),
      )
    }
    assertEquals(seen.length, 0)
  })

  it("refuses an empty iCalendar body before any request", async () => {
    const { client, seen } = setup(() => new Response(null, { status: 201 }))
    assertEquals(
      failure(await client.createObject(INBOX, " ")).code,
      CalDavErrorCode.InvalidArgument,
    )
    assertEquals(
      failure(await client.updateObject(TASK, "", `"1"`)).code,
      CalDavErrorCode.InvalidArgument,
    )
    assertEquals(seen.length, 0)
  })

  it("gives a stale etag (412 on If-Match) its own code, Conflict", async () => {
    const { client } = setup(() => new Response(null, { status: 412 }))
    const update = failure(await client.updateObject(TASK, ICS, `"old"`))
    assertEquals([update.code, update.status], [CalDavErrorCode.Conflict, 412])
    assertEquals(failure(await client.deleteObject(TASK, `"old"`)).code, CalDavErrorCode.Conflict)
  })

  it("reports a taken address on create as AlreadyExists, not Conflict", async () => {
    const { client } = setup(() => new Response(null, { status: 412 }))
    assertEquals(failure(await client.createObject(INBOX, ICS)).code, CalDavErrorCode.AlreadyExists)
  })

  it("reports Stalwart's 412 no-uid-conflict as UidConflict, not Conflict", async () => {
    const body = await fixture("stalwart-412-no-uid-conflict.xml")
    const { client } = setup(() => new Response(body, { status: 412 }))
    const update = failure(await client.updateObject(TASK, ICS, `"1"`))
    assertEquals([update.code, update.condition], [CalDavErrorCode.UidConflict, "no-uid-conflict"])
    assertEquals(failure(await client.createObject(INBOX, ICS)).code, CalDavErrorCode.UidConflict)
  })

  it("maps other refusals to their own codes", async () => {
    const cases: [number, CalDavErrorCode][] = [
      [401, CalDavErrorCode.Unauthorized],
      [403, CalDavErrorCode.Forbidden],
      [404, CalDavErrorCode.NotFound],
      [410, CalDavErrorCode.NotFound],
      [413, CalDavErrorCode.TooLarge],
      [409, CalDavErrorCode.Server],
      [500, CalDavErrorCode.Server],
    ]
    for (const [status, code] of cases) {
      const { client } = setup(() => new Response("", { status }))
      const error = failure(await client.updateObject(TASK, ICS, `"1"`))
      assertEquals([error.code, error.status], [code, status], String(status))
    }
  })
})

describe("calendars", () => {
  it("makes a calendar under the home with a UUID segment, never the display name", async () => {
    const { client, seen } = setup(() => new Response(null, { status: 201 }))
    const made = output(
      await client.makeCalendar(HOME, { displayName: "Inbox / Later", components: ["VTODO"] }),
    )
    assertMatch(
      made.url,
      /^https:\/\/dav\.example\.com\/dav\/cal\/user%40example\.com\/[0-9a-f-]{36}\/$/,
    )
    assertEquals(seen[0].method, "MKCALENDAR")
    assert(seen[0].body!.includes("Inbox / Later"))
  })

  it("reports a refused property of a PROPPATCH", async () => {
    const { client } = setup(() =>
      multistatus(
        `<D:multistatus xmlns:D="DAV:"><D:response><D:href>/dav/cal/user%40example.com/x/</D:href><D:propstat><D:prop><D:displayname/></D:prop><D:status>HTTP/1.1 403 Forbidden</D:status></D:propstat></D:response></D:multistatus>`,
      )
    )
    assertEquals(
      failure(await client.updateCalendar(`${HOME}x/`, { displayName: "New" })).code,
      CalDavErrorCode.Forbidden,
    )
  })

  it("refuses to delete a collection that is not a calendar, such as the home", async () => {
    const { client, seen } = setup(async () =>
      multistatus(await fixture("stalwart-propfind-home.xml"))
    )
    assertEquals(failure(await client.deleteCalendar(HOME)).code, CalDavErrorCode.InvalidArgument)
    assertEquals(seen.map((request) => request.method), ["PROPFIND"])
    assertEquals(seen[0].headers.get("Depth"), "0")
  })

  it("deletes a calendar collection after checking its type", async () => {
    const home = await fixture("stalwart-propfind-home.xml")
    const { client, seen } = setup((request) =>
      request.method === "PROPFIND" ? multistatus(home) : new Response(null, { status: 204 })
    )
    output(await client.deleteCalendar(INBOX))
    assertEquals(seen.map((request) => [request.method, request.url]), [
      ["PROPFIND", INBOX],
      ["DELETE", INBOX],
    ])
  })
})

describe("limits", () => {
  it("stops reading a response over maxResponseBytes", async () => {
    const { client } = setup(() => new Response("x".repeat(2048), { status: 200 }), {
      maxResponseBytes: 1024,
    })
    assertEquals(failure(await client.getObject(TASK)).code, CalDavErrorCode.TooLarge)
  })

  it("times out a slow trickle at the call deadline and aborts the fetch", async () => {
    // Each chunk arrives well inside a per-chunk budget, so only a whole-call deadline stops it.
    // The stream errors when the fetch's signal aborts, as a real fetch body does.
    const { client, seen } = setup((request) => {
      let timer: ReturnType<typeof setTimeout> | undefined
      return new Response(
        new ReadableStream<Uint8Array>({
          start(controller) {
            request.signal?.addEventListener("abort", () => {
              clearTimeout(timer)
              controller.error(request.signal?.reason)
            })
          },
          pull: (controller) =>
            new Promise<void>((resolve) => {
              timer = setTimeout(() => {
                controller.enqueue(new TextEncoder().encode("X"))
                resolve()
              }, 5)
            }),
        }),
        { status: 200 },
      )
    }, { timeoutMs: 60 })
    const started = Date.now()
    const error = failure(await client.getObject(TASK))
    assertEquals(error.code, CalDavErrorCode.Timeout)
    assert(Date.now() - started < 1000, "the call outlived its deadline")
    assert(seen[0].signal?.aborted, "the fetch was not aborted, so its socket stays open")
  })

  it("times out a request that never answers", async () => {
    const { client } = setup(
      (request) =>
        new Promise<Response>(() => {
          // Never settles; only the deadline ends the call.
          void request
        }),
      { timeoutMs: 30 },
    )
    assertEquals(failure(await client.getObject(TASK)).code, CalDavErrorCode.Timeout)
  })

  it("reports a failed connection as Network", async () => {
    const { client } = setup(() => Promise.reject(new TypeError("connection refused")))
    assertEquals(failure(await client.getObject(TASK)).code, CalDavErrorCode.Network)
  })
})
