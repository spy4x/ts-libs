import { describe, it } from "@std/testing/bdd"
import { expect } from "@std/expect"
import { type } from "arktype"

import {
  defineSettings,
  saveSettings,
  type SettingsStore,
  type StoredSettings,
  type VersionedSettings,
} from "./settings.ts"

const schema = type({
  theme: "'light' | 'dark' | 'system'",
  timeZone: "string | null",
  display: { hourCycle: "'h12' | 'h23' | null" },
})
type Prefs = typeof schema.infer

const defaults: Prefs = { theme: "system", timeZone: null, display: { hourCycle: null } }
const prefs = defineSettings(schema, { defaults })

const berlin: Prefs = { theme: "dark", timeZone: "Europe/Berlin", display: { hourCycle: "h23" } }

/** An in-memory store with the compare-and-set the interface asks for. */
function memoryStore(initial: StoredSettings | null = null) {
  let record = initial
  const store: SettingsStore & { record: () => StoredSettings | null } = {
    read: () => Promise.resolve(record),
    write: (_owner, expected, next) => {
      if ((record?.version ?? 0) !== expected) return Promise.resolve(false)
      record = next
      return Promise.resolve(true)
    },
    record: () => record,
  }
  return store
}

describe("defineSettings", () => {
  it("starts a person on version 0 with the defaults", () => {
    expect(prefs.initial).toEqual({ version: 0, value: defaults })
    expect(prefs.resolve(null)).toEqual({ version: 0, value: defaults })
  })

  it("hands each caller of resolve(null) its own copy of the defaults", () => {
    const first = prefs.resolve(null)
    first.value.display.hourCycle = "h12"
    expect(prefs.resolve(null).value.display.hourCycle).toBeNull()
    expect(prefs.initial.value.display.hourCycle).toBeNull()
  })

  it("refuses defaults that fail the schema", () => {
    expect(() => defineSettings(schema, { defaults: { ...defaults, theme: "pink" } as never }))
      .toThrow("defaults do not pass")
  })

  it("refuses a cap that is not a positive integer", () => {
    for (const maxBytes of [0, 1.5, Infinity, NaN]) {
      expect(() => defineSettings(schema, { defaults, maxBytes })).toThrow("maxBytes")
    }
  })
})

describe("parse", () => {
  it("rejects a value that fails the schema", () => {
    const result = prefs.parse({ ...berlin, theme: "pink" })
    expect(result.ok).toBe(false)
    if (result.ok || result.reason !== "invalid") throw new Error("expected invalid")
    expect(result.error.description).toContain("theme")
  })

  it("drops keys the schema does not declare, at every depth", () => {
    const result = prefs.parse({ ...berlin, admin: true, display: { hourCycle: "h12", x: 1 } })
    expect(result).toEqual({
      ok: true,
      value: { theme: "dark", timeZone: "Europe/Berlin", display: { hourCycle: "h12" } },
    })
  })

  it("drops keys named after Object.prototype members, at the top and one level down", () => {
    const input = JSON.parse(
      `{"theme":"dark","timeZone":null,"__proto__":{"x":1},"constructor":1,"toString":2,` +
        `"valueOf":3,"hasOwnProperty":4,"display":{"hourCycle":"h23","__proto__":{"y":1},` +
        `"constructor":5,"toString":6}}`,
    )
    const result = prefs.parse(input)
    expect(result.ok).toBe(true)
    if (!result.ok) throw new Error("expected ok")
    expect(Object.keys(result.value)).toEqual(["theme", "timeZone", "display"])
    expect(Object.keys(result.value.display)).toEqual(["hourCycle"])
    expect(JSON.stringify(result.value)).toBe(
      `{"theme":"dark","timeZone":null,"display":{"hourCycle":"h23"}}`,
    )
  })

  it("rejects a value whose JSON is over the cap", () => {
    const small = defineSettings(schema, { defaults, maxBytes: 80 })
    const result = small.parse({ ...berlin, timeZone: "x".repeat(80) })
    expect(result).toMatchObject({ ok: false, reason: "too-large", maxBytes: 80 })
  })

  it("measures the cap in UTF-8 bytes, not characters", () => {
    const value = { ...defaults, timeZone: "é".repeat(30) } // 30 characters, 60 bytes
    const bytes = new TextEncoder().encode(JSON.stringify(value)).byteLength
    const capped = defineSettings(schema, { defaults, maxBytes: bytes - 1 })
    expect(capped.parse(value)).toMatchObject({ ok: false, reason: "too-large", bytes })
    expect(defineSettings(schema, { defaults, maxBytes: bytes }).parse(value).ok).toBe(true)
  })
})

describe("resolve", () => {
  it("fills keys a stored value lacks from the defaults", () => {
    expect(prefs.resolve({ version: 3, value: { theme: "light" } })).toEqual({
      version: 3,
      value: { ...defaults, theme: "light" },
    })
  })

  it("reads a value that no longer passes as the defaults and keeps its version", () => {
    expect(prefs.resolve({ version: 7, value: { theme: "sepia" } })).toEqual({
      version: 7,
      value: defaults,
    })
    expect(prefs.resolve({ version: 2, value: "not an object" })).toEqual({
      version: 2,
      value: defaults,
    })
  })
})

describe("save", () => {
  const current: VersionedSettings<Prefs> = { version: 4, value: defaults }

  it("accepts a save based on the current version and bumps it", () => {
    expect(prefs.save(current, { version: 4, value: berlin })).toEqual({
      ok: true,
      settings: { version: 5, value: berlin },
    })
  })

  it("refuses a save based on an older version with the current record", () => {
    expect(prefs.save(current, { version: 3, value: berlin })).toEqual({
      ok: false,
      reason: "conflict",
      current,
    })
  })

  it("refuses a request without a whole, non-negative version", () => {
    for (const version of [undefined, -1, 1.5, "4"]) {
      expect(prefs.save(current, { version, value: berlin })).toMatchObject({
        ok: false,
        reason: "invalid",
      })
    }
  })

  it("refuses an invalid value on the current version", () => {
    expect(prefs.save(current, { version: 4, value: { theme: 1 } })).toMatchObject({
      ok: false,
      reason: "invalid",
    })
  })
})

describe("saveSettings", () => {
  it("writes the first save as version 1", async () => {
    const store = memoryStore()
    const result = await saveSettings(prefs, store, "owner", { version: 0, value: berlin })
    expect(result).toEqual({ ok: true, settings: { version: 1, value: berlin } })
    expect(store.record()).toEqual({ version: 1, value: berlin })
  })

  it("leaves the store alone when a save is refused", async () => {
    const store = memoryStore({ version: 2, value: berlin })
    const result = await saveSettings(prefs, store, "owner", { version: 1, value: defaults })
    expect(result).toEqual({
      ok: false,
      reason: "conflict",
      current: { version: 2, value: berlin },
    })
    expect(store.record()).toEqual({ version: 2, value: berlin })
  })

  it("reports a conflict with the winning record when another save lands first", async () => {
    const winner = { version: 3, value: { ...berlin, theme: "light" } }
    let reads = 0
    const store: SettingsStore = {
      // The first read sees version 2; another device saves version 3 before this write.
      read: () => Promise.resolve(reads++ === 0 ? { version: 2, value: berlin } : winner),
      write: () => Promise.resolve(false),
    }
    const result = await saveSettings(prefs, store, "owner", { version: 2, value: defaults })
    expect(result).toEqual({ ok: false, reason: "conflict", current: winner })
  })
})
