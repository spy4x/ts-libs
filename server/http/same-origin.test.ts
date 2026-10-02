import { expect } from "@std/expect"
import { describe, it } from "@std/testing/bdd"
import { Hono } from "hono"
import {
  createSameOriginCheck,
  createSameOriginMutationGuard,
  createSameOriginUpgradeGuard,
  SAFE_METHODS,
  SAME_ORIGIN_REFUSED,
  type SameOriginGuardOptions,
  type SameOriginRefusal,
} from "./same-origin.ts"
import { SESSION_COOKIE_NAME } from "../sign-in/cookie.ts"

const APP = "https://app.example.com"

const ACCEPTED: Record<string, string> = {
  cookie: `${SESSION_COOKIE_NAME}=1:token`,
  origin: APP,
  "sec-fetch-site": "same-origin",
}

/** A real Hono app with the guard on every route and one handler per method. */
function buildApp(options?: SameOriginGuardOptions) {
  const app = new Hono()
  app.use("*", createSameOriginMutationGuard(options))
  app.on(
    ["GET", "HEAD", "OPTIONS", "POST", "PUT", "PATCH", "DELETE"],
    "/thing",
    (c) => c.json({ accepted: true }),
  )
  return app
}

function send(
  headers: Record<string, string | undefined>,
  init: { method?: string; url?: string; options?: SameOriginGuardOptions } = {},
): Promise<Response> {
  const clean: Record<string, string> = {}
  for (const [name, value] of Object.entries(headers)) if (value !== undefined) clean[name] = value
  return Promise.resolve(
    buildApp(init.options).request(init.url ?? `${APP}/thing`, {
      method: init.method ?? "POST",
      headers: clean,
    }),
  )
}

