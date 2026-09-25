/**
 * The error vocabulary a store or a form reports with, the helpers that build it, and the
 * `Result` used to return one.
 *
 * `ErrType` is the discriminant: a caller switches on `error.type` and gets a narrowed interface,
 * never a bare `Error` string. `ErrType` and `ValidationError` are *re-exported* from
 * `@spy4x/validation` rather than redeclared: that package tags its own error, and it cannot import
 * this one, because this package already imports it and a cycle between the two fails
 * `deno publish`.
 *
 * @module
 */

import {
  ErrType,
  VALIDATION_MESSAGE,
  type ValidationError as ValidationErrorShape,
} from "@spy4x/validation"

export { ErrType }

/** Canonical copy for each category, so the same failure reads the same in every product. */
export const ERR_MESSAGE = {
  validation: VALIDATION_MESSAGE,
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
 * A rejected input: its kind, one sentence for the user, the issues per field path, and arktype's
 * own errors.
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
