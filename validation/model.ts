/**
 * Form-validation state: which field carries which issue.
 *
 * Ported from the component library's `crud/validation.ts`, itself ported from
 * `gb/libs/client/helpers.ts`, with arktype as the only validator. Framework-agnostic on purpose:
 * the shape is `{ [field]: { [errorType]: { message, payload } } }` and nothing here knows what
 * renders it.
 *
 * The issue map is keyed by field with a per-field record of issue types, so an application's own
 * checks (`NOT_UNIQUE`, `LINKED_ENTITY_IS_DELETED`) sit beside the schema's and neither overwrites
 * the other.
 */

import { Type, type as arkType } from "arktype"

/**
 * Issue kinds the schema itself reports.
 *
 * An application extends this with its own string constants — the type of an issue is only ever a
 * map key, so nothing has to be registered anywhere.
 */
export enum ValidationType {
  /** The value did not satisfy the model's arktype schema. */
  SCHEMA = "SCHEMA",
}

/** One issue on one field. */
export interface FieldIssue {
  /** Text shown next to the field. */
  message: string
  /** Optional pointer a caller can act on — typically the id of the row the value collides with. */
  payload?: number
}

/** Issues of one field, keyed by issue type. A cleared issue is either absent or `undefined`. */
export type FieldValidation = Record<string, FieldIssue | undefined>

/**
 * Issues of a whole model, keyed by field name.
 *
 * The mapped member types and autocompletes the fields of `M`, so `vl.value.name?.SCHEMA` reads
 * like the model. The index signature is what lets `validateSchema` write a dotted path reported by
 * arktype (`"address.city"`) back under its top-level field without an assertion.
 */
export type ValidationModel<M extends object> =
  & { [K in keyof M]?: FieldValidation }
  & Record<string, FieldValidation | undefined>

/**
 * Whether no field carries an issue.
 *
 * A field whose every issue type has been cleared counts as valid, which is what makes
 * `setFieldIssue(…, undefined)` an eraser rather than a new issue.
 */
export function isValid<M extends object>(vl: ValidationModel<M>): boolean {
  return Object.values(vl).every((field) => !hasIssue(field))
}

/** Set or clear one issue on one field, leaving that field's other issue types alone. */
export function setFieldIssue<M extends object>(
  vl: ValidationModel<M>,
  field: keyof M & string,
  type: string,
  message: string | undefined,
  payload?: number,
): ValidationModel<M> {
  const issue: FieldIssue | undefined = message === undefined ? undefined : { message, payload }
  const next: ValidationModel<M> = { ...vl }
  const field_ = pruned({ ...vl[field], [type]: issue })

  // A field with nothing left to report is dropped, so `vl.name` is `undefined` rather than `{}`
  // — the difference a caller sees when it asks whether a field has any issue at all.
  if (Object.keys(field_).length === 0) {
    delete next[field]
    return next
  }

  next[field] = field_
  return next
}

/**
 * The issues arktype reported for a value, keyed by the model field they belong to.
 *
 * A nested failure (`address.city`) is reported against its top-level field (`address`), because
 * that is the one a field row can render. Several issues on one field are joined into one message.
 */
export function schemaIssues<S extends Type>(
  schema: S,
  value: unknown,
): Record<string, FieldValidation> {
  const outcome = schema(value)
  if (!(outcome instanceof arkType.errors)) return {}

  const issues: Record<string, FieldValidation> = {}
  for (const issue of outcome.issues) {
    const field = issue.path.length > 0 ? String(issue.path[0]) : ""
    if (field === "") continue
    const previous = issues[field]?.SCHEMA?.message
    issues[field] = {
      [ValidationType.SCHEMA]: {
        message: previous === undefined ? issue.message : `${previous} ${issue.message}`,
      },
    }
  }
  return issues
}

/**
 * Validate a model against its schema and fold the result into a validation model.
 *
 * Only {@link ValidationType.SCHEMA} is written: a field that now passes has that entry cleared,
 * and an application's own issue types survive untouched, so a domain check does not have to be
 * re-run to avoid being erased by the next keystroke.
 */
export function validateSchema<S extends Type, M extends object>(
  schema: S,
  value: M,
  vl: ValidationModel<M>,
): ValidationModel<M> {
  const issues = schemaIssues(schema, value)
  let next: ValidationModel<M> = { ...vl }

  for (const field of new Set([...Object.keys(vl), ...Object.keys(issues)])) {
    const current = { ...next[field] }
    const message = issues[field]?.[ValidationType.SCHEMA]?.message
    current[ValidationType.SCHEMA] = message === undefined ? undefined : { message }
    next = { ...next, [field]: pruned(current) }
  }
  return next
}

/**
 * Whether two validation models carry the same issues.
 *
 * Kept separate from a reference check because `validateSchema` builds a fresh object on every
 * pass: without this, a validation effect would write its own signal in a loop. Comparison is by
 * sorted key, so it does not depend on the order fields were added in.
 */
export function sameValidation<M extends object>(
  a: ValidationModel<M>,
  b: ValidationModel<M>,
): boolean {
  const left = issueKeys(a)
  const right = issueKeys(b)
  return left.length === right.length && left.every((entry, index) => entry === right[index])
}

/** Flatten a validation model into sorted, comparable lines. */
function issueKeys<M extends object>(vl: ValidationModel<M>): string[] {
  const lines: string[] = []
  for (const field of Object.keys(vl).sort()) {
    for (const type of Object.keys(vl[field] ?? {}).sort()) {
      const issue = vl[field]?.[type]
      if (issue === undefined) continue
      lines.push(`${field}\u0000${type}\u0000${issue.message}\u0000${issue.payload ?? ""}`)
    }
  }
  return lines
}

/** Whether a field carries at least one live issue. */
function hasIssue(field: FieldValidation | undefined): boolean {
  return field !== undefined && Object.values(field).some((issue) => issue !== undefined)
}

/** Drop the cleared entries, so a validated field holds no undefined noise. */
function pruned(field: FieldValidation): FieldValidation {
  return Object.fromEntries(Object.entries(field).filter(([, issue]) => issue !== undefined))
}
