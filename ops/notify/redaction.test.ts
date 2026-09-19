import { expect } from "@std/expect"
import { describe, it } from "@std/testing/bdd"
import { HealthchecksClient, HealthchecksOutcome } from "./healthchecks.ts"
import { NotificationSeverity, NtfyClient } from "./ntfy.ts"

/**
 * Every notifier failure must be free of the credential the client was
 * configured with.
 *
 * Slack, Mailchimp and healthchecks were each fixed for returning
 * `cause.message` from a transport catch, and ntfy was missed — its base URL
 * can carry the token in a path segment, and `fetch` puts the whole URL in its
 * error text. This suite drives both notifiers to a URL-bearing transport
 * failure and asserts the serialised result is clean, so a fourth call site
 * written the same way cannot pass.
 */

/** Stands in for the credential, in a position no sanitised result can contain. */
const TOKEN = "REALTOKENISH"

/** What the platform throws for a URL it cannot parse — URL included. */
const urlBearingFailure = (url: string) => () =>
  Promise.reject(new TypeError(`Invalid URL: '${url}'`))

const assertClean = (label: string, result: unknown): void => {
  const serialised = JSON.stringify(result)
  expect({ label, leaksToken: serialised.includes(TOKEN) }).toEqual({ label, leaksToken: false })
  expect({ label, leaksHost: serialised.includes("example.invalid") }).toEqual({
    label,
    leaksHost: false,
  })
}

describe("no notifier failure leaks the configured credential", () => {
  it("keeps the ntfy token out of a transport failure", async () => {
    const baseUrl = `${TOKEN}`
    const url = `https://ntfy.example.invalid/${baseUrl}/test-topic`
    const client = new NtfyClient({
      baseUrl: `https://ntfy.example.invalid/${baseUrl}`,
      topic: "test-topic",
    }, {
      fetcher: urlBearingFailure(url),
      retry: { maxAttempts: 1 },
    })
    const result = await client.push({
      title: "backup failed",
      message: "detail",
      severity: NotificationSeverity.Failure,
    })
    expect(result.ok).toBe(false)
    expect(result.ok === false && result.code).toBe("network_error")
    assertClean("ntfy transport", result)
  })

  it("keeps the ntfy token out of a transport failure reached through notifyFailure", async () => {
    const url = `https://ntfy.example.invalid/${TOKEN}/test-topic`
    const client = new NtfyClient({
      baseUrl: `https://ntfy.example.invalid/${TOKEN}`,
      topic: "test-topic",
      token: "test-token-not-real",
    }, { fetcher: urlBearingFailure(url), retry: { maxAttempts: 1 } })
    const result = await client.notifyFailure("backup failed", "detail")
    expect(result.ok).toBe(false)
    assertClean("ntfy notifyFailure", result)
  })

  it("keeps the healthchecks capability key out of a transport failure", async () => {
    const url = `https://hc-ping.example.invalid/${TOKEN}`
    const client = new HealthchecksClient({ pingUrl: url }, {
      fetcher: urlBearingFailure(`${url}/fail`),
      retry: { maxAttempts: 1 },
    })
    const result = await client.ping({ outcome: HealthchecksOutcome.Fail })
    expect(result.ok).toBe(false)
    assertClean("healthchecks ping", result)
  })

  it("still names each transport failure, so the results stay diagnosable", async () => {
    const client = new NtfyClient({
      baseUrl: `https://ntfy.example.invalid/${TOKEN}`,
      topic: "test-topic",
    }, {
      fetcher: urlBearingFailure(`https://ntfy.example.invalid/${TOKEN}/test-topic`),
      retry: { maxAttempts: 1 },
    })
    const result = await client.push({
      title: "backup failed",
      message: "detail",
      severity: NotificationSeverity.Failure,
    })
    expect(result.ok === false && result.message).toBe(
      "TypeError: transport failure (url withheld)",
    )
  })
})
