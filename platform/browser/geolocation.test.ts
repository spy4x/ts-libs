import { describe, it } from "@std/testing/bdd"
import { expect } from "@std/expect"

import { GEOLOCATION_FAILED, GEOLOCATION_UNSUPPORTED, requestGeolocation } from "./geolocation.ts"

function fakeGeolocation(
  resolve: (
    success: (position: GeolocationPosition) => void,
    failure?: (error: GeolocationPositionError) => void,
  ) => void,
): Geolocation {
  return {
    getCurrentPosition: (success: PositionCallback, failure?: PositionErrorCallback) =>
      resolve(success, failure ?? undefined),
    watchPosition: () => 0,
    clearWatch: () => {},
  } as unknown as Geolocation
}

describe("requestGeolocation", () => {
  it("maps a resolved position onto the coordinates callback", () => {
    const positions: Array<{ latitude: number; longitude: number }> = []

    requestGeolocation(
      (position) => positions.push(position),
      () => {},
      fakeGeolocation((success) =>
        success({
          coords: { latitude: 52.52, longitude: 13.405, accuracy: 10 },
          timestamp: 0,
        } as unknown as GeolocationPosition)
      ),
    )

    expect(positions).toEqual([{ latitude: 52.52, longitude: 13.405 }])
  })

  it("reports a denied permission as one readable message", () => {
    const errors: string[] = []

    requestGeolocation(
      () => {},
      (message) => errors.push(message),
      fakeGeolocation((_success, failure) => failure?.({} as GeolocationPositionError)),
    )

    expect(errors).toEqual([GEOLOCATION_FAILED])
  })

  it("reports a runtime with no geolocation instead of throwing", () => {
    const errors: string[] = []

    requestGeolocation(() => {}, (message) => errors.push(message), null)

    expect(errors).toEqual([GEOLOCATION_UNSUPPORTED])
  })

  it("asks the global navigator's geolocation when none is passed", () => {
    const positions: Array<{ latitude: number; longitude: number }> = []
    const fake = fakeGeolocation((success) =>
      success({ coords: { latitude: 1, longitude: 2 } } as unknown as GeolocationPosition)
    )
    Object.defineProperty(navigator, "geolocation", { value: fake, configurable: true })
    try {
      requestGeolocation((position) => positions.push(position))
    } finally {
      delete (navigator as { geolocation?: Geolocation }).geolocation
    }

    expect(positions).toEqual([{ latitude: 1, longitude: 2 }])
    expect("geolocation" in navigator).toBe(false)
  })

  it("stays silent when no error callback is passed", () => {
    expect(() => requestGeolocation(() => {}, undefined, null)).not.toThrow()
  })
})
