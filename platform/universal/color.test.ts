import { describe, it } from "@std/testing/bdd"
import { expect } from "@std/expect"
import { type } from "arktype"

import {
  contrastRatio,
  hexColor,
  isHexColor,
  readableTextColor,
  relativeLuminance,
} from "./color.ts"

const INVALID = [``, `#fff`, `#ffff`, `ffffff`, `#fffffff`, `#gggggg`, ` #ffffff`, `#ffffff `]

describe(`isHexColor`, () => {
  it(`accepts #rrggbb in lower and upper case`, () => {
    for (const hex of [`#000000`, `#ffffff`, `#FFFFFF`, `#1a2B3c`]) {
      expect(isHexColor(hex)).toBe(true)
    }
  })

  it(`refuses short, long, bare, padded and non-hex strings, and non-strings`, () => {
    const hexLike = { toString: () => `#ffffff` }
    for (const other of [...INVALID, null, undefined, 0xffffff, {}, hexLike]) {
      expect(isHexColor(other)).toBe(false)
    }
  })
})

describe(`relativeLuminance`, () => {
  it(`is 0 for black, 1 for white and about 0.216 for mid-grey`, () => {
    expect(relativeLuminance(`#000000`)).toBe(0)
    expect(relativeLuminance(`#ffffff`)).toBeCloseTo(1, 10)
    expect(relativeLuminance(`#808080`)).toBeCloseTo(0.2159, 4)
  })

  it(`weights green over red over blue`, () => {
    expect(relativeLuminance(`#00ff00`)).toBeCloseTo(0.7152, 4)
    expect(relativeLuminance(`#ff0000`)).toBeCloseTo(0.2126, 4)
    expect(relativeLuminance(`#0000ff`)).toBeCloseTo(0.0722, 4)
  })

  it(`reads upper case the same as lower case`, () => {
    expect(relativeLuminance(`#1A2B3C`)).toBe(relativeLuminance(`#1a2b3c`))
  })

  it(`throws a RangeError for a value that is not #rrggbb`, () => {
    for (const other of INVALID) {
      expect(() => relativeLuminance(other)).toThrow(RangeError)
    }
  })
})

describe(`contrastRatio`, () => {
  it(`gives the published WCAG ratios for known pairs`, () => {
    expect(contrastRatio(`#000000`, `#ffffff`)).toBeCloseTo(21, 10)
    expect(contrastRatio(`#777777`, `#ffffff`)).toBeCloseTo(4.48, 2)
    expect(contrastRatio(`#767676`, `#ffffff`)).toBeCloseTo(4.54, 2)
    expect(contrastRatio(`#0000ff`, `#ffffff`)).toBeCloseTo(8.59, 2)
    expect(contrastRatio(`#ff0000`, `#ffffff`)).toBeCloseTo(4, 2)
  })

  it(`is the same in either order and 1 for one colour against itself`, () => {
    expect(contrastRatio(`#ffffff`, `#777777`)).toBe(contrastRatio(`#777777`, `#ffffff`))
    expect(contrastRatio(`#1a2b3c`, `#1A2B3C`)).toBe(1)
  })

  it(`throws a RangeError when either colour is invalid`, () => {
    expect(() => contrastRatio(`#fff`, `#000000`)).toThrow(RangeError)
    expect(() => contrastRatio(`#000000`, `red`)).toThrow(RangeError)
  })
})

describe(`readableTextColor`, () => {
  it(`picks white on dark backgrounds and black on light ones`, () => {
    expect(readableTextColor(`#000000`)).toBe(`#ffffff`)
    expect(readableTextColor(`#1D4ED8`)).toBe(`#ffffff`)
    expect(readableTextColor(`#ffffff`)).toBe(`#000000`)
    expect(readableTextColor(`#FDE68A`)).toBe(`#000000`)
  })

  it(`picks the higher contrast near the middle: black on #777777, white on #6f6f6f`, () => {
    expect(readableTextColor(`#777777`)).toBe(`#000000`)
    expect(readableTextColor(`#6f6f6f`)).toBe(`#ffffff`)
  })

  it(`throws a RangeError for an invalid background`, () => {
    expect(() => readableTextColor(`#12345`)).toThrow(RangeError)
  })
})

describe(`hexColor`, () => {
  it(`accepts #rrggbb and refuses anything else with a readable message`, () => {
    const schema = type({ color: hexColor })
    expect(schema({ color: `#1A2b3c` })).toEqual({ color: `#1A2b3c` })
    const refused = schema({ color: `#fff` })
    expect(refused).toBeInstanceOf(type.errors)
    expect(String(refused)).toContain(`a hex colour like #1a2b3c`)
  })
})
