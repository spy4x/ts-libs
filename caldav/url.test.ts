// Behaviour tests for the CalDAV URL rules: href resolution, resource identity, new member URLs
// and the origin check that guards credentials.

import { assert, assertEquals, assertThrows } from "@std/assert"
import { describe, it } from "@std/testing/bdd"
import { childUrl, isSameOrigin, resolveHref, sameResource } from "./url.ts"

const SERVER = "https://dav.example.com/dav/cal/"

describe("resolveHref", () => {
  it("resolves an absolute path against the request URL and keeps its encoding", () => {
    const url = resolveHref(
      "/dav/cal/user%40example.com/1.0%20%2F%20Inbox/a.ics",
      SERVER,
    )
    assertEquals(
      url?.href,
      "https://dav.example.com/dav/cal/user%40example.com/1.0%20%2F%20Inbox/a.ics",
    )
  })

  it("resolves a relative href against the collection it came from", () => {
    const url = resolveHref("a.ics", "https://dav.example.com/cal/inbox/")
    assertEquals(url?.href, "https://dav.example.com/cal/inbox/a.ics")
  })

  it("keeps a full URL to another host as that host, for the origin check to judge", () => {
    assertEquals(
      resolveHref("https://other.example.org/x", SERVER)?.host,
      "other.example.org",
    )
  })

  it("returns null for an href that is not a URL", () => {
    assertEquals(resolveHref("http://[bad", SERVER), null)
  })
})

describe("sameResource", () => {
  it("treats a percent-encoded @ and a literal @ as the same segment", () => {
    assert(sameResource(
      "https://dav.example.com/cal/user%40example.com/a.ics",
      "https://dav.example.com/cal/user@example.com/a.ics",
    ))
  })

  it("treats an encoded slash inside a segment as different from a path separator", () => {
    assert(
      !sameResource(
        "https://dav.example.com/cal/1.0%20%2F%20Inbox/",
        "https://dav.example.com/cal/1.0%20/%20Inbox/",
      ),
    )
    assert(
      !sameResource(
        "https://dav.example.com/a%2Fb",
        "https://dav.example.com/a/b",
      ),
    )
  })

  it("matches the same encoded slash written in either hex case", () => {
    assert(
      sameResource(
        "https://dav.example.com/a%2fb",
        "https://dav.example.com/a%2Fb",
      ),
    )
  })

  it("ignores a trailing slash on a collection", () => {
    assert(
      sameResource(
        "https://dav.example.com/cal/inbox/",
        "https://dav.example.com/cal/inbox",
      ),
    )
  })

  it("refuses a different origin, path or query", () => {
    const base = "https://dav.example.com/cal/a.ics"
    assert(!sameResource(base, "http://dav.example.com/cal/a.ics"))
    assert(!sameResource(base, "https://dav.example.com:8443/cal/a.ics"))
    assert(!sameResource(base, "https://other.example.com/cal/a.ics"))
    assert(!sameResource(base, "https://dav.example.com/cal/b.ics"))
    assert(!sameResource(base, "https://dav.example.com/cal/a.ics?x=1"))
  })

  it("compares a malformed escape as written instead of throwing", () => {
    assert(
      sameResource(
        "https://dav.example.com/a%E0",
        "https://dav.example.com/a%E0",
      ),
    )
    assert(
      !sameResource(
        "https://dav.example.com/a%E0",
        "https://dav.example.com/a%E1",
      ),
    )
  })

  it("never matches an invalid URL", () => {
    assert(!sameResource("not a url", "not a url"))
  })
})

describe("childUrl", () => {
  it("appends an encoded segment to a collection with or without a trailing slash", () => {
    const id = "6c1f0e52-7a4b-4f7e-9c3d-2b8e5a1d0f43.ics"
    const expected = `https://dav.example.com/cal/user%40example.com/inbox/${id}`
    assertEquals(
      childUrl("https://dav.example.com/cal/user%40example.com/inbox/", id)
        .href,
      expected,
    )
    assertEquals(
      childUrl("https://dav.example.com/cal/user%40example.com/inbox", id).href,
      expected,
    )
  })

  it("encodes characters that would otherwise change the path", () => {
    const url = childUrl("https://dav.example.com/cal/", "a/b?c#d e.ics")
    assertEquals(url.href, "https://dav.example.com/cal/a%2Fb%3Fc%23d%20e.ics")
  })

  it("drops a query and fragment from the collection URL", () => {
    assertEquals(
      childUrl("https://dav.example.com/cal/?x=1#y", "a.ics").href,
      "https://dav.example.com/cal/a.ics",
    )
  })

  it("refuses a segment that would not name a new member", () => {
    for (const segment of ["", ".", ".."]) {
      assertThrows(
        () => childUrl("https://dav.example.com/cal/", segment),
        RangeError,
      )
    }
  })
})

describe("isSameOrigin", () => {
  it("accepts any path on the configured origin", () => {
    assert(isSameOrigin("https://dav.example.com/.well-known/caldav", SERVER))
    assert(isSameOrigin("https://DAV.example.com:443/other", SERVER))
  })

  it("refuses another host, another port and another scheme", () => {
    assert(!isSameOrigin("https://evil.example.org/dav/cal/", SERVER))
    assert(!isSameOrigin("https://dav.example.com.evil.example.org/", SERVER))
    assert(!isSameOrigin("https://dav.example.com:8443/dav/cal/", SERVER))
    assert(!isSameOrigin("http://dav.example.com/dav/cal/", SERVER))
  })

  it("refuses non-HTTP schemes even when both sides match", () => {
    assert(!isSameOrigin("data:text/plain,x", "data:text/plain,x"))
    assert(!isSameOrigin("file:///etc/passwd", "file:///etc/"))
  })

  it("refuses an invalid URL on either side", () => {
    assert(!isSameOrigin("not a url", SERVER))
    assert(!isSameOrigin(SERVER, "not a url"))
  })
})
