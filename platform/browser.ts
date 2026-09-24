/**
 * `@spy4x/platform/browser` — helpers that need a browser.
 *
 * Nothing here touches a global at import time: `getCookie` takes its `document`, `makeStorage`
 * takes its storage object, and `downloadResponseAsFile` takes its `document`, object-URL factory
 * and timer, all as parameters, defaulting to the real globals only when the caller passes none.
 * All three are safe under SSR and testable with fakes.
 */

export * from "./browser/cookie.ts"
export * from "./browser/download.ts"
export * from "./browser/storage.ts"
