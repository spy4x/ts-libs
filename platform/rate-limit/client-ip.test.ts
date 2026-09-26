import { assertEquals } from "@std/assert"
import { describe, it } from "@std/testing/bdd"

import {
  clientIp,
  clientIpBucket,
  humanRetry,
  type TrustedProxyHeader,
  UNKNOWN_CLIENT_IP,
} from "./client-ip.ts"

/** Request with the given headers and no body. */
function request(headers: Record<string, string> = {}): Request {
  return new Request("http://localhost/auth/sign-in", { headers })
}

describe("clientIp", () => {
  it("ignores every forwarding header by default, so a client cannot pick its bucket", () => {
    const req = request({
      "cf-connecting-ip": "203.0.113.9",
      "x-forwarded-for": "198.51.100.7",
      "x-real-ip": "192.0.2.1",
    })
    assertEquals(clientIp(req, "192.0.2.1"), "192.0.2.1")
  })

  it("returns the transport peer address by default", () => {
    assertEquals(clientIp(request(), "192.0.2.1"), "192.0.2.1")
  })

  it("falls back to the placeholder by default when there is no peer address", () => {
    assertEquals(clientIp(request({ "x-forwarded-for": "203.0.113.9" })), UNKNOWN_CLIENT_IP)
  })

  it("reads CF-Connecting-IP when the proxy is trusted", () => {
    assertEquals(
      clientIp(request({ "cf-connecting-ip": "203.0.113.9" }), undefined, true),
      "203.0.113.9",
    )
  })

  it("reads the first X-Forwarded-For hop, not the last and not the whole list", () => {
    const req = request({ "x-forwarded-for": "203.0.113.9, 198.51.100.7, 192.0.2.1" })
    assertEquals(clientIp(req, undefined, true), "203.0.113.9")
  })

  it("reads X-Real-IP when the proxy is trusted", () => {
    assertEquals(
      clientIp(request({ "x-real-ip": "198.51.100.7" }), undefined, true),
      "198.51.100.7",
    )
  })

  it("falls back to the transport peer address with no headers", () => {
    assertEquals(clientIp(request(), "192.0.2.1", true), "192.0.2.1")
  })

  it("prefers CF-Connecting-IP over every other source", () => {
    const req = request({
      "cf-connecting-ip": "203.0.113.9",
      "x-forwarded-for": "198.51.100.7",
      "x-real-ip": "192.0.2.1",
    })
    assertEquals(clientIp(req, "127.0.0.1", true), "203.0.113.9")
  })

  it("prefers the first X-Forwarded-For hop over X-Real-IP and the peer address", () => {
    const req = request({
      "x-forwarded-for": "203.0.113.9, 198.51.100.7",
      "x-real-ip": "192.0.2.1",
    })
    assertEquals(clientIp(req, "127.0.0.1", true), "203.0.113.9")
  })

  it("prefers X-Real-IP over the peer address", () => {
    assertEquals(
      clientIp(request({ "x-real-ip": "198.51.100.7" }), "127.0.0.1", true),
      "198.51.100.7",
    )
  })

  it("ignores forwarding headers when the proxy is not trusted", () => {
    const req = request({ "cf-connecting-ip": "203.0.113.9", "x-forwarded-for": "198.51.100.7" })
    assertEquals(clientIp(req, "127.0.0.1", false), "127.0.0.1")
  })

  it("falls through a blank header to the next source", () => {
    const req = request({ "cf-connecting-ip": "   ", "x-forwarded-for": " 203.0.113.9 " })
    assertEquals(clientIp(req, undefined, true), "203.0.113.9")
  })

  it("falls through an empty first hop to X-Real-IP", () => {
    assertEquals(
      clientIp(
        request({ "x-forwarded-for": ", 198.51.100.7", "x-real-ip": "192.0.2.1" }),
        undefined,
        true,
      ),
      "192.0.2.1",
    )
  })

  it("falls back to the peer address when the trusted header holds anything but one IP", () => {
    const forged = [
      "not-an-ip",
      "NOT-AN-IP",
      "192.0.2.1:8080",
      "[2001:db8::1]",
      "[2001:db8::1]:443",
      "fe80::1%eth0",
      "a".repeat(64_000),
    ]
    for (const value of forged) {
      assertEquals(
        clientIp(request({ "x-real-ip": value }), "192.0.2.50", "x-real-ip"),
        "192.0.2.50",
        value.slice(0, 40),
      )
    }
  })

  it("falls through a header that is not an IP to the next header when all three are trusted", () => {
    const req = request({ "cf-connecting-ip": "unknown", "x-forwarded-for": "203.0.113.9:1234" })
    assertEquals(clientIp(req, "192.0.2.50", true), "192.0.2.50")
    const next = request({ "cf-connecting-ip": "unknown", "x-real-ip": "198.51.100.7" })
    assertEquals(clientIp(next, "192.0.2.50", true), "198.51.100.7")
  })

  it("gives an IPv4-mapped IPv6 address and its IPv4 address the same result", () => {
    const header = (value: string) => clientIp(request({ "x-real-ip": value }), undefined, true)
    assertEquals(header("::ffff:192.0.2.1"), "192.0.2.1")
    assertEquals(header("192.0.2.1"), "192.0.2.1")
    assertEquals(clientIp(request(), "::ffff:192.0.2.1"), "192.0.2.1")
  })

  it("writes an IPv6 address from a header or the peer in its canonical spelling", () => {
    const req = request({ "cf-connecting-ip": "2001:0DB8:0:0::0001" })
    assertEquals(clientIp(req, undefined, "cf-connecting-ip"), "2001:db8::1")
    assertEquals(clientIp(request(), " 2001:DB8::1 "), "2001:db8::1")
  })

  it("keeps a peer address that is not an IP as the transport wrote it", () => {
    assertEquals(clientIp(request(), "/run/app.sock"), "/run/app.sock")
  })

  it("returns the placeholder when there is no header and no peer address", () => {
    assertEquals(clientIp(request()), UNKNOWN_CLIENT_IP)
    assertEquals(clientIp(request(), "  "), UNKNOWN_CLIENT_IP)
  })

  describe("a single trusted header name", () => {
    /** All three headers present with distinct values, so a wrong pick is caught. */
    const allThree = {
      "cf-connecting-ip": "203.0.113.9",
      "x-forwarded-for": "198.51.100.7",
      "x-real-ip": "192.0.2.1",
    }
    const expected: Record<TrustedProxyHeader, string> = {
      "cf-connecting-ip": "203.0.113.9",
      "x-forwarded-for": "198.51.100.7",
      "x-real-ip": "192.0.2.1",
    }

    for (const header of Object.keys(expected) as TrustedProxyHeader[]) {
      it(`reads only ${header} and ignores the other two when it is named as trusted`, () => {
        assertEquals(clientIp(request(allThree), "127.0.0.1", header), expected[header])
      })
    }

    it(
      "a caller behind Traefik can get the address Traefik wrote, whatever CF-Connecting-IP the " +
        "client sent",
      () => {
        // Traefik with default settings overwrites X-Forwarded-For and X-Real-IP with the real
        // chain, but passes a client-supplied CF-Connecting-IP straight through — trustedProxy:
        // true would read the forged value first; naming "x-real-ip" does not.
        const req = request({
          "cf-connecting-ip": "203.0.113.9", // forged by the client
          "x-forwarded-for": "127.0.0.1", // rewritten by Traefik
          "x-real-ip": "127.0.0.1", // rewritten by Traefik
        })
        assertEquals(clientIp(req, undefined, "x-real-ip"), "127.0.0.1")
      },
    )

    it("falls back to remoteAddr, not to another header, when the named header is absent", () => {
      const req = request({ "cf-connecting-ip": "203.0.113.9", "x-forwarded-for": "198.51.100.7" })
      assertEquals(clientIp(req, "127.0.0.1", "x-real-ip"), "127.0.0.1")
    })

    it("falls back to remoteAddr, not to another header, when the named header is empty", () => {
      const req = request({
        "x-real-ip": "   ",
        "cf-connecting-ip": "203.0.113.9",
        "x-forwarded-for": "198.51.100.7",
      })
      assertEquals(clientIp(req, "127.0.0.1", "x-real-ip"), "127.0.0.1")
    })

    it("falls back to the placeholder when the named header and remoteAddr are both absent", () => {
      assertEquals(clientIp(request(), undefined, "x-real-ip"), UNKNOWN_CLIENT_IP)
    })
  })
})

