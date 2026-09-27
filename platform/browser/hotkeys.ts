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

/**
 * Parse a combination such as `"mod+k"`, `"shift+n"`, `"?"` or `"ctrl+alt+delete"`.
 *
 * Tokens are joined by `+` and are case-insensitive; the last one is the key and the others are
 * modifiers (`mod`, `ctrl`, `meta`/`cmd`, `alt`/`option`, `shift`). `mod` means Command on Apple
 * platforms and Control elsewhere. The `+` key itself is written `"plus"`, or as the last token
 * (`"mod++"`). Key names follow `KeyboardEvent.key` (`"escape"`, `"arrowup"`, `"f1"`), with the
 * short forms `esc`, `space`, `up`, `down`, `left`, `right`, `del` and `return`.
 *
 * Only one key press per combination: a sequence such as `"g i"` is refused.
 *
 * @param combo The combination as written in code.
 * @returns The key and its modifiers.
 * @throws {Error} When the combination is empty, names no key, names an unknown modifier or holds
 *   whitespace between keys.
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
    hotkey.key = KEY_ALIASES[token] ?? token
  })
  return hotkey
}

/**
 * Whether a key press is the combination.
 *
 * Control, Meta and Alt must be held exactly as the combination says, after `mod` is resolved for
 * the platform. Shift must match too, except for a combination whose key is a symbol (`"?"`,
 * `"/"`, `"+"`) and that does not name `shift`: such a character already says which Shift state
 * produced it, and keyboard layouts disagree about which symbols need Shift.
 *
 * A letter or a digit also matches by its physical key (`event.code`), so `"mod+k"` still fires
 * with a non-Latin layout, and `"alt+k"` still fires on a Mac, where Option turns `k` into `˚`.
 *
 * @param hotkey A combination from {@link parseHotkey}.
 * @param event The key press, or anything with the same fields.
 * @param apple Whether `mod` means Command (`true`) or Control (`false`); see
 *   {@link isApplePlatform}.
 */
export function matchesHotkey(hotkey: Hotkey, event: HotkeyEvent, apple: boolean): boolean {
  const ctrl = hotkey.ctrl || (hotkey.mod && !apple)
  const meta = hotkey.meta || (hotkey.mod && apple)
  if (event.ctrlKey !== ctrl || event.metaKey !== meta || event.altKey !== hotkey.alt) return false

  const symbol = hotkey.key.length === 1 && !/[a-z0-9 ]/.test(hotkey.key)
  if (!(symbol && !hotkey.shift) && event.shiftKey !== hotkey.shift) return false

  if (event.key.toLowerCase() === hotkey.key) return true
  return physicalCode(hotkey.key) !== undefined && event.code === physicalCode(hotkey.key)
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
