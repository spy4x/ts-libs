/**
 * Call every listener with one value, each inside its own `try`/`catch`.
 *
 * A listener that throws costs only itself: the ones after it still run, and so does the work the
 * caller does after the dispatch. The failure goes to `console.error` and not to an error listener,
 * because that listener may be the one that threw.
 */
export function notifyListeners<T>(
  listeners: Iterable<(value: T) => void>,
  value: T,
  what: string,
): void {
  for (const listener of [...listeners]) {
    try {
      listener(value)
    } catch (error) {
      console.error(`realtime: a ${what} listener threw`, error)
    }
  }
}
