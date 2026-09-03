// DB INTEGRATION TIER — the PRN ceiling's WINDOW (issue #4686).
//
// THE DEFECT, in the owner's own screenshot: "Acetaminophen … Redose OK — min interval
// passed · 0 of 5 today" at 09:16, with the last dose at 7:15 PM the previous evening.
// Every ceiling in the app cited a Drug Facts figure stated "in 24 hours" and counted a
// profile-local calendar DAY, so midnight disarmed it. Doses at 16:00 / 20:00 / 23:45
// read "3 of 5"; five more before 15:45 the next day produced EIGHT administrations
// inside 24 hours with "Max reached" never firing.
//
// WHY THIS TIER. The count is a SQL predicate over `intake_item_logs`, and the two rows
// it has to tell apart — an administration inside the window and one outside it — are
// identical at every surface. A dose row also carries no `profile_id` of its own (it is
// scoped through its parent item), so the fixture pins TWO profiles in different zones
// and asserts each one's count separately: a predicate that leaked across profiles, or
// that resolved a day in the wrong zone, is visible here and nowhere above.
//
// THE CLOCK IS SET EXPLICITLY per case rather than taken from the tier freeze, because
// the whole subject is which instant the window ends at. Every fixture states the
// administration instant it means; the untimed cases state its ABSENCE, which is the
// other half of the rule.
//
// Fixtures are synthetic throwaway rows (per-file temp DB). No PHI.

import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";
import { db, today } from "@/lib/db";
import { utcMinute, utcInstant } from "@/lib/date";
import { setTimezone } from "@/lib/settings";
import { getMedicationFamilyStates } from "@/lib/queries/intake/prn-family";
import { getPrnOverMaxItems } from "@/lib/queries";
import { redoseCardLabel } from "@/lib/redose-format";
import { prnQuickLogRedoseStatus } from "@/lib/prn-redose";
import { loadMedicationsData } from "@/app/(app)/medications/med-data";

// 09:16 UTC on the 3rd — the screenshot's own clock. New York (−04:00) is 05:16 on the
// same date and Kiritimati (+14:00) is 23:16 on the 3rd, so "local noon" and "local
// today" land in genuinely different places for the two profiles.
const NOW_ISO = "2026-09-03T09:16:00Z";

beforeEach(() => {
  vi.setSystemTime(new Date(NOW_ISO));
});
afterEach(() => {
  vi.setSystemTime(new Date(NOW_ISO));
});

function seedProfile(name: string, tz: string): number {
  const id = Number(
    db.prepare("INSERT INTO profiles (name) VALUES (?)").run(name)
      .lastInsertRowid
  );
  setTimezone(id, tz);
  return id;
}

// An as-needed medication with the label's own numbers on it.
function seedPrnMed(
  profileId: number,
  name: string,
  opts: { minInterval?: number; maxDaily?: number | null; amount?: string } = {}
): { itemId: number; doseId: number } {
  const itemId = Number(
    db
      .prepare(
        `INSERT INTO intake_items
           (profile_id, name, active, kind, condition, obligation,
            min_interval_hours, max_daily_count)
         VALUES (?, ?, 1, 'medication', 'daily', 'may', ?, ?)`
      )
      .run(profileId, name, opts.minInterval ?? 4, opts.maxDaily ?? 5)
      .lastInsertRowid
  );
  const doseId = Number(
    db
      .prepare(
        `INSERT INTO intake_item_doses (item_id, amount, time_of_day, food_timing, sort)
         VALUES (?, ?, 'anytime', 'any', 0)`
      )
      .run(itemId, opts.amount ?? "160 mg").lastInsertRowid
  );
  return { itemId, doseId };
}

// One administration. `at` is the stated administration instant, or null for a row
// that states none (a past-day check-off — #4428/#4779); `date` is the adherence day,
// which the restamp core is explicit about NOT being a bound on `at`.
function logAdministration(
  itemId: number,
  doseId: number,
  date: string,
  at: string | null
): void {
  db.prepare(
    `INSERT INTO intake_item_logs
       (dose_id, item_id, date, recorded_at, occurred_at, status, amount)
     VALUES (?, ?, ?, ?, ?, 'taken', '160 mg')`
  ).run(doseId, itemId, date, utcInstant(new Date(NOW_ISO)), at);
}

function countFor(profileId: number, itemId: number): number {
  return getMedicationFamilyStates(profileId, utcMinute(new Date())).get(
    itemId
  )!.countInWindow;
}

function cardLine(profileId: number, itemId: number): string | null {
  return loadMedicationsData(profileId).byId.get(itemId)?.prnRedoseLine ?? null;
}

