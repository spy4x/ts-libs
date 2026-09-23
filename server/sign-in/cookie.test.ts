import { expect } from "@std/expect"
import { describe, it } from "@std/testing/bdd"
import { Hono } from "hono"
import { COOKIE_SECRET, createClock, T0 } from "./fake-store.test.ts"
import { SESSION_COOKIE_NAME, SessionCookie, type SessionCookieOptions } from "./cookie.ts"

const VALUE = "1:AAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA"
const HOUR = 3_600_000

interface ParsedCookie {
  name: string
  value: string
  /** Attribute names lower-cased; a flag attribute maps to `""`. */
  attributes: Map<string, string>
}

function parseSetCookie(header: string): ParsedCookie {
  const [pair, ...rest] = header.split(";").map((part) => part.trim())
  const eq = pair.indexOf("=")
  const attributes = new Map<string, string>()
  for (const part of rest) {
    const at = part.indexOf("=")
    if (at === -1) attributes.set(part.toLowerCase(), "")
    else attributes.set(part.slice(0, at).toLowerCase(), part.slice(at + 1))
  }
  return { name: pair.slice(0, eq), value: pair.slice(eq + 1), attributes }
}

function setCookies(response: Response): ParsedCookie[] {
  return response.headers.getSetCookie().map(parseSetCookie)
}

/** An app that sets, reads and clears through one `SessionCookie`. */
function appWith(options: Partial<SessionCookieOptions> = {}, expiresAt = new Date(T0 + HOUR)) {
  const clock = createClock()
  const cookie = new SessionCookie({ secret: COOKIE_SECRET, clock, ...options })
  const app = new Hono()
  app.get("/set", async (c) => {
    try {
      await cookie.set(c, { userId: 7, expiresAt }, VALUE)
    } catch (error) {
      return c.text((error as Error).name, 500)
    }
    return c.text("set")
  })
  app.get("/read", async (c) => c.json({ value: await cookie.read(c) }))
  app.get("/clear", (c) => {
    cookie.clear(c)
    return c.text("cleared")
  })
  return { app, clock, cookie }
}

async function issuedCookieHeader(options: Partial<SessionCookieOptions> = {}): Promise<string> {
  const { app } = appWith(options)
  const [session] = setCookies(await app.request("/set"))
  return `${session.name}=${session.value}`
}

async function readWith(app: Hono, cookieHeader: string | null): Promise<string | null> {
  const headers = cookieHeader === null ? undefined : { cookie: cookieHeader }
  const body = await (await app.request("/read", { headers })).json()
  return body.value
}

describe("SessionCookie.set", () => {
  it("sets Max-Age in seconds, counted from the injected clock to the session's expiry", async () => {
    const { app } = appWith({}, new Date(T0 + 60 * 24 * HOUR + 999))
    const [session, userId] = setCookies(await app.request("/set"))
    // Sixty days is 5 184 000 seconds; in milliseconds it would be over Hono's 400-day ceiling.
    expect(session.attributes.get("max-age")).toBe("5184000")
    expect(userId.attributes.get("max-age")).toBe("5184000")
    expect(session.attributes.get("expires")).toBe(
      new Date(T0 + 60 * 24 * HOUR + 999).toUTCString(),
    )
  })

  it("marks the session cookie HttpOnly, Secure, SameSite=Lax and Path=/", async () => {
    const { app } = appWith()
    const [session] = setCookies(await app.request("/set"))
    expect(session.name).toBe(SESSION_COOKIE_NAME)
    expect(session.attributes.has("httponly")).toBe(true)
    expect(session.attributes.has("secure")).toBe(true)
    expect(session.attributes.get("samesite")).toBe("Lax")
    expect(session.attributes.get("path")).toBe("/")
  })

  it("leaves the user-id cookie readable by scripts but otherwise as strict", async () => {
    const { app } = appWith()
    const [, userId] = setCookies(await app.request("/set"))
    expect(userId.name).toBe("user_id")
    expect(userId.value).toBe("7")
    expect(userId.attributes.has("httponly")).toBe(false)
    expect(userId.attributes.has("secure")).toBe(true)
    expect(userId.attributes.get("samesite")).toBe("Lax")
    expect(userId.attributes.get("path")).toBe("/")
  })

  it("drops Secure only for the literal false", async () => {
    const plain = setCookies(await appWith({ secure: false }).app.request("/set"))
    expect(plain.map((cookie) => cookie.attributes.has("secure"))).toEqual([false, false])

    for (const secure of [undefined, true, "false", 0, null]) {
      const cookies = setCookies(
        await appWith({ secure: secure as boolean }).app.request("/set"),
      )
      expect({ secure, flags: cookies.map((cookie) => cookie.attributes.has("secure")) })
        .toEqual({ secure, flags: [true, true] })
    }
  })

  it("refuses to set a cookie for a session with less than a second left", async () => {
    for (const expiresAt of [new Date(T0), new Date(T0 - 1), new Date(T0 + 999)]) {
      const { app } = appWith({}, expiresAt)
      const response = await app.request("/set")
      expect(await response.text()).toBe("RangeError")
      expect(response.headers.getSetCookie()).toEqual([])
    }
  })

  it("uses the names it is given", async () => {
    const { app } = appWith({ name: "sid", userIdName: "uid" })
    const cookies = setCookies(await app.request("/set"))
    expect(cookies.map((cookie) => cookie.name)).toEqual(["sid", "uid"])
  })
})

describe("SessionCookie.read", () => {
  it("returns the value it signed", async () => {
    const { app } = appWith()
    expect(await readWith(app, await issuedCookieHeader())).toBe(VALUE)
  })

  it("returns null without a cookie", async () => {
    const { app } = appWith()
    expect(await readWith(app, null)).toBeNull()
    expect(await readWith(app, "other=1")).toBeNull()
  })

  it("returns null for an unsigned value, an edited value, or another secret's signature", async () => {
    const { app } = appWith()
    const issued = await issuedCookieHeader()
    const signature = decodeURIComponent(issued.slice(issued.indexOf("=") + 1)).split(".")[1]
    const edited = `${SESSION_COOKIE_NAME}=${
      encodeURIComponent(`${VALUE.replace("1:", "2:")}.${signature}`)
    }`
    const foreign = await issuedCookieHeader({ secret: "another-cookie-secret-not-real-0123456" })

    expect(await readWith(app, `${SESSION_COOKIE_NAME}=${encodeURIComponent(VALUE)}`)).toBeNull()
    expect(await readWith(app, edited)).toBeNull()
    expect(await readWith(app, foreign)).toBeNull()
  })
})

describe("SessionCookie.clear", () => {
  it("expires both cookies at the path and with the Secure flag they were set with", async () => {
    const { app } = appWith()
    const cookies = setCookies(await app.request("/clear"))
    expect(cookies.map((cookie) => cookie.name)).toEqual([SESSION_COOKIE_NAME, "user_id"])
    for (const cookie of cookies) {
      expect(cookie.value).toBe("")
      expect(cookie.attributes.get("max-age")).toBe("0")
      expect(cookie.attributes.get("path")).toBe("/")
      expect(cookie.attributes.has("secure")).toBe(true)
    }
  })
})

describe("SessionCookie options", () => {
  it("refuses a missing, short, blank or non-printable secret", () => {
    for (const secret of [undefined, "", "short", " ".repeat(40), "\n".repeat(40), 1]) {
      expect(() => new SessionCookie({ secret: secret as string })).toThrow(TypeError)
    }
  })
})
