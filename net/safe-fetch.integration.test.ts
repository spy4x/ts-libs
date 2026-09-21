/**
 * The loopback integration tests for `net/` (#61, #74).
 *
 * Everything else in this package is tested against a `Fetcher` that returns
 * hand-built `Response` objects. That is the right tool for policy decisions,
 * and it is the wrong tool for three claims in #61, because each of them is
 * about what happens on the wire: which headers a second site receives, what a
 * body that stops arriving does to the reader, and whether a refused redirect
 * lets go of the connection. A hand-built `Response` cannot be wrong about any
 * of them, so a test using one cannot catch them being wrong.
 *
 * These tests therefore run `safeFetch` against real HTTP servers, over real
 * sockets, with Deno's own `fetch` underneath. The servers are started by the
 * test itself on `127.0.0.1` with an ephemeral port, so the tier needs no
 * container and there is nothing to skip: if a server cannot listen,
 * `Deno.serve` throws and the test is red.
 *
 * TWO SEAMS ARE MOVED, AND ONLY TWO:
 *
 *  - The guard refuses a loopback address, which is its whole point, so the
 *    servers answer under public-looking names (`site-a.test`) that
 *    `PUBLIC_RESOLVER` resolves to a public address. That is what makes the
 *    policy let the request through.
 *  - `loopbackFetcher` is this file's hosts file: it maps those two names onto
 *    the two loopback ports and **refuses any other host**, so no request
 *    written here can leave the machine. What it hands to the platform `fetch`
 *    is the method, headers and signal `safeFetch` built — unchanged.
 *
 * Nothing else is faked. The redirect, the headers on the second request, the
 * stalled body and the cancelled stream are all the real thing.
 */

import { assertEquals, assertRejects } from "@std/assert"
import { describe, it } from "@std/testing/bdd"
import { BodyReadTimeoutError, readBoundedText } from "./bounded-body.ts"
import { defaultFetcher, type Fetcher, safeFetch } from "./safe-fetch.ts"
import { type DnsResolver, UrlValidationError } from "./url-policy.ts"

const LOOPBACK = "127.0.0.1"

/** Obviously fake credentials, in the headers a caller would really carry. */
const FAKE_AUTHORIZATION = "Bearer not-a-real-token"
const FAKE_COOKIE = "session=not-a-real-session"

/** The part of both fake credentials that must never reach the second site. */
const SECRET_FRAGMENT = "not-a-real"

/**
 * True if any header value carries the secret, under any name.
 *
 * Checking the value and not the name is the point: a credential can cross an
 * origin under a name nobody thought to look at, which is exactly what a header
 * record built from an array of pairs used to do.
 */
function carriesSecret(received: Headers): boolean {
  return [...received].some(([, value]) => value.includes(SECRET_FRAGMENT))
}

/**
 * Every name resolves to the address `example.com` used to answer on.
 *
 * It has to be an address the policy calls public, so the RFC 5737
 * documentation ranges are no use here: the guard refuses those too. This is
 * the same fixture address the unit tests use, and nothing ever connects to it
 * — `loopbackFetcher` decides where the socket actually goes.
 */
const PUBLIC_RESOLVER: DnsResolver = {
  resolve: () => Promise.resolve(["93.184.216.34"]),
}

/** A server on loopback, reached under a public-looking name. */
interface Site {
  /** The origin the guard sees. */
  origin: string
  /** The loopback port it actually listens on. */
  port: number
  /** The headers of every request it has answered, in order. */
  received: Headers[]
  shutdown(): Promise<void>
}

/** Start one site on an ephemeral loopback port. */
function startSite(host: string, handler: (request: Request) => Response): Site {
  const received: Headers[] = []
  const server = Deno.serve({ port: 0, hostname: LOOPBACK, onListen: () => {} }, (request) => {
    received.push(new Headers(request.headers))
    return handler(request)
  })
  return {
    origin: `https://${host}`,
    port: server.addr.port,
    received,
    shutdown: () => server.shutdown(),
  }
}

/**
 * The hosts file for this file: the two names resolve to the two loopback
 * ports, and every other host is refused before a socket is opened.
 */
