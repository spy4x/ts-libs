import { assertEquals, assertRejects, assertStrictEquals, assertThrows } from "@std/assert"
import {
  buildExportEnvelope,
  EXPORT_VERSION,
  exportDownloadHeaders,
  exportDownloadResponse,
  type ExportEnvelope,
  exportFileName,
  formatLocalDate,
} from "./export.ts"

/**
 * A fixed instant whose UTC day is known: 2026-03-09T18:30Z.
 *
 * Whether that is the 9th or the 10th *locally* depends on the host timezone, so
 * the filename tests derive the expected day from local getters — the same way a
 * user reads it — instead of hard-coding a day that is only right on UTC.
 */
const FIXED = new Date("2026-03-09T18:30:00.000Z")
const FIXED_NOW = () => FIXED

/** `YYYY-MM-DD` from local getters, independent of the host timezone. */
function localDayOf(date: Date): string {
  return [
    String(date.getFullYear()).padStart(4, "0"),
    String(date.getMonth() + 1).padStart(2, "0"),
    String(date.getDate()).padStart(2, "0"),
  ].join("-")
}

Deno.test("export: the envelope carries the version, user and timestamp", async () => {
  const envelope = await buildExportEnvelope({
    userId: "user-1",
    user: { id: "user-1", email: "user@example.com" },
    collections: [],
    now: FIXED_NOW,
  })
  assertEquals(envelope.version, EXPORT_VERSION)
  assertEquals(envelope.exportedAt, "2026-03-09T18:30:00.000Z")
  assertEquals(envelope.user, { id: "user-1", email: "user@example.com" })
})

Deno.test("export: collections are attached under their own names", async () => {
  const envelope = await buildExportEnvelope({
    userId: "user-1",
    user: { id: "user-1" },
    collections: [
      { name: "areas", load: () => [{ id: "area-1" }] },
      { name: "snapshots", load: async () => await Promise.resolve([{ id: "snap-1" }]) },
    ],
    now: FIXED_NOW,
  })
  assertEquals(envelope.areas, [{ id: "area-1" }])
  assertEquals(envelope.snapshots, [{ id: "snap-1" }])
})

Deno.test("export: each loader is scoped to the requesting user", async () => {
  const seen: string[] = []
  await buildExportEnvelope({
    userId: "user-42",
    user: { id: "user-42" },
    collections: [{
      name: "focus",
      load: (userId) => {
        seen.push(userId)
        return []
      },
    }],
    now: FIXED_NOW,
  })
  assertEquals(seen, ["user-42"])
})

Deno.test("export: a loaded collection is not shared between envelopes", async () => {
  const first = await buildExportEnvelope({
    userId: "user-1",
    user: { id: "user-1" },
    collections: [{ name: "areas", load: () => [{ id: "area-1" }] }],
    now: FIXED_NOW,
  })
  const second = await buildExportEnvelope({
    userId: "user-2",
    user: { id: "user-2" },
    collections: [{ name: "areas", load: () => [] }],
    now: FIXED_NOW,
  })
  assertEquals(first.areas, [{ id: "area-1" }])
  assertEquals(second.areas, [])
})

Deno.test("export: a reserved collection name is refused", async () => {
  for (const name of ["version", "exportedAt", "user"]) {
    await assertRejects(
      () =>
        buildExportEnvelope({
          userId: "user-1",
          user: { id: "user-1" },
          collections: [{ name, load: () => [] }],
        }),
      TypeError,
      "reserved",
    )
  }
})

Deno.test("export: a duplicated collection name is refused", async () => {
  await assertRejects(
    () =>
      buildExportEnvelope({
        userId: "user-1",
        user: { id: "user-1" },
        collections: [
          { name: "areas", load: () => [] },
          { name: "areas", load: () => [] },
        ],
      }),
    TypeError,
    "duplicate",
  )
})

Deno.test("export: an empty userId is refused", async () => {
  await assertRejects(
    () => buildExportEnvelope({ userId: "", user: { id: "" }, collections: [] }),
    TypeError,
  )
})

Deno.test("export: a product may override the format version", async () => {
  const envelope = await buildExportEnvelope({
    version: "2.1",
    userId: "user-1",
    user: { id: "user-1" },
    collections: [],
    now: FIXED_NOW,
  })
  assertEquals(envelope.version, "2.1")
})

/**
 * Run `operation` with the process timezone forced to `tz`.
 *
 * `formatLocalDate` is defined by local getters, which makes it *extensionally
 * identical* to a UTC-reader on a host running at UTC: 23:30 local is 23:30Z, and
 * no instant can separate the two. A test that wants to tell them apart has to
 * choose the offset, so this pins one for the duration of the assertion and
 * restores the environment in a `finally`.
 */
function withTimeZone<T>(tz: string, operation: () => T): T {
  const previous = Deno.env.get("TZ")
  Deno.env.set("TZ", tz)
  try {
    return operation()
  } finally {
    if (previous === undefined) Deno.env.delete("TZ")
    else Deno.env.set("TZ", previous)
  }
}

Deno.test("export: the filename is <name>-YYYY-MM-DD.json", () => {
  // Literal, not derived: an expectation computed with the same local getters the
  // implementation uses would agree with a broken implementation.
  assertEquals(
    exportFileName("northstar", new Date(2026, 2, 9, 12, 0, 0)),
    "northstar-2026-03-09.json",
  )
  assertEquals(
    exportFileName("northstar", new Date(2026, 2, 9, 23, 30, 0)),
    "northstar-2026-03-09.json",
  )
})

