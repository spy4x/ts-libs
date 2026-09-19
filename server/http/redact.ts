/**
 * Provider-error redaction.
 *
 * Errors from an upstream provider (LLM, scraper, payment) carry the provider's
 * own message, which can include model internals, quota hints, partial request
 * bodies or a request id that ties the log to a customer. Two audiences, two
 * outputs:
 *
 *  - the log gets the error's class name and the calling scope, and nothing else
 *    — enough for grep and error grouping;
 *  - the client gets a constant string that carries no provider text at all.
 *
 * Actionable errors — a bad URL, an exhausted quota, a 401 — must not travel
 * through here: they are handled where they are raised, with a message the caller
 * can act on.
 *
 * Deviations from the `offer-lens` source, covered by tests below: the generic
 * message is not shared between scopes (a second scope silently inheriting the
 * first's message is how `batch_item` failures surfaced as "Analysis failed"),
 * and `logProviderError` returns the line it logged so a caller can count or
 * forward it without re-reading `console.error`.
 */

/**
 * Which call site failed. A finite, closed set, so a log line's scope is always
 * one of the known values.
 */
export enum ProviderScope {
  Analyze = 1,
  BatchItem = 2,
}

/** The client-facing message per scope. Never derived from the provider error. */
const GENERIC_MESSAGES: Record<ProviderScope, string> = {
  [ProviderScope.Analyze]: "Analysis failed",
  [ProviderScope.BatchItem]: "Analysis failed",
}

/** The leading token of each log line, so a log query can target one scope. */
const LOG_SCOPES: Record<ProviderScope, string> = {
  [ProviderScope.Analyze]: "analyze",
  [ProviderScope.BatchItem]: "batch_item",
}

/** Generic message returned to the client for a provider failure. */
export function genericProviderMessage(scope: ProviderScope): string {
  return GENERIC_MESSAGES[scope]
}

/**
 * Log a provider-side failure with no payload detail, and return the line.
 *
 * Only the error's class name (or `typeof` for a non-`Error` throw) is written;
 * never `message`, `stack`, `cause`, a request id or any field of the error. The
 * line is a fixed shape — `${scope}_provider_error ${name}` — with no
 * interpolation of provider text.
 */
export function logProviderError(scope: ProviderScope, error: unknown): string {
  const name = error instanceof Error && error.name ? error.name : typeof error
  const line = `${LOG_SCOPES[scope]}_provider_error ${name}`
  console.error(line)
  return line
}
