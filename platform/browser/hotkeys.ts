/**
 * Keyboard shortcuts: parse a combination such as `"mod+k"` and match it against a key press.
 *
 * Nothing here reads a global at import time. {@link isApplePlatform} reads `navigator` only when
 * the caller passes none, and the matcher takes the platform as an argument, so a server render and
 * a test decide it themselves.
 *
 * @module
 */

/** A parsed keyboard combination: one key and the modifiers held with it. */
export interface Hotkey {
  /**
   * The key, lowercased: a character (`"k"`, `"?"`, `"/"`, `"+"`, `" "`) or a `KeyboardEvent.key`
   * name (`"escape"`, `"arrowup"`, `"f1"`).
   */
  key: string
  /** `mod`: Command on Apple platforms, Control elsewhere. */
  mod: boolean
  /** Control, on every platform. */
  ctrl: boolean
  /** Meta: Command on Apple platforms, the Windows or Super key elsewhere. */
  meta: boolean
  /** Alt, which Apple keyboards label Option. */
  alt: boolean
  /** Shift. */
  shift: boolean
}

/** The part of a `KeyboardEvent` that {@link matchesHotkey} reads. */
export interface HotkeyEvent {
  key: string
  /** The physical key (`"KeyK"`). Used for letters and digits when `key` does not match. */
  code?: string
  ctrlKey: boolean
  metaKey: boolean
  altKey: boolean
  shiftKey: boolean
  /**
   * Whether a modifier is held, as `KeyboardEvent.getModifierState` answers. The matcher asks it
   * about `"AltGraph"`. Without it, Control and Alt held together are read as AltGr.
   */
  getModifierState?(key: string): boolean
}

/** Names a combination may use for each modifier, lowercased. */
const MODIFIERS: Readonly<Record<string, keyof Omit<Hotkey, "key">>> = {
  mod: "mod",
  ctrl: "ctrl",
  control: "ctrl",
  meta: "meta",
  cmd: "meta",
  command: "meta",
  alt: "alt",
  option: "alt",
  opt: "alt",
  shift: "shift",
}

/** Short names a combination may use for a key, mapped to `KeyboardEvent.key`, lowercased. */
const KEY_ALIASES: Readonly<Record<string, string>> = {
  esc: "escape",
  space: " ",
  spacebar: " ",
  plus: "+",
  up: "arrowup",
  down: "arrowdown",
  left: "arrowleft",
  right: "arrowright",
  del: "delete",
  return: "enter",
}

/** `KeyboardEvent.key` names, lowercased, that a combination may name besides a character. */
const NAMED_KEYS = new Set([
  "escape",
  "enter",
  "tab",
  "backspace",
  "delete",
  "insert",
  "home",
  "end",
  "pageup",
  "pagedown",
  "arrowup",
  "arrowdown",
  "arrowleft",
  "arrowright",
  "contextmenu",
])

/**
 * Whether a lowercased key is a symbol: one character that is not a Latin letter, digit or space.
 */
function isSymbol(key: string): boolean {
  return key.length === 1 && !/[a-z0-9 ]/.test(key)
}

/**
 * Parse a combination such as `"mod+k"`, `"shift+n"`, `"?"` or `"ctrl+alt+delete"`.
 *
 * Tokens are joined by `+` and are case-insensitive; the last one is the key and the others are
 * modifiers: `mod`, `ctrl` or `control`, `meta`, `cmd` or `command`, `alt`, `option` or `opt`, and
 * `shift`. `mod` means Command on Apple platforms and Control elsewhere.
 *
 * The key is one of these, and nothing else:
 *
 * - one character that is not whitespace, such as `k`, `1`, `?` or `/`; the `+` key is written
 *   `plus`, or as the last token (`"mod++"`);
 * - a function key, `f1` to `f24`;
 * - one of these `KeyboardEvent.key` names: `escape`, `enter`, `tab`, `backspace`, `delete`,
 *   `insert`, `home`, `end`, `pageup`, `pagedown`, `arrowup`, `arrowdown`, `arrowleft`,
 *   `arrowright` and `contextmenu`;
 * - a short form: `esc`, `space` or `spacebar` (the space bar), `up`, `down`, `left`, `right`,
 *   `del` and `return`.
 *
 * Only one key press per combination: a sequence such as `"g i"` is refused. So is a combination
 * that could never fire: an unknown key name (`"mod+escpe"`), and `shift` with a symbol
 * (`"shift+/"`), because a key press reports the character Shift produced (`"?"`), not the key
 * under it. Write the symbol itself instead.
 *
 * @param combo The combination as written in code.
 * @returns The key and its modifiers.
 * @throws {Error} When the combination is empty, names no key, names an unknown modifier or an
 *   unknown key, holds whitespace between keys, or pairs `shift` with a symbol.
 */