describe("same-origin mutation guard", () => {
  it("accepts a same-origin POST that carries the session cookie", async () => {
    const response = await send(ACCEPTED)
    expect(response.status).toBe(200)
    expect(await response.json()).toEqual({ accepted: true })
  })

  for (const method of ["GET", "HEAD", "OPTIONS"]) {
    it(`lets a ${method} through with no cookie, origin or fetch metadata`, async () => {
      const response = await send({}, { method })
      expect(response.status).toBe(200)
    })
  }

  for (const method of ["PUT", "PATCH", "DELETE"]) {
    it(`refuses a cross-site ${method}`, async () => {
      const response = await send({ ...ACCEPTED, "sec-fetch-site": "cross-site" }, { method })
      expect(response.status).toBe(403)
    })
  }

  for (const method of ["patch", "PROPFIND"]) {
    it(`refuses a cross-site ${method}, a method outside the safe list`, async () => {
      const response = await send({ ...ACCEPTED, "sec-fetch-site": "cross-site" }, { method })
      expect(response.status).toBe(403)
    })
  }

  it("does not let a caller add a method to SAFE_METHODS", async () => {
    const methods = SAFE_METHODS as string[]
    try {
      expect(() => methods.push("POST")).toThrow(TypeError)
      const response = await send({ ...ACCEPTED, "sec-fetch-site": "cross-site" })
      expect(response.status).toBe(403)
    } finally {
      // Only reached with a push when the list is not frozen; keeps the other tests unaffected.
      if (!Object.isFrozen(methods) && methods.includes("POST")) methods.pop()
    }
  })

  it("refuses a mutation with no session cookie with 403 and the default body", async () => {
    const response = await send({ ...ACCEPTED, cookie: undefined })
    expect(response.status).toBe(403)
    expect(await response.json()).toEqual({ error: SAME_ORIGIN_REFUSED })
  })

  it("refuses a session cookie with an empty value", async () => {
    const response = await send({ ...ACCEPTED, cookie: `${SESSION_COOKIE_NAME}=` })
    expect(response.status).toBe(403)
  })

  it("refuses a cookie whose name only ends with the session cookie's name", async () => {
    const response = await send({ ...ACCEPTED, cookie: `x${SESSION_COOKIE_NAME}=1:token` })
    expect(response.status).toBe(403)
  })

  it("finds the session cookie among other cookies", async () => {
    const response = await send({
      ...ACCEPTED,
      cookie: `theme=dark; x${SESSION_COOKIE_NAME}=0; ${SESSION_COOKIE_NAME}=1:token; lang=en`,
    })
    expect(response.status).toBe(200)
  })

  it("reads a configured cookie name instead of the default", async () => {
    const options = { cookieName: "sid" }
    expect((await send({ ...ACCEPTED, cookie: "sid=abc" }, { options })).status).toBe(200)
    expect((await send(ACCEPTED, { options })).status).toBe(403)
  })

  it("refuses a mutation with no Origin header", async () => {
    const response = await send({ ...ACCEPTED, origin: undefined })
    expect(response.status).toBe(403)
  })

  it("accepts Origin null with Sec-Fetch-Site same-origin, as a no-referrer form post sends", async () => {
    const response = await send({ ...ACCEPTED, origin: "null" })
    expect(response.status).toBe(200)
  })

  for (const site of ["same-site", "cross-site", "none", undefined]) {
    it(`refuses Origin null with Sec-Fetch-Site ${site ?? "absent"}`, async () => {
      const response = await send({ ...ACCEPTED, origin: "null", "sec-fetch-site": site })
      expect(response.status).toBe(403)
    })
  }

  it("refuses an Origin from another site", async () => {
    const response = await send({ ...ACCEPTED, origin: "https://evil.example.com" })
    expect(response.status).toBe(403)
  })

  it("refuses an Origin that differs only in scheme or port", async () => {
    expect((await send({ ...ACCEPTED, origin: "http://app.example.com" })).status).toBe(403)
    expect((await send({ ...ACCEPTED, origin: "https://app.example.com:8443" })).status).toBe(403)
  })

  it("refuses a mutation with no Sec-Fetch-Site header", async () => {
    const response = await send({ ...ACCEPTED, "sec-fetch-site": undefined })
    expect(response.status).toBe(403)
  })

  for (const site of ["same-site", "cross-site", "none"]) {
    it(`refuses Sec-Fetch-Site: ${site}`, async () => {
      const response = await send({ ...ACCEPTED, "sec-fetch-site": site })
      expect(response.status).toBe(403)
    })
  }

  it("refuses behind a TLS proxy by default, because the server sees http://", async () => {
    const response = await send(ACCEPTED, { url: "http://app.example.com/thing" })
    expect(response.status).toBe(403)
  })

  it("accepts behind a TLS proxy when the expected origin is configured", async () => {
    const response = await send(ACCEPTED, {
      url: "http://app.example.com/thing",
      options: { expectedOrigin: APP },
    })
    expect(response.status).toBe(200)
  })

  it("accepts any of several expected origins and refuses the request's own", async () => {
    const options = { expectedOrigin: ["https://admin.example.com", APP] }
    const internal = "http://api.internal:8000/thing"
    expect((await send(ACCEPTED, { url: internal, options })).status).toBe(200)
    const admin = { ...ACCEPTED, origin: "https://admin.example.com" }
    expect((await send(admin, { url: internal, options })).status).toBe(200)
    const own = { ...ACCEPTED, origin: "http://api.internal:8000" }
    expect((await send(own, { url: internal, options })).status).toBe(403)
  })

  it("passes a cookieless same-origin POST when the cookie is not required", async () => {
    const options = { requireSessionCookie: false }
    const response = await send({ ...ACCEPTED, cookie: undefined }, { options })
    expect(response.status).toBe(200)
  })

  it("still refuses a cross-site POST when the cookie is not required", async () => {
    const options = { requireSessionCookie: false }
    const crossSite = { origin: "https://evil.example.com", "sec-fetch-site": "cross-site" }
    expect((await send(crossSite, { options })).status).toBe(403)
  })

  describe("allowHeaderless", () => {
    const options = { requireSessionCookie: false, allowHeaderless: true }

    it("passes a POST with neither header, as a one-click unsubscribe sends", async () => {
      expect((await send({}, { options })).status).toBe(200)
    })

    it("still refuses a cross-site browser POST", async () => {
      const crossSite = { origin: "https://evil.example.com", "sec-fetch-site": "cross-site" }
      expect((await send(crossSite, { options })).status).toBe(403)
    })

    it("still refuses a POST with only one of the two headers", async () => {
      expect((await send({ origin: "https://evil.example.com" }, { options })).status).toBe(403)
      expect((await send({ "sec-fetch-site": "cross-site" }, { options })).status).toBe(403)
    })

    it("throws at construction when the session cookie is still required", () => {
      expect(() => createSameOriginCheck({ allowHeaderless: true })).toThrow(TypeError)
      const required = { allowHeaderless: true, requireSessionCookie: true }
      expect(() => createSameOriginMutationGuard(required)).toThrow(TypeError)
    })

    it("is off by default", async () => {
      expect((await send({}, { options: { requireSessionCookie: false } })).status).toBe(403)
    })

    it("lets createSameOriginCheck pass the same request", () => {
      const check = createSameOriginCheck(options)
      expect(check(new Request(`${APP}/thing`, { method: "POST" }))).toBeUndefined()
    })
  })

  it("hands each refusal reason to onReject and returns its response", async () => {
    const reasons: SameOriginRefusal[] = []
    const options: SameOriginGuardOptions = {
      onReject: (c, reason) => {
        reasons.push(reason)
        return c.json({ rejected: reason }, 418)
      },
    }
    const noCookie = await send({ ...ACCEPTED, cookie: undefined }, { options })
    expect(noCookie.status).toBe(418)
    expect(await noCookie.json()).toEqual({ rejected: "no-session-cookie" })
    await send({ ...ACCEPTED, origin: "https://evil.example.com" }, { options })
    await send({ ...ACCEPTED, "sec-fetch-site": "same-site" }, { options })
    expect(reasons).toEqual(["no-session-cookie", "origin-mismatch", "not-same-origin-fetch"])
  })

  it("does not call onReject for an accepted request", async () => {
    let calls = 0
    const options: SameOriginGuardOptions = {
      onReject: (c) => {
        calls++
        return c.text("no", 403)
      },
    }
    expect((await send(ACCEPTED, { options })).status).toBe(200)
    expect(calls).toBe(0)
  })

  for (const bad of ["https://app.example.com/", "app.example.com", "null", "file:///tmp/x"]) {
    it(`throws at construction for the expected origin ${JSON.stringify(bad)}`, () => {
      expect(() => createSameOriginMutationGuard({ expectedOrigin: bad })).toThrow(TypeError)
    })
  }

  it("throws at construction for an empty list of expected origins", () => {
    expect(() => createSameOriginMutationGuard({ expectedOrigin: [] })).toThrow(TypeError)
  })
})

