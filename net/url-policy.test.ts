import { assertEquals, assertRejects } from "@std/assert"
import { describe, it } from "@std/testing/bdd"
import {
  defaultResolver,
  DnsResolutionError,
  isLocalHostname,
  isPublicAddress,
  isPublicIpv4,
  isPublicIpv6,
  parseIpv6Groups,
  UrlValidationError,
  validatePublicUrl,
} from "./url-policy.ts"
import { normalizeUrlShape } from "./url-shape.ts"

// ── Shared rules with net/url-shape ────────────────────────────────────────

/** Records the A and AAAA answers separately so the AAAA branch is observable. */
function typedResolver(records: Record<string, { a?: string[]; aaaa?: string[] }>) {
  return {
    resolve: (host: string) => {
      const entry = records[host]
      if (!entry) return Promise.reject(new Error(`no such host: ${host}`))
      return Promise.resolve([...(entry.a ?? []), ...(entry.aaaa ?? [])])
    },
  }
}

/** Rejects unknown hosts, like the sources' `staticResolver`. */
function staticResolver(records: Record<string, string[]>) {
  return {
    resolve: (host: string) => {
      if (!(host in records)) {
        return Promise.reject(new Error(`no such host: ${host}`))
      }
      return Promise.resolve(records[host])
    },
  }
}

const PUBLIC_IPV4 = staticResolver({
  "example.com": ["93.184.216.34"],
  "blog.example": ["93.184.216.34"],
  "beef.de": ["93.184.216.34"],
})

