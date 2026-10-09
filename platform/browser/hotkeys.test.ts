import { describe, it } from "@std/testing/bdd"
import { expect } from "@std/expect"

import {
  createHotkeyMatcher,
  type HotkeyEvent,
  type HotkeySequenceEvent,
  isApplePlatform,
  isTypingTarget,
  matchesHotkey,
  parseHotkey,
  type TypingTarget,
} from "./hotkeys.ts"

/** A key press with no modifier held, overridden field by field. */
function press(key: string, fields: Partial<HotkeyEvent> = {}): HotkeyEvent {
  return { key, ctrlKey: false, metaKey: false, altKey: false, shiftKey: false, ...fields }
}

/** A `getModifierState` that reports AltGraph as `held` and every other modifier as released. */
function altGraph(held: boolean): (key: string) => boolean {
  return (key) => held && key === "AltGraph"
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

  it("refuses an unknown key name and accepts function keys and KeyboardEvent.key names", () => {
    expect(() => parseHotkey("mod+escpe")).toThrow('unknown key "escpe"')
    expect(() => parseHotkey("f25")).toThrow('unknown key "f25"')
    expect(["f1", "F24", "PageDown", "home"].map((key) => parseHotkey(key).key))
      .toEqual(["f1", "f24", "pagedown", "home"])
  })

  it("refuses shift with a symbol, which no key press can report", () => {
    expect(() => parseHotkey("shift+/")).toThrow("can never fire")
    expect(parseHotkey("shift+n").shift).toBe(true)
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
  })

  it("falls back to reading Control and Alt together as AltGr, for a symbol naming neither", () => {
    expect(fires("@", press("@", { ctrlKey: true, altKey: true, code: "KeyQ" }))).toBe(true)
    expect(fires("@", press("@", { ctrlKey: true }))).toBe(false)
    expect(fires("q", press("q", { ctrlKey: true, altKey: true }))).toBe(false)
    expect(fires("mod+/", press("/", { ctrlKey: true, altKey: true }))).toBe(false)
  })

  it("never reads AltGr for a combination that names Alt or Meta", () => {
    expect(fires("alt+/", press("/", { ctrlKey: true, altKey: true }))).toBe(false)
    expect(fires("meta+/", press("/", { ctrlKey: true, altKey: true, metaKey: true }))).toBe(false)
  })

  it("never reads AltGr on Apple platforms, where Control and Option are a real chord", () => {
    const controlOption = press("/", { ctrlKey: true, altKey: true })
    expect(fires("/", controlOption, true)).toBe(false)
    expect(fires("/", { ...controlOption, getModifierState: altGraph(true) }, true)).toBe(false)
    expect(fires("ctrl+alt+/", controlOption, true)).toBe(true)
  })

  it("asks the event whether AltGr is held when the event can say", () => {
    // US Windows: Control+Alt+/ is a real chord, and the browser reports no AltGraph.
    const chord = press("/", { ctrlKey: true, altKey: true, getModifierState: altGraph(false) })
    expect(fires("/", chord)).toBe(false)
    expect(fires("ctrl+alt+/", chord)).toBe(true)
    // German Windows: AltGr+Q types "@", with or without Control and Alt reported beside it.
    const altGr = { code: "KeyQ", getModifierState: altGraph(true) }
    expect(fires("@", press("@", { ...altGr, ctrlKey: true, altKey: true }))).toBe(true)
    expect(fires("@", press("@", altGr))).toBe(true)
  })

  it("matches a letter or a digit by its physical key when the character differs", () => {
    expect(fires("alt+k", press("˚", { altKey: true, code: "KeyK" }), true)).toBe(true)
    expect(fires("mod+k", press("л", { ctrlKey: true, code: "KeyK" }))).toBe(true)
    expect(fires("mod+1", press("!", { ctrlKey: true, code: "Digit1" }))).toBe(true)
    expect(fires("mod+k", press("л", { ctrlKey: true, code: "KeyL" }))).toBe(false)
  })

  it("never matches by physical key when the press typed another Latin letter or digit", () => {
    // AZERTY: the key where QWERTY has Q types "a".
    expect(fires("q", press("a", { code: "KeyQ" }))).toBe(false)
    expect(fires("a", press("a", { code: "KeyQ" }))).toBe(true)
    // Dvorak: the key where QWERTY has K types "t".
    expect(fires("k", press("t", { code: "KeyK" }))).toBe(false)
    expect(fires("mod+w", press("z", { ctrlKey: true, code: "KeyW" }))).toBe(false)
  })

  it("never matches by physical key while AltGr is held, except on Apple platforms", () => {
    // German: AltGr+Q types "@". Polish: AltGr+A types "ą".
    expect(fires("q", press("@", { code: "KeyQ", getModifierState: altGraph(true) }))).toBe(false)
    expect(fires("a", press("ą", { code: "KeyA", getModifierState: altGraph(true) }))).toBe(false)
    const cyrillic = press("л", { ctrlKey: true, code: "KeyK", getModifierState: altGraph(false) })
    expect(fires("mod+k", cyrillic)).toBe(true)
    // A Mac has no AltGr, so Option keeps its physical-key match whatever the browser reports.
    const option = press("˚", { altKey: true, code: "KeyK", getModifierState: altGraph(true) })
    expect(fires("alt+k", option, true)).toBe(true)
  })

  it("matches nothing for an event with no key", () => {
    const keyless = { ...press("k"), key: undefined } as unknown as HotkeyEvent
    expect(fires("k", keyless)).toBe(false)
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

describe("createHotkeyMatcher", () => {
  /** A key press at `at` milliseconds. */
  function at(key: string, time: number, fields: Partial<HotkeySequenceEvent> = {}) {
    return { ...press(key), timeStamp: time, ...fields } as HotkeySequenceEvent
  }

  const table = [
    { id: `new`, keys: [`n`] },
    { id: `today`, keys: [`g`, `t`] },
    { id: `upcoming`, keys: [`g`, `u`] },
    { id: `help`, keys: [`?`] },
    { id: `edit`, keys: [`enter`] },
    { id: `edit-too`, keys: [`e`] },
  ]

  it("fires a single key at once", () => {
    const match = createHotkeyMatcher(table)
    expect(match(at(`n`, 0))).toBe(`new`)
  })

  it("fires a two-key sequence on its second key and returns the caller's id", () => {
    const match = createHotkeyMatcher(table)
    expect(match(at(`g`, 0))).toBeUndefined()
    expect(match(at(`u`, 100))).toBe(`upcoming`)
  })

  it("forgets a finished sequence, so the second key alone does nothing", () => {
    const match = createHotkeyMatcher(table)
    match(at(`g`, 0))
    match(at(`t`, 10))
    expect(match(at(`t`, 20))).toBeUndefined()
  })

  it("drops the first key when the second comes after the timeout", () => {
    const match = createHotkeyMatcher(table, { timeoutMs: 500 })
    match(at(`g`, 0))
    expect(match(at(`t`, 501))).toBeUndefined()
  })

  it("accepts the second key exactly at the timeout", () => {
    const match = createHotkeyMatcher(table, { timeoutMs: 500 })
    match(at(`g`, 0))
    expect(match(at(`t`, 500))).toBe(`today`)
  })

  it("waits 1000 ms by default", () => {
    const match = createHotkeyMatcher(table)
    match(at(`g`, 0))
    expect(match(at(`t`, 1000))).toBe(`today`)
    match(at(`g`, 2000))
    expect(match(at(`t`, 3001))).toBeUndefined()
  })

  it("drops the first key when another key comes between", () => {
    const match = createHotkeyMatcher(table)
    match(at(`g`, 0))
    match(at(`x`, 10))
    expect(match(at(`t`, 20))).toBeUndefined()
  })

  it("restarts from a key that breaks a sequence, so g g t still reaches g t", () => {
    const match = createHotkeyMatcher(table)
    match(at(`g`, 0))
    match(at(`g`, 10))
    expect(match(at(`t`, 20))).toBe(`today`)
  })

  it("lets a key that breaks a sequence fire its own single binding", () => {
    const match = createHotkeyMatcher(table)
    match(at(`g`, 0))
    expect(match(at(`n`, 10))).toBe(`new`)
  })

  it("ignores a press on a text field and drops the waiting key", () => {
    const match = createHotkeyMatcher(table)
    expect(match(at(`n`, 0, { target: { tagName: `INPUT`, type: `text` } }))).toBeUndefined()
    match(at(`g`, 10))
    match(at(`t`, 20, { target: { tagName: `TEXTAREA` } }))
    expect(match(at(`t`, 30))).toBeUndefined()
  })

  it("ignores a press while composing and drops the waiting key", () => {
    const match = createHotkeyMatcher(table)
    expect(match(at(`n`, 0, { isComposing: true }))).toBeUndefined()
    match(at(`g`, 10))
    match(at(`x`, 20, { isComposing: true }))
    expect(match(at(`t`, 30))).toBeUndefined()
  })

  it("ignores a press the caller's ignore predicate rejects and drops the waiting key", () => {
    const match = createHotkeyMatcher(table, {
      ignore: (event) => (event.target as { inDialog?: boolean } | null)?.inDialog === true,
    })
    const dialog = { inDialog: true } as unknown as TypingTarget
    expect(match(at(`n`, 0, { target: dialog }))).toBeUndefined()
    match(at(`g`, 10))
    match(at(`x`, 20, { target: dialog }))
    expect(match(at(`t`, 30))).toBeUndefined()
    expect(match(at(`n`, 40))).toBe(`new`)
  })

  it("does not match a key with Control held unless the binding names it", () => {
    const match = createHotkeyMatcher(table)
    expect(match(at(`n`, 0, { ctrlKey: true }))).toBeUndefined()
  })

  it("lets a lone Shift press pass without dropping the waiting key", () => {
    const match = createHotkeyMatcher([{ id: `big`, keys: [`g`, `shift+t`] }])
    match(at(`g`, 0))
    expect(match(at(`Shift`, 10, { shiftKey: true }))).toBeUndefined()
    expect(match(at(`T`, 20, { shiftKey: true }))).toBe(`big`)
  })

  it("matches a symbol typed with Shift held", () => {
    const match = createHotkeyMatcher(table)
    expect(match(at(`/`, 0, { shiftKey: true }))).toBeUndefined()
    expect(match(at(`?`, 0, { shiftKey: true }))).toBe(`help`)
  })

  it("lets the shorter binding win when a key is also the start of a sequence", () => {
    const match = createHotkeyMatcher([
      { id: `single`, keys: [`g`] },
      { id: `pair`, keys: [`g`, `t`] },
    ])
    expect(match(at(`g`, 0))).toBe(`single`)
    expect(match(at(`t`, 10))).toBeUndefined()
  })

  it("lets the earlier binding win when two have the same keys", () => {
    const match = createHotkeyMatcher([
      { id: `first`, keys: [`g`, `t`] },
      { id: `second`, keys: [`g`, `t`] },
    ])
    match(at(`g`, 0))
    expect(match(at(`t`, 10))).toBe(`first`)
  })

  it("reads mod as Command when apple is set", () => {
    const match = createHotkeyMatcher([{ id: `k`, keys: [`mod+k`] }], { apple: true })
    expect(match(at(`k`, 0, { ctrlKey: true }))).toBeUndefined()
    expect(match(at(`k`, 1, { metaKey: true }))).toBe(`k`)
  })

  it("throws for a binding with no keys", () => {
    expect(() => createHotkeyMatcher([{ id: 1, keys: [] }])).toThrow(`at least one key`)
  })

  it("throws for a key it cannot read", () => {
    expect(() => createHotkeyMatcher([{ id: 1, keys: [`ctrl+`] }])).toThrow()
  })
})
