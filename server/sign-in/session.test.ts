import { expect } from "@std/expect"
import { describe, it } from "@std/testing/bdd"
import { encodeHex } from "@std/encoding/hex"
import {
  createClock,
  createFakeStore,
  OTHER_PEPPER,
  PEPPER,
  STORE_METHODS,
  T0,
} from "./fake-store.test.ts"
import {
  MAX_SESSION_MINUTES,
  SecondFactorStatus,
  SessionManager,
  type SessionRecord,
  SessionStatus,
  type SessionStore,
} from "./session.ts"

const MINUTE = 60_000
const DURATION_MINUTES = 60

function setup<S extends SessionRecord = SessionRecord>(store = createFakeStore<S>()) {
  const clock = createClock()
  const sessions = new SessionManager<S>({
    store: store.store,
    pepper: PEPPER,
    durationMinutes: DURATION_MINUTES,
    clock,
  })
  return { ...store, clock, sessions }
}

async function hmacHex(key: string, message: string): Promise<string> {
  const cryptoKey = await crypto.subtle.importKey(
    "raw",
    new TextEncoder().encode(key),
    { name: "HMAC", hash: "SHA-256" },
    false,
    ["sign"],
  )
  const mac = await crypto.subtle.sign("HMAC", cryptoKey, new TextEncoder().encode(message))
  return encodeHex(new Uint8Array(mac))
}

function tokenOf(cookieValue: string): string {
  return cookieValue.slice(cookieValue.indexOf(":") + 1)
}

/** Changes one character of a string to another character of the base64url alphabet. */
function flipLast(value: string): string {
  const last = value[value.length - 1]
  return value.slice(0, -1) + (last === "A" ? "B" : "A")
}

describe("SessionManager.create", () => {
  it("stores the HMAC-SHA-256 of the token under the pepper, never the token", async () => {
    const { sessions, rows } = setup()
    const { session, cookieValue } = await sessions.create({
      userId: 7,
      secondFactor: SecondFactorStatus.NotRequired,
    })
    const token = tokenOf(cookieValue)

    expect(cookieValue).toMatch(/^1:[A-Za-z0-9_-]{43}$/)
    expect(rows.get(session.id)?.tokenHash).toBe(await hmacHex(PEPPER, token))
    expect(JSON.stringify([...rows.values()])).not.toContain(token)
  })

  it("issues a different 256-bit token every time", async () => {
    const { sessions } = setup()
    const first = await sessions.create({ userId: 7, secondFactor: SecondFactorStatus.NotRequired })
    const second = await sessions.create({
      userId: 7,
      secondFactor: SecondFactorStatus.NotRequired,
    })
    expect(tokenOf(first.cookieValue)).not.toBe(tokenOf(second.cookieValue))
    expect(first.session.tokenHash).not.toBe(second.session.tokenHash)
  })

  it("starts an active session a full lifetime from the injected clock", async () => {
    const { sessions } = setup()
    const { session } = await sessions.create({
      userId: 7,
      secondFactor: SecondFactorStatus.Pending,
    })
    expect(session.status).toBe(SessionStatus.Active)
    expect(session.secondFactor).toBe(SecondFactorStatus.Pending)
    expect(session.expiresAt.getTime()).toBe(T0 + DURATION_MINUTES * MINUTE)
  })

  it("carries the app's own fields through to the store", async () => {
    interface AppSession extends SessionRecord {
      keyId: number
    }
    const { sessions, rows } = setup<AppSession>()
    const { session } = await sessions.create({
      userId: 7,
      keyId: 42,
      secondFactor: SecondFactorStatus.NotRequired,
    })
    expect(rows.get(session.id)?.keyId).toBe(42)
  })

  it("ignores status, expiry and hash smuggled in with the app's fields", async () => {
    const { sessions, rows } = setup()
    const smuggled = {
      userId: 7,
      secondFactor: SecondFactorStatus.NotRequired,
      status: SessionStatus.Active,
      tokenHash: "0".repeat(64),
      expiresAt: new Date(T0 + 10_000 * MINUTE),
    }
    const { session } = await sessions.create(smuggled)
    const row = rows.get(session.id)
    expect(row?.tokenHash).not.toBe("0".repeat(64))
    expect(row?.expiresAt.getTime()).toBe(T0 + DURATION_MINUTES * MINUTE)
  })

  it("refuses a second-factor value that is not one of the three", async () => {
    const { sessions, calls } = setup()
    await expect(
      sessions.create({ userId: 7, secondFactor: 99 as SecondFactorStatus }),
    ).rejects.toThrow(TypeError)
    expect(calls).toEqual([])
  })

  it("refuses a store id that cannot round-trip through the cookie", async () => {
    for (const id of [0, -1, 1.5, Number.NaN, 2 ** 53]) {
      const fake = createFakeStore()
      const store: SessionStore = {
        ...fake.store,
        create: async (session) => ({ ...(await fake.store.create(session)), id }),
      }
      const { sessions } = setup({ ...fake, store })
      await expect(
        sessions.create({ userId: 7, secondFactor: SecondFactorStatus.NotRequired }),
      ).rejects.toThrow(TypeError)
    }
  })
})

