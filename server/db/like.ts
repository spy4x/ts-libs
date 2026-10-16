/**
 * Build a `LIKE` pattern that matches a user's text literally.
 *
 * @module
 */

/**
 * `value` with every `\`, `%` and `_` escaped by a backslash, wrapped in `%…%`: a `LIKE` pattern
 * that matches any text containing `value` as it is written. Unescaped, a `%` or `_` in a search
 * box would act as a wildcard, so `%` alone would match every row and a long run of `_%` would
 * make the database scan slowly.
 *
 * Postgres uses `\` as the default `LIKE` escape, so the pattern works as it is:
 *
 * ```ts
 * sql`SELECT id FROM users WHERE email ILIKE ${likeContains(search)}`
 * ```
 *
 * SQLite has no default escape character, so a query there must name it:
 * `WHERE email LIKE ? ESCAPE '\'`. Without the `ESCAPE` clause SQLite reads `\%` as a backslash
 * followed by a wildcard.
 *
 * Ported from `template/libs/server/auth/admin-users.ts` (`containsPattern`).
 */
export function likeContains(value: string): string {
  return `%${value.replace(/[\\%_]/g, (character) => `\\${character}`)}%`
}