describe("validatePublicUrl", () => {
  it("reuses net/url-shape for scheme, character and parse rules", async () => {
    // The two rulesets share one implementation above the host rules, so every
    // shape rejection that happens before the host check is identical.
    const shared = [
      { input: "", message: "Enter a URL" },
      { input: "   ", message: "Enter a URL" },
      { input: "javascript:alert(1)", message: "URL must start with http:// or https://" },
      { input: "ftp://example.com/", message: "URL must start with http:// or https://" },
      { input: "data:text/html,evil", message: "URL must start with http:// or https://" },
      { input: "file:///etc/passwd", message: "URL must start with http:// or https://" },
      { input: "https://", message: "Invalid URL format" },
      { input: "https://example.com:99999/", message: "Invalid URL format" },
      { input: "https://exa mple.com", message: "URL contains invalid characters" },
      { input: "https://example.com\n.evil", message: "URL contains invalid characters" },
    ]
    for (const { input, message } of shared) {
      const shape = normalizeUrlShape(input)
      assertEquals(shape.ok, false, `shape should reject ${JSON.stringify(input)}`)
      if (!shape.ok) assertEquals(shape.message, message)
      // The policy must reject the same inputs with a message that never echoes
      // the raw input back.
      await assertRejects(() => validatePublicUrl(input), UrlValidationError, message)
    }
  })

  it("rejects an empty input", async () => {
    await assertRejects(
      () => validatePublicUrl(""),
      UrlValidationError,
      "Enter a URL",
    )
    await assertRejects(
      () => validatePublicUrl("   "),
      UrlValidationError,
      "Enter a URL",
    )
  })

  it("rejects userinfo", async () => {
    await assertRejects(
      () => validatePublicUrl("https://user:pass@example.com/"),
      UrlValidationError,
      "credentials",
    )
    await assertRejects(
      () => validatePublicUrl("https://:pass@example.com/"),
      UrlValidationError,
      "credentials",
    )
  })

  it("rejects credentials before it looks at the host", async () => {
    // Ordering matters: a credentialed URL must report `userinfo`, not the
    // loopback it happens to point at, so a caller can tell the two apart.
    try {
      await validatePublicUrl("https://user:pass@127.0.0.1/")
      throw new Error("expected throw")
    } catch (err) {
      assertEquals(err instanceof UrlValidationError, true)
      if (err instanceof UrlValidationError) assertEquals(err.code, "userinfo")
    }
  })

  it("rejects localhost variants", async () => {
    await assertRejects(
      () => validatePublicUrl("http://localhost/"),
      UrlValidationError,
      "special-use",
    )
    await assertRejects(
      () => validatePublicUrl("http://api.localhost/"),
      UrlValidationError,
      "special-use",
    )
    await assertRejects(
      () => validatePublicUrl("http://LOCALHOST/"),
      UrlValidationError,
      "special-use",
    )
  })

  it("rejects a fully-qualified special-use host with a trailing dot", async () => {
    // Regression: the WHATWG parser keeps `localhost.` (only the root label is
    // dropped for real domains), so an exact-match special-use set missed it.
    const resolver = typedResolver({
      "localhost.": { a: ["93.184.216.34"] },
      "api.localhost.": { a: ["93.184.216.34"] },
      "LOCALHOST..": { a: ["93.184.216.34"] },
      "intranet.local.": { a: ["93.184.216.34"] },
    })
    for (const input of ["http://localhost./", "http://api.localhost./", "http://LOCALHOST../"]) {
      try {
        await validatePublicUrl(input, { resolver })
        throw new Error(`expected throw for ${input}`)
      } catch (err) {
        assertEquals(err instanceof UrlValidationError, true, input)
        if (err instanceof UrlValidationError) {
          assertEquals(err.code, "special_use", `code mismatch for ${input}`)
        }
      }
    }
    await assertRejects(
      () => validatePublicUrl("http://intranet.local./", { resolver }),
      UrlValidationError,
      "special-use",
    )
  })

  it("rejects WHATWG-normalized loopback (127.1, 0x7f000001, 2130706433, 0177.0.0.1)", async () => {
    // The WHATWG parser canonicalises every non-canonical IPv4 spelling into
    // dotted-decimal, so these arrive at the IP branch already normalised.
    for (
      const input of [
        "http://127.1/",
        "http://127.0.1/",
        "http://0x7f000001/",
        "http://2130706433/",
        "http://0177.0.0.1/",
        "http://0x7f.1/",
        "http://127.0.0.1/",
      ]
    ) {
      try {
        await validatePublicUrl(input)
        throw new Error(`expected throw for ${input}`)
      } catch (err) {
        assertEquals(err instanceof UrlValidationError, true, input)
        if (err instanceof UrlValidationError) {
          assertEquals(err.code, "non_public_ip", `code mismatch for ${input}`)
        }
      }
    }
  })

  it("rejects RFC1918, link-local metadata, CGNAT, docs", async () => {
    for (
      const input of [
        "http://10.0.0.1/",
        "http://172.20.5.6/",
        "http://192.168.0.1/",
        "http://169.254.169.254/latest/meta-data/",
        "http://100.64.0.1/",
        "http://192.0.2.1/",
        "http://198.51.100.1/",
        "http://203.0.113.1/",
      ]
    ) {
      await assertRejects(() => validatePublicUrl(input), UrlValidationError, "non-public")
    }
  })

  it("rejects IPv6 loopback, ULA, link-local, docs, multicast, mapped loopback", async () => {
    for (
      const input of [
        "http://[::1]/",
        "http://[::ffff:127.0.0.1]/",
        "http://[fc00::1]/",
        "http://[fe80::1]/",
        "http://[2001:db8::1]/",
        "http://[ff02::1]/",
        "http://[::]/",
      ]
    ) {
      await assertRejects(() => validatePublicUrl(input), UrlValidationError, "non-public")
    }
  })

  it("rejects deprecated IPv4-compatible IPv6 literals", async () => {
    for (
      const input of [
        "http://[::127.0.0.1]/",
        "http://[::169.254.169.254]/",
        "http://[::10.0.0.1]/",
      ]
    ) {
      await assertRejects(() => validatePublicUrl(input), UrlValidationError, "non-public")
    }
  })

  it("accepts a public IPv4-compatible IPv6 literal in canonical form", async () => {
    // The WHATWG parser canonicalizes `[::8.8.8.8]` to `[::808:808]`.
    assertEquals(await validatePublicUrl("http://[::8.8.8.8]/"), "http://[::808:808]/")
  })

  it("accepts a public IPv6 literal with brackets", async () => {
    assertEquals(
      await validatePublicUrl("https://[2606:4700:4700::1111]/"),
      "https://[2606:4700:4700::1111]/",
    )
  })

  it("accepts a public host that resolves via the injected resolver", async () => {
    assertEquals(
      await validatePublicUrl("https://example.com/landing", { resolver: PUBLIC_IPV4 }),
      "https://example.com/landing",
    )
  })

  it("resolves A and AAAA and rejects a private AAAA behind a public A", async () => {
    // This is the AAAA half of the two-family check: a host with a perfectly
    // public A record and a loopback AAAA record must be refused.
    const resolver = typedResolver({
      "dual.example": { a: ["93.184.216.34"], aaaa: ["::1"] },
      "ula.example": { a: ["93.184.216.34"], aaaa: ["fd12:3456:789a::1"] },
      "mapped.example": { a: ["93.184.216.34"], aaaa: ["::ffff:10.0.0.1"] },
      "public.example": { a: ["93.184.216.34"], aaaa: ["2606:4700:4700::1111"] },
    })
    for (const host of ["dual.example", "ula.example", "mapped.example"]) {
      try {
        await validatePublicUrl(`https://${host}/`, { resolver })
        throw new Error(`expected throw for ${host}`)
      } catch (err) {
        assertEquals(err instanceof UrlValidationError, true, host)
        if (err instanceof UrlValidationError) {
          assertEquals(err.code, "non_public_ip", `code mismatch for ${host}`)
        }
      }
    }
    assertEquals(
      await validatePublicUrl("https://public.example/", { resolver }),
      "https://public.example/",
    )
  })

  it("rejects a private A behind a public AAAA", async () => {
    const resolver = typedResolver({
      "flipped.example": { a: ["10.0.0.1"], aaaa: ["2606:4700:4700::1111"] },
    })
    await assertRejects(
      () => validatePublicUrl("https://flipped.example/", { resolver }),
      UrlValidationError,
      "non-public",
    )
  })

  it("does not misclassify hex-letter domains like beef.de as an IP", async () => {
    assertEquals(
      await validatePublicUrl("https://beef.de/some-page", { resolver: PUBLIC_IPV4 }),
      "https://beef.de/some-page",
    )
  })

  it("prepends https when the scheme is missing", async () => {
    assertEquals(
      await validatePublicUrl("example.com/landing", { resolver: PUBLIC_IPV4 }),
      "https://example.com/landing",
    )
  })

  it("lowercases the host in the canonical result", async () => {
    assertEquals(
      await validatePublicUrl("https://EXAMPLE.COM/Foo", { resolver: PUBLIC_IPV4 }),
      "https://example.com/Foo",
    )
  })

  it("preserves a non-default port in the canonical result", async () => {
    assertEquals(
      await validatePublicUrl("https://example.com:8443/path", { resolver: PUBLIC_IPV4 }),
      "https://example.com:8443/path",
    )
    assertEquals(
      await validatePublicUrl("example.com:8443/path", { resolver: PUBLIC_IPV4 }),
      "https://example.com:8443/path",
    )
  })

  it("elides the default port (https 443, http 80)", async () => {
    assertEquals(
      await validatePublicUrl("https://example.com:443/path", { resolver: PUBLIC_IPV4 }),
      "https://example.com/path",
    )
    assertEquals(
      await validatePublicUrl("http://example.com:80/path", { resolver: PUBLIC_IPV4 }),
      "http://example.com/path",
    )
  })

  it("preserves a bracketed IPv6 host with a non-default port", async () => {
    assertEquals(
      await validatePublicUrl("https://[2606:4700:4700::1111]:8443/path"),
      "https://[2606:4700:4700::1111]:8443/path",
    )
  })

  it("elides the default port on a bracketed IPv6 host", async () => {
    assertEquals(
      await validatePublicUrl("https://[2606:4700:4700::1111]:443/"),
      "https://[2606:4700:4700::1111]/",
    )
  })

  it("rejects when any DNS answer is private (mixed public+private)", async () => {
    const resolver = staticResolver({
      "split.example": ["93.184.216.34", "10.0.0.1"],
    })
    await assertRejects(
      () => validatePublicUrl("https://split.example/", { resolver }),
      UrlValidationError,
      "non-public",
    )
  })

  it("rejects a non-canonical IPv4 answer returned by DNS", async () => {
    // A resolver cannot be trusted to return canonical dotted-decimal: the
    // classifiers refuse anything else rather than parsing it.
    for (
      const answer of ["127.1", "2130706433", "0x7f000001", "0177.0.0.1", "1.2.3", "999.0.0.1"]
    ) {
      const resolver = staticResolver({ "sneaky.example": [answer] })
      await assertRejects(
        () => validatePublicUrl("https://sneaky.example/", { resolver }),
        UrlValidationError,
        "non-public",
      )
    }
  })

  it("rejects a DNS lookup failure", async () => {
    await assertRejects(
      () => validatePublicUrl("https://nx.example.com/", { resolver: staticResolver({}) }),
      DnsResolutionError,
      "DNS",
    )
  })

  it("rejects an empty DNS answer", async () => {
    const resolver = staticResolver({ "empty.example": [] })
    await assertRejects(
      () => validatePublicUrl("https://empty.example/", { resolver }),
      DnsResolutionError,
      "no addresses",
    )
  })

  it("rejects asynchronously when the resolver rejects", async () => {
    const rejecting = {
      resolve: () => Promise.reject(new Error("upstream dns offline")),
    }
    await assertRejects(
      () => validatePublicUrl("https://example.com/", { resolver: rejecting }),
      DnsResolutionError,
      "DNS",
    )
  })

  it("never echoes the raw URL or credentials in an error message", async () => {
    const cases = [
      "https://user:super-secret@example.com/",
      "javascript:alert(1)",
      "http://localhost/admin",
      "http://10.0.0.5/x",
    ]
    for (const input of cases) {
      try {
        await validatePublicUrl(input)
        throw new Error(`expected throw for ${input}`)
      } catch (err) {
        const msg = err instanceof Error ? err.message : String(err)
        assertEquals(msg.includes("super-secret"), false, `leak in: ${input}`)
        assertEquals(msg.includes("user:pass"), false, `leak in: ${input}`)
        assertEquals(msg.includes(input), false, `leak raw URL: ${input}`)
      }
    }
  })

  it("exposes a stable code field for routing", async () => {
    const cases: Array<[string, string]> = [
      ["", "empty"],
      ["https://user:x@example.com/", "userinfo"],
      ["javascript:x", "unsupported_protocol"],
      ["http://localhost/", "special_use"],
      ["http://localhost./", "special_use"],
      ["http://127.0.0.1/", "non_public_ip"],
      ["http://10.0.0.1/", "non_public_ip"],
      ["http://[::1]/", "non_public_ip"],
      ["https://intranet/", "invalid_hostname"],
      ["https://nx.example.com/", "dns_failure"],
    ]
    const resolver = typedResolver({
      "localhost.": { a: ["93.184.216.34"] },
      "intranet": { a: ["93.184.216.34"] },
    })
    for (const [input, expectedCode] of cases) {
      try {
        await validatePublicUrl(input, { resolver })
        throw new Error(`expected throw for ${input}`)
      } catch (err) {
        assertEquals(err instanceof UrlValidationError, true, `not a policy error: ${input}`)
        if (err instanceof UrlValidationError) {
          assertEquals(err.code, expectedCode, `code mismatch for ${input}`)
        }
      }
    }
  })

  it("rejects http when allowHttp is false", async () => {
    await assertRejects(
      () =>
        validatePublicUrl("http://example.com/", {
          resolver: PUBLIC_IPV4,
          allowHttp: false,
        }),
      UrlValidationError,
      "HTTPS required",
    )
  })

  it("rejects a URL with no host", async () => {
    await assertRejects(() => validatePublicUrl("https://"), UrlValidationError)
  })

  it("rejects a bare hostname with no dot", async () => {
    await assertRejects(
      () => validatePublicUrl("https://intranet/", { resolver: PUBLIC_IPV4 }),
      UrlValidationError,
      "Invalid domain",
    )
  })

  it("rejects a hostname with a trailing dot that is not special-use", async () => {
    await assertRejects(
      () => validatePublicUrl("https://example.com./", { resolver: PUBLIC_IPV4 }),
      UrlValidationError,
      "Invalid domain",
    )
  })
})

