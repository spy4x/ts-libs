import { describe, it } from "@std/testing/bdd"
import { expect } from "@std/expect"

import {
  type HotkeyEvent,
  isApplePlatform,
  isTypingTarget,
  matchesHotkey,
  parseHotkey,
} from "./hotkeys.ts"

/** A key press with no modifier held, overridden field by field. */
function press(key: string, fields: Partial<HotkeyEvent> = {}): HotkeyEvent {
  return { key, ctrlKey: false, metaKey: false, altKey: false, shiftKey: false, ...fields }
}

/** Whether `combo` matches `event`, on Apple (`true`) or elsewhere. */
function fires(combo: string, event: HotkeyEvent, apple = false): boolean {
  return matchesHotkey(parseHotkey(combo), event, apple)
}

describe("parseHotkey", () => {
  it("reads the modifiers and the key, case-insensitively", () => {
    expect(parseHotkey("Mod+Shift+K")).toEqual({
      key: "k",
      mod: true,
      ctrl: false,
      meta: false,
      alt: false,
      shift: true,
    })
  })

  it("accepts the other names of each modifier", () => {
    const hotkey = parseHotkey("control+cmd+option+x")
    expect([hotkey.ctrl, hotkey.meta, hotkey.alt, hotkey.shift]).toEqual([true, true, true, false])
  })

  it("maps the short key names to KeyboardEvent.key names", () => {
    expect(["esc", "space", "up", "del", "return", "plus"].map((key) => parseHotkey(key).key))
      .toEqual(["escape", " ", "arrowup", "delete", "enter", "+"])
  })

  it("reads a lone plus and a trailing plus as the plus key", () => {
    expect(parseHotkey("+").key).toBe("+")
    const hotkey = parseHotkey("mod++")
    expect([hotkey.mod, hotkey.key]).toEqual([true, "+"])
  })

  it("refuses an empty combination, an empty part and a missing key", () => {
    expect(() => parseHotkey("  ")).toThrow("empty")
    expect(() => parseHotkey("mod+")).toThrow("empty part")
    expect(() => parseHotkey("mod+shift")).toThrow("names no key")
  })

  it("refuses an unknown modifier and a two-key sequence", () => {
    expect(() => parseHotkey("hyper+k")).toThrow('unknown modifier "hyper"')
    expect(() => parseHotkey("g i")).toThrow("sequence")
  })
})

describe("matchesHotkey", () => {
  it("resolves mod to Control elsewhere and to Command on Apple platforms", () => {
    expect(fires("mod+k", press("k", { ctrlKey: true }))).toBe(true)
    expect(fires("mod+k", press("k", { metaKey: true }))).toBe(false)
    expect(fires("mod+k", press("k", { metaKey: true }), true)).toBe(true)
    expect(fires("mod+k", press("k", { ctrlKey: true }), true)).toBe(false)
  })

  it("does not fire a modifier combination for the plain key, or the reverse", () => {
    expect(fires("mod+k", press("k"))).toBe(false)
    expect(fires("k", press("k", { ctrlKey: true }))).toBe(false)
    expect(fires("k", press("k", { altKey: true }))).toBe(false)
  })

  it("holds Shift to what a letter combination says, whatever Caps Lock did", () => {
    expect(fires("shift+n", press("N", { shiftKey: true }))).toBe(true)
    expect(fires("n", press("N", { shiftKey: true }))).toBe(false)
    expect(fires("n", press("N"))).toBe(true)
    expect(fires("shift+n", press("n"))).toBe(false)
  })

  it("ignores Shift for a symbol the combination does not shift", () => {
    expect(fires("?", press("?", { shiftKey: true }))).toBe(true)
    expect(fires("/", press("/"))).toBe(true)
    expect(fires("?", press("/", { shiftKey: true }))).toBe(false)
    expect(fires("shift+/", press("/"))).toBe(false)
  })

  it("matches a letter or a digit by its physical key when the character differs", () => {
    expect(fires("alt+k", press("˚", { altKey: true, code: "KeyK" }), true)).toBe(true)
    expect(fires("mod+k", press("л", { ctrlKey: true, code: "KeyK" }))).toBe(true)
    expect(fires("mod+1", press("!", { ctrlKey: true, code: "Digit1" }))).toBe(true)
    expect(fires("mod+k", press("л", { ctrlKey: true, code: "KeyL" }))).toBe(false)
  })

  it("matches named keys whatever their case", () => {
    expect(fires("esc", press("Escape"))).toBe(true)
    expect(fires("up", press("ArrowUp"))).toBe(true)
    expect(fires("space", press(" "))).toBe(true)
  })
})

describe("isApplePlatform", () => {
  it("prefers userAgentData and falls back to platform", () => {
    expect(isApplePlatform({ userAgentData: { platform: "macOS" }, platform: "Linux" })).toBe(true)
    expect(isApplePlatform({ userAgentData: { platform: "" }, platform: "iPhone" })).toBe(true)
    expect(isApplePlatform({ platform: "Win32" })).toBe(false)
  })

  it("answers false with no navigator", () => {
    expect(isApplePlatform(null)).toBe(false)
  })
})

describe("isTypingTarget", () => {
  it("counts text inputs, text areas, selects and editable content as typing", () => {
    expect(isTypingTarget({ tagName: "INPUT", type: "text" })).toBe(true)
    expect(isTypingTarget({ tagName: "input", type: "search" })).toBe(true)
    expect(isTypingTarget({ tagName: "TEXTAREA" })).toBe(true)
    expect(isTypingTarget({ tagName: "SELECT" })).toBe(true)
    expect(isTypingTarget({ tagName: "DIV", isContentEditable: true })).toBe(true)
  })

  it("does not count buttons, checkboxes or other elements as typing", () => {
    expect(isTypingTarget({ tagName: "INPUT", type: "checkbox" })).toBe(false)
    expect(isTypingTarget({ tagName: "BUTTON" })).toBe(false)
    expect(isTypingTarget({ tagName: "DIV", isContentEditable: false })).toBe(false)
    expect(isTypingTarget(null)).toBe(false)
  })
})
