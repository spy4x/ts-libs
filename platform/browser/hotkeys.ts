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

/** One entry of a {@link createHotkeyMatcher} table: the key presses that trigger `id`. */
export interface HotkeyBinding<Id> {
  /** What the caller gets back when the presses complete. */
  id: Id
  /**
   * The key presses in order, each written as {@link parseHotkey} takes it: `["n"]` is one press,
   * `["g", "t"]` is `g` then `t`. A binding with several ways to fire is several entries.
   */
  keys: readonly string[]
}

/** The part of a `KeyboardEvent` that {@link createHotkeyMatcher} reads. */
export interface HotkeySequenceEvent extends HotkeyEvent {
  /**
   * The element the press landed on. Anything fits, so a browser `KeyboardEvent` (whose target is
   * an `EventTarget`) is accepted as it is. The matcher treats the target as an element for
   * {@link isTypingTarget} only when it is an object, and as no element otherwise.
   */
  target?: object | null
  /** When the press happened, in milliseconds. `KeyboardEvent.timeStamp` serves. */
  timeStamp: number
  /** `true` while an input method is composing text. */
  isComposing?: boolean
}

/** Options for {@link createHotkeyMatcher}. */
export interface HotkeyMatcherOptions<Event extends HotkeySequenceEvent> {
  /** How long a pressed key waits for the next one, in milliseconds. Defaults to `1000`. */
  timeoutMs?: number
  /** Whether `mod` means Command. Pass {@link isApplePlatform}'s answer. Defaults to `false`. */
  apple?: boolean
  /** Return `true` to make the matcher ignore this press, for example inside a dialog. */
  ignore?: (event: Event) => boolean
}

/** Keys that are only a modifier or lock going down; they are never part of a sequence. */
const MODIFIER_KEYS = new Set([
  "shift",
  "control",
  "alt",
  "meta",
  "altgraph",
  "os",
  "capslock",
  "numlock",
  "scrolllock",
  "fn",
  "fnlock",
  "hyper",
  "super",
])

interface Progress<Id> {
  id: Id
  combos: readonly Hotkey[]
  /** How many presses of the sequence have matched. */
  matched: number
}

/**
 * Build a matcher for a table of bindings, each one or more key presses (`["g", "t"]`). Call the
 * result with every key press, in order: it returns the id of the binding the press completes, or
 * `undefined`. It holds no DOM reference and starts no timer, so it runs on a server and in a test.
 *
 * - **Sequences.** A pressed key that starts a longer binding is kept for `timeoutMs`, counted from
 *   the events' `timeStamp`. The next press must continue it; any other key, or a late one, drops
 *   it. A dropped key is not lost: the press that dropped it is matched again from the start, so
 *   `g g t` still reaches `g t`. While a longer sequence is waiting, it has the first claim on the
 *   next key: with `g t x` and `t` in one table, `t` after `g` continues `g t x` and does not fire
 *   `t`; any later key that breaks the sequence is matched again from the start.
 * - **A key that is also the start of a sequence.** The shorter binding wins. If `g` and `g t` are
 *   both in the table, `g` fires at once and `g t` can never fire, because the matcher cannot know
 *   whether a second key will follow without delaying `g`. Give the sequence its own first key.
 *   When two bindings have the same keys, the earlier one in the table wins.
 * - **Ignored presses.** A press while typing ({@link isTypingTarget}), while composing, or when
 *   `ignore` returns `true` never matches, and it drops a waiting key. A lone modifier press
 *   (`Shift`, `Control`, `Alt`, `Meta`, `CapsLock` and the like) is skipped without dropping it,
 *   so `g` then `shift+t` works.
 * - **Modifiers** follow {@link matchesHotkey}: a key with Control, Alt or Meta held matches only a
 *   combination that names them.
 *
 * @param table The bindings, in priority order.
 * @param options `timeoutMs`, `apple` and `ignore`.
 * @returns A function to call with each key press.
 * @throws {Error} When a key in the table cannot be read, or a binding has no keys.
 */
export function createHotkeyMatcher<Id, Event extends HotkeySequenceEvent = HotkeySequenceEvent>(
  table: readonly HotkeyBinding<Id>[],
  { timeoutMs = 1000, apple = false, ignore }: HotkeyMatcherOptions<Event> = {},
): (event: Event) => Id | undefined {
  const fresh: Progress<Id>[] = table.map(({ id, keys }) => {
    if (keys.length === 0) throw new Error(`A hotkey binding needs at least one key`)
    return { id, combos: keys.map((combo) => parseHotkey(combo)), matched: 0 }
  })
  let waiting: { progress: Progress<Id>[]; at: number } | null = null

  const step = (candidates: readonly Progress<Id>[], event: Event): Progress<Id>[] =>
    candidates
      .filter((p) => matchesHotkey(p.combos[p.matched], event, apple))
      .map((p) => ({ ...p, matched: p.matched + 1 }))

  return (event) => {
    if (
      event.isComposing === true ||
      isTypingTarget(event.target as TypingTarget | null | undefined) || ignore?.(event) === true
    ) {
      waiting = null
      return undefined
    }
    if (typeof event.key === "string" && MODIFIER_KEYS.has(event.key.toLowerCase())) {
      return undefined
    }
    const live = waiting && event.timeStamp - waiting.at <= timeoutMs ? waiting.progress : null
    waiting = null
    let advanced = live ? step(live, event) : []
    if (advanced.length === 0) advanced = step(fresh, event)
    const done = advanced.find((p) => p.matched === p.combos.length)
    if (done) return done.id
    if (advanced.length > 0) waiting = { progress: advanced, at: event.timeStamp }
    return undefined
  }
}
