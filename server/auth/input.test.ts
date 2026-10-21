import { expect } from "@std/expect"
import { describe, it } from "@std/testing/bdd"
import { checkAttemptChallenge, checkIssueChallenge, checkNewKey, checkSecret } from "./input.ts"

/** The message of what `run` throws; fails the test when it does not throw. */
function messageOf(run: () => unknown): string {
  try {
    run()
  } catch (error) {
    expect(error).toBeInstanceOf(TypeError)
    return (error as TypeError).message
  }
  throw new Error("expected a TypeError")
}

describe("store input errors", () => {
  const secret = "hunter2-super-secret\u0000"

  it("name the field and the rule but never echo a rejected secret", () => {
    const message = messageOf(() => checkSecret(secret))
    expect(message).toContain("must be free of NUL characters")
    expect(message).not.toContain("hunter2")
    expect(message).not.toContain("was")
  })

  it("never echo a rejected key secret or challenge hash", () => {
    const now = new Date()
    const messages = [
      messageOf(() =>
        checkNewKey({ method: "password", subject: "s", email: null, secret, provenAt: null })
      ),
      messageOf(() =>
        checkIssueChallenge({
          purpose: "p",
          subject: "s",
          secretHash: secret,
          expiresAt: now,
          now,
        })
      ),
      messageOf(() =>
        checkAttemptChallenge({
          purpose: "p",
          subject: "s",
          secretHash: secret,
          maxAttempts: 3,
          now,
        })
      ),
    ]
    expect(messages[0]).toContain("secret must be")
    expect(messages[1]).toContain("secretHash must be")
    expect(messages[2]).toContain("secretHash must be")
    for (const message of messages) expect(message).not.toContain("hunter2")
  })
})