describe("defaultResolver", () => {
  it("is exported and callable", () => {
    assertEquals(typeof defaultResolver.resolve, "function")
  })

  /**
   * Run `body` with `Deno.resolveDns` replaced, then restore it.
   *
   * The stub is how this suite stays hermetic while still exercising the real
   * `defaultResolver`: it reproduces the two behaviours of the platform API
   * that matter here — an answer, and `Deno.errors.NotFound` on NODATA.
   */
  async function withStubbedDns(
    resolver: (host: string, type: string) => Promise<string[]>,
    body: () => Promise<void>,
  ): Promise<void> {
    const original = Deno.resolveDns
    Object.defineProperty(Deno, "resolveDns", {
      configurable: true,
      writable: true,
      value: resolver,
    })
    try {
      await body()
    } finally {
      Object.defineProperty(Deno, "resolveDns", {
        configurable: true,
        writable: true,
        value: original,
      })
    }
  }

  it("queries A and AAAA and returns both families", async () => {
    // An implementation that skipped the AAAA family would let a public-A host
    // with a loopback AAAA through the guard.
    const requested: string[] = []
    await withStubbedDns((host, type) => {
      requested.push(`${type}:${host}`)
      const records: Record<string, string[]> = {
        "A:both.example": ["93.184.216.34"],
        "AAAA:both.example": ["2606:4700:4700::1111"],
      }
      const answer = records[`${type}:${host}`]
      return answer ? Promise.resolve(answer) : Promise.reject(new Deno.errors.NotFound("NODATA"))
    }, async () => {
      assertEquals(
        await defaultResolver.resolve("both.example"),
        ["93.184.216.34", "2606:4700:4700::1111"],
      )
      assertEquals(requested.includes("A:both.example"), true)
      assertEquals(requested.includes("AAAA:both.example"), true)
    })
  })

  it("treats NODATA in one family as an empty answer, not a failure", async () => {
    // `Deno.resolveDns` throws `Deno.errors.NotFound` for a family the name has
    // no records for. Most of the public web is A-only, so propagating that
    // would refuse `github.com`. NODATA is a legitimate empty family.
    await withStubbedDns((_host, type) => {
      if (type === "AAAA") return Promise.reject(new Deno.errors.NotFound("NODATA"))
      return Promise.resolve(["93.184.216.34"])
    }, async () => {
      assertEquals(await defaultResolver.resolve("a-only.example"), ["93.184.216.34"])
    })
  })

  it("treats NODATA as empty in the other direction too", async () => {
    await withStubbedDns((_host, type) => {
      if (type === "A") return Promise.reject(new Deno.errors.NotFound("NODATA"))
      return Promise.resolve(["2606:4700:4700::1111"])
    }, async () => {
      assertEquals(await defaultResolver.resolve("aaaa-only.example"), ["2606:4700:4700::1111"])
    })
  })

  it("still fails closed on a real lookup error", async () => {
    // NODATA is the only error that means "empty". A SERVFAIL, a timeout or a
    // malformed reply must propagate, or an unanswerable family would be read
    // as safe — the exact bypass this guard exists to stop.
    for (
      const error of [
        new Deno.errors.InvalidData("malformed reply"),
        new Deno.errors.TimedOut("query timed out"),
        new Error("SERVFAIL"),
        new TypeError("network unreachable"),
      ]
    ) {
      await withStubbedDns(() => Promise.reject(error), async () => {
        await assertRejects(
          () => defaultResolver.resolve("broken.example"),
          Error,
          error.message,
        )
      })
    }
  })

  it("returns an empty set when neither family answers, and the guard refuses it", async () => {
    // NODATA on both families means the name has no records at all. The
    // resolver reports that as an empty answer rather than an error — NODATA is
    // not a lookup failure — so refusing it is the *policy's* job, and it does:
    // "no records" is not a routable destination.
    await withStubbedDns(
      () => Promise.reject(new Deno.errors.NotFound("NODATA")),
      async () => {
        assertEquals(await defaultResolver.resolve("gone.example"), [])
        try {
          await validatePublicUrl("https://gone.example/", { resolver: defaultResolver })
          throw new Error("expected throw")
        } catch (err) {
          assertEquals(err instanceof DnsResolutionError, true)
          if (err instanceof DnsResolutionError) assertEquals(err.code, "dns_failure")
        }
      },
    )
  })

  it("accepts an A-only host end to end through the stubbed platform API", async () => {
    // The regression this pins: rejecting NODATA refused every A-only host, so
    // `validatePublicUrl("https://github.com/")` raised `dns_failure`. This
    // drives the *real* `defaultResolver` under the policy, with only the
    // platform DNS call stubbed to behave like an A-only host.
    await withStubbedDns((_host, type) => {
      if (type === "AAAA") return Promise.reject(new Deno.errors.NotFound("NODATA"))
      return Promise.resolve(["20.205.243.166"])
    }, async () => {
      assertEquals(await validatePublicUrl("https://a-only.example/"), "https://a-only.example/")
      // An empty family is not a bypass: the family that does answer is still
      // checked for routability.
      await withStubbedDns((_host, type) => {
        if (type === "AAAA") return Promise.reject(new Deno.errors.NotFound("NODATA"))
        return Promise.resolve(["10.0.0.1"])
      }, async () => {
        await assertRejects(
          () => validatePublicUrl("https://private-a-only.example/"),
          UrlValidationError,
          "non-public",
        )
      })
    })
  })
})

