/**
 * `@ts-libs/platform/api` — the browser side of the API result convention.
 *
 * {@link apiFetch} wraps `fetch` for a JSON API and reports the outcome as an {@link ApiResult}
 * instead of throwing. See `api.ts` for the header-merge bug fixed at extraction time.
 */

export { type ApiError, apiFetch, type ApiResult } from "./api.ts"
