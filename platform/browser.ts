/**
 * `@spy4x/platform/browser` — helpers that need a browser.
 *
 * Nothing here touches a global at import time: `makeStorage` takes its storage object as a
 * parameter, and `downloadResponseAsFile` takes its `document`, object-URL factory and timer the
 * same way, defaulting to the real globals only when the caller passes none. Both are safe under
 * SSR and testable with fakes.
 */

export * from "./browser/cookie.ts"
export * from "./browser/download.ts"
export * from "./browser/storage.ts"