// ── Classifier sanity checks ───────────────────────────────────────────────

describe("isPublicIpv4", () => {
  it("rejects RFC1918, loopback, link-local, CGNAT, docs, multicast, broadcast, unspecified", () => {
    for (
      const addr of [
        "10.0.0.1",
        "172.16.0.1",
        "172.31.255.254",
        "192.168.1.1",
        "127.0.0.1",
        "127.255.255.254",
        "169.254.169.254",
        "169.254.0.1",
        "100.64.0.1",
        "100.127.255.254",
        "192.0.2.1",
        "198.51.100.1",
        "203.0.113.1",
        "224.0.0.1",
        "239.255.255.255",
        "240.0.0.1",
        "255.255.255.255",
        "0.0.0.0",
        "198.18.0.1",
        "192.0.0.1",
      ]
    ) {
      assertEquals(isPublicIpv4(addr), false, addr)
    }
  })

  it("accepts public addresses and boundary edges", () => {
    for (
      const addr of [
        "8.8.8.8",
        "1.1.1.1",
        "172.32.0.1",
        "172.15.255.255",
        "100.63.255.255",
        "100.128.0.0",
        "198.17.255.255",
        "198.20.0.0",
      ]
    ) {
      assertEquals(isPublicIpv4(addr), true, addr)
    }
  })

  it("rejects malformed and non-canonical spellings", () => {
    for (
      const addr of [
        "1.2.3",
        "1.2.3.4.5",
        "256.0.0.0",
        "-1.2.3.4",
        "a.b.c.d",
        "2130706433",
        "0x7f000001",
        "0177.0.0.1",
        "127.1",
      ]
    ) {
      assertEquals(isPublicIpv4(addr), false, addr)
    }
  })
})