/** What a browser sends on a WebSocket handshake from the app's own page. */
const HANDSHAKE: Record<string, string> = {
  cookie: `${SESSION_COOKIE_NAME}=1:token`,
  origin: APP,
  upgrade: "websocket",
}

/**
 * A real Hono app with the upgrade guard on `/ws`. The handler stands in for the upgrade: reaching
 * it means the guard let the handshake through.
 */
function sendHandshake(
  headers: Record<string, string | undefined>,
  init: { method?: string; url?: string; options?: SameOriginGuardOptions } = {},
): Promise<Response> {
  const app = new Hono()
  app.on(
    ["GET", "POST"],
    "/ws",
    createSameOriginUpgradeGuard(init.options),
    (c) => c.json({ upgraded: true }),
  )
  const clean: Record<string, string> = {}
  for (const [name, value] of Object.entries(headers)) if (value !== undefined) clean[name] = value
  return Promise.resolve(
    app.request(init.url ?? `${APP}/ws`, { method: init.method ?? "GET", headers: clean }),
  )
}

describe("same-origin upgrade guard", () => {
  it("accepts a handshake from the app's own origin with the session cookie", async () => {
    const response = await sendHandshake(HANDSHAKE)
    expect(response.status).toBe(200)
    expect(await response.json()).toEqual({ upgraded: true })
  })

  it("accepts a handshake that carries no Sec-Fetch-Site header", async () => {
    const response = await sendHandshake({ ...HANDSHAKE, "sec-fetch-site": undefined })
    expect(response.status).toBe(200)
  })

  it("refuses a handshake from another site with 403 and the default body", async () => {
    const response = await sendHandshake({ ...HANDSHAKE, origin: "https://evil.example.com" })
    expect(response.status).toBe(403)
    expect(await response.json()).toEqual({ error: SAME_ORIGIN_REFUSED })
  })

  it("checks a request whatever its method", async () => {
    const response = await sendHandshake(
      { ...HANDSHAKE, origin: "https://evil.example.com" },
      { method: "POST" },
    )
    expect(response.status).toBe(403)
  })

  it("checks a request whatever its Upgrade header says", async () => {
    const crossSite = { ...HANDSHAKE, origin: "https://evil.example.com" }
    expect((await sendHandshake({ ...crossSite, upgrade: undefined })).status).toBe(403)
    expect((await sendHandshake({ ...crossSite, upgrade: "WebSocket" })).status).toBe(403)
  })

  it("refuses a handshake with no Origin header", async () => {
    const response = await sendHandshake({ ...HANDSHAKE, origin: undefined })
    expect(response.status).toBe(403)
  })

  it("refuses Origin null even with Sec-Fetch-Site same-origin", async () => {
    const response = await sendHandshake({
      ...HANDSHAKE,
      origin: "null",
      "sec-fetch-site": "same-origin",
    })
    expect(response.status).toBe(403)
  })

  it("refuses an Origin that differs only in scheme or port", async () => {
    expect((await sendHandshake({ ...HANDSHAKE, origin: "http://app.example.com" })).status)
      .toBe(403)
    expect((await sendHandshake({ ...HANDSHAKE, origin: "https://app.example.com:8443" })).status)
      .toBe(403)
  })

  it("refuses a handshake with no session cookie", async () => {
    const response = await sendHandshake({ ...HANDSHAKE, cookie: undefined })
    expect(response.status).toBe(403)
  })

  it("accepts a cookieless handshake from its own origin when the cookie is not required", async () => {
    const options = { requireSessionCookie: false }
    expect((await sendHandshake({ ...HANDSHAKE, cookie: undefined }, { options })).status).toBe(200)
    const crossSite = { ...HANDSHAKE, cookie: undefined, origin: "https://evil.example.com" }
    expect((await sendHandshake(crossSite, { options })).status).toBe(403)
  })

  it("accepts any of several expected origins behind a TLS proxy", async () => {
    const options = { expectedOrigin: ["https://admin.example.com", APP] }
    const internal = "http://api.internal:8000/ws"
    expect((await sendHandshake(HANDSHAKE, { url: internal, options })).status).toBe(200)
    const admin = { ...HANDSHAKE, origin: "https://admin.example.com" }
    expect((await sendHandshake(admin, { url: internal, options })).status).toBe(200)
    const own = { ...HANDSHAKE, origin: "http://api.internal:8000" }
    expect((await sendHandshake(own, { url: internal, options })).status).toBe(403)
  })

  it("hands each refusal reason to onReject and returns its response", async () => {
    const reasons: SameOriginRefusal[] = []
    const options: SameOriginGuardOptions = {
      onReject: (c, reason) => {
        reasons.push(reason)
        return c.json({ rejected: reason }, 418)
      },
    }
    const noCookie = await sendHandshake({ ...HANDSHAKE, cookie: undefined }, { options })
    expect(noCookie.status).toBe(418)
    expect(await noCookie.json()).toEqual({ rejected: "no-session-cookie" })
    await sendHandshake({ ...HANDSHAKE, origin: "https://evil.example.com" }, { options })
    expect((await sendHandshake(HANDSHAKE, { options })).status).toBe(200)
    expect(reasons).toEqual(["no-session-cookie", "origin-mismatch"])
  })

  for (const bad of ["https://app.example.com/", "app.example.com", "null", "file:///tmp/x"]) {
    it(`throws at construction for the expected origin ${JSON.stringify(bad)}`, () => {
      expect(() => createSameOriginUpgradeGuard({ expectedOrigin: bad })).toThrow(TypeError)
    })
  }

  it("throws at construction for an empty list of expected origins", () => {
    expect(() => createSameOriginUpgradeGuard({ expectedOrigin: [] })).toThrow(TypeError)
  })
})

