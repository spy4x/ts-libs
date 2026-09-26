/**
 * `@spy4x/platform/browser` — helpers that need a browser.
 *
 * Nothing here touches a global at import time: `getCookie` takes its `document`, `makeStorage`
 * takes its storage object, `downloadResponseAsFile` and `downloadCsv` take their `document`,
 * object-URL factory and timer, `copyToClipboard` its clipboard and `document`, and
 * `requestGeolocation` its `Geolocation`, all as parameters, defaulting to the real globals only
 * when the caller passes none. All of them are safe under SSR and testable with fakes.
 */

export * from "./browser/clipboard.ts"
export * from "./browser/cookie.ts"
export * from "./browser/download.ts"
export * from "./browser/geolocation.ts"
export * from "./browser/storage.ts"
