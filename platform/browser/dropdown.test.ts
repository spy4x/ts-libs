import { describe, it } from "@std/testing/bdd"
import { expect } from "@std/expect"

import { shouldDropdownOpenUp } from "./dropdown.ts"

describe("shouldDropdownOpenUp", () => {
  it("never opens upward for the first two rows, which would clip at the top", () => {
    expect(shouldDropdownOpenUp(0, 10)).toBe(false)
    expect(shouldDropdownOpenUp(1, 10)).toBe(false)
  })

  it("opens upward from the third row when there is something to clip", () => {
    expect(shouldDropdownOpenUp(2, 10)).toBe(true)
    expect(shouldDropdownOpenUp(9, 10)).toBe(true)
  })

  it("never opens upward in a list of two or fewer items", () => {
    expect(shouldDropdownOpenUp(0, 2)).toBe(false)
    expect(shouldDropdownOpenUp(1, 2)).toBe(false)
    expect(shouldDropdownOpenUp(5, 1)).toBe(false)
  })

  it("treats a negative index as a first row", () => {
    expect(shouldDropdownOpenUp(-1, 10)).toBe(false)
  })
})
