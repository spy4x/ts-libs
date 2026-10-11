import { describe, it } from "@std/testing/bdd"
import { expect } from "@std/expect"
import { type } from "arktype"

import { isUuid, UUID_PATTERN, UUID_V7_PATTERN, uuidV7 } from "./uuid.ts"

/**
 * 2100-01-01T00:00:00.000Z. The generator never goes back in time, so the fake clocks start after
 * the real one, and every test's clock is later than the one before it.
 */
const START = 4_102_444_800_000
const HOUR = 3_600_000

const V4 = "3f2b8c1e-9d4a-4f6b-8a1c-0e5d7b9a2c4f"
const V7 = "019b77da-9c80-7abc-9def-0123456789ab"
const NIL = "00000000-0000-0000-0000-000000000000"

/** Runs `run` with `Date.now` answering from `clock`, and puts the real one back afterwards. */
function withClock<T>(clock: () => number, run: () => T): T {
  const real = Date.now
  Date.now = clock
  try {
    return run()
  } finally {
    Date.now = real
  }
}

/** The millisecond in the first 48 bits of an id. */
function timeOf(id: string): number {
  return parseInt(id.slice(0, 8) + id.slice(9, 13), 16)
}

function expectStrictlyAscending(ids: string[]): void {
  for (let i = 1; i < ids.length; i++) {
    if (!(ids[i - 1]! < ids[i]!)) {
      throw new Error(`id ${i} (${ids[i]}) does not sort after id ${i - 1} (${ids[i - 1]})`)
    }
  }
}

describe("uuidV7", () => {
  it("makes a lower-case id with version digit 7 and the standard variant", () => {
    // A new millisecond per id, so the counter beside the version digit starts over 200 times.
    let now = START
    const ids = withClock(() => now++, () => Array.from({ length: 200 }, () => uuidV7()))
    for (const id of ids) {
      expect(id).toMatch(/^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/)
      expect(id[14]).toBe("7")
      expect("89ab").toContain(id[19])
    }
  })

  it("starts the id with the millisecond it was made in", () => {
    const at = START + HOUR
    const id = withClock(() => at, () => uuidV7())
    expect(timeOf(id)).toBe(at)
    expect(new Date(timeOf(id)).toISOString()).toBe("2100-01-01T01:00:00.000Z")
  })

  it("sorts ids made in later milliseconds after earlier ones", () => {
    let now = START + 2 * HOUR
    const ids = withClock(() => now++, () => Array.from({ length: 500 }, () => uuidV7()))
    expectStrictlyAscending(ids)
    expect(timeOf(ids[499]!) - timeOf(ids[0]!)).toBe(499)
  })

  it("sorts ids made inside one millisecond in creation order", () => {
    const at = START + 3 * HOUR
    const ids = withClock(() => at, () => Array.from({ length: 2_000 }, () => uuidV7()))
    expectStrictlyAscending(ids)
    expect(ids.every((id) => timeOf(id) === at)).toBe(true)
  })

  it("keeps creation order when one millisecond needs more ids than the counter holds", () => {
    const at = START + 4 * HOUR
    const ids = withClock(() => at, () => Array.from({ length: 20_000 }, () => uuidV7()))
    expectStrictlyAscending(ids)
    expect(timeOf(ids[0]!)).toBe(at)
    // 20 000 ids at no more than 4 096 per millisecond need at least four more milliseconds.
    expect(timeOf(ids[19_999]!)).toBeGreaterThanOrEqual(at + 4)
    expect(ids.every((id) => isUuid(id, 7))).toBe(true)
  })

  it("keeps creation order when the clock steps back", () => {
    const at = START + 5 * HOUR
    const times = [at, at + 5, at - 1_000, at + 2, at + 5, at + 6]
    let call = 0
    const ids = withClock(() => times[call++]!, () => times.map(() => uuidV7()))
    expectStrictlyAscending(ids)
    expect(ids.map((id) => timeOf(id) - at)).toEqual([0, 5, 5, 5, 5, 6])
  })
})

describe("isUuid", () => {
  it("accepts a lower-case UUID of any version when no version is asked for", () => {
    for (const id of [V4, V7, NIL, crypto.randomUUID(), uuidV7()]) {
      expect(isUuid(id)).toBe(true)
    }
  })

  it("refuses upper case, a wrong shape and anything that is not a string", () => {
    const wrong = [
      V4.toUpperCase(),
      V4.replaceAll("-", ""),
      V4.slice(0, -1),
      `${V4}0`,
      ` ${V4}`,
      `${V4}\n`,
      `{${V4}}`,
      V4.replace("3", "g"),
      "",
      null,
      undefined,
      7,
      {},
    ]
    for (const value of wrong) {
      expect(isUuid(value)).toBe(false)
      expect(isUuid(value, 4)).toBe(false)
    }
  })

  it("accepts only the version asked for", () => {
    expect(isUuid(V7, 7)).toBe(true)
    expect(isUuid(V4, 4)).toBe(true)
    expect(isUuid(V4, 7)).toBe(false)
    expect(isUuid(V7, 4)).toBe(false)
    expect(isUuid(crypto.randomUUID(), 4)).toBe(true)
    expect(isUuid(crypto.randomUUID(), 7)).toBe(false)
    expect(isUuid(uuidV7(), 7)).toBe(true)
    expect(isUuid(uuidV7(), 4)).toBe(false)
    expect(isUuid(NIL, 7)).toBe(false)
  })

  it("refuses the asked version in a variant other than the standard one", () => {
    expect(isUuid("019b77da-9c80-7abc-7def-0123456789ab", 7)).toBe(false)
    expect(isUuid("019b77da-9c80-7abc-cdef-0123456789ab", 7)).toBe(false)
    expect(isUuid("019b77da-9c80-7abc-7def-0123456789ab")).toBe(true)
  })

  it("narrows an unknown value to a string", () => {
    const value: unknown = V7
    const length = isUuid(value) ? value.length : 0
    expect(length).toBe(36)
  })
})

describe("UUID patterns", () => {
  it("UUID_PATTERN matches a lower-case UUID of any version and nothing longer", () => {
    expect(UUID_PATTERN.test(V4)).toBe(true)
    expect(UUID_PATTERN.test(NIL)).toBe(true)
    expect(UUID_PATTERN.test(uuidV7())).toBe(true)
    expect(UUID_PATTERN.test(V4.toUpperCase())).toBe(false)
    expect(UUID_PATTERN.test(`x${V4}`)).toBe(false)
    expect(UUID_PATTERN.test(`${V4}x`)).toBe(false)
  })

  it("UUID_V7_PATTERN matches version 7 in the standard variant only", () => {
    expect(UUID_V7_PATTERN.test(uuidV7())).toBe(true)
    expect(UUID_V7_PATTERN.test(V7)).toBe(true)
    expect(UUID_V7_PATTERN.test(V4)).toBe(false)
    expect(UUID_V7_PATTERN.test("019b77da-9c80-7abc-cdef-0123456789ab")).toBe(false)
    expect(UUID_V7_PATTERN.test(V7.toUpperCase())).toBe(false)
  })

  it("work as arktype schemas", () => {
    const schema = type({ any: UUID_PATTERN, v7: UUID_V7_PATTERN })
    expect(schema({ any: V4, v7: V7 })).toEqual({ any: V4, v7: V7 })
    expect(schema({ any: V4, v7: V4 }) instanceof type.errors).toBe(true)
    expect(schema({ any: "not-a-uuid", v7: V7 }) instanceof type.errors).toBe(true)
  })
})
