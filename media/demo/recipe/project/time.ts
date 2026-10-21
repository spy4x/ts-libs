import { formatInstantLong, zoneCity } from "@spy4x/time/tz"

const call = new Date("2026-11-05T15:00:00Z")
const zones = ["America/New_York", "Europe/Berlin", "Asia/Singapore"]

for (const zone of zones) {
  console.log(zoneCity(zone).padEnd(10), formatInstantLong(call, zone))
}
