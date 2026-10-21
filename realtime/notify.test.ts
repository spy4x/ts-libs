/**
 * Fail-closed fan-out, and the hint-only payload.
 *
 * The first case in this suite is the one the source got wrong: `financy`'s `getUsersForModel`
 * ended in a `default:` clause returning `Array.from(userBySocket.values())`, so an unknown model
 * broadcast a change to every connected user. A notifier that cannot fail closed is a data leak
 * waiting for a renamed aggregate.
 */

import { expect } from "@std/expect"
import { describe, it } from "@std/testing/bdd"

import { type AggregateChange, AggregateNotifier, NotifyStatus } from "./notify.ts"
import { RecordingFanout } from "./testing.ts"

function change(aggregate: string, sequence = 42): AggregateChange {
  return { groupId: "group-1", aggregate, sequence }
}

describe("AggregateNotifier", () => {
  it("announces a contiguous change to the users the resolver names", async () => {
    const fanout = new RecordingFanout({ "user-1": 2, "user-2": 1 })
    const notifier = new AggregateNotifier({
      fanout,
      resolvers: new Map([["invoice", () => ["user-1", "user-2"]]]),
    })

    const outcome = await notifier.notify(change("invoice", 12))

    expect(outcome.status).toBe(NotifyStatus.Sent)
    expect(outcome.recipients).toBe(3)
    expect(fanout.calls).toEqual([
      {
        userIds: ["user-1", "user-2"],
        message: {
          kind: "change.hint",
          groupId: "group-1",
          aggregate: "invoice",
          sequence: 12,
        },
      },
    ])
  })

  it("sends a hint that carries no entity data", async () => {
    const fanout = new RecordingFanout({ "user-1": 1 })
    const notifier = new AggregateNotifier({
      fanout,
      resolvers: new Map([["invoice", () => ["user-1"]]]),
    })

    await notifier.notify(change("invoice"))

    const message = fanout.calls[0].message as unknown as Record<
      string,
      unknown
    >
    expect(Object.keys(message).sort()).toEqual([
      "aggregate",
      "groupId",
      "kind",
      "sequence",
    ])
  })

  it("sends nothing at all when the aggregate has no resolver", async () => {
    const fanout = new RecordingFanout({ "user-1": 1, "user-2": 1 })
    const notifier = new AggregateNotifier({
      fanout,
      resolvers: new Map([["invoice", () => ["user-1"]]]),
    })

    const outcome = await notifier.notify(change("payment"))

    expect(outcome).toEqual({
      status: NotifyStatus.UnknownAggregate,
      aggregate: "payment",
      groupId: "group-1",
      sequence: 42,
      recipients: 0,
    })
    expect(fanout.calls).toEqual([])
  })

  it("does not broadcast an unknown aggregate to every connected user", async () => {
    const fanout = new RecordingFanout({
      "user-1": 1,
      "user-2": 1,
      "user-3": 1,
    })
    expect(fanout.userIds()).toEqual(["user-1", "user-2", "user-3"])
    const notifier = new AggregateNotifier({ fanout })

    const outcome = await notifier.notify(change("renamed-aggregate"))

    expect(outcome.recipients).toBe(0)
    expect(fanout.calls).toEqual([])
  })

  it("reports an unknown aggregate so a host can alert instead of guessing", async () => {
    const unknown: AggregateChange[] = []
    const notifier = new AggregateNotifier({
      fanout: new RecordingFanout({ "user-1": 1 }),
      onUnknownAggregate: (change) => unknown.push(change),
    })

    await notifier.notify(change("payment"))

    expect(unknown).toEqual([change("payment")])
  })

  it("sends nothing when the resolver returns nobody", async () => {
    const fanout = new RecordingFanout({ "user-1": 1 })
    const notifier = new AggregateNotifier({
      fanout,
      resolvers: new Map([["invoice", () => []]]),
    })

    const outcome = await notifier.notify(change("invoice"))

    expect(outcome.status).toBe(NotifyStatus.NoRecipients)
    expect(fanout.calls).toEqual([])
  })

  it("ignores an empty user id rather than delivering to nobody", async () => {
    const fanout = new RecordingFanout({ "user-1": 1 })
    const notifier = new AggregateNotifier({
      fanout,
      resolvers: new Map([["invoice", () => ["user-1", ""]]]),
    })

    const outcome = await notifier.notify(change("invoice"))

    expect(outcome.status).toBe(NotifyStatus.Sent)
    expect(fanout.calls[0].userIds).toEqual(["user-1"])
  })

  it("delivers once when a resolver names the same user twice", async () => {
    const fanout = new RecordingFanout({ "user-1": 2 })
    const notifier = new AggregateNotifier({
      fanout,
      resolvers: new Map([["invoice", () => ["user-1", "user-1"]]]),
    })

    await notifier.notify(change("invoice"))

    expect(fanout.calls[0].userIds).toEqual(["user-1"])
  })

  it("does not widen the audience when the resolver throws", async () => {
    const fanout = new RecordingFanout({ "user-1": 1, "user-2": 1 })
    const failures: string[] = []
    const notifier = new AggregateNotifier({
      fanout,
      resolvers: new Map([
        ["invoice", () => {
          throw new Error("membership lookup failed")
        }],
      ]),
      onError: (_change, error) => failures.push(error.message),
    })

    const outcome = await notifier.notify(change("invoice"))

    expect(outcome.status).toBe(NotifyStatus.Failed)
    expect(outcome.error).toBe("membership lookup failed")
    expect(outcome.recipients).toBe(0)
    expect(failures).toEqual(["membership lookup failed"])
    expect(fanout.calls).toEqual([])
  })

  it("answers failed instead of rejecting when the fan-out throws", async () => {
    const failures: string[] = []
    const notifier = new AggregateNotifier({
      fanout: {
        sendToUsers() {
          throw new Error("socket table locked")
        },
      },
      resolvers: new Map([["invoice", () => ["user-1"]]]),
      onError: (_change, error) => failures.push(error.message),
    })

    const outcome = await notifier.notify(change("invoice"))

    expect(outcome.status).toBe(NotifyStatus.Failed)
    expect(outcome.error).toBe("socket table locked")
    expect(failures).toEqual(["socket table locked"])
  })

  it("still answers when the onError or onUnknownAggregate hook throws", async () => {
    const notifier = new AggregateNotifier({
      fanout: new RecordingFanout({ "user-1": 1 }),
      resolvers: new Map([["invoice", () => {
        throw new Error("lookup failed")
      }]]),
      onError: () => {
        throw new Error("alerting is down")
      },
      onUnknownAggregate: () => {
        throw new Error("alerting is down")
      },
    })

    const logged = await withSilencedErrors(async () => [
      (await notifier.notify(change("invoice"))).status,
      (await notifier.notify(change("payment"))).status,
    ])

    expect(logged.result).toEqual([NotifyStatus.Failed, NotifyStatus.UnknownAggregate])
    expect(logged.count).toBe(2)
  })

  it("waits for an asynchronous resolver before sending", async () => {
    const fanout = new RecordingFanout({ "user-1": 1 })
    const notifier = new AggregateNotifier({
      fanout,
      resolvers: new Map([
        ["invoice", async () => {
          await Promise.resolve()
          return ["user-1"]
        }],
      ]),
    })

    const outcome = await notifier.notify(change("invoice"))

    expect(outcome.status).toBe(NotifyStatus.Sent)
  })

  it("knows which aggregates it can resolve", () => {
    const notifier = new AggregateNotifier({
      fanout: new RecordingFanout(),
      resolvers: new Map([["invoice", () => []]]),
    })
    notifier.register("payment", () => [])

    expect(notifier.knows("invoice")).toBe(true)
    expect(notifier.knows("receipt")).toBe(false)
    expect(notifier.aggregates()).toEqual(["invoice", "payment"])
  })
})

/** Runs `action` with `console.error` captured, so a hook's logged throw stays out of the run. */
async function withSilencedErrors<T>(
  action: () => Promise<T>,
): Promise<{ result: T; count: number }> {
  const original = console.error
  let count = 0
  console.error = () => count++
  try {
    return { result: await action(), count }
  } finally {
    console.error = original
  }
}
