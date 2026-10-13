/**
 * Parse one quick-add line such as `Call Anna @phone #work tomorrow 3pm !high` into a title, tags,
 * contexts, a due date and a priority, plus the position of every recognised token.
 *
 * The same names as `@spy4x/platform/universal/quick-add`, where the code sits until 2.0.
 *
 * @example
 * ```ts
 * const parsed = parseQuickAdd("Call Anna tomorrow 3pm !high", {
 *   now: new Date(),
 *   timeZone: "Europe/Berlin",
 * })
 * ```
 * @module
 */
export * from "@spy4x/platform/universal/quick-add"
