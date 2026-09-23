import { expect } from "@std/expect"
import { describe, it } from "@std/testing/bdd"
import { Hono } from "hono"
import { COOKIE_SECRET, createClock, createFakeStore, PEPPER, T0 } from "./fake-store.test.ts"
import { SessionCookie } from "./cookie.ts"
import {
  type AuthEnv,
  createAuth,
  NOT_AUTHENTICATED,
  NOT_AUTHORIZED,
  SECOND_FACTOR_REQUIRED,
} from "./middleware.ts"
import {
  SecondFactorStatus,
  SessionManager,
  type SessionRecord,
  SessionStatus,
  type SessionStore,
} from "./session.ts"

interface User {
  id: number
  hasSecondFactor: boolean
  admin: boolean
}

const MINUTE = 60_000
const DURATION_MINUTES = 60

/** A real Hono app over the fake store, with one route per guard. */
function setup(
  options: { store?: SessionStore; users?: User[]; mountParseAuth?: boolean } = {},
) {
  const fake = createFakeStore()
  const store = options.store ?? fake.store
  const clock = createClock()
  const users = new Map(
    (options.users ?? [
      { id: 7, hasSecondFactor: false, admin: false },
      { id: 8, hasSecondFactor: true, admin: true },
      { id: 9, hasSecondFactor: false, admin: true },
    ]).map((user) => [user.id, user]),
  )
  const sessions = new SessionManager({
    store,
    pepper: PEPPER,
    durationMinutes: DURATION_MINUTES,
    clock,
  })
  const cookie = new SessionCookie({ secret: COOKIE_SECRET, clock })
  const auth = createAuth<SessionRecord, User>({
    sessions,
    cookie,
    loadUser: (userId) => Promise.resolve(users.get(userId) ?? null),
    hasSecondFactor: (user) => user.hasSecondFactor,
  })

  const reached: string[] = []
  const app = new Hono<AuthEnv<SessionRecord, User>>()
  app.onError((_error, c) => c.text("internal error", 500)) // keeps the expected failure quiet
  if (options.mountParseAuth !== false) app.use("*", auth.parseAuth)
  app.post("/sign-in/:userId/:secondFactor", async (c) => {
    const session = await auth.startSession(c, {
      userId: Number(c.req.param("userId")),
      secondFactor: Number(c.req.param("secondFactor")) as SecondFactorStatus,
    })
    return c.json({ id: session.id })
  })
  app.post("/sign-out", async (c) => {
    await auth.endSession(c)
    return c.json({ auth: c.get("auth") })
  })
  app.get("/state", (c) => {
    const state = c.get("auth")
    return c.json({ state: state === null ? "null" : state === undefined ? "undefined" : "set" })
  })
  app.get("/one", auth.isAuthenticated1FA, (c) => {
    reached.push("one")
    return c.json({ userId: c.get("auth")?.user.id })
  })
  app.get("/two", auth.isAuthenticated2FA, (c) => {
    reached.push("two")
    return c.json({ userId: c.get("auth")?.user.id })
  })
  app.get("/admin", auth.isAuthorized((state) => state.user.admin), (c) => {
    reached.push("admin")
    return c.json({ userId: c.get("auth")?.user.id })
  })
  app.get(
    "/truthy",
    auth.isAuthorized(() => "yes" as unknown as boolean),
    (c) => {
      reached.push("truthy")
      return c.text("reached")
    },
  )
  return { app, clock, sessions, users, reached, ...fake }
}

function cookieHeaderFrom(response: Response): string {
  return response.headers.getSetCookie()
    .map((header) => header.split(";")[0])
    .join("; ")
}

async function signIn(
  app: Hono<AuthEnv<SessionRecord, User>>,
  userId: number,
  secondFactor: SecondFactorStatus,
): Promise<{ cookie: string; id: number }> {
  const response = await app.request(`/sign-in/${userId}/${secondFactor}`, { method: "POST" })
  expect(response.status).toBe(200)
  const { id } = await response.json()
  return { cookie: cookieHeaderFrom(response), id }
}

async function get(app: Hono<AuthEnv<SessionRecord, User>>, path: string, cookie?: string) {
  const response = await app.request(path, { headers: cookie ? { cookie } : undefined })
  const body = response.headers.get("content-type")?.includes("json")
    ? await response.json()
    : await response.text()
  return { status: response.status, body, setCookie: response.headers.getSetCookie() }
}

