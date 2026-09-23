/**
 * The browser side of the API result convention: {@link apiFetch} wraps `fetch` so a caller
 * branches on `ok` instead of on a thrown exception, and always gets a typed status and a message.
 *
 * Moved from `template/apps/spa/src/state/api.ts`. Browser-only — nothing here imports Hono or a
 * server type, and this file must stay that way so a server bundle never pulls in `fetch`-shaped
 * browser code it does not need. {@link ApiError} and {@link ApiResult} are moved from
 * `template/libs/platform/types/+index.ts`, unchanged.
 *
 * **Bug fixed at extraction time.** The source built the request as
 * `{ credentials: "include", headers: { "content-type": "application/json", ...init?.headers },
 * ...init }`. Because `init` was spread last, a caller passing its own `headers` replaced the
 * whole merged headers object instead of adding to it — a caller who only wanted to add
 * `Authorization` silently lost `content-type`. Here the default header and the caller's headers
 * are merged into one `Headers` instance first (accepting every `HeadersInit` form: a plain
 * object, an array of `[name, value]` pairs, or a `Headers` instance), the caller's own
 * `content-type` wins because it is applied after the default, and `headers` is the only field
 * `init` does not get to overwrite by a later spread — every other `init` field (`credentials`,
 * `signal`, `method`, `body`, …) still reaches `fetch` exactly as the caller set it.
 */

/** One failure `apiFetch` can report: an HTTP status and a message meant to be shown as-is. */
export interface ApiError {
  status: number
  message: string
}

/** Outcome of {@link apiFetch}: the parsed body on success, or a typed error on failure. */
export type ApiResult<T> =
  | { ok: true; status: number; data: T }
  | { ok: false; status: number; error: ApiError }

/**
 * `fetch` a JSON API and report the outcome as an {@link ApiResult} instead of throwing.
 *
 * Always sends `credentials: "include"` and a `content-type: application/json` header, both
 * overridable through `init`. The response body is read as JSON regardless of status; a body that
 * is not valid JSON (including an empty body) is treated as `null` rather than failing the call.
 * On a non-2xx response, the error message is the body's own `error` string when it has one string
 * `error` field, else the fallback `"Request failed"`.
 *
 * @example
 * ```ts
 * const result = await apiFetch<User>("/api/me")
 * if (!result.ok) return result.error.message
 * return result.data
 * ```
 */
export async function apiFetch<T>(
  path: string,
  init: RequestInit = {},
): Promise<ApiResult<T>> {
  const { headers: callerHeaders, ...rest } = init
  const headers = new Headers({ "content-type": "application/json" })
  if (callerHeaders !== undefined) {
    for (const [name, value] of new Headers(callerHeaders)) {
      headers.set(name, value)
    }
  }

  const response = await fetch(path, {
    credentials: "include",
    ...rest,
    headers,
  })

  let data: unknown = null
  try {
    data = await response.json()
  } catch (_error) {
    data = null
  }

  if (!response.ok) {
    const message =
      data && typeof data === "object" && "error" in data && typeof data.error === "string"
        ? data.error
        : "Request failed"
    return { ok: false, status: response.status, error: { status: response.status, message } }
  }
  return { ok: true, status: response.status, data: data as T }
}