describe("SessionManager.validate", () => {
  it("accepts the cookie value it issued", async () => {
    const { sessions } = setup()
    const { session, cookieValue } = await sessions.create({
      userId: 7,
      secondFactor: SecondFactorStatus.NotRequired,
    })
    const valid = await sessions.validate(cookieValue)
    expect(valid?.session.id).toBe(session.id)
    expect(valid?.extended).toBe(false)
  })

  it("refuses a token that differs in one character", async () => {
    const { sessions } = setup()
    const { cookieValue } = await sessions.create({
      userId: 7,
      secondFactor: SecondFactorStatus.NotRequired,
    })
    expect(await sessions.validate(flipLast(cookieValue))).toBeNull()
  })

  it("refuses a session hashed under another pepper", async () => {
    const { sessions, store, clock } = setup()
    const { cookieValue } = await sessions.create({
      userId: 7,
      secondFactor: SecondFactorStatus.NotRequired,
    })
    const other = new SessionManager({
      store,
      pepper: OTHER_PEPPER,
      durationMinutes: DURATION_MINUTES,
      clock,
    })
    expect(await other.validate(cookieValue)).toBeNull()
  })

  it("refuses every id form but plain digits, even where Number() would find session 1", async () => {
    const { sessions } = setup()
    const { cookieValue } = await sessions.create({
      userId: 7,
      secondFactor: SecondFactorStatus.NotRequired,
    })
    const token = tokenOf(cookieValue)
    expect(await sessions.validate(`1:${token}`)).not.toBeNull()

    const loose = ["1e0", "0x1", " 1", "1 ", "+1", "01", "1.0", "0b1", "1n", "１"]
    for (const id of loose) {
      expect({ id, valid: await sessions.validate(`${id}:${token}`) }).toEqual({ id, valid: null })
    }
  })

  it("refuses anything after the token, a token of the wrong length, and non-strings", async () => {
    const { sessions } = setup()
    const { cookieValue } = await sessions.create({
      userId: 7,
      secondFactor: SecondFactorStatus.NotRequired,
    })
    const token = tokenOf(cookieValue)
    const malformed: unknown[] = [
      `1:${token}:extra`,
      `1:${token}:`,
      `1:${token} `,
      `1:${token}\n`,
      `1:${token.slice(0, -1)}`,
      `1:${token}A`,
      `1:${token.slice(0, -1)}=`,
      `1:${token.slice(0, -1)}+`,
      `:${token}`,
      `1${token}`,
      "",
      "0:" + token,
      "-1:" + token,
      "9007199254740993:" + token,
      undefined,
      null,
      1,
    ]
    for (const value of malformed) {
      expect({ value, valid: await sessions.validate(value as string) }).toEqual({
        value,
        valid: null,
      })
    }
  })

  it("refuses a row the store returns under a different id", async () => {
    const fake = createFakeStore()
    const store: SessionStore = {
      ...fake.store,
      findById: async (id) => {
        const row = await fake.store.findById(id)
        return row ? { ...row, id: id + 1 } : null
      },
    }
    const { sessions } = setup({ ...fake, store })
    const { cookieValue } = await sessions.create({
      userId: 7,
      secondFactor: SecondFactorStatus.NotRequired,
    })
    expect(await sessions.validate(cookieValue)).toBeNull()
  })

  it("refuses a session at the exact instant it expires, and never extends it", async () => {
    const { sessions, clock, calls, rows } = setup()
    const { session, cookieValue } = await sessions.create({
      userId: 7,
      secondFactor: SecondFactorStatus.NotRequired,
    })
    const expiresAt = session.expiresAt.getTime()

    clock.set(expiresAt)
    expect(await sessions.validate(cookieValue)).toBeNull()
    clock.set(expiresAt + 1)
    expect(await sessions.validate(cookieValue)).toBeNull()
    clock.set(expiresAt + 365 * 24 * 60 * MINUTE)
    expect(await sessions.validate(cookieValue)).toBeNull()

    expect(calls).not.toContain("extend")
    expect(rows.get(session.id)?.expiresAt.getTime()).toBe(expiresAt)
  })

  it("accepts a session one millisecond before it expires, and extends it", async () => {
    const { sessions, clock } = setup()
    const { session, cookieValue } = await sessions.create({
      userId: 7,
      secondFactor: SecondFactorStatus.NotRequired,
    })
    clock.set(session.expiresAt.getTime() - 1)
    const valid = await sessions.validate(cookieValue)
    expect(valid?.extended).toBe(true)
  })

  for (const status of [SessionStatus.SignedOut, SessionStatus.Expired, 0, 99]) {
    it(`refuses a session with status ${status} and never extends it`, async () => {
      const { sessions, clock, calls, rows } = setup()
      const { session, cookieValue } = await sessions.create({
        userId: 7,
        secondFactor: SecondFactorStatus.NotRequired,
      })
      const row = rows.get(session.id) as SessionRecord
      row.status = status as SessionStatus
      clock.advance(50 * MINUTE) // inside the extension zone

      expect(await sessions.validate(cookieValue)).toBeNull()
      expect(calls).not.toContain("extend")
      expect(row.status).toBe(status)
      expect(row.expiresAt.getTime()).toBe(session.expiresAt.getTime())
    })
  }

  it("extends to a full lifetime when less than a quarter is left", async () => {
    const { sessions, clock, rows } = setup()
    const { session, cookieValue } = await sessions.create({
      userId: 7,
      secondFactor: SecondFactorStatus.NotRequired,
    })
    clock.advance(46 * MINUTE) // 14 of 60 minutes left
    const valid = await sessions.validate(cookieValue)

    const expected = T0 + 46 * MINUTE + DURATION_MINUTES * MINUTE
    expect(valid?.extended).toBe(true)
    expect(valid?.session.expiresAt.getTime()).toBe(expected)
    expect(rows.get(session.id)?.expiresAt.getTime()).toBe(expected)
  })

  it("does not extend with exactly a quarter left", async () => {
    const { sessions, clock, calls } = setup()
    const { cookieValue } = await sessions.create({
      userId: 7,
      secondFactor: SecondFactorStatus.NotRequired,
    })
    clock.advance(45 * MINUTE) // 15 of 60 minutes left
    const valid = await sessions.validate(cookieValue)
    expect(valid?.extended).toBe(false)
    expect(calls).not.toContain("extend")
  })

  it("refuses a session signed out between the read and the extension", async () => {
    const fake = createFakeStore()
    const store: SessionStore = {
      ...fake.store,
      findById: async (id) => {
        const row = await fake.store.findById(id)
        await fake.store.signOut(id) // another request signs out right after this read
        return row
      },
    }
    const { sessions, clock, rows } = setup({ ...fake, store })
    const { session, cookieValue } = await sessions.create({
      userId: 7,
      secondFactor: SecondFactorStatus.NotRequired,
    })
    clock.advance(50 * MINUTE)

    expect(await sessions.validate(cookieValue)).toBeNull()
    expect(rows.get(session.id)?.status).toBe(SessionStatus.SignedOut)
    expect(rows.get(session.id)?.expiresAt.getTime()).toBe(session.expiresAt.getTime())
  })

  it("reads the store on every call, so a sign-out is refused on the next request", async () => {
    const { sessions, calls } = setup()
    const { cookieValue } = await sessions.create({
      userId: 7,
      secondFactor: SecondFactorStatus.NotRequired,
    })
    expect(await sessions.validate(cookieValue)).not.toBeNull()
    expect(await sessions.validate(cookieValue)).not.toBeNull()
    expect(await sessions.signOut(cookieValue)).toBe(true)
    expect(await sessions.validate(cookieValue)).toBeNull()
    expect(calls.filter((name) => name === "findById")).toHaveLength(4)
  })

  it("stops on an expiry that is not a valid Date instead of treating it as unexpired", async () => {
    for (const expiresAt of [new Date(Number.NaN), "2999-01-01T00:00:00Z", null, 32503680000000]) {
      const { sessions, rows } = setup()
      const { session, cookieValue } = await sessions.create({
        userId: 7,
        secondFactor: SecondFactorStatus.NotRequired,
      })
      ;(rows.get(session.id) as { expiresAt: unknown }).expiresAt = expiresAt
      await expect(sessions.validate(cookieValue)).rejects.toThrow(TypeError)
    }
  })

  it("stops when the injected clock returns something that is not a finite number", async () => {
    const { sessions, clock } = setup()
    const { cookieValue } = await sessions.create({
      userId: 7,
      secondFactor: SecondFactorStatus.NotRequired,
    })
    clock.set(Number.NaN)
    await expect(sessions.validate(cookieValue)).rejects.toThrow(TypeError)
  })
})