describe("clientIp with trustedProxies", () => {
  const cloudflare = ["104.16.0.0/13", "2400:cb00::/32"]

  it("reads the header when the peer is inside a listed range", () => {
    const req = request({ "cf-connecting-ip": "198.51.100.7" })
    const options = { trustedProxies: cloudflare }
    assertEquals(clientIp(req, "104.16.0.1", "cf-connecting-ip", options), "198.51.100.7")
    assertEquals(clientIp(req, "2400:cb00::1", "cf-connecting-ip", options), "198.51.100.7")
    assertEquals(clientIp(req, "::ffff:104.16.0.1", true, options), "198.51.100.7")
  })

  it("ignores the header and returns the peer when the peer is outside every range", () => {
    const req = request({ "cf-connecting-ip": "198.51.100.7", "x-real-ip": "203.0.113.9" })
    const options = { trustedProxies: cloudflare }
    assertEquals(clientIp(req, "192.0.2.1", "cf-connecting-ip", options), "192.0.2.1")
    assertEquals(clientIp(req, "104.24.0.0", true, options), "104.24.0.0")
  })

  it("ignores the header when there is no peer address to check", () => {
    const req = request({ "cf-connecting-ip": "198.51.100.7" })
    assertEquals(
      clientIp(req, undefined, "cf-connecting-ip", { trustedProxies: cloudflare }),
      UNKNOWN_CLIENT_IP,
    )
  })

  it("trusts no one with an empty list", () => {
    const req = request({ "cf-connecting-ip": "198.51.100.7" })
    assertEquals(clientIp(req, "104.16.0.1", true, { trustedProxies: [] }), "104.16.0.1")
  })

  it("throws on a malformed range, even when no header would be read", () => {
    for (const trustedProxy of [true, false] as const) {
      let error: unknown
      try {
        clientIp(request(), "192.0.2.1", trustedProxy, { trustedProxies: ["104.16.0.0/33"] })
      } catch (caught) {
        error = caught
      }
      assertEquals(error instanceof RangeError, true, `trustedProxy=${trustedProxy}`)
    }
  })

  it("trusts CF-Connecting-IP only when the X-Real-IP Traefik wrote is a Cloudflare edge", () => {
    // antonshubin.com's layout: Traefik writes X-Real-IP; Cloudflare, when it is the one that
    // connected, names the visitor in CF-Connecting-IP.
    const visitor = (headers: Record<string, string>) => {
      const req = request(headers)
      const peer = clientIp(req, "10.0.0.5", "x-real-ip")
      return clientIp(req, peer, "cf-connecting-ip", { trustedProxies: cloudflare })
    }
    assertEquals(
      visitor({ "x-real-ip": "104.16.0.1", "cf-connecting-ip": "198.51.100.7" }),
      "198.51.100.7",
    )
    assertEquals(
      visitor({ "x-real-ip": "192.0.2.1", "cf-connecting-ip": "198.51.100.7" }),
      "192.0.2.1",
    )
  })
})