export function parseHotkey(combo: string): Hotkey {
  const text = combo.trim()
  if (text === "") throw new Error("A hotkey combination is empty")

  let tokens: string[]
  if (text === "+") tokens = ["+"]
  else if (text.endsWith("++")) tokens = [...text.slice(0, -2).split("+"), "+"]
  else tokens = text.split("+")

  const hotkey: Hotkey = {
    key: "",
    mod: false,
    ctrl: false,
    meta: false,
    alt: false,
    shift: false,
  }
  const last = tokens.length - 1
  tokens.forEach((raw, index) => {
    const token = raw.trim().toLowerCase()
    if (token === "") throw new Error(`The hotkey "${combo}" has an empty part`)
    if (/\s/.test(token)) {
      throw new Error(`The hotkey "${combo}" holds a sequence; only one key press is supported`)
    }
    if (index < last) {
      const modifier = MODIFIERS[token]
      if (modifier === undefined) {
        throw new Error(`The hotkey "${combo}" names an unknown modifier "${raw.trim()}"`)
      }
      hotkey[modifier] = true
      return
    }
    if (token in MODIFIERS) throw new Error(`The hotkey "${combo}" names no key`)
    const key = KEY_ALIASES[token] ?? token
    if (key.length > 1 && !NAMED_KEYS.has(key) && !/^f([1-9]|1[0-9]|2[0-4])$/.test(key)) {
      throw new Error(`The hotkey "${combo}" names an unknown key "${raw.trim()}"`)
    }
    hotkey.key = key
  })
  if (hotkey.shift && isSymbol(hotkey.key)) {
    throw new Error(
      `The hotkey "${combo}" can never fire: a key press reports the character Shift produces, ` +
        `so write that character instead of shift`,
    )
  }
  return hotkey
}

/**
 * Whether a key press is the combination.
 *
 * Control, Meta and Alt must be held exactly as the combination says, after `mod` is resolved for
 * the platform. Shift must match too, except for a combination whose key is a symbol (`"?"`,
 * `"/"`, `"+"`): such a character already says which Shift state produced it, and keyboard layouts
 * disagree about which symbols need Shift.
 *
 * A symbol typed with AltGr, such as `@` on a German keyboard, still fires a symbol combination
 * that names none of Control, Alt, Meta and `mod`: while AltGr is held, Control and Alt are ignored
 * for it. When the event has `getModifierState`, its `"AltGraph"` answer says whether AltGr is
 * held, so a real Control+Alt chord on a keyboard without AltGr fires `"ctrl+alt+/"` and never
 * `"/"`. An event without that method has Control and Alt held together read as AltGr. On Apple
 * platforms there is no AltGr: Control and Option held together are always a chord there.
 *
 * A letter or a digit also matches by its physical key (`event.code`), but only when the key press
 * typed no Latin letter or digit: `"mod+k"` still fires with a Cyrillic layout, and `"alt+k"` on a
 * Mac, where Option turns `k` into `˚`. A key that types another Latin letter is that letter, so on
 * AZERTY the key that types `a` fires `"a"` and never `"q"`, and on Dvorak the key that types `t`
 * fires `"t"` and never `"k"`. A modifier that turns the key into something other than a Latin
 * letter or digit, as Option on a Mac usually does, makes the combination follow the key's QWERTY
 * position instead: on a French Mac keyboard, `"alt+a"` fires on the key printed Q. A press made
 * with AltGr never matches by its physical key, because AltGr picks another character on purpose:
 * on a German keyboard, AltGr+Q types `@` and does not fire `"q"`.
 *
 * An event with no `key`, such as the plain `Event` some browsers send when they autofill a
 * field, matches nothing.
 *
 * @param hotkey A combination from {@link parseHotkey}.
 * @param event The key press, or anything with the same fields.
 * @param apple Whether `mod` means Command (`true`) or Control (`false`); see
 *   {@link isApplePlatform}.
 */