describe("SessionManager sign-out and second factor", () => {
  it("signs out only with the matching token", async () => {
    const { sessions, rows } = setup()
    const { session, cookieValue } = await sessions.create({
      userId: 7,
      secondFactor: SecondFactorStatus.NotRequired,
    })
    expect(await sessions.signOut(flipLast(cookieValue))).toBe(false)
    expect(await sessions.signOut(`1e0:${tokenOf(cookieValue)}`)).toBe(false)
    expect(rows.get(session.id)?.status).toBe(SessionStatus.Active)

    expect(await sessions.signOut(cookieValue)).toBe(true)
    expect(rows.get(session.id)?.status).toBe(SessionStatus.SignedOut)
    expect(await sessions.signOut(cookieValue)).toBe(false)
  })

  it("signs out every session of a user except the one named", async () => {
    const { sessions, rows } = setup()
    const make = (userId: number) =>
      sessions.create({ userId, secondFactor: SecondFactorStatus.NotRequired })
    const a = await make(7)
    const b = await make(7)
    const c = await make(7)
    const other = await make(8)

    await sessions.signOutUser(7, { except: b.session.id })
    expect(rows.get(a.session.id)?.status).toBe(SessionStatus.SignedOut)
    expect(rows.get(b.session.id)?.status).toBe(SessionStatus.Active)
    expect(rows.get(c.session.id)?.status).toBe(SessionStatus.SignedOut)
    expect(rows.get(other.session.id)?.status).toBe(SessionStatus.Active)

    await sessions.signOutUser(7)
    expect(rows.get(b.session.id)?.status).toBe(SessionStatus.SignedOut)
  })

  it("completes the second factor only on an active session", async () => {
    const { sessions, rows } = setup()
    const active = await sessions.create({ userId: 7, secondFactor: SecondFactorStatus.Pending })
    const gone = await sessions.create({ userId: 7, secondFactor: SecondFactorStatus.Pending })
    await sessions.signOut(gone.cookieValue)

    expect(await sessions.completeSecondFactor(active.session.id)).toBe(true)
    expect(rows.get(active.session.id)?.secondFactor).toBe(SecondFactorStatus.Completed)
    expect(await sessions.completeSecondFactor(gone.session.id)).toBe(false)
    expect(rows.get(gone.session.id)?.secondFactor).toBe(SecondFactorStatus.Pending)
    expect(rows.get(gone.session.id)?.status).toBe(SessionStatus.SignedOut)
  })

  it("marks sessions that ran out as expired, by the injected clock", async () => {
    const { sessions, clock, rows } = setup()
    const early = await sessions.create({ userId: 7, secondFactor: SecondFactorStatus.NotRequired })
    clock.advance(30 * MINUTE)
    const late = await sessions.create({ userId: 7, secondFactor: SecondFactorStatus.NotRequired })
    clock.set(early.session.expiresAt.getTime())

    await sessions.expireStale()
    expect(rows.get(early.session.id)?.status).toBe(SessionStatus.Expired)
    expect(rows.get(late.session.id)?.status).toBe(SessionStatus.Active)
  })
})