describe("isPublicIpv6", () => {
  it("rejects loopback, ULA, link-local, multicast, docs, mapped-private, NAT64-private, unspecified", () => {
    for (
      const addr of [
        "::1",
        "::",
        "fc00::1",
        "fd12:3456:789a::1",
        "fe80::1",
        "febf::1",
        "ff02::1",
        "2001:db8::1",
        "::ffff:127.0.0.1",
        "::ffff:10.0.0.1",
        "::ffff:169.254.169.254",
        "64:ff9b::127.0.0.1",
        "100::",
        "100::1",
        "100::ffff:ffff:ffff:ffff",
        "fec0::1",
        "feff:ffff:ffff:ffff:ffff:ffff:ffff:ffff",
        "2001::1",
        "2001:0:ffff:ffff:ffff:ffff:ffff:ffff",
      ]
    ) {
      assertEquals(isPublicIpv6(addr), false, addr)
    }
    assertEquals(isPublicIpv6("64:ff9b::8.8.8.8"), true)
  })

  it("classifies deprecated IPv4-compatible addresses via the embedded IPv4", () => {
    assertEquals(isPublicIpv6("::7f00:1"), false)
    assertEquals(isPublicIpv6("::127.0.0.1"), false)
    assertEquals(isPublicIpv6("::a9fe:a9fe"), false)
    assertEquals(isPublicIpv6("::169.254.169.254"), false)
    assertEquals(isPublicIpv6("::a00:1"), false)
    assertEquals(isPublicIpv6("::10.0.0.1"), false)
    assertEquals(isPublicIpv6("::808:808"), true)
    assertEquals(isPublicIpv6("::8.8.8.8"), true)
    // ::1 must remain loopback (not be misinterpreted as 0.0.0.1).
    assertEquals(isPublicIpv6("::1"), false)
  })

  it("accepts public addresses just outside the special ranges", () => {
    assertEquals(isPublicIpv6("fbff::1"), true)
    // feb0:: is INSIDE fe80::/10 link-local (feb0 = 11111110 10110000).
    assertEquals(isPublicIpv6("feb0::1"), false)
    assertEquals(isPublicIpv6("2606:4700:4700::1111"), true)
    assertEquals(isPublicIpv6("2001:4860:4860::8888"), true)
    // 2001:1::/32 is real (APNIC), not blocked.
    assertEquals(isPublicIpv6("2001:1::1"), true)
    assertEquals(isPublicIpv6("2001:2::1"), false)
  })

  it("rejects malformed input", () => {
    assertEquals(isPublicIpv6("not::an::addr"), false)
    assertEquals(isPublicIpv6(":::"), false)
    assertEquals(isPublicIpv6(""), false)
  })
})

