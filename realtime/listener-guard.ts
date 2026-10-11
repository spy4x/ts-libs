/**
 * Calls one listener so that its failure costs only itself.
 *
 * Internal to the package: every place that tells several listeners about one event calls each of
 * them through this, so a listener that throws cannot silence the ones registered after it or stop
 * the work that follows the dispatch.
 *
 * @module
 */

/**
 * Call `listener` with `args`. A throw is logged with `console.error` and swallowed.
 *
 * The failure is not reported through any `onError` listener, because that listener may be the one
 * that threw. `name` says which listener it was, for the log line.
 */
export function callListener<Arguments extends unknown[]>(
  name: string,
  listener: (...args: Arguments) => void,
  ...args: Arguments
): void {
  try {
    listener(...args)
  } catch (error) {
    console.error(`realtime: ${name} listener threw`, error)
  }
}
