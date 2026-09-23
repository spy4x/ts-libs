/**
 * The error vocabulary the inventory batch agreed on, and the `Result` used to return one.
 *
 * `ErrType` is the discriminant: a caller switches on `error.type` and gets a narrowed interface,
 * never a bare `Error` string. `ValidationError` is *re-exported* from `@spy4x/validation`
 * rather than redeclared — this package does not own a validation model, and issue #23 owns the
 * single `{ description, details }` envelope.
 */

import type { ValidationError as ValidationErrorShape } from "@spy4x/validation"

/** Category of a failed operation. Numeric so it is cheap to switch on and serialise. */
export enum ErrType {
  Validation = 1,
  Connection = 2,
  Server = 3,
  Other = 4,
}

/** Canonical copy for each category, so the same failure reads the same in every product. */
export const ERR_MESSAGE = {
  validation: "Provided data doesn't seem valid. Check the form validation error messages.",
  connection:
    "There seems to be a problem with connection to the server. Check your internet connection.",
} as const

/** Base shape every error shares: a category and human-readable copy. */
export interface Err {
  type: ErrType
  /** What went wrong, in the user's words. */
  message: string
}

/**
 * A rejected input, carrying arktype's own errors.
 *
 * Alias of `@spy4x/validation`'s `ValidationError` — kept under this name because
 * {@link ServerError} / {@link ConnectionError} live here and a caller should be able to import
 * the whole vocabulary from one place. It is not a second envelope.
 */
export type ValidationError = ValidationErrorShape

/** The request never reached the server. */
export interface ConnectionError extends Err {
  type: ErrType.Connection
  message: string
}

/** The server answered with a failure status. */
export interface ServerError extends Err {
  type: ErrType.Server
  status: number
  message: string
}

/** An error this package has no category for. */
export interface OtherError extends Err {
  type: ErrType.Other
  message: string
}

/** Every error {@link Result} can carry. */
export type AnyError = ValidationError | ConnectionError | ServerError | OtherError

/** Result of an operation that can fail: exactly one of `result` / `error` is non-null. */
export type OperationResult<T, E = unknown> =
  | { error: null; result: T }
  | { error: E; result: null }

/** In-flight state of an operation, for a store or a form to render. */
export interface OperationState<T, E = unknown> {
  inProgress: boolean
  result: null | T
  error: null | E
}

/** Idle state of an operation. */
export function idleOperationState<T, E = unknown>(): OperationState<T, E> {
  return { inProgress: false, result: null, error: null }
}
