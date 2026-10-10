/**
 * A display label for the device behind a `User-Agent` header (#406).
 *
 * `deviceName` turns the header into a name a person recognises in a list of signed-in devices,
 * such as "Safari on iPhone". It is a label, not browser detection: it knows the common browsers
 * and systems, says nothing about versions, and must never decide what a client is allowed to do.
 * The header is whatever the client chose to send.
 *
 * Pure: no I/O, no permissions. Runs in a browser bundle too.
 *
 * @module
 */

/** The name of a device whose user agent says nothing this module recognises. */
export const UNKNOWN_DEVICE = "Unknown device"

/**
 * How much of the header is read. Real user agents are well under 300 characters; the rest of a
 * longer one is ignored, so a client cannot make the patterns below scan a header-limit-sized
 * string.
 */
const MAX_USER_AGENT_LENGTH = 512

/** Browsers, most specific first: Edge and Opera also say "Chrome", and Chrome also says "Safari". */
const BROWSERS: readonly [RegExp, string][] = [
  [/\bEdg(e|A|iOS)?\//, "Edge"],
  [/\b(OPR|Opera)\//, "Opera"],
  [/\bSamsungBrowser\//, "Samsung Internet"],
  [/\b(Firefox|FxiOS)\//, "Firefox"],
  [/\b(Chrome|CriOS|Chromium)\//, "Chrome"],
  [/\bVersion\/[\d.]+.*\bSafari\//, "Safari"],
]

/** Systems, most specific first: Android says "Linux", and an iPhone says "like Mac OS X". */
const SYSTEMS: readonly [RegExp, string][] = [
  [/\biPhone\b/, "iPhone"],
  [/\biPad\b/, "iPad"],
  [/\bAndroid\b/, "Android"],
  [/\bCrOS\b/, "ChromeOS"],
  [/\bWindows\b/, "Windows"],
  [/\bMac OS X\b|\bMacintosh\b/, "macOS"],
  [/\bLinux\b/, "Linux"],
]

/**
 * A short name a person recognises their device by, such as "Firefox on Linux" or "Safari on
 * iPhone". Only the browser or only the system is named when the other is unknown, and
 * {@link UNKNOWN_DEVICE} when neither is, or when the header is missing.
 *
 * The answer is always one of a fixed set of strings, under 30 characters long, built from this
 * module's own words and never from the header's text, so it is safe to store and to show.
 *
 * An iPad that asks for the desktop site sends a Mac's user agent and is named "Safari on macOS".
 */
export function deviceName(userAgent: string | null | undefined): string {
  const agent = (userAgent ?? "").slice(0, MAX_USER_AGENT_LENGTH)
  const browser = BROWSERS.find(([pattern]) => pattern.test(agent))?.[1]
  const system = SYSTEMS.find(([pattern]) => pattern.test(agent))?.[1]
  if (browser && system) return `${browser} on ${system}`
  return browser ?? system ?? UNKNOWN_DEVICE
}
