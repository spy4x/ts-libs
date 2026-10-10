import { expect } from "@std/expect"
import { describe, it } from "@std/testing/bdd"
import { deviceName, UNKNOWN_DEVICE } from "./user-agent.ts"

describe("deviceName", () => {
  const agents: [string, string][] = [
    [
      "Mozilla/5.0 (X11; Linux x86_64; rv:131.0) Gecko/20100101 Firefox/131.0",
      "Firefox on Linux",
    ],
    [
      "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/129.0.0.0 Safari/537.36",
      "Chrome on Windows",
    ],
    [
      "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/129.0.0.0 Safari/537.36 Edg/129.0.0.0",
      "Edge on Windows",
    ],
    [
      "Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/129.0.0.0 Safari/537.36 OPR/114.0.0.0",
      "Opera on macOS",
    ],
    [
      "Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/18.0 Safari/605.1.15",
      "Safari on macOS",
    ],
    [
      "Mozilla/5.0 (iPhone; CPU iPhone OS 18_0 like Mac OS X) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/18.0 Mobile/15E148 Safari/604.1",
      "Safari on iPhone",
    ],
    [
      "Mozilla/5.0 (iPhone; CPU iPhone OS 18_0 like Mac OS X) AppleWebKit/605.1.15 (KHTML, like Gecko) CriOS/129.0.6668.69 Mobile/15E148 Safari/604.1",
      "Chrome on iPhone",
    ],
    [
      "Mozilla/5.0 (iPad; CPU OS 17_0 like Mac OS X) AppleWebKit/605.1.15 (KHTML, like Gecko) FxiOS/131.0 Mobile/15E148 Safari/605.1.15",
      "Firefox on iPad",
    ],
    [
      "Mozilla/5.0 (Linux; Android 14; SM-S911B) AppleWebKit/537.36 (KHTML, like Gecko) SamsungBrowser/26.0 Chrome/122.0.0.0 Mobile Safari/537.36",
      "Samsung Internet on Android",
    ],
    [
      "Mozilla/5.0 (Linux; Android 14; Pixel 8) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/129.0.0.0 Mobile Safari/537.36",
      "Chrome on Android",
    ],
    [
      "Mozilla/5.0 (X11; CrOS x86_64 14541.0.0) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/129.0.0.0 Safari/537.36",
      "Chrome on ChromeOS",
    ],
  ]
  for (const [agent, name] of agents) {
    it(`names "${name}"`, () => {
      expect(deviceName(agent)).toBe(name)
    })
  }

  it("names only the system when the browser is unknown", () => {
    expect(deviceName("SomeBot/1.0 (Windows NT 10.0)")).toBe("Windows")
  })

  it("does not call a WebKit browser it does not know Safari", () => {
    const agent =
      "Mozilla/5.0 (Linux; Android 14) AppleWebKit/537.36 (KHTML, like Gecko) SomeBrowser/1.0 Safari/537.36"
    expect(deviceName(agent)).toBe("Android")
  })

  it("names only the browser when the system is unknown", () => {
    expect(deviceName("Firefox/131.0")).toBe("Firefox")
  })

  it("says unknown device for an empty, missing or unrecognised agent", () => {
    expect(deviceName("")).toBe(UNKNOWN_DEVICE)
    expect(deviceName(null)).toBe(UNKNOWN_DEVICE)
    expect(deviceName(undefined)).toBe(UNKNOWN_DEVICE)
    expect(deviceName("curl/8.9.1")).toBe(UNKNOWN_DEVICE)
  })

  it("reads only the start of an oversized header", () => {
    const padding = "x".repeat(600)
    expect(deviceName(`${padding} Firefox/131.0 (X11; Linux x86_64)`)).toBe(UNKNOWN_DEVICE)
    expect(deviceName(`Firefox/131.0 (X11; Linux x86_64) ${padding}`)).toBe("Firefox on Linux")
  })
})
