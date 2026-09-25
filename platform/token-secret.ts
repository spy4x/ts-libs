// The secret rule every token primitive shares. Internal: `platform/deno.json` does not export this
// file, so `assertUsableSecret` is not public API. `tokens.ts` and `signed-payload.ts` both call it,
// which is why it lives outside either of them.

import { MIN_SECRET_LENGTH, TokenError, TokenErrorCode } from "./tokens.ts"

/**
 * Rejects any secret that would make the digest meaningless or brute-forceable.
 *
 * The source (`mig/lib/tokens.ts:38-44`) did not check at all, so `newOpaqueToken()` with
 * no argument hashed against the literal `"undefined"` and produced a token any
 * caller could forge. Fail closed instead: an unusable secret is a programming
 * error, not a warning.
 *
 * Two ways a secret is unusable, both checked on the trimmed value so a secret of
 * nothing but whitespace cannot pass on length alone: 1) absent, or not a
 * printable string — the value may arrive from untyped configuration, and a
 * secret made of NUL bytes or other control characters is a placeholder, not
 * entropy, so `"\u0000".repeat(64)` is rejected even though it is long enough;
 * 2) shorter than {@link MIN_SECRET_LENGTH}.
 *
 * @throws {TokenError} `InvalidSecret` when the secret is missing, blank, not a
 *         string, not printable, or below {@link MIN_SECRET_LENGTH} characters.
 *         Messages are constants — the rejected value is never echoed.
 */
export function assertUsableSecret(secret: string): void {
  if (typeof secret !== "string") {
    throw new TokenError(TokenErrorCode.InvalidSecret, "secret must be a non-empty string")
  }
  const trimmed = secret.trim()
  if (trimmed === "" || !isPrintable(trimmed)) {
    throw new TokenError(TokenErrorCode.InvalidSecret, "secret must be a non-empty string")
  }
  if (trimmed.length < MIN_SECRET_LENGTH) {
    throw new TokenError(TokenErrorCode.InvalidSecret, "secret must be at least 32 characters")
  }
}

/** True when every character is printable ASCII (`0x20`-`0x7E`). */
function isPrintable(value: string): boolean {
  for (const char of value) {
    const code = char.codePointAt(0) as number
    if (code < 0x20 || code > 0x7e) return false
  }
  return true
}
