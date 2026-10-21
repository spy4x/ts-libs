/**
 * Run `load` once and share its promise with every later call, unless it
 * rejects: a rejected promise is dropped, so the next call runs `load` again.
 *
 * Not in `email/deno.json`'s `exports` map; `smtp.ts` uses it so one failed
 * nodemailer import does not fail every later send until the process restarts.
 */
export function cacheUntilRejected<T>(load: () => Promise<T>): () => Promise<T> {
  let pending: Promise<T> | undefined
  return () => {
    pending ??= load().catch((error) => {
      pending = undefined
      throw error
    })
    return pending
  }
}
