// Test helper: fake tools with obviously fake values, so a leaked fixture can never be
// mistaken for a real credential or endpoint.

import type { JsonSchemaObject } from "./tools.ts"

/** An obviously-fake bearer token used across the suite. */
export const FAKE_TOKEN = "not-a-real-token"

/** A different token of the same length as {@link FAKE_TOKEN}, for the auth tests. */
export const FAKE_TOKEN_WRONG = "not-a-fake-token"

/** A body that must never appear in a log line. */
export const FAKE_SECRET_BODY = "top-secret-body-must-not-be-logged"

export function toolSchema(
  properties: Record<string, unknown>,
  required: string[] = [],
): JsonSchemaObject {
  return { type: "object", properties, required }
}
