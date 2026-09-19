/**
 * `chatJson` — arktype schema in, validated value out, with at most one repair
 * round-trip.
 *
 * The interesting cases are the boundaries: a fence the model added anyway, a
 * shape the schema rejects, and the second failure that must not become a third
 * request.
 */

import { assertEquals, assertMatch, assertRejects } from "@std/assert"
import { it } from "@std/testing/bdd"
import { type } from "arktype"

import { AiErrorCode, isAiError } from "./errors.ts"
import type { AiError } from "./errors.ts"
import { parseCompletionJson, repairPrompt } from "./chat-json.ts"
import { createChatClient } from "./chat.ts"
import {
  completionBody,
  createFakeFetcher,
  createFakeTimer,
  createRecordingLogger,
  FAKE_API_KEY,
  FAKE_BASE_URL,
  type FakeReply,
} from "./test-fixtures.ts"

const planSchema = type({
  tasks: type({ text: "string", "time?": "string" }).array(),
})

const ASK = {
  messages: [{ role: "user" as const, content: "plan my day" }],
  schema: planSchema,
}

function harness(replies: FakeReply[]) {
  const fake = createFakeFetcher(replies)
  const timer = createFakeTimer()
  const { logger, lines } = createRecordingLogger()
  const client = createChatClient({
    apiKey: FAKE_API_KEY,
    baseUrl: FAKE_BASE_URL,
    fetcher: fake.fetcher,
    timer,
    logger,
  })
  return { client, fake, timer, lines }
}

it("returns the validated value, typed by the schema", async () => {
  const { client } = harness([
    { body: completionBody(JSON.stringify({ tasks: [{ text: "ship it", time: "09:00" }] })) },
  ])
  const result = await client.chatJson(ASK)

  assertEquals(result.data.tasks[0].text, "ship it")
  assertEquals(result.data.tasks[0].time, "09:00")
  assertEquals(result.attempts, 1)

  // Type-level: `data` is the inferred arktype output, so this compiles and
  // `.totallyNotAField` would not.
  const count: number = result.data.tasks.length
  assertEquals(count, 1)
})

it("recovers JSON the model wrapped in a fence", async () => {
  const fenced = "```json\n" + JSON.stringify({ tasks: [{ text: "fenced" }] }) + "\n```"
  const { client } = harness([{ body: completionBody(fenced) }])
  const result = await client.chatJson(ASK)
  assertEquals(result.data.tasks[0].text, "fenced")
})

it("returns a typed error with arktype details when the schema rejects the value", async () => {
  const { client } = harness([
    { body: completionBody(JSON.stringify({ tasks: [{ text: 42 }] })) },
    { body: completionBody(JSON.stringify({ tasks: [{ text: 42 }] })) },
  ])
  const error = await assertRejects(() => client.chatJson({ ...ASK, repairAttempts: 0 }))

  assertEquals(isAiError(error), true)
  if (!isAiError(error)) return
  assertEquals(error.code, AiErrorCode.SchemaMismatch)
  assertMatch(error.message, /tasks\[0\]\.text/)
  assertMatch(error.message, /must be a string/)
})

it("takes the schema's inferred output, not its input", async () => {
  const coerced = type({ count: "string.numeric.parse" })
  const { client } = harness([{ body: completionBody(JSON.stringify({ count: "12" })) }])
  const result = await client.chatJson({ ...ASK, schema: coerced })
  assertEquals(result.data.count, 12)
  assertEquals(typeof result.data.count, "number")
})

it("does not accept a scalar completion for an object schema", async () => {
  const { client } = harness([{ body: completionBody(`42`) }])
  const error = await assertRejects(() => client.chatJson({ ...ASK, repairAttempts: 0 }))
  // It is the schema that rejects a scalar for an object type, so the failure is
  // a schema mismatch rather than "no JSON found" — the ladder did find one.
  assertEquals(isAiError(error) ? error.code : 0, AiErrorCode.SchemaMismatch)
  assertMatch(isAiError(error) ? error.message : "", /must be an object/)
})

it("accepts a scalar completion for a scalar schema", async () => {
  const { client } = harness([{ body: completionBody("42") }])
  const result = await client.chatJson({ ...ASK, schema: type("number") })
  assertEquals(result.data, 42)
})

it("attempts exactly one repair round-trip and returns the repaired value", async () => {
  const { client, fake, lines } = harness([
    { body: completionBody("no json in here at all") },
    { body: completionBody(JSON.stringify({ tasks: [{ text: "repaired" }] })) },
  ])
  const result = await client.chatJson(ASK)

  assertEquals(result.data.tasks[0].text, "repaired")
  assertEquals(result.attempts, 2)
  assertEquals(fake.calls(), 2)
  assertEquals(lines.length, 1, "one repair must produce exactly one log line")
  assertEquals(lines[0].fields.repair, 1)
})

