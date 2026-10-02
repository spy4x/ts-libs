/** What stands in for an address in a log line. */
export const REDACTED_EMAIL = "<REDACTED:EMAIL>"

/**
 * `text` with every copy of `email` replaced by {@link REDACTED_EMAIL}, in any letter case: a mail
 * server may echo `Jane@Example.com` for a stored `jane@example.com`.
 */
export function redactAddress(text: string, email: string): string {
  if (email === "") return text
  const pattern = new RegExp(email.replace(/[.*+?^${}()|[\]\\]/g, "\\$&"), "gi")
  return text.replace(pattern, REDACTED_EMAIL)
}