describe("isPublicAddress", () => {
  it("dispatches on family and strips brackets", () => {
    assertEquals(isPublicAddress("8.8.8.8"), true)
    assertEquals(isPublicAddress("127.0.0.1"), false)
    assertEquals(isPublicAddress("::1"), false)
    assertEquals(isPublicAddress("2606:4700:4700::1111"), true)
    assertEquals(isPublicAddress("[2606:4700:4700::1111]"), true)
    assertEquals(isPublicAddress("[::1]"), false)
    assertEquals(isPublicAddress(""), false)
  })
})

describe("parseIpv6Groups", () => {
  it("handles ::, embedded IPv4 and mixed forms", () => {
    assertEquals(parseIpv6Groups("::1"), [0, 0, 0, 0, 0, 0, 0, 1])
    assertEquals(parseIpv6Groups("::"), [0, 0, 0, 0, 0, 0, 0, 0])
    assertEquals(parseIpv6Groups("::ffff:127.0.0.1"), [0, 0, 0, 0, 0, 0xffff, 0x7f00, 0x0001])
    assertEquals(parseIpv6Groups("fe80::1"), [0xfe80, 0, 0, 0, 0, 0, 0, 1])
    assertEquals(parseIpv6Groups("1:2:3:4:5:6:7:8"), [1, 2, 3, 4, 5, 6, 7, 8])
    assertEquals(parseIpv6Groups("1::"), [1, 0, 0, 0, 0, 0, 0, 0])
    assertEquals(parseIpv6Groups("1::8"), [1, 0, 0, 0, 0, 0, 0, 8])
    assertEquals(parseIpv6Groups(""), null)
    assertEquals(parseIpv6Groups("1:2:3:4:5:6:7"), null)
    assertEquals(parseIpv6Groups("1:::1"), null)
  })

  it("strips a zone id before parsing", () => {
    assertEquals(parseIpv6Groups("fe80::1%eth0"), [0xfe80, 0, 0, 0, 0, 0, 0, 1])
    assertEquals(parseIpv6Groups("%eth0"), null)
  })
})

describe("isLocalHostname", () => {
  it("matches special-use names, their subdomains and fully-qualified forms", () => {
    for (
      const host of [
        "localhost",
        "LOCALHOST",
        "localhost.",
        "localhost..",
        "api.localhost",
        "deep.api.localhost.",
        "ip6-localhost",
        "ip6-loopback",
        "printer.local",
        "printer.local.",
        "example.invalid",
      ]
    ) {
      assertEquals(isLocalHostname(host), true, host)
    }
  })

  it("leaves ordinary public hostnames alone", () => {
    for (const host of ["example.com", "mylocalhost", "notlocal.example", "notlocalhost.example"]) {
      assertEquals(isLocalHostname(host), false, host)
    }
  })
})
