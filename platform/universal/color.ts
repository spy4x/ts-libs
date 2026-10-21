/**
 * Hex colours and their WCAG 2.x contrast: check a `#rrggbb` value, measure how far apart two
 * colours are, and pick black or white text that stays readable on a background.
 *
 * Pure maths with no host API, so a colour field in the browser and a server validator use the same
 * rules.
 *
 * @example A tag colour from a form, and the text colour to draw on it
 * ```ts
 * import { type } from "arktype"
 *
 * const tagSchema = type({ name: "string", color: hexColor })
 * readableTextColor("#1d4ed8") // "#ffffff"
 * contrastRatio("#777777", "#ffffff") // about 4.48
 * ```
 *
 * @module
 */

import { type Type, type } from "arktype"

const HEX_COLOR = /^#[0-9a-f]{6}$/i

/** True for a six-digit hex colour, `#rrggbb`, in lower or upper case. */
export function isHexColor(value: unknown): value is string {
  return typeof value === `string` && HEX_COLOR.test(value)
}

/** The sRGB transfer curve undone for one channel byte, giving its linear light from 0 to 1. */
function linearChannel(byte: number): number {
  const c = byte / 255
  return c <= 0.04045 ? c / 12.92 : ((c + 0.055) / 1.055) ** 2.4
}

/**
 * The WCAG 2.x relative luminance of a hex colour: 0 for black, 1 for white.
 *
 * Uses the sRGB threshold 0.04045 that WCAG 2.2 corrected the older 0.03928 to; the two differ
 * by less than any 8-bit channel can show.
 *
 * @throws {RangeError} when `hex` is not `#rrggbb`.
 */
export function relativeLuminance(hex: string): number {
  if (!isHexColor(hex)) throw new RangeError(`Not a #rrggbb hex colour: ${JSON.stringify(hex)}`)
  const [r, g, b] = [1, 3, 5].map((at) => linearChannel(parseInt(hex.slice(at, at + 2), 16)))
  return 0.2126 * r + 0.7152 * g + 0.0722 * b
}

/**
 * The WCAG 2.x contrast ratio of two hex colours, from 1 (the same) to 21 (black on white). The
 * order does not matter. WCAG AA asks for 4.5 for body text and 3 for large text.
 *
 * @throws {RangeError} when either colour is not `#rrggbb`.
 */
export function contrastRatio(a: string, b: string): number {
  const [light, dark] = [relativeLuminance(a), relativeLuminance(b)].sort((x, y) => y - x)
  return (light + 0.05) / (dark + 0.05)
}

/**
 * Black or white, whichever has the higher contrast ratio on `background`. A tie goes to black.
 *
 * @throws {RangeError} when `background` is not `#rrggbb`.
 */
export function readableTextColor(background: string): `#000000` | `#ffffff` {
  return contrastRatio(background, `#ffffff`) > contrastRatio(background, `#000000`)
    ? `#ffffff`
    : `#000000`
}

/** A `string` that {@link isHexColor} accepts, for an arktype schema. */
export const hexColor: Type<string> = type(`string`).narrow((value, ctx) =>
  isHexColor(value) || ctx.mustBe(`a hex colour like #1a2b3c`)
)