function loopbackFetcher(sites: Site[]): Fetcher {
  return {
    fetch(input, init) {
      const requested = new URL(input)
      const site = sites.find((candidate) => new URL(candidate.origin).host === requested.host)
      if (!site) {
        return Promise.reject(
          new Error(`this test may not leave loopback, and asked for ${requested.origin}`),
        )
      }
      const target = new URL(
        requested.pathname + requested.search,
        `http://${LOOPBACK}:${site.port}`,
      )
      return defaultFetcher.fetch(target.href, init)
    },
  }
}

/**
 * Wait for something the server side observes, and fail with a sentence rather
 * than a hang if it never happens.
 *
 * This is a deadline, not a measurement: nothing here asserts how long anything
 * took, only that a cancellation the client has already issued reaches the
 * server before the test gives up on it.
 */
async function waitFor(what: string, done: () => boolean): Promise<void> {
  for (let attempt = 0; attempt < 100; attempt++) {
    if (done()) return
    await new Promise((resolve) => setTimeout(resolve, 10))
  }
  throw new Error(`${what} never happened`)
}

/** A body that arrives and then stops, plus the flags a test reads afterwards. */
function stalledBody(): {
  stream: ReadableStream<Uint8Array>
  cancelled: () => boolean
  close: () => void
} {
  let cancelled = false
  let controller: ReadableStreamDefaultController<Uint8Array> | undefined
  const stream = new ReadableStream<Uint8Array>({
    start(c) {
      controller = c
      c.enqueue(new TextEncoder().encode("first chunk, then silence"))
    },
    cancel() {
      cancelled = true
    },
  })
  return {
    stream,
    cancelled: () => cancelled,
    close: () => {
      try {
        controller?.close()
      } catch {
        // Already cancelled by the client, which is the expected path.
      }
    },
  }
}

