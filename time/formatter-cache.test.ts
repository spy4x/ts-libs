import { expect } from "@std/expect"
import { describe, it } from "@std/testing/bdd"
import { FORMATTER_CACHE_LIMIT, formatterCaches } from "./formatter-cache.ts"
import { formatInstantLong, isoDateInTz, tzOffsetMinutes, zonedDateTime } from "./tz.ts"

const SPELLINGS = FORMATTER_CACHE_LIMIT * 3

/** The `index`-th upper/lower case mix of `text`: bit `n` of `index` upper-cases letter `n`. */
function caseMix(text: string, index: number): string {
  let bit = 0
  return [...text].map((char) => {
    if (!/[a-z]/.test(char)) return char
    return (index >> bit++) & 1 ? char.toUpperCase() : char
  }).join("")
}

describe("formatter caches", () => {
  it("hold no more formatters than the limit, however many zone spellings and locales arrive", () => {
    const instant = new Date("2026-08-28T08:00:00Z")
    for (let index = 0; index < SPELLINGS; index++) {
      const zone = caseMix("europe/berlin", index)
      expect(isoDateInTz(instant, zone)).toBe("2026-08-28")
      expect(tzOffsetMinutes(instant, zone)).toBe(120)
      expect(zonedDateTime("2026-08-28", "10:00", zone)).toEqual(instant)
      formatInstantLong(instant, "Europe/Berlin", `en-x-a${String(index).padStart(5, "0")}`)
    }
    expect(formatterCaches.length).toBe(3)
    for (const cache of formatterCaches) {
      expect(cache.size).toBeLessThanOrEqual(FORMATTER_CACHE_LIMIT)
    }
  })
})
