/**
 * Tells a host when its page has returned to the user, so a realtime transport can recover at once.
 *
 * A phone that puts the app in the background freezes its timers and may kill its socket; the
 * transport then sits in a long backoff, or holds a socket that is already dead. Three browser
 * events say the page is back: `visibilitychange` to visible, `online`, and `pageshow` of a page
 * restored from the back-forward cache. This module only listens; what to do is the caller's
 * (usually {@link ClientTransport.resume}).
 */

/** The parts of `window` and `document` the watcher uses, so a test or a worker can supply them. */
export interface PageLifecycleTarget {
  document: {
    readonly visibilityState: string
    addEventListener(type: "visibilitychange", listener: () => void): void
    removeEventListener(type: "visibilitychange", listener: () => void): void
  }
  addEventListener(type: "online" | "pageshow", listener: (event: Event) => void): void
  removeEventListener(type: "online" | "pageshow", listener: (event: Event) => void): void
}

/**
 * Calls `onResume` when the page becomes visible, the browser goes online, or a page is restored
 * from the back-forward cache (`pageshow` with `persisted`). A first `pageshow` of a fresh load is
 * ignored: the page has just connected. `target` defaults to the global `window`. Returns a
 * function that removes every listener.
 */
export function watchPageResume(
  onResume: () => void,
  target: PageLifecycleTarget = globalThis as unknown as PageLifecycleTarget,
): () => void {
  const onVisibility = () => {
    if (target.document.visibilityState === "visible") onResume()
  }
  const onOnline = () => onResume()
  const onPageShow = (event: Event) => {
    if ((event as PageTransitionEvent).persisted) onResume()
  }
  target.document.addEventListener("visibilitychange", onVisibility)
  target.addEventListener("online", onOnline)
  target.addEventListener("pageshow", onPageShow)
  return () => {
    target.document.removeEventListener("visibilitychange", onVisibility)
    target.removeEventListener("online", onOnline)
    target.removeEventListener("pageshow", onPageShow)
  }
}