describe("parseAuth", () => {
  it("sets auth to null, not undefined, when there is no session cookie", async () => {
    const { app } = setup()
    expect((await get(app, "/state")).body).toEqual({ state: "null" })
  })

  it("resolves the session and user a sign-in created", async () => {
    const { app } = setup()
    const { cookie } = await signIn(app, 7, SecondFactorStatus.NotRequired)
    expect(await get(app, "/one", cookie)).toMatchObject({ status: 200, body: { userId: 7 } })
  })

  it("clears the cookie and stays unauthenticated when the session was signed out", async () => {
    const { app, rows } = setup()
    const { cookie, id } = await signIn(app, 7, SecondFactorStatus.NotRequired)
    ;(rows.get(id) as SessionRecord).status = SessionStatus.SignedOut

    const result = await get(app, "/one", cookie)
    expect(result.status).toBe(401)
    expect(result.body).toEqual({ error: NOT_AUTHENTICATED })
    expect(result.setCookie.map((header) => header.split(";")[0])).toEqual([
      "sessionIdToken=",
      "user_id=",
    ])
  })

  it("clears the cookie and stays unauthenticated when the user is gone", async () => {
    const { app, users } = setup()
    const { cookie } = await signIn(app, 7, SecondFactorStatus.NotRequired)
    users.delete(7)

    const result = await get(app, "/one", cookie)
    expect(result.status).toBe(401)
    expect(result.setCookie).toHaveLength(2)
    expect(result.setCookie.every((header) => header.includes("Max-Age=0"))).toBe(true)
  })

  it("sends the cookie again with the new lifetime after an extension", async () => {
    const { app, clock } = setup()
    const { cookie } = await signIn(app, 7, SecondFactorStatus.NotRequired)

    expect((await get(app, "/one", cookie)).setCookie).toEqual([])
    clock.advance(50 * MINUTE)
    const extended = await get(app, "/one", cookie)
    expect(extended.status).toBe(200)
    expect(extended.setCookie).toHaveLength(2)
    for (const header of extended.setCookie) {
      expect(header).toContain(`Max-Age=${DURATION_MINUTES * 60}`)
    }
  })

  it("lets a store failure fail the request instead of passing it", async () => {
    const fake = createFakeStore()
    let failing = false
    const store: SessionStore = {
      ...fake.store,
      findById: (id) => failing ? Promise.reject(new Error("store down")) : fake.store.findById(id),
    }
    const { app, reached } = setup({ store })
    const { cookie } = await signIn(app, 7, SecondFactorStatus.NotRequired)
    failing = true

    expect((await get(app, "/one", cookie)).status).toBe(500)
    expect(reached).toEqual([])
  })
})

