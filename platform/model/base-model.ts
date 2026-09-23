/**
 * Base model schemas: every persisted record carries at least `id` and `createdAt`.
 * `UndeletableBaseModelSchema` layers `updatedAt` on top, and `BaseModelSchema` layers a nullable
 * `deletedAt` on top of that — three tiers so a read-only or never-deleted projection is not
 * forced to carry a field it will never receive.
 *
 * Moved from `template/libs/platform/types/+index.ts`, unchanged.
 *
 * **`"+": "reject"` decision: none of the three declares it.** An app is expected to extend these
 * with its own fields via `.and()` (`BaseModelSchema.and({ name: "string" })`), and arktype
 * resolves `"+": "reject"` at intersection time by making every key the left side does not already
 * declare resolve to `never` on that side. Declaring it here breaks composition immediately, even
 * inside this file: building `UndeletableBaseModelSchema` from a hypothetical
 * `ImmutableBaseModelSchema` with `"+": "reject"` throws at module load —
 * `ParseError: Intersection at updatedAt of never and Date results in an unsatisfiable type` —
 * because `updatedAt` is a key `ImmutableBaseModelSchema` never declared. Confirmed by
 * constructing that composition directly and reading the thrown error. A schema that must refuse
 * unknown keys declares `"+": "reject"` on its own final, composed shape — the wire schemas in
 * `push.ts` do exactly that — not on a base an app or a sibling schema in this file is meant to
 * extend.
 */
import { type } from "arktype"

import { DateNullableSchema, dateSchema } from "./date.ts"

/** The two fields present on every record: its id and when it was created. */
export const ImmutableBaseModelSchema = type({
  id: "number",
  createdAt: dateSchema,
})

/** {@link ImmutableBaseModelSchema} plus `updatedAt`, for a record that can be edited. */
export const UndeletableBaseModelSchema = ImmutableBaseModelSchema.and({
  updatedAt: dateSchema,
})

/** {@link UndeletableBaseModelSchema} plus a nullable `deletedAt`, for a soft-deletable record. */
export const BaseModelSchema = UndeletableBaseModelSchema.and({
  deletedAt: DateNullableSchema,
})

/** Value {@link BaseModelSchema} produces. */
export type BaseModel = typeof BaseModelSchema.infer
