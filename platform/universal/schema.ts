/**
 * The one arktype type-level helper this package needs, plus the validation types it re-exports.
 *
 * `@ts-libs/validation` owns the runtime parser and the `{ description, details }` error envelope;
 * this package must not declare a second one. What it does need is the ability to name "the value
 * a schema produces" without depending on the shape of `Type`'s type parameters — which is what
 * {@link InferSchema} provides.
 */

import type { Type } from "arktype"

/**
 * Value a schema accepts and produces.
 *
 * Equal to `@ts-libs/validation`'s `SchemaOutput`, spelled as an inferred property so it works
 * with the `Type` instance a caller actually passes.
 */
export type InferSchema<S extends Type> = S["infer"]
