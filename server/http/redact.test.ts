import { assertEquals, assertStrictEquals } from "@std/assert"
import { genericProviderMessage, logProviderError, ProviderScope } from "./redact.ts"

/** Capture `console.error` lines. */
function captureConsoleError(operation: () => void): string[] {
  const original = console.error
  const lines: string[] = []
  console.error = (...args: unknown[]) => {
    lines.push(args.map((arg) => String(arg)).join(" "))
  }
  try {
    operation()
  } finally {
    console.error = original
  }
  return lines
}

/** Every substring that must never reach a log line or a client. */
const FORBIDDEN = [
  "sk-live-XXXX",
  "invalid_api_key",
  "deepseek",
  "/v1/chat",
  "req_abc123",
  "at Provider.parse",
  "SELECT",
]

Deno.test("redact: the generic message is stable for the analyze scope", () => {
  assertEquals(genericProviderMessage(ProviderScope.Analyze), "Analysis failed")
})

Deno.test("redact: the generic message is stable for the batch_item scope", () => {
  assertEquals(genericProviderMessage(ProviderScope.BatchItem), "Analysis failed")
})

Deno.test("redact: the generic message carries no provider text", () => {
  const providerText = "BadRequest: 401 invalid_api_key sk-live-XXXX at deepseek /v1/chat"
  const message = genericProviderMessage(ProviderScope.Analyze)
  assertEquals(message, "Analysis failed")
  assertStrictEquals(message.includes(providerText), false)
  for (const fragment of FORBIDDEN) {
    assertStrictEquals(message.includes(fragment), false, `generic message leaked ${fragment}`)
  }
})

Deno.test("redact: the log line never includes the provider message", () => {
  const providerText = "BadRequest: 401 invalid_api_key sk-live-XXXX at deepseek /v1/chat"
  const lines = captureConsoleError(() => {
    logProviderError(ProviderScope.Analyze, new Error(providerText))
  })
  assertEquals(lines.length, 1)
  assertEquals(lines[0], "analyze_provider_error Error")
  for (const fragment of FORBIDDEN) {
    assertStrictEquals(lines[0].includes(fragment), false, `log line leaked ${fragment}`)
  }
})

Deno.test("redact: the batch_item log line is scoped and equally redacted", () => {
  const lines = captureConsoleError(() => {
    logProviderError(
      ProviderScope.BatchItem,
      new Error("TypeError: cannot read property 'x' of undefined at Provider.parse"),
    )
  })
  assertEquals(lines.length, 1)
  assertEquals(lines[0], "batch_item_provider_error Error")
  assertStrictEquals(lines[0].includes("TypeError:"), false)
  assertStrictEquals(lines[0].includes("Provider.parse"), false)
})

Deno.test("redact: the error class name is logged", () => {
  class ProviderQuotaError extends Error {
    constructor() {
      super("secret payload: quota 0/100 for org acme")
      this.name = "ProviderQuotaError"
    }
  }
  const lines = captureConsoleError(() => {
    logProviderError(ProviderScope.Analyze, new ProviderQuotaError())
  })
  assertEquals(lines[0], "analyze_provider_error ProviderQuotaError")
  assertStrictEquals(lines[0].includes("secret payload"), false)
  assertStrictEquals(lines[0].includes("acme"), false)
})

Deno.test("redact: a provider error with a request id and a stack leaks neither", () => {
  const error = new Error("upstream 500, request id req_abc123")
  error.stack =
    `Error: upstream 500, request id req_abc123\n    at Provider.parse (/srv/secret.ts:12:3)`
  const lines = captureConsoleError(() => {
    logProviderError(ProviderScope.Analyze, error)
  })
  assertStrictEquals(lines[0].includes("req_abc123"), false, "leaked request id")
  assertStrictEquals(lines[0].includes("/srv/secret.ts"), false, "leaked stack frame")
  assertStrictEquals(lines[0].includes("upstream 500"), false, "leaked provider status text")
})

Deno.test("redact: a non-Error throw logs its type, never its value", () => {
  const lines = captureConsoleError(() => {
    logProviderError(ProviderScope.Analyze, "string thrown with a token sk-live-XXXX")
    logProviderError(ProviderScope.BatchItem, 42)
    logProviderError(ProviderScope.Analyze, null)
  })
  assertEquals(lines.length, 3)
  assertEquals(lines[0], "analyze_provider_error string")
  assertEquals(lines[1], "batch_item_provider_error number")
  assertEquals(lines[2], "analyze_provider_error object")
  for (const line of lines) {
    assertStrictEquals(line.includes("sk-live-XXXX"), false)
  }
})

Deno.test("redact: the logged line is returned so a caller can forward it", () => {
  let returned = ""
  const lines = captureConsoleError(() => {
    returned = logProviderError(ProviderScope.Analyze, new Error("boom"))
  })
  assertEquals(returned, lines[0])
})

Deno.test("redact: the scope enum starts at 1 and is finite", () => {
  assertEquals(ProviderScope.Analyze, 1)
  assertEquals(ProviderScope.BatchItem, 2)
  assertEquals(Object.keys(ProviderScope).length, 4)
})
