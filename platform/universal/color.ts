/**
 * Everything in `@spy4x/platform/universal/color-core`, plus {@link hexColor}, an arktype schema
 * for a `#rrggbb` colour. Importing this module puts arktype (about 150 KB minified) into a browser
 * bundle, because arktype's own module code runs when it loads; browser code that only checks or
 * contrasts colours imports `color-core` instead.
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

import { isHexColor } from "./color-core.ts"

export * from "./color-core.ts"

/** A `string` that {@link isHexColor} accepts, for an arktype schema. */
export const hexColor: Type<string> = type(`string`).narrow((value, ctx) =>
  isHexColor(value) || ctx.mustBe(`a hex colour like #1a2b3c`)
)
