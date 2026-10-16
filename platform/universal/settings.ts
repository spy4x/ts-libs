/**
 * Typed, versioned settings: one arktype schema per app, a version number for conflict detection,
 * and a size cap. Storage stays with the app; this module decides what may be saved.
 *
 * A record that was never saved is version `0` with the app's defaults. Every accepted save
 * writes version `current + 1`. A save names the version it was based on, and a save based on an
 * older version is refused with the current record, so two devices never overwrite each other
 * silently: the second one sees what the first one saved and decides again.
 *
 * @example
 * ```ts
 * import { type } from "arktype"
 *
 * const preferences = defineSettings(
 *   type({ theme: "'light' | 'dark' | 'system'", timeZone: "string | null" }),
 *   { defaults: { theme: "system", timeZone: null } },
 * )
 *
 * const result = await saveSettings(preferences, store, userId, await request.json())
 * if (!result.ok && result.reason === "conflict") return Response.json(result.current, { status: 409 })
 * ```
 */

import { type Type, type } from "arktype"
import { validate, type ValidationError } from "@spy4x/validation"
import { isRecord } from "./is-record.ts"

/** The default cap on a saved value: 4 KiB of UTF-8 JSON, plenty for a handful of preferences. */
export const DEFAULT_SETTINGS_MAX_BYTES = 4096

/** A settings value and the version it was saved as. Version `0` means "never saved". */
export interface VersionedSettings<T> {
  /** `0` before the first save, then one more on every accepted save. */
  version: number
  /** The value, valid against the app's schema. */
  value: T
}

/** A record as the store hands it back: the value is unchecked JSON until it is resolved. */
export interface StoredSettings {
  version: number
  value: unknown
}

/** Why a value or a save was refused. */
export type SettingsRefusal<T> =
  /** The save was based on `version`, but the record has moved on to `current`. */
  | { ok: false; reason: "conflict"; current: VersionedSettings<T> }
  /** The request or the value does not match the schema. */
  | { ok: false; reason: "invalid"; error: ValidationError }
  /** The value's JSON is longer than the cap. */
  | { ok: false; reason: "too-large"; maxBytes: number; bytes: number }

/** Outcome of {@link SettingsDefinition.parse}. */
export type SettingsParseResult<T> =
  | { ok: true; value: T }
  | Exclude<SettingsRefusal<T>, { reason: "conflict" }>

/** Outcome of {@link SettingsDefinition.save} and {@link saveSettings}. */
export type SettingsSaveResult<T> =
  | { ok: true; settings: VersionedSettings<T> }
  | SettingsRefusal<T>

/** Options for {@link defineSettings}. */
export interface SettingsOptions<T> {
  /** The value a person has before the first save. Must pass the schema. */
  defaults: T
  /** The largest saved value, in bytes of UTF-8 JSON. Default {@link DEFAULT_SETTINGS_MAX_BYTES}. */
  maxBytes?: number
}

/** One app's settings: its schema, defaults and cap, with the checks built on them. */
export interface SettingsDefinition<T> {
  /** The record a person has before the first save: version `0` and the defaults. */
  readonly initial: VersionedSettings<T>
  /** The cap on a saved value, in bytes of UTF-8 JSON. */
  readonly maxBytes: number
  /**
   * Check an untrusted value against the schema and the cap. Keys the schema does not declare
   * are dropped, at every depth, so nothing unexpected reaches storage.
   */
  parse(value: unknown): SettingsParseResult<T>
  /**
   * Read a stored record into a valid one. Keys missing from the stored value take their
   * defaults, so a value saved before a new key existed still reads. A value that no longer
   * passes the schema reads as the defaults, keeping its version so the next save still detects
   * a conflict. `null` or `undefined` reads as {@link initial}.
   */
  resolve(stored: StoredSettings | null | undefined): VersionedSettings<T>
  /**
   * Apply an untrusted save request, `{ version, value }`, to the current record. `version` is
   * the version the request was based on. Returns the next record (version + 1) or the refusal.
   */
  save(current: VersionedSettings<T>, request: unknown): SettingsSaveResult<T>
}