describe("guards", () => {
  it("refuse a request that never went through parseAuth", async () => {
    const { app, reached } = setup({ mountParseAuth: false })
    for (const path of ["/one", "/two", "/admin"]) {
      expect(await get(app, path)).toMatchObject({
        status: 401,
        body: { error: NOT_AUTHENTICATED },
      })
    }
    expect(reached).toEqual([])
  })

  it("refuse a request without a session, with 401 and the not-authenticated body", async () => {
    const { app, reached } = setup()
    for (const path of ["/one", "/two", "/admin"]) {
      expect(await get(app, path)).toMatchObject({
        status: 401,
        body: { error: NOT_AUTHENTICATED },
      })
    }
    expect(reached).toEqual([])
  })

  it("let a user without a second factor through when none was required", async () => {
    const { app } = setup()
    const { cookie } = await signIn(app, 9, SecondFactorStatus.NotRequired)
    expect((await get(app, "/two", cookie)).status).toBe(200)
    expect((await get(app, "/admin", cookie)).status).toBe(200)
  })

  it("hold a session owing its second factor at the 2FA guard, but not at the 1FA one", async () => {
    const { app, reached } = setup()
    const { cookie } = await signIn(app, 8, SecondFactorStatus.Pending)
    expect((await get(app, "/one", cookie)).status).toBe(200)
    for (const path of ["/two", "/admin"]) {
      expect(await get(app, path, cookie)).toMatchObject({
        status: 401,
        body: { error: SECOND_FACTOR_REQUIRED },
      })
    }
    expect(reached).toEqual(["one"])
  })

  it("hold a user with a second factor whose session says none was required", async () => {
    const { app } = setup()
    const { cookie } = await signIn(app, 8, SecondFactorStatus.NotRequired)
    for (const path of ["/two", "/admin"]) {
      expect(await get(app, path, cookie)).toMatchObject({
        status: 401,
        body: { error: SECOND_FACTOR_REQUIRED },
      })
    }
  })

  it("hold a session marked as owing a second factor even when the user has none", async () => {
    const { app } = setup()
    const { cookie } = await signIn(app, 9, SecondFactorStatus.Pending)
    for (const path of ["/two", "/admin"]) {
      expect((await get(app, path, cookie)).status).toBe(401)
    }
  })

  it("hold a session with a second-factor value they do not know", async () => {
    const { app, rows } = setup()
    const { cookie, id } = await signIn(app, 9, SecondFactorStatus.NotRequired)
    ;(rows.get(id) as SessionRecord).secondFactor = 99 as SecondFactorStatus
    expect((await get(app, "/one", cookie)).status).toBe(200)
    for (const path of ["/two", "/admin"]) {
      expect(await get(app, path, cookie)).toMatchObject({
        status: 401,
        body: { error: SECOND_FACTOR_REQUIRED },
      })
    }
  })

  it("let a session through once its second factor is completed", async () => {
    const { app, sessions } = setup()
    const { cookie, id } = await signIn(app, 8, SecondFactorStatus.Pending)
    expect((await get(app, "/two", cookie)).status).toBe(401)
    expect(await sessions.completeSecondFactor(id)).toBe(true)
    expect(await get(app, "/two", cookie)).toMatchObject({ status: 200, body: { userId: 8 } })
    expect((await get(app, "/admin", cookie)).status).toBe(200)
  })

  it("answer 403 when the app's check refuses, and only after the second factor", async () => {
    const { app, reached } = setup()
    const { cookie } = await signIn(app, 7, SecondFactorStatus.NotRequired)
    expect(await get(app, "/admin", cookie)).toMatchObject({
      status: 403,
      body: { error: NOT_AUTHORIZED },
    })
    expect(reached).toEqual([])
  })

  it("answer 403 when the app's check returns a truthy value that is not true", async () => {
    const { app, reached } = setup()
    const { cookie } = await signIn(app, 9, SecondFactorStatus.NotRequired)
    expect((await get(app, "/truthy", cookie)).status).toBe(403)
    expect(reached).toEqual([])
  })

  it("treat a truthy hasSecondFactor answer as having one", async () => {
    const { app } = setup({
      users: [{ id: 7, hasSecondFactor: 1 as unknown as boolean, admin: true }],
    })
    const { cookie } = await signIn(app, 7, SecondFactorStatus.NotRequired)
    expect((await get(app, "/two", cookie)).status).toBe(401)
  })
})

describe("startSession and endSession", () => {
  it("set a session cookie that expires with the session", async () => {
    const { app, rows } = setup()
    const response = await app.request(`/sign-in/7/${SecondFactorStatus.NotRequired}`, {
      method: "POST",
    })
    const { id } = await response.json()
    const [session] = response.headers.getSetCookie()
    expect(rows.get(id)?.expiresAt.getTime()).toBe(T0 + DURATION_MINUTES * MINUTE)
    expect(session).toContain(`Max-Age=${DURATION_MINUTES * 60}`)
    expect(session).toContain("HttpOnly")
    expect(session).toContain("Secure")
  })

  it("sign out the session, clear the cookie, and make the old cookie worthless", async () => {
    const { app, rows } = setup()
    const { cookie, id } = await signIn(app, 7, SecondFactorStatus.NotRequired)

    const response = await app.request("/sign-out", { method: "POST", headers: { cookie } })
    expect(await response.json()).toEqual({ auth: null })
    expect(response.headers.getSetCookie().every((header) => header.includes("Max-Age=0")))
      .toBe(true)
    expect(rows.get(id)?.status).toBe(SessionStatus.SignedOut)
    expect((await get(app, "/one", cookie)).status).toBe(401)
  })

  it("clear the cookie even when there is no session to sign out", async () => {
    const { app, calls } = setup()
    const response = await app.request("/sign-out", { method: "POST" })
    expect(response.headers.getSetCookie()).toHaveLength(2)
    expect(calls).not.toContain("signOut")
  })
})
