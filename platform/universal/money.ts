/**
 * Everything in `@spy4x/platform/universal/money-core`, plus {@link currencyCode}, an arktype
 * schema for an ISO 4217 code. Importing this module puts arktype (about 150 KB minified) into a
 * browser bundle, because arktype's own module code runs when it loads; browser code that only
 * formats, parses or converts money imports `money-core` instead.
 *
 * @module
 */

import { type Type, type } from "arktype"

import { isCurrencyCode } from "./money-core.ts"

export * from "./money-core.ts"

/** A `string` that {@link isCurrencyCode} accepts, for an arktype schema. */
export const currencyCode: Type<string> = type(`string`).narrow((value, ctx) =>
  isCurrencyCode(value) || ctx.mustBe(`an ISO 4217 currency code like EUR`)
)
