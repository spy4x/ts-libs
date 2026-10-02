/** What stands in for an address in a log line. */
export const REDACTED_EMAIL = "<REDACTED:EMAIL>"

/**
 * `text` with every copy of `email` replaced by {@link REDACTED_EMAIL}, in any letter case (a mail
 * server may echo `Jane@Example.com` for a stored `jane@example.com`) and URL-encoded as well (an
 * HTTP API's error may quote a URL that carries `jane%40example.com`).
 */
export function redactAddress(text: string, email: string): string {
  if (email === "") return text
  const forms = new Set([email, encodeURIComponent(email)])
  const pattern = new RegExp([...forms].map(escapeRegExp).join("|"), "gi")
  return text.replace(pattern, REDACTED_EMAIL)
}

function escapeRegExp(text: string): string {
  return text.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")
}