describe("SessionManager options", () => {
  it("refuses a missing, short, blank or non-printable pepper", () => {
    const store = createFakeStore().store
    for (const pepper of [undefined, "", "short", " ".repeat(40), "\u0000".repeat(40), 42]) {
      expect(() => new SessionManager({ store, pepper: pepper as string, durationMinutes: 60 }))
        .toThrow(TypeError)
    }
  })

  it("refuses a lifetime that is not a whole number of minutes from 1 to 400 days", () => {
    const store = createFakeStore().store
    for (const durationMinutes of [0, -1, 1.5, Number.NaN, MAX_SESSION_MINUTES + 1]) {
      expect(() => new SessionManager({ store, pepper: PEPPER, durationMinutes })).toThrow(
        RangeError,
      )
    }
    expect(() =>
      new SessionManager({ store, pepper: PEPPER, durationMinutes: MAX_SESSION_MINUTES })
    )
      .not.toThrow()
  })
})

describe("fake session store", () => {
  it("has exactly the interface's methods as its own keys, each a function that is not a constructor", () => {
    const { store } = createFakeStore()
    expect(Object.keys(store).sort()).toEqual(STORE_METHODS)
    for (const name of STORE_METHODS) {
      const method = (store as unknown as Record<string, unknown>)[name]
      expect(typeof method).toBe("function")
      expect(Object.hasOwn(method as object, "prototype")).toBe(false)
    }
  })
})

describe("session.ts source", () => {
  it("compares the token hash with constantTimeEquals and never with === or !==", async () => {
    const source = await Deno.readTextFile(new URL("./session.ts", import.meta.url))
    const code = source.split("\n").filter((line) => !/^\s*(\/\/|\*|\/\*\*)/.test(line))
    expect(code.filter((line) => line.includes("constantTimeEquals(hash, session.tokenHash)")))
      .toHaveLength(1)
    expect(code.filter((line) => /tokenHash\s*[!=]==|[!=]==\s*\S*tokenHash/.test(line)))
      .toEqual([])
  })
})
