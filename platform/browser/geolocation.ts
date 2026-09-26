/**
 * Ask the browser for the current position once, and route the answer to two callbacks.
 *
 * Nothing here reads `navigator` at import time: the `Geolocation` object is a parameter, read from
 * the global only when the caller passes none, so the module is safe to import during a server
 * render and testable with a fake.
 *
 * @module
 */

/** A resolved position, reduced to the two numbers a caller stores. */
export interface GeoCoordinates {
  latitude: number
  longitude: number
}

/** Message {@link requestGeolocation} reports when the runtime has no `Geolocation` at all. */
export const GEOLOCATION_UNSUPPORTED = "Geolocation is not supported by this browser"

/** Message {@link requestGeolocation} reports when the browser refused or failed to answer. */
export const GEOLOCATION_FAILED = "Cannot get geolocation"

/**
 * Ask for the current position and report the result.
 *
 * The success callback receives the coordinates alone. Every failure — no `Geolocation` in this
 * runtime, a denied permission, a timeout — becomes one call to `onError` with a readable English
 * message ({@link GEOLOCATION_UNSUPPORTED} or {@link GEOLOCATION_FAILED}); a caller that shows its
 * own wording compares against those two constants.
 *
 * @param onLocation Called with the resolved coordinates.
 * @param onError Called with a readable failure message; a no-op by default.
 * @param geolocation The `Geolocation` to ask. `undefined` reads `navigator.geolocation`; `null`
 * means there is none, which is how a test or a server render states it.
 */
export function requestGeolocation(
  onLocation: (position: GeoCoordinates) => void,
  onError: (message: string) => void = () => {},
  geolocation?: Geolocation | null,
): void {
  const port = geolocation === undefined
    ? (globalThis as { navigator?: { geolocation?: Geolocation } }).navigator?.geolocation
    : geolocation
  if (!port) {
    onError(GEOLOCATION_UNSUPPORTED)
    return
  }

  port.getCurrentPosition(
    (position) =>
      onLocation({
        latitude: position.coords.latitude,
        longitude: position.coords.longitude,
      }),
    () => onError(GEOLOCATION_FAILED),
  )
}
