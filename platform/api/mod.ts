/**
 * `@spy4x/platform/api` — the browser side of the API result convention.
 *
 * {@link apiFetch} wraps `fetch` for a JSON API and reports the outcome as an {@link ApiResult}
 * instead of throwing on an HTTP error. A failure carries the status, a message (the body's `error`,
 * else its `message`, else `"Request failed"`) and the body's string `code` when present. A network
 * failure still rejects. See `api.ts` for how headers merge.
 *
 * `apiFetch` reads an error body in three shapes: `{ error }` (a string), `{ code, message }`, or
 * `{ error: { code, message } }`. The message is the string `error`, else the string `message` of an
 * `error` object, else the body's string `message`, else `"Request failed"`. `error.code` is the string
 * `code` of an `error` object, else the body's string `code`, when there is one, so a client can branch
 * on `caldav_unreachable` instead of on wording. `error.reason` and `error.fields` are the `reason`
 * string and the `fields` record (`fieldErrorsSchema` of `@spy4x/validation`) of an `error` object,
 * each left out when absent or of another shape. Non-string fields are ignored, and so is any extra
 * field in the nested object (such as `requestId`). Only HTTP answers resolve: a network failure still rejects, so wrap the call in
 * `try`/`catch` where a throw is not acceptable.
 *
 * @module
 */

export { type ApiError, apiFetch, type ApiResult } from "./api.ts"
export {
  createOfflineFetch,
  INVALID_REPLY_CODE,
  type OfflineApiResult,
  type OfflineFetch,
  type OfflineFetchOptions,
} from "./offline-fetch.ts"