describe("safeFetch over real sockets", () => {
  it("does not send the credential headers to another site after a redirect", async () => {
    const landing = startSite("site-b.test", () => new Response("landed", { status: 200 }))
    const start = startSite(
      "site-a.test",
      () =>
        new Response("moved", {
          status: 302,
          headers: { location: `${landing.origin}/landing` },
        }),
    )
    try {
      const result = await safeFetch(`${start.origin}/start`, {
        fetcher: loopbackFetcher([start, landing]),
        resolver: PUBLIC_RESOLVER,
        headers: {
          Authorization: FAKE_AUTHORIZATION,
          Cookie: FAKE_COOKIE,
          "Proxy-Authorization": FAKE_AUTHORIZATION,
          "User-Agent": "ts-libs-integration",
        },
      })
      assertEquals(await readBoundedText(result.response), "landed")
      assertEquals(result.url, `${landing.origin}/landing`)

      // The first site is the one the caller addressed: it gets everything.
      assertEquals(start.received.length, 1)
      assertEquals(start.received[0].get("authorization"), FAKE_AUTHORIZATION)
      assertEquals(start.received[0].get("cookie"), FAKE_COOKIE)

      // The second site was chosen by the first one, and receives no credential
      // of the caller's — but still the headers that are not credentials.
      assertEquals(landing.received.length, 1)
      assertEquals(landing.received[0].get("authorization"), null)
      assertEquals(landing.received[0].get("cookie"), null)
      assertEquals(landing.received[0].get("proxy-authorization"), null)
      assertEquals(landing.received[0].get("user-agent"), "ts-libs-integration")
    } finally {
      await start.shutdown()
      await landing.shutdown()
    }
  })

  it("keeps the credentials dropped on a later same-site hop", async () => {
    // The second site sends the caller on to one of its own paths. That hop
    // does not change origin, so a drop recomputed from what the caller passed
    // would find nothing to drop and deliver the token on the third request.
    const landing = startSite("site-b.test", (request) => {
      if (new URL(request.url).pathname === "/a") {
        return new Response("moved again", { status: 302, headers: { location: "/b" } })
      }
      return new Response("landed", { status: 200 })
    })
    const start = startSite(
      "site-a.test",
      () =>
        new Response("moved", {
          status: 302,
          headers: { location: `${landing.origin}/a` },
        }),
    )
    try {
      const result = await safeFetch(`${start.origin}/start`, {
        fetcher: loopbackFetcher([start, landing]),
        resolver: PUBLIC_RESOLVER,
        headers: {
          Authorization: FAKE_AUTHORIZATION,
          Cookie: FAKE_COOKIE,
          "Proxy-Authorization": FAKE_AUTHORIZATION,
        },
      })
      assertEquals(await readBoundedText(result.response), "landed")
      assertEquals(result.url, `${landing.origin}/b`)

      assertEquals(landing.received.length, 2)
      for (const received of landing.received) {
        assertEquals(carriesSecret(received), false, [...received.keys()].join(", "))
      }
    } finally {
      await start.shutdown()
      await landing.shutdown()
    }
  })

  it("sends no credential to another site whatever shape the headers arrive in", async () => {
    // Over a real connection the header record becomes real header lines, so a
    // credential that crossed under the name `0` would arrive as
    // `0: Authorization,Bearer …`. Each shape is checked on the wire.
    const shapes: [string, HeadersInit][] = [
      ["Headers", new Headers({ Authorization: FAKE_AUTHORIZATION, Cookie: FAKE_COOKIE })],
      ["array of pairs", [["Authorization", FAKE_AUTHORIZATION], ["Cookie", FAKE_COOKIE]]],
      ["plain object", { Authorization: FAKE_AUTHORIZATION, Cookie: FAKE_COOKIE }],
    ]
    for (const [shape, headers] of shapes) {
      const landing = startSite("site-b.test", () => new Response("landed", { status: 200 }))
      const start = startSite(
        "site-a.test",
        () =>
          new Response("moved", {
            status: 302,
            headers: { location: `${landing.origin}/landing` },
          }),
      )
      try {
        const result = await safeFetch(`${start.origin}/start`, {
          fetcher: loopbackFetcher([start, landing]),
          resolver: PUBLIC_RESOLVER,
          headers,
        })
        assertEquals(await readBoundedText(result.response), "landed")
        // The first site is addressed by the caller, so it gets the credential
        // under its proper name — that is what makes the second assertion mean
        // something.
        assertEquals(start.received[0].get("authorization"), FAKE_AUTHORIZATION, shape)
        assertEquals(carriesSecret(landing.received[0]), false, `${shape}: leaked`)
      } finally {
        await start.shutdown()
        await landing.shutdown()
      }
    }
  })

  it("gives up on a body that stops arriving, and lets the server know", async () => {
    const body = stalledBody()
    const site = startSite("site-a.test", () => new Response(body.stream, { status: 200 }))
    try {
      const result = await safeFetch(`${site.origin}/slow`, {
        fetcher: loopbackFetcher([site]),
        resolver: PUBLIC_RESOLVER,
      })
      await assertRejects(
        () => readBoundedText(result.response, { maxBytes: 1024, timeoutMs: 50 }),
        BodyReadTimeoutError,
        "stalled",
      )
      await waitFor("the server's end of the stalled body was cancelled", body.cancelled)
    } finally {
      body.close()
      await site.shutdown()
    }
  })

  it("lets go of the connection when a redirect target is refused", async () => {
    const body = stalledBody()
    const site = startSite(
      "site-a.test",
      () =>
        new Response(body.stream, {
          status: 302,
          // The cloud metadata address: a redirect the policy must refuse.
          headers: { location: "http://169.254.169.254/latest/meta-data/" },
        }),
    )
    try {
      await assertRejects(
        () =>
          safeFetch(`${site.origin}/bounce`, {
            fetcher: loopbackFetcher([site]),
            resolver: PUBLIC_RESOLVER,
          }),
        UrlValidationError,
        "non-public",
      )
      // The refusal happens on the client. The server learning that its
      // response body was cancelled is the only proof from outside the process
      // that the connection was not simply abandoned open.
      await waitFor("the refused redirect's body was cancelled", body.cancelled)
    } finally {
      body.close()
      await site.shutdown()
    }
  })

  it("refuses to fetch a host this file did not start", async () => {
    // The guard rail on the tests themselves: `loopbackFetcher` is what keeps
    // every socket here on the loopback interface, so it gets its own test.
    const site = startSite("site-a.test", () => new Response("ok"))
    try {
      await assertRejects(
        () =>
          safeFetch("https://site-c.test/elsewhere", {
            fetcher: loopbackFetcher([site]),
            resolver: PUBLIC_RESOLVER,
          }),
        Error,
        "may not leave loopback",
      )
      assertEquals(site.received.length, 0)
    } finally {
      await site.shutdown()
    }
  })
})