export function matchesHotkey(hotkey: Hotkey, event: HotkeyEvent, apple: boolean): boolean {
  if (typeof event.key !== "string") return false
  const ctrl = hotkey.ctrl || (hotkey.mod && !apple)
  const meta = hotkey.meta || (hotkey.mod && apple)
  const symbol = isSymbol(hotkey.key)
  const altGr = symbol && !apple && !ctrl && !meta && !hotkey.alt && isAltGraphHeld(event)
  if (!altGr && (event.ctrlKey !== ctrl || event.altKey !== hotkey.alt)) return false
  if (event.metaKey !== meta) return false
  if (!symbol && event.shiftKey !== hotkey.shift) return false

  const typed = event.key.toLowerCase()
  if (typed === hotkey.key) return true
  if (/^[a-z0-9]$/.test(typed)) return false
  if (!apple && isAltGraphHeld(event)) return false
  return physicalCode(hotkey.key) !== undefined && event.code === physicalCode(hotkey.key)
}

/**
 * Whether AltGr is held: the event's own answer when it has `getModifierState`, and otherwise
 * Control and Alt held together, the pair Windows also accepts for AltGr.
 */
function isAltGraphHeld(event: HotkeyEvent): boolean {
  if (typeof event.getModifierState === "function") return event.getModifierState("AltGraph")
  return event.ctrlKey && event.altKey
}

/** `event.code` of a letter or digit key (`"KeyK"`, `"Digit1"`), or `undefined` for any other. */
function physicalCode(key: string): string | undefined {
  if (/^[a-z]$/.test(key)) return `Key${key.toUpperCase()}`
  if (/^[0-9]$/.test(key)) return `Digit${key}`
  return undefined
}

/** The part of `navigator` that {@link isApplePlatform} reads. */
export interface PlatformNavigator {
  platform?: string
  userAgentData?: { platform?: string }
}

/**
 * Whether the browser runs on macOS, iOS or iPadOS, where `mod` means Command.
 *
 * Reads `navigator.userAgentData.platform` where the browser has it, and `navigator.platform`
 * otherwise. Returns `false` with no navigator, as in a server render.
 *
 * @param navigator The navigator to read. `undefined` reads the global one; `null` means none.
 */
export function isApplePlatform(navigator?: PlatformNavigator | null): boolean {
  const source = navigator === undefined
    ? (globalThis as { navigator?: PlatformNavigator }).navigator
    : navigator
  const platform = source?.userAgentData?.platform || source?.platform || ""
  return /mac|iphone|ipad|ipod/i.test(platform)
}

/** The part of an element that {@link isTypingTarget} reads. `HTMLElement` satisfies it. */
export interface TypingTarget {
  tagName?: string
  type?: string
  isContentEditable?: boolean
}

/** `<input>` types that take no typed text, so a key press on them is not typing. */
const NON_TEXT_INPUTS = new Set([
  "button",
  "checkbox",
  "color",
  "file",
  "hidden",
  "image",
  "radio",
  "range",
  "reset",
  "submit",
])

/**
 * Whether a key press on this element is typing: a text `<input>`, a `<textarea>`, a `<select>` or
 * `contenteditable` content. A page-wide shortcut should leave those key presses alone.
 *
 * @param target The event's target. Anything that is not an element answers `false`.
 */
export function isTypingTarget(target: TypingTarget | null | undefined): boolean {
  if (target === null || target === undefined) return false
  if (target.isContentEditable === true) return true
  const tag = target.tagName?.toUpperCase()
  if (tag === "TEXTAREA" || tag === "SELECT") return true
  if (tag === "INPUT") return !NON_TEXT_INPUTS.has((target.type ?? "text").toLowerCase())
  return false
}
