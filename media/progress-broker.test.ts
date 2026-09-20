import { expect } from "@std/expect"
import { describe, it } from "@std/testing/bdd"
import { SseProgressBroker } from "./progress-broker.ts"
import { countedAbortSignal, FakeTimers } from "./test-doubles.ts"

interface Payload {
  percent: number
}

const decoder = new TextDecoder()

function open(
  broker: SseProgressBroker<Payload>,
  jobId: string | number,
  options: Parameters<SseProgressBroker<Payload>["subscribe"]>[1] = {},
): ReadableStreamDefaultReader<Uint8Array> {
  return broker.subscribe(jobId, options).getReader()
}

async function read(reader: ReadableStreamDefaultReader<Uint8Array>): Promise<string> {
  const { value } = await reader.read()
  return decoder.decode(value)
}

async function drain(reader: ReadableStreamDefaultReader<Uint8Array>): Promise<string> {
  let text = ""
  while (true) {
    const { done, value } = await reader.read()
    if (done) {
      return text
    }
    text += decoder.decode(value)
  }
}

describe("SseProgressBroker", () => {
  it("delivers a published payload to a subscribed stream", async () => {
    const broker = new SseProgressBroker<Payload>()
    const reader = open(broker, 7)
    broker.publish(7, { percent: 50 })
    expect(await read(reader)).toBe('event: progress\ndata: {"percent":50}\n\n')
  })

  it("names the event when one is given", async () => {
    const broker = new SseProgressBroker<Payload>()
    const reader = open(broker, 7)
    broker.publish(7, { percent: 50 }, { event: "clip-progress" })
    expect(await read(reader)).toBe('event: clip-progress\ndata: {"percent":50}\n\n')
  })

  it("does nothing when publishing to a job nobody subscribed to", () => {
    const broker = new SseProgressBroker<Payload>()
    broker.publish(7, { percent: 50 })
    expect(broker.jobCount).toBe(0)
  })

  it("delivers one payload to both subscribers of the same job", async () => {
    const broker = new SseProgressBroker<Payload>()
    const first = open(broker, 7)
    const second = open(broker, 7)
    broker.publish(7, { percent: 25 })
    expect(await read(first)).toBe('event: progress\ndata: {"percent":25}\n\n')
    expect(await read(second)).toBe('event: progress\ndata: {"percent":25}\n\n')
    expect(broker.subscriberCount(7)).toBe(2)
  })

  it("keeps jobs apart", async () => {
    const broker = new SseProgressBroker<Payload>()
    const first = open(broker, 7)
    const second = open(broker, "seven")
    broker.publish(7, { percent: 10 })
    broker.publish("seven", { percent: 90 })
    expect(await read(first)).toBe('event: progress\ndata: {"percent":10}\n\n')
    expect(await read(second)).toBe('event: progress\ndata: {"percent":90}\n\n')
  })

  it("replays the last payload to a subscriber that arrives late", async () => {
    const broker = new SseProgressBroker<Payload>()
    open(broker, 7)
    broker.publish(7, { percent: 75 })
    const late = open(broker, 7)
    expect(await read(late)).toBe('event: progress\ndata: {"percent":75}\n\n')
  })

  it("skips the replay when the subscriber asks for none", async () => {
    const broker = new SseProgressBroker<Payload>()
    open(broker, 7)
    broker.publish(7, { percent: 75 })
    const late = open(broker, 7, { replayLatest: false })
    broker.publish(7, { percent: 80 })
    expect(await read(late)).toBe('event: progress\ndata: {"percent":80}\n\n')
  })

  it("removes an aborted subscriber and forgets the job", async () => {
    const broker = new SseProgressBroker<Payload>()
    const controller = new AbortController()
    const reader = open(broker, 7, { signal: controller.signal })
    expect(broker.subscriberCount(7)).toBe(1)

    controller.abort()

    expect(broker.subscriberCount(7)).toBe(0)
    expect(broker.jobCount).toBe(0)
    const { done } = await reader.read()
    expect(done).toBe(true)
  })

  it("removes a subscriber whose stream was cancelled", async () => {
    const broker = new SseProgressBroker<Payload>()
    const stream = broker.subscribe(7)
    const reader = stream.getReader()
    expect(broker.subscriberCount(7)).toBe(1)

    await reader.cancel()

    expect(broker.subscriberCount(7)).toBe(0)
    expect(broker.jobCount).toBe(0)
  })

  it("removes only the aborted subscriber of a two-subscriber job", async () => {
    const broker = new SseProgressBroker<Payload>()
    const controller = new AbortController()
    open(broker, 7, { signal: controller.signal })
    const kept = open(broker, 7)

    controller.abort()

    expect(broker.subscriberCount(7)).toBe(1)
    broker.publish(7, { percent: 60 })
    expect(await read(kept)).toBe('event: progress\ndata: {"percent":60}\n\n')
  })

  it("clears the pending deadline when a subscriber aborts", () => {
    const timers = new FakeTimers()
    const broker = new SseProgressBroker<Payload>({ timers })
    const controller = new AbortController()
    open(broker, 7, { signal: controller.signal, timeoutMs: 60_000 })
    expect(timers.pending).toBe(1)

    controller.abort()

    expect(timers.pending).toBe(0)
  })

  it("detaches the abort listener when the job completes", () => {
    const broker = new SseProgressBroker<Payload>()
    const controller = new AbortController()
    const counted = countedAbortSignal(controller.signal)
    open(broker, 7, { signal: counted.signal })
    expect(counted.listenerCount()).toBe(1)

    broker.complete(7)

    expect(broker.subscriberCount(7)).toBe(0)
    expect(counted.listenerCount()).toBe(0)
  })

  it("detaches the abort listener when the stream is cancelled", async () => {
    const broker = new SseProgressBroker<Payload>()
    const controller = new AbortController()
    const counted = countedAbortSignal(controller.signal)
    const reader = open(broker, 7, { signal: counted.signal })
    expect(counted.listenerCount()).toBe(1)

    await reader.cancel()

    expect(broker.subscriberCount(7)).toBe(0)
    expect(counted.listenerCount()).toBe(0)
  })

  it("detaches the abort listener when the deadline fires", () => {
    const timers = new FakeTimers()
    const broker = new SseProgressBroker<Payload>({ timers })
    const controller = new AbortController()
    const counted = countedAbortSignal(controller.signal)
    open(broker, 7, { signal: counted.signal, timeoutMs: 60_000 })
    expect(counted.listenerCount()).toBe(1)

    timers.runAll()

    expect(timers.pending).toBe(0)
    expect(counted.listenerCount()).toBe(0)
  })

  it("removes the subscriber when the counted signal aborts", async () => {
    const broker = new SseProgressBroker<Payload>()
    const controller = new AbortController()
    const counted = countedAbortSignal(controller.signal)
    const reader = open(broker, 7, { signal: counted.signal })
    expect(counted.listenerCount()).toBe(1)

    controller.abort()

    expect(broker.subscriberCount(7)).toBe(0)
    const { done } = await reader.read()
    expect(done).toBe(true)
  })

  it("closes a subscription that never completes instead of hanging", async () => {
    const timers = new FakeTimers()
    const broker = new SseProgressBroker<Payload>({ timers })
    const reader = open(broker, 7, { timeoutMs: 60_000 })

    timers.runAll()

    const frame = await read(reader)
    expect(frame).toContain("event: error")
    expect(frame).toContain("produced no completion within 60000 ms")
    const { done } = await reader.read()
    expect(done).toBe(true)
    expect(broker.subscriberCount(7)).toBe(0)
    expect(broker.jobCount).toBe(0)
    expect(timers.pending).toBe(0)
  })

  it("does not arm a deadline for a non-positive timeout", () => {
    const timers = new FakeTimers()
    const broker = new SseProgressBroker<Payload>({ timers })
    open(broker, 7, { timeoutMs: 0 })
    expect(timers.pending).toBe(0)
  })

  it("closes every subscriber with a completion event", async () => {
    const broker = new SseProgressBroker<Payload>()
    const first = open(broker, 7)
    const second = open(broker, 7)

    broker.complete(7)

    expect(await read(first)).toBe('event: complete\ndata: {"complete":true}\n\n')
    expect(await read(second)).toBe('event: complete\ndata: {"complete":true}\n\n')
    expect(await drain(first)).toBe("")
    expect(broker.subscriberCount(7)).toBe(0)
    expect(broker.jobCount).toBe(0)
  })

  it("publishes a final payload before completing", async () => {
    const broker = new SseProgressBroker<Payload>()
    const reader = open(broker, 7)
    broker.complete(7, { payload: { percent: 100 } })
    const frames = await drain(reader)
    expect(frames).toContain('event: progress\ndata: {"percent":100}\n\n')
    expect(frames).toContain('event: complete\ndata: {"complete":true}\n\n')
  })

  it("delivers a failure in band and ends the stream", async () => {
    const broker = new SseProgressBroker<Payload>()
    const reader = open(broker, 7)
    broker.fail(7, new Error("encoder died"))
    expect(await read(reader)).toBe('event: error\ndata: {"message":"encoder died"}\n\n')
    const { done } = await reader.read()
    expect(done).toBe(true)
    expect(broker.jobCount).toBe(0)
  })

  it("reports a non-Error failure as text", async () => {
    const broker = new SseProgressBroker<Payload>()
    const reader = open(broker, 7)
    broker.fail(7, "disk full")
    expect(await read(reader)).toBe('event: error\ndata: {"message":"disk full"}\n\n')
  })

  it("ignores a publish, complete or fail for a job that already ended", () => {
    const broker = new SseProgressBroker<Payload>()
    open(broker, 7)
    broker.complete(7)
    broker.publish(7, { percent: 10 })
    broker.complete(7)
    broker.fail(7, new Error("late"))
    expect(broker.jobCount).toBe(0)
  })

  it("keeps the job entry while at least one subscriber remains", async () => {
    const broker = new SseProgressBroker<Payload>()
    const first = broker.subscribe(7).getReader()
    const second = broker.subscribe(7).getReader()
    await second.cancel()
    expect(broker.subscriberCount(7)).toBe(1)
    expect(broker.jobCount).toBe(1)
    broker.publish(7, { percent: 30 })
    expect(await read(first)).toBe('event: progress\ndata: {"percent":30}\n\n')
  })

  it("exposes the last payload of a live job", () => {
    const broker = new SseProgressBroker<Payload>()
    open(broker, 7)
    broker.publish(7, { percent: 42 })
    expect(broker.latestOf(7)).toEqual({ percent: 42 })
    expect(broker.latestOf(8)).toBe(undefined)
  })
})