describe("same-origin check on a plain Request", () => {
  function request(headers: Record<string, string>, method = "POST", url = `${APP}/thing`) {
    return new Request(url, { method, headers })
  }

  it("accepts a same-origin POST that carries the session cookie", () => {
    expect(createSameOriginCheck()(request(ACCEPTED))).toBeUndefined()
  })

  it("lets a GET through with no cookie, origin or fetch metadata", () => {
    expect(createSameOriginCheck()(request({}, "GET"))).toBeUndefined()
  })

  it("reports each refusal in the documented order", () => {
    const check = createSameOriginCheck()
    expect(check(request({}))).toBe("no-session-cookie")
    expect(check(request({ ...ACCEPTED, cookie: `${SESSION_COOKIE_NAME}=` })))
      .toBe("no-session-cookie")
    expect(check(request({ ...ACCEPTED, origin: "https://evil.example" }))).toBe("origin-mismatch")
    expect(check(request({ ...ACCEPTED, "sec-fetch-site": "same-site" })))
      .toBe("not-same-origin-fetch")
  })

  it("skips the cookie check when requireSessionCookie is false", () => {
    const { cookie: _, ...noCookie } = ACCEPTED
    expect(createSameOriginCheck({ requireSessionCookie: false })(request(noCookie)))
      .toBeUndefined()
  })

  it("throws at construction for an expected origin that is not bare", () => {
    expect(() => createSameOriginCheck({ expectedOrigin: `${APP}/path` })).toThrow(TypeError)
  })
})
