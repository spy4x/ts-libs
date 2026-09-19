/**
 * `@ts-libs/ai` — an OpenAI-compatible chat completions client, plus the JSON
 * recovery every structured-output feature ends up needing.
 *
 * Import the barrel for all of it, or a subpath (`@ts-libs/ai/parse-json`) for
 * one module. Nothing here reads the network at import time.
 */

export * from "./chat.ts"
export * from "./chat-json.ts"
export * from "./parse-json.ts"
export * from "./errors.ts"
