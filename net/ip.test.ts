import { expect } from "@std/expect"
import { describe, it } from "@std/testing/bdd"
import { ipInRanges, normalizeIp, parseIp } from "./ip.ts"

describe("parseIp", () => {
  it("accepts a dotted-decimal IPv4 address with its bytes", () => {
    expect(parseIp("192.0.2.1")).toEqual({
      version: 4,
      address: "192.0.2.1",
      bytes: Uint8Array.from([192, 0, 2, 1]),
    })
    expect(normalizeIp("0.0.0.0")).toBe("0.0.0.0")
    expect(normalizeIp("255.255.255.255")).toBe("255.255.255.255")
  })

  it("refuses an IPv4 octet above 255, a leading zero, and the wrong octet count", () => {
    for (
      const input of ["256.0.0.1", "192.0.2.256", "010.0.0.1", "192.0.2.01", "192.0.2", "1.2.3.4.5"]
    ) {
      expect(parseIp(input), input).toBeNull()
    }
  })

  it("writes an IPv6 address in its RFC 5952 spelling", () => {
    const cases: [string, string][] = [
      ["2001:DB8::1", "2001:db8::1"],
      ["2001:0db8:0000:0000:0000:0000:0000:0001", "2001:db8::1"],
      ["::", "::"],
      ["::1", "::1"],
      ["1::", "1::"],
      // the longest zero run is compressed, not the first
      ["2001:db8:0:0:1:0:0:0", "2001:db8:0:0:1::"],
      // on a tie the first run is compressed
      ["2001:0:0:1:0:0:1:1", "2001::1:0:0:1:1"],
      // a single zero group stays as it is
      ["2001:db8:0:1:1:1:1:1", "2001:db8:0:1:1:1:1:1"],
      ["ffff:ffff:ffff:ffff:ffff:ffff:ffff:ffff", "ffff:ffff:ffff:ffff:ffff:ffff:ffff:ffff"],
      ["64:ff9b::192.0.2.1", "64:ff9b::c000:201"],
    ]
    for (const [input, canonical] of cases) {
      expect(normalizeIp(input), input).toBe(canonical)
      expect(parseIp(input)?.version, input).toBe(6)
    }
  })

  it("returns the 16 bytes of an IPv6 address in network order", () => {
    expect(parseIp("2001:db8::ff01")?.bytes).toEqual(
      Uint8Array.from([0x20, 0x01, 0x0d, 0xb8, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0xff, 0x01]),
    )
  })

  it("reports an IPv4-mapped IPv6 address as the IPv4 address it carries", () => {
    for (const input of ["::ffff:192.0.2.1", "::FFFF:c000:201", "0:0:0:0:0:ffff:192.0.2.1"]) {
      expect(parseIp(input), input).toEqual({
        version: 4,
        address: "192.0.2.1",
        bytes: Uint8Array.from([192, 0, 2, 1]),
      })
    }
  })

  it("keeps an IPv4-translated or IPv4-compatible address as IPv6", () => {
    expect(normalizeIp("::ffff:0:c000:201")).toBe("::ffff:0:c000:201")
    expect(normalizeIp("::192.0.2.1")).toBe("::c000:201")
  })

  it("refuses a port, brackets, a zone id, whitespace and anything that is not an address", () => {
    const refused = [
      "",
      " 192.0.2.1",
      "192.0.2.1 ",
      "192.0.2.1\n",
      "192.0.2.1:8080",
      "[2001:db8::1]",
      "[2001:db8::1]:443",
      "fe80::1%eth0",
      "fe80::1%25eth0",
      "2001:db8::1/64",
      "::ffff:192.0.2.1x",
      "::ffff:192.0.2.01",
      "::ffff:192.0.2",
      "2001:db8:::1",
      "2001::db8::1",
      "1:2:3:4:5:6:7:8:9",
      "1:2:3:4:5:6:7",
      "12345::1",
      "g::1",
      "unknown",
      "localhost",
      "0x7f000001",
      "2130706433",
      "127.1",
      `${"1:".repeat(30)}1`,
      "a".repeat(64_000),
    ]
    for (const input of refused) {
      expect(parseIp(input), JSON.stringify(input.slice(0, 40))).toBeNull()
    }
  })

  it("accepts the longest valid spelling, 45 characters, under the length cap", () => {
    const longest = "ffff:ffff:ffff:ffff:ffff:ffff:255.255.255.255"
    expect(longest.length).toBe(45)
    expect(normalizeIp(longest)).toBe("ffff:ffff:ffff:ffff:ffff:ffff:ffff:ffff")
    expect(parseIp(`0${longest}`)).toBeNull()
  })
})