Deno.test("export: formatLocalDate reads the local calendar day, never the UTC day", () => {
  // Unconditional, hard-coded expectations — nothing here can coincide with a
  // broken implementation's output, so it never degrades into a no-op.
  assertEquals(formatLocalDate(new Date(2026, 2, 9, 23, 30, 0)), "2026-03-09")
  assertEquals(formatLocalDate(new Date(2026, 2, 9, 0, 30, 0)), "2026-03-09")
  assertEquals(formatLocalDate(new Date(2025, 11, 31, 23, 30, 0)), "2025-12-31")
})

Deno.test("export: the local day differs from the UTC day west of Greenwich", () => {
  // Forces a negative offset so the two calendars genuinely disagree: 2026-03-09
  // 23:30 at UTC-04:00 is 2026-03-10T03:30Z. Reading `getUTC*` names the file for
  // the 10th, so this is red for that mutation on any host, UTC included — which
  // is the property a CI run without `TZ` needs.
  withTimeZone("America/New_York", () => {
    const evening = new Date(2026, 2, 9, 23, 30, 0)
    assertStrictEquals(
      evening.getTimezoneOffset() > 0,
      true,
      "the forced timezone did not take effect; refusing to report a vacuous pass",
    )
    assertStrictEquals(evening.getUTCDate(), 10)
    assertEquals(formatLocalDate(evening), "2026-03-09")
    assertEquals(exportFileName("northstar", evening), "northstar-2026-03-09.json")
  })
})

Deno.test("export: the local day differs from the UTC day east of Greenwich", () => {
  // The mirror case: 2026-03-09 00:30 at UTC+07:00 is 2026-03-08T17:30Z, so a
  // UTC-reader names the file for the 8th.
  withTimeZone("Asia/Bangkok", () => {
    const morning = new Date(2026, 2, 9, 0, 30, 0)
    assertStrictEquals(morning.getTimezoneOffset() < 0, true)
    assertStrictEquals(morning.getUTCDate(), 8)
    assertEquals(formatLocalDate(morning), "2026-03-09")
    assertEquals(exportFileName("northstar", morning), "northstar-2026-03-09.json")
  })
})

Deno.test("export: a fixed instant is named for its local day", () => {
  // 2026-03-09T23:30Z is the 10th at +05:00 and still the 9th at -05:00: the
  // instant the source's `toISOString().slice(0, 10)` named a day early. The day
  // depends on the host timezone here, so the expectation is derived; the forced
  // offset tests above are the ones that bite unconditionally.
  const evening = new Date("2026-03-09T23:30:00.000Z")
  assertEquals(
    exportFileName("northstar", evening),
    `northstar-${localDayOf(evening)}.json`,
  )
})

Deno.test("export: the filename date shape is fixed", () => {
  const filename = exportFileName("northstar", new Date(2026, 2, 9, 23, 30, 0))
  assertStrictEquals(/^northstar-\d{4}-\d{2}-\d{2}\.json$/.test(filename), true)
})

Deno.test("export: the filename cannot inject a header or a path", () => {
  const day = localDayOf(FIXED)
  assertEquals(
    exportFileName('evil"; filename="x\r\nX-Injected: 1', FIXED),
    `evil-filename-x-X-Injected-1-${day}.json`,
  )
  assertEquals(exportFileName("../../etc/passwd", FIXED), `etc-passwd-${day}.json`)
  assertEquals(exportFileName("naïve café", FIXED), `na-ve-caf-${day}.json`)
})

Deno.test("export: an empty or punctuation-only name falls back to `export`", () => {
  const day = localDayOf(FIXED)
  assertEquals(exportFileName("", FIXED), `export-${day}.json`)
  assertEquals(exportFileName("   ", FIXED), `export-${day}.json`)
  assertEquals(exportFileName("///", FIXED), `export-${day}.json`)
  // `..` is a path segment, not a name: it must never survive into the filename.
  assertEquals(exportFileName("..", FIXED), `export-${day}.json`)
  assertEquals(exportFileName(".", FIXED), `export-${day}.json`)
})

Deno.test("export: the content-disposition header is an attachment", () => {
  const headers = exportDownloadHeaders("northstar", FIXED)
  assertEquals(
    headers.get("content-disposition"),
    `attachment; filename="northstar-${localDayOf(FIXED)}.json"`,
  )
  assertEquals(headers.get("content-type"), "application/json; charset=utf-8")
})

Deno.test("export: an invalid date is refused instead of naming a file `NaN`", () => {
  assertThrows(() => exportDownloadHeaders("northstar", new Date("nonsense")), RangeError)
  assertThrows(() => exportFileName("northstar", new Date(Number.NaN)), RangeError)
})

Deno.test("export: the download response serialises the envelope with the headers", async () => {
  const envelope: ExportEnvelope<{ id: string }> = {
    exportedAt: FIXED.toISOString(),
    version: EXPORT_VERSION,
    user: { id: "user-1" },
    areas: [{ id: "area-1" }],
  }
  const response = exportDownloadResponse(envelope, { name: "northstar", date: FIXED })

  assertEquals(response.status, 200)
  assertEquals(
    response.headers.get("content-disposition"),
    `attachment; filename="northstar-${localDayOf(FIXED)}.json"`,
  )
  assertEquals(response.headers.get("content-type"), "application/json; charset=utf-8")
  assertEquals(await response.json(), envelope)
  assertStrictEquals(response.bodyUsed, true)
})