describe("clientIpBucket", () => {
  it("gives two addresses in one IPv6 /64 one bucket and two /64s two", () => {
    assertEquals(clientIpBucket("2001:db8:1:2:aaaa::1"), "2001:db8:1:2::/64")
    assertEquals(clientIpBucket("2001:db8:1:2:ffff:ffff:ffff:ffff"), "2001:db8:1:2::/64")
    assertEquals(clientIpBucket("2001:db8:1:3::1"), "2001:db8:1:3::/64")
  })

  it("writes the /64 in its canonical spelling", () => {
    assertEquals(clientIpBucket("2001:0DB8:0000:0000:1::1"), "2001:db8::/64")
    assertEquals(clientIpBucket("::1"), "::/64")
  })

  it("leaves an IPv4 address unchanged and reduces a mapped address to its IPv4", () => {
    assertEquals(clientIpBucket("192.0.2.1"), "192.0.2.1")
    assertEquals(clientIpBucket("::ffff:192.0.2.1"), "192.0.2.1")
  })

  it("leaves a value that is not an address unchanged", () => {
    assertEquals(clientIpBucket(UNKNOWN_CLIENT_IP), UNKNOWN_CLIENT_IP)
    assertEquals(clientIpBucket("/run/app.sock"), "/run/app.sock")
  })
})

describe("humanRetry", () => {
  it("counts whole seconds", () => {
    assertEquals(humanRetry(1000), "1 second")
    assertEquals(humanRetry(45_000), "45 seconds")
  })

  it("rounds up a partial second, because the window is not open yet", () => {
    assertEquals(humanRetry(1), "1 second")
    assertEquals(humanRetry(1001), "2 seconds")
  })

  it("switches to minutes at a full minute", () => {
    assertEquals(humanRetry(60_000), "1 minute")
    assertEquals(humanRetry(90_000), "2 minutes")
    assertEquals(humanRetry(300_000), "5 minutes")
  })

  it("labels a sub-minute remainder in seconds, never as zero minutes", () => {
    assertEquals(humanRetry(59_000), "59 seconds")
    assertEquals(humanRetry(60_001), "2 minutes")
  })

  it("is deterministic for zero and non-finite input", () => {
    assertEquals(humanRetry(0), "0 seconds")
    assertEquals(humanRetry(-5), "0 seconds")
    assertEquals(humanRetry(Number.NaN), "0 seconds")
    assertEquals(humanRetry(Number.POSITIVE_INFINITY), "0 seconds")
  })

  it("depends on no clock and no locale", () => {
    assertEquals(humanRetry(1_700_000_000_000), "28333334 minutes")
  })
})