it("sends the repair prompt as an assistant turn plus a bounded instruction", async () => {
  const modelText = "{not json at all}"
  const { client, fake } = harness([
    { body: completionBody(modelText) },
    { body: completionBody(JSON.stringify({ tasks: [{ text: "ok" }] })) },
  ])
  await client.chatJson(ASK)

  const repairBody = fake.requests[1].body as { messages: Array<{ role: string; content: string }> }
  assertEquals(repairBody.messages.length, 3)
  assertEquals(repairBody.messages[1], { role: "assistant", content: modelText })
  assertEquals(repairBody.messages[2].role, "user")
  assertMatch(repairBody.messages[2].content, /previous answer could not be used/)
  assertMatch(repairBody.messages[2].content, /Reply with one JSON value only/)
})

it("caps repair at one attempt even when a larger count is asked for", async () => {
  const { client, fake } = harness([
    { body: completionBody("nope") },
    { body: completionBody("still nope") },
    { body: completionBody(JSON.stringify({ tasks: [{ text: "unused" }] })) },
  ])
  const error = await assertRejects(() => client.chatJson({ ...ASK, repairAttempts: 5 }))

  assertEquals(fake.calls(), 2, "a second failure must not become a third request")
  assertEquals(fake.remaining(), 1)
  assertEquals(isAiError(error) ? error.code : 0, AiErrorCode.JsonNotFound)
})

it("issues one request when repair is disabled", async () => {
  const { client, fake } = harness([
    { body: completionBody("nope") },
    { body: completionBody(JSON.stringify({ tasks: [{ text: "unused" }] })) },
  ])
  await assertRejects(() => client.chatJson({ ...ASK, repairAttempts: 0 }))
  assertEquals(fake.calls(), 1)
})

it("issues one request when the first answer already validates", async () => {
  const { client, fake } = harness([
    { body: completionBody(JSON.stringify({ tasks: [{ text: "fine" }] })) },
    { body: completionBody("unused") },
  ])
  await client.chatJson(ASK)
  assertEquals(fake.calls(), 1)
  assertEquals(fake.remaining(), 1)
})

it("sums usage across the repair round-trip, field by field", async () => {
  const { client } = harness([
    {
      body: completionBody("nope", { usage: { prompt_tokens: 10, completion_tokens: 2 } }),
    },
    {
      body: completionBody(JSON.stringify({ tasks: [{ text: "ok" }] }), {
        usage: { prompt_tokens: 20, completion_tokens: 5, total_tokens: 25 },
      }),
    },
  ])
  const result = await client.chatJson(ASK)
  assertEquals(result.usage, { promptTokens: 30, completionTokens: 7, totalTokens: 25 })
})

it("reports no usage when neither attempt reported any", async () => {
  const { client } = harness([
    { body: completionBody(JSON.stringify({ tasks: [{ text: "ok" }] })) },
  ])
  const result = await client.chatJson(ASK)
  assertEquals(result.usage, undefined)
})

it("surfaces a provider failure from a repair attempt as a provider error", async () => {
  const { client } = harness([
    { body: completionBody("nope") },
    { status: 500, body: { error: { message: "upstream gone" } } },
    { status: 500, body: { error: { message: "upstream gone" } } },
    { status: 500, body: { error: { message: "upstream gone" } } },
  ])
  const error = await assertRejects(() => client.chatJson(ASK))
  assertEquals(isAiError(error) ? error.code : 0, AiErrorCode.ProviderError)
})

it("keeps the model's own text out of the schema-mismatch message", async () => {
  const modelText = `{"tasks":"sk-test-not-a-real-key and a prompt fragment"}`
  const { client } = harness([
    { body: completionBody(modelText) },
    { body: completionBody(modelText) },
  ])
  const error = await assertRejects(() => client.chatJson({ ...ASK, repairAttempts: 0 }))
  const message = isAiError(error) ? error.message : ""
  assertEquals(message.includes("sk-test-not-a-real-key"), false)
  assertEquals(message.includes("a prompt fragment"), false)
})

it("builds a repair prompt with no completion text in it", () => {
  const error = {
    kind: "json",
    code: AiErrorCode.JsonNotFound,
    message: "ai: the completion held no JSON object or array",
  } as AiError
  const prompt = repairPrompt(error)
  assertEquals(prompt.includes("completion held no JSON"), false)
  assertMatch(prompt, /not a JSON object or array/)
})

it("collapses a multi-line validator summary into one line", async () => {
  const wide = type({ a: "string", b: "string", c: "string" })
  const { client } = harness([{ body: completionBody(JSON.stringify({ a: 1, b: 2, c: 3 })) }])
  const error = await assertRejects(() =>
    client.chatJson({ ...ASK, schema: wide, repairAttempts: 0 })
  )
  const message = isAiError(error) ? error.message : ""
  assertEquals(message.includes("\n"), false)
  assertEquals(message.length < 500, true)
})

it("parses and validates a completion without a client", () => {
  const outcome = parseCompletionJson(JSON.stringify({ tasks: [{ text: "direct" }] }), planSchema)
  assertEquals(outcome.error, null)
  assertEquals(outcome.data?.tasks[0].text, "direct")
  assertEquals(outcome.failure, null)

  const bad = parseCompletionJson("not json", planSchema)
  assertEquals(bad.failure, "json-not-found")

  const mismatched = parseCompletionJson(JSON.stringify({ tasks: "nope" }), planSchema)
  assertEquals(mismatched.failure, "schema-mismatch")
  assertEquals(isAiError(mismatched.error), true)
})
