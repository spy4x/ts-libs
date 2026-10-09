/**
 * `@spy4x/platform/api` — the browser side of the API result convention.
 *
 * {@link apiFetch} wraps `fetch` for a JSON API and reports the outcome as an {@link ApiResult}
 * instead of throwing on an HTTP error. A failure carries the status, a message (the body's `error`,
 * else its `message`, else `"Request failed"`) and the body's string `code` when present. A network
 * failure still rejects. See `api.ts` for the header-merge bug fixed at extraction time.
 *
 * @module
 */

export { type ApiError, apiFetch, type ApiResult } from "./api.ts"