const saveRequest = type({ version: "number.integer >= 0", value: "unknown" })

/**
 * Define one app's settings from an arktype object schema and its defaults.
 *
 * Throws when the defaults fail the schema or the cap, or when `maxBytes` is not a positive
 * integer: both are mistakes in the app's code, not in a person's input.
 */
export function defineSettings<T extends object>(
  schema: Type<T>,
  options: SettingsOptions<T>,
): SettingsDefinition<T> {
  const maxBytes = options.maxBytes ?? DEFAULT_SETTINGS_MAX_BYTES
  if (!Number.isInteger(maxBytes) || maxBytes <= 0) {
    throw new Error(`defineSettings: maxBytes must be a positive integer, got ${maxBytes}`)
  }
  const strict = schema.onDeepUndeclaredKey("delete") as unknown as Type<T>

  const parse = (value: unknown): SettingsParseResult<T> => {
    const { error, data } = validate(strict, value)
    if (error) return { ok: false, reason: "invalid", error }
    const bytes = jsonBytes(data)
    if (bytes > maxBytes) return { ok: false, reason: "too-large", maxBytes, bytes }
    return { ok: true, value: data as T }
  }

  const defaults = parse(options.defaults)
  if (!defaults.ok) {
    const why = defaults.reason === "invalid" ? defaults.error.description : "too large"
    throw new Error(`defineSettings: the defaults do not pass: ${why}`)
  }
  const initial: VersionedSettings<T> = { version: 0, value: defaults.value }

  return {
    initial,
    maxBytes,
    parse,
    resolve(stored) {
      if (stored === null || stored === undefined) return initial
      const merged = isRecord(stored.value) ? { ...initial.value, ...stored.value } : stored.value
      const result = parse(merged)
      return { version: stored.version, value: result.ok ? result.value : initial.value }
    },
    save(current, request) {
      const shape = validate(saveRequest, request)
      if (shape.error) return { ok: false, reason: "invalid", error: shape.error }
      if (shape.data.version !== current.version) {
        return { ok: false, reason: "conflict", current }
      }
      const result = parse(shape.data.value)
      if (!result.ok) return result
      return { ok: true, settings: { version: current.version + 1, value: result.value } }
    },
  }
}

/**
 * Where an app keeps one owner's settings record: a row, a key, a file. This module never sees
 * how.
 */
export interface SettingsStore {
  /** The owner's record, or `null` when nothing was saved yet. */
  read(ownerId: string): Promise<StoredSettings | null>
  /**
   * Store `next` only when the owner's stored version is still `expectedVersion` (`0`: no record
   * yet), in one atomic step such as `UPDATE … WHERE version = $expected` or an insert that fails
   * on an existing row. Returns `false` when another write got there first.
   */
  write(
    ownerId: string,
    expectedVersion: number,
    next: VersionedSettings<unknown>,
  ): Promise<boolean>
}

/**
 * Read, check and write one save request against a store.
 *
 * When another save lands between the read and the write, the store's compare-and-set refuses
 * this one, and the result is a conflict carrying the record that won.
 */
export async function saveSettings<T>(
  definition: SettingsDefinition<T>,
  store: SettingsStore,
  ownerId: string,
  request: unknown,
): Promise<SettingsSaveResult<T>> {
  const current = definition.resolve(await store.read(ownerId))
  const result = definition.save(current, request)
  if (!result.ok) return result
  if (await store.write(ownerId, current.version, result.settings)) return result
  return { ok: false, reason: "conflict", current: definition.resolve(await store.read(ownerId)) }
}

function jsonBytes(value: unknown): number {
  return new TextEncoder().encode(JSON.stringify(value)).byteLength
}
