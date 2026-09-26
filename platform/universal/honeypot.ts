/**
 * The server half of a honeypot form field: a field simple bots fill in and people never see.
 *
 * A page renders the field off-screen under {@link HONEYPOT_FIELD_NAME} (or a name of its own); a
 * handler that receives the form reads it back with {@link honeypotFilled} and rejects the post
 * when it carries a value. The check has to run on the server as well as in the page: a form posted
 * with no JavaScript never runs a client-side check at all.
 *
 * @module
 */

/**
 * Default `name` of the honeypot field.
 *
 * Deliberately not a word a browser's own autofill heuristics reach for — `"company"`, `"website"`,
 * `"url"` and similar strongly signal a category to Chrome's autofill even with `autocomplete="off"`
 * on the input, and an autofilled honeypot rejects a real visitor's genuine submission.
 */
export const HONEYPOT_FIELD_NAME = "hp-field"

/**
 * Whether a submitted honeypot field carries a value — a person never types into a field they
 * cannot see, so any value here means whatever posted the form was not one.
 *
 * @param data The submitted form data, e.g. `await request.formData()`.
 * @param name Field name the page rendered. Defaults to {@link HONEYPOT_FIELD_NAME}.
 */
export function honeypotFilled(data: FormData, name: string = HONEYPOT_FIELD_NAME): boolean {
  return String(data.get(name) ?? "").length > 0
}