describe("the ceiling counts the trailing 24 hours, not a calendar day (#4686)", () => {
  it("the screenshot's own case: last night's dose still counts at 09:16", () => {
    const p = seedProfile("Screenshot", "UTC");
    const { itemId, doseId } = seedPrnMed(p, "Acetaminophen");
    // 7:15 PM the previous evening — 14 hours ago, and on yesterday's `date`.
    logAdministration(itemId, doseId, "2026-09-02", "2026-09-02T19:15:00Z");

    expect(countFor(p, itemId)).toBe(1);
    // Was "Redose OK — min interval passed · 0 of 5 today".
    expect(cardLine(p, itemId)).toBe(
      "Redose OK — min interval passed · 1 of 5 in 24h"
    );
  });

  it("a five-dose sequence SPANNING midnight reaches the ceiling", () => {
    const p = seedProfile("Overnight", "UTC");
    const { itemId, doseId } = seedPrnMed(p, "Acetaminophen");
    for (const at of [
      "2026-09-02T16:00:00Z",
      "2026-09-02T20:00:00Z",
      "2026-09-02T23:45:00Z",
    ])
      logAdministration(itemId, doseId, "2026-09-02", at);
    for (const at of ["2026-09-03T03:00:00Z", "2026-09-03T08:00:00Z"])
      logAdministration(itemId, doseId, "2026-09-03", at);

    // The calendar-day count read 2; the label's window holds all five.
    expect(countFor(p, itemId)).toBe(5);
    expect(cardLine(p, itemId)).toBe("Max reached · 5 of 5 in 24h");
    // And the over-max care finding rides the same count: a sixth is over.
    logAdministration(itemId, doseId, "2026-09-03", "2026-09-03T09:00:00Z");
    expect(
      getPrnOverMaxItems(p, utcMinute(new Date())).map((o) => o.id)
    ).toContain(itemId);
  });

  it("a dose that has aged out of the window stops counting", () => {
    const p = seedProfile("AgedOut", "UTC");
    const { itemId, doseId } = seedPrnMed(p, "Acetaminophen");
    // 09:15 on the 2nd is 24h01m before now; 09:17 is inside by a minute.
    logAdministration(itemId, doseId, "2026-09-02", "2026-09-02T09:15:00Z");
    logAdministration(itemId, doseId, "2026-09-02", "2026-09-02T09:17:00Z");
    expect(countFor(p, itemId)).toBe(1);
  });

  it("the window is the SUBJECT's, and one profile's doses never reach another's", () => {
    // Two profiles whose local day is different at this instant: 05:16 on the 3rd in
    // New York, 23:16 on the 3rd in Kiritimati. Both hold a dose given 20 hours ago,
    // and each must see exactly its own.
    const ny = seedProfile("NewYork", "America/New_York");
    const kiri = seedProfile("Kiritimati", "Pacific/Kiritimati");
    expect(today(ny)).toBe("2026-09-03");
    expect(today(kiri)).toBe("2026-09-03");
    const a = seedPrnMed(ny, "Ibuprofen");
    const b = seedPrnMed(kiri, "Ibuprofen");
    logAdministration(a.itemId, a.doseId, "2026-09-02", "2026-09-02T13:16:00Z");
    logAdministration(b.itemId, b.doseId, "2026-09-02", "2026-09-02T13:16:00Z");
    logAdministration(b.itemId, b.doseId, "2026-09-03", "2026-09-03T08:00:00Z");

    expect(countFor(ny, a.itemId)).toBe(1);
    expect(countFor(kiri, b.itemId)).toBe(2);
  });
});

// ── A ROW THAT STATES NO ADMINISTRATION INSTANT ──────────────────────────────
//
// The count still has to place it, and profile-local NOON of its own `date` is the
// honest midpoint of a day nobody timed. These cases pin BOTH sides of that anchor,
// because the anchor is the part a green suite can be blind to: an untimed row dated
// TODAY has to count even before local noon (that is the regression the anchor's
// bounded form produced), and one dated YESTERDAY has to drop out once local noon
// passes.
describe("an untimed administration is anchored at local noon of its own day", () => {
  // 09:16 UTC is BEFORE local noon in UTC and AFTER it in Kiritimati (23:16) — one
  // instant, both sides of the anchor, which is what makes this a discriminating pair
  // rather than two spellings of one case.
  it.each([
    // tz, row date, expected count
    ["UTC", "2026-09-03", 1], // today, before local noon → in
    ["UTC", "2026-09-02", 1], // yesterday, local noon is 21h ago → in
    ["Pacific/Kiritimati", "2026-09-03", 1], // today (local), noon 11h ago → in
    ["Pacific/Kiritimati", "2026-09-02", 0], // yesterday (local), noon 35h ago → out
  ] as const)("%s, dated %s → %i", (tz, date, expected) => {
    const p = seedProfile(`Untimed-${tz}-${date}`, tz);
    const { itemId, doseId } = seedPrnMed(p, "Acetaminophen");
    logAdministration(itemId, doseId, date, null);
    expect(countFor(p, itemId)).toBe(expected);
  });

  it("counts beside timed rows, and the interval clock is untouched by the anchor", () => {
    const p = seedProfile("UntimedMixed", "UTC");
    const { itemId, doseId } = seedPrnMed(p, "Acetaminophen", {
      minInterval: 6,
    });
    // One placed dose an hour ago, one check-off for yesterday that states no minute.
    logAdministration(itemId, doseId, "2026-09-03", "2026-09-03T08:16:00Z");
    logAdministration(itemId, doseId, "2026-09-02", null);
    expect(countFor(p, itemId)).toBe(2);
    // The interval is a DURATION and reads the placed dose, never the noon anchor:
    // an hour after a real dose the window is shut, and it says so.
    const status = prnQuickLogRedoseStatus(
      {
        minIntervalHours: 6,
        maxDailyCount: 5,
        familyCount: 2,
        familyLastGivenAt: "2026-09-03T08:16:00Z",
        familyMaxDailyCount: 5,
      },
      new Date(NOW_ISO)
    )!;
    expect(status.open).toBe(false);
    expect(redoseCardLabel(status)).toBe("Next dose in ~5h · 2 of 5 in 24h");
  });
});
