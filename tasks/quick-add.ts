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
 *
 * `parseQuickAdd` takes the line a person types and the current moment and time zone. It returns the
 * title without its tokens, the `#tags`, the `@contexts`, a due date, a priority, and the position of
 * every recognised token, so a field can highlight them as the person types.
 *
 * @module
 */
export * from "@spy4x/platform/universal/quick-add"