describe("ipInRanges", () => {
  it("matches an IPv4 address at both edges of a range and not one step outside", () => {
    const ranges = ["104.16.0.0/13"]
    expect(ipInRanges("104.16.0.0", ranges)).toBe(true)
    expect(ipInRanges("104.23.255.255", ranges)).toBe(true)
    expect(ipInRanges("104.15.255.255", ranges)).toBe(false)
    expect(ipInRanges("104.24.0.0", ranges)).toBe(false)
  })

  it("matches an IPv6 address at both edges of a range and not one step outside", () => {
    const ranges = ["2a06:98c0::/29"]
    expect(ipInRanges("2a06:98c0::", ranges)).toBe(true)
    expect(ipInRanges("2a06:98c7:ffff:ffff:ffff:ffff:ffff:ffff", ranges)).toBe(true)
    expect(ipInRanges("2a06:98bf:ffff:ffff:ffff:ffff:ffff:ffff", ranges)).toBe(false)
    expect(ipInRanges("2a06:98c8::", ranges)).toBe(false)
  })

  it("matches a prefix that ends on a byte boundary", () => {
    expect(ipInRanges("2606:4700:ffff::1", ["2606:4700::/32"])).toBe(true)
    expect(ipInRanges("2606:4701::", ["2606:4700::/32"])).toBe(false)
    expect(ipInRanges("10.255.255.255", ["10.0.0.0/8"])).toBe(true)
    expect(ipInRanges("11.0.0.0", ["10.0.0.0/8"])).toBe(false)
  })

  it("checks every range in the list", () => {
    const ranges = ["173.245.48.0/20", "2400:cb00::/32", "104.16.0.0/13"]
    expect(ipInRanges("104.16.0.1", ranges)).toBe(true)
    expect(ipInRanges("2400:cb00::1", ranges)).toBe(true)
    expect(ipInRanges("192.0.2.1", ranges)).toBe(false)
  })

  it("treats a bare address as a range of that one address", () => {
    expect(ipInRanges("192.0.2.1", ["192.0.2.1"])).toBe(true)
    expect(ipInRanges("192.0.2.2", ["192.0.2.1"])).toBe(false)
    expect(ipInRanges("2001:db8::1", ["2001:db8::1"])).toBe(true)
    expect(ipInRanges("2001:db8::2", ["2001:db8::1"])).toBe(false)
  })

  it("matches every address of its own family with a /0 and none of the other", () => {
    expect(ipInRanges("255.255.255.255", ["0.0.0.0/0"])).toBe(true)
    expect(ipInRanges("2001:db8::1", ["0.0.0.0/0"])).toBe(false)
    expect(ipInRanges("2001:db8::1", ["::/0"])).toBe(true)
    expect(ipInRanges("192.0.2.1", ["::/0"])).toBe(false)
  })

  it("never compares an IPv4 address with an IPv6 range that shares its leading bits", () => {
    // 38.6.71.0 is 0x26064700, the first 32 bits of 2606:4700::/32.
    expect(ipInRanges("38.6.71.0", ["2606:4700::/32"])).toBe(false)
  })

  it("matches an IPv4-mapped IPv6 address against IPv4 ranges", () => {
    expect(ipInRanges("::ffff:104.16.0.1", ["104.16.0.0/13"])).toBe(true)
    expect(ipInRanges("::ffff:6810:1", ["104.16.0.0/13"])).toBe(true)
    expect(ipInRanges("::ffff:104.24.0.0", ["104.16.0.0/13"])).toBe(false)
  })

  it("ignores the bits after the prefix in a range's base address", () => {
    expect(ipInRanges("10.200.0.1", ["10.0.0.1/8"])).toBe(true)
    expect(ipInRanges("2001:db8:ffff::", ["2001:db8::1/32"])).toBe(true)
  })

  it("says false for anything that is not an address, and for an empty list", () => {
    for (const ip of ["", "unknown", "104.16.0.1:443", " 104.16.0.1", "999.16.0.1"]) {
      expect(ipInRanges(ip, ["104.16.0.0/13", "0.0.0.0/0", "::/0"]), ip).toBe(false)
    }
    expect(ipInRanges("104.16.0.1", [])).toBe(false)
  })

  it("throws on a range that is not valid, even after an earlier range matched", () => {
    const malformed = [
      "10.0.0.0/33",
      "2001:db8::/129",
      "10.0.0.0/",
      "10.0.0.0/08",
      "10.0.0.0/-1",
      "10.0.0.0/8 ",
      "10.0.0/8",
      "cloudflare",
      "",
      "[2001:db8::]/32",
      "fe80::%eth0/64",
    ]
    for (const cidr of malformed) {
      expect(() => ipInRanges("10.0.0.1", ["10.0.0.0/8", cidr]), cidr).toThrow(RangeError)
      expect(() => ipInRanges("not-an-ip", [cidr]), cidr).toThrow(RangeError)
    }
  })
})
