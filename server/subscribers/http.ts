import { parseBoundedFormData } from "@spy4x/net/bounded-body"

/**
 * Headers for every page that a token opens or a token form posts to. `no-store` keeps a page that
 * shows an address out of every cache; `strict-origin` keeps the token in the URL out of the
 * `Referer` another site receives.
 */
export const TOKEN_PAGE_HEADERS: Readonly<Record<string, string>> = Object.freeze({
  "Cache-Control": "no-store",
  "Referrer-Policy": "strict-origin",
})

/** The form-body cap {@link unsubscribeTokenFrom} applies by default: a token is a few hundred
 * bytes, so 4 KiB fits any real form and nothing more. */
export const UNSUBSCRIBE_FORM_MAX_BYTES = 4 * 1024

/** Options of {@link unsubscribeTokenFrom}. */
export interface UnsubscribeTokenOptions {
  /** Largest form body read, in bytes. Defaults to {@link UNSUBSCRIBE_FORM_MAX_BYTES}. */
  maxBytes?: number
}

/**
 * The unsubscribe token of a request: the `token` query parameter first, as a mail client's
 * one-click POST (RFC 8058) keeps it on the URL with an unrelated body, then the `token` field of a
 * form body read under `maxBytes`. `null` when neither holds one, and also when the body is over
 * the cap, stalls, has no content type or does not parse as a form: the caller answers each of
 * those as a link it does not recognise.
 */
export async function unsubscribeTokenFrom(
  request: Request,
  options: UnsubscribeTokenOptions = {},
): Promise<string | null> {
  const fromQuery = new URL(request.url).searchParams.get("token")
  if (fromQuery) return fromQuery
  if (request.body === null || !request.headers.get("content-type")) return null
  try {
    const form = await parseBoundedFormData(request, {
      maxBytes: options.maxBytes ?? UNSUBSCRIBE_FORM_MAX_BYTES,
    })
    const field = form.get("token")
    return typeof field === "string" && field !== "" ? field : null
  } catch {
    return null
  }
}
