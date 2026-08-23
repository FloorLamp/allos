// DB INTEGRATION TIER — issue #3572: which CALENDAR the dormant-PRN threshold counts in.
//
// The dormant-PRN sweep (#880 item 3) flags an active PRN med with no dose in 90+ days.
// When the med has never been dosed the anchor is its CREATION, and the gather derived
// that anchor with `intake_items.created_at.slice(0, 10)` — the first ten characters of a
// stored UTC instant, which is the UTC calendar day. It was then differenced against
// `todayStr`, which is `today(profileId)` and therefore PROFILE-LOCAL. Two calendars met
// in one subtraction, so the 90-day line landed a day early or a day late for any profile
// whose local date differs from UTC at the moment of the read.
//
// This is NOT the display half of the same defect (#3546/#3573). Nothing here is
// rendered: the truncation is arithmetic, and its output is the app's VERDICT about
// whether a medication is dormant. So the fixture asserts the verdict, not a label.
//
// EVERY FIXTURE STRADDLES, and that is the design rather than thoroughness. An instant at
// midday agrees in every zone within eleven hours of UTC, so a midday fixture is green
// under the bug and green under the fix — it is the entire defect class, tested away.
// Each med below is created at an instant whose UTC day and profile-local day DIFFER by
// exactly one, positioned so that one day of difference is the whole verdict.
//
// BOTH DIRECTIONS, as separate tests, because they are not the same failure. East of UTC
// the truncation reads a med as OLDER than it is and flags a med that is not dormant yet;
// west of UTC it reads one as YOUNGER and hides a med that is. A fix reaching for a fixed
// sign would pass one and fail the other.
//
// The clock is frozen through the lib/clock.ts seam so the two extreme zones' "today" is
// a fact of the fixture rather than of the hour CI happened to start. 11:30 UTC is the
// one hour of the day that straddles for Etc/GMT+12 and Etc/GMT-13 at once — the same
// instant lib/__tests__/trash.test.ts reads as three different days.
//
// Fixtures are synthetic throwaway rows (per-file temp DB via setup.ts). No PHI.

import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { db, today } from "@/lib/db";
import { setTimezone } from "@/lib/settings";
import { dateFromCreatedAt } from "@/lib/timeline-format";
import { DEFAULT_DORMANT_DAYS } from "@/lib/dormant-prn";
import { loadMedicationsData } from "@/app/(app)/medications/med-data";

// 00:30 on Aug 5 at UTC+13, and 23:30 on Aug 3 at UTC-12: one instant, three days.
const FROZEN_NOW = "2026-08-04T11:30:00.000Z";

// Fixed-offset zones, so the fixture is never also asserting a DST rule.
const EAST = "Etc/GMT-13"; // UTC+13
const WEST = "Etc/GMT+12"; // UTC-12

let priorNow: string | undefined;

beforeEach(() => {
  priorNow = process.env.ALLOS_TEST_NOW;
  process.env.ALLOS_TEST_NOW = FROZEN_NOW;
});

afterEach(() => {
  if (priorNow == null) delete process.env.ALLOS_TEST_NOW;
  else process.env.ALLOS_TEST_NOW = priorNow;
});

function newProfile(name: string, tz: string): number {
  const id = Number(
    db.prepare("INSERT INTO profiles (name) VALUES (?)").run(name)
      .lastInsertRowid
  );
  setTimezone(id, tz);
  return id;
}

// An active, never-dosed PRN medication stamped with an explicit creation instant.
// `obligation = 'may'` is what makes it as-needed (isOnDemand), and never-dosed is what
// puts the creation stamp in the anchor seat.
function seedNeverDosedPrn(
  profileId: number,
  name: string,
  createdAtUtc: string
): number {
  return Number(
    db
      .prepare(
        `INSERT INTO intake_items
           (profile_id, name, active, kind, condition, obligation, created_at)
         VALUES (?, ?, 1, 'medication', 'daily', 'may', ?)`
      )
      .run(profileId, name, createdAtUtc).lastInsertRowid
  );
}

function isFlaggedDormant(profileId: number, itemId: number): boolean {
  return loadMedicationsData(profileId).dormantPrn.some(
    (d) => d.itemId === itemId
  );
}

describe("dormant-PRN threshold counts in the PROFILE'S calendar (#3572)", () => {
  it("the threshold it is measuring against is 90 days", () => {
    // The two fixtures below sit at 89 and 90 local days, so the constant is load-bearing
    // for both verdicts rather than incidental to them.
    expect(DEFAULT_DORMANT_DAYS).toBe(90);
  });

  // EAST OF UTC — the truncation reads the med as OLDER than it is.
  //
  // 11:30 local on May 8 at UTC+13 is 22:30 UTC on May 7. The profile's today is Aug 5,
  // so the med is 89 local days old: one day short of the sweep. The UTC day is May 7,
  // which is 90 days back, so the truncation crossed the line and offered to retire a
  // medication the person last acquired inside the window.
  it("does NOT flag a med 89 PROFILE-LOCAL days old, though its UTC day is 90 back", () => {
    const p = newProfile("EastPrn", EAST);
    const createdAt = "2026-05-07 22:30:00";
    const itemId = seedNeverDosedPrn(p, "Loratadine", createdAt);

    expect(today(p)).toBe("2026-08-05");
    expect(dateFromCreatedAt(createdAt, EAST)).toBe("2026-05-08"); // 89 days
    // What shipped: the first ten characters of the same stamp.
    expect(createdAt.slice(0, 10)).toBe("2026-05-07"); // 90 days

    expect(isFlaggedDormant(p, itemId)).toBe(false);
  });

  // WEST OF UTC — the truncation reads the med as YOUNGER than it is.
  //
  // 18:00 local on May 5 at UTC-12 is 06:00 UTC on May 6. The profile's today is Aug 3,
  // so the med is 90 local days old and the sweep is exactly what should offer it. The
  // UTC day is May 6, which is 89 days back, so the truncation held the offer back a day.
  it("DOES flag a med 90 PROFILE-LOCAL days old, though its UTC day is only 89 back", () => {
    const p = newProfile("WestPrn", WEST);
    const createdAt = "2026-05-06 06:00:00";
    const itemId = seedNeverDosedPrn(p, "Cetirizine", createdAt);

    expect(today(p)).toBe("2026-08-03");
    expect(dateFromCreatedAt(createdAt, WEST)).toBe("2026-05-05"); // 90 days
    expect(createdAt.slice(0, 10)).toBe("2026-05-06"); // 89 days

    const suggestion = loadMedicationsData(p).dormantPrn.find(
      (d) => d.itemId === itemId
    );
    expect(suggestion).toBeDefined();
    // The count the card prints is the local one too — the anchor is not merely used for
    // the yes/no, it IS the number.
    expect(suggestion?.daysSince).toBe(90);
    expect(suggestion?.lastUsed).toBeNull();
  });

  // HOW OLD SOMETHING IS DOES NOT DEPEND ON WHERE YOU STAND. Both ends of the
  // subtraction shift together when a profile's zone shifts, so one creation instant is
  // the SAME number of days ago for every profile on earth — and that invariance is
  // exactly what mixing calendars destroys. 11:30 UTC on May 6 is 90 local days before
  // each profile's own today, in both zones. The truncation pinned one end to the UTC day
  // and left the other local, so it answered 91 for the east profile and 89 for the west
  // one — dropping the west profile's med out of the sweep entirely — off a single
  // stored stamp that describes one moment.
  it("gives one creation instant the same age in both zones", () => {
    const createdAt = "2026-05-06 11:30:00";
    const east = newProfile("EastSame", EAST);
    const west = newProfile("WestSame", WEST);
    const eastItem = seedNeverDosedPrn(east, "Ibuprofen", createdAt);
    const westItem = seedNeverDosedPrn(west, "Ibuprofen", createdAt);

    expect(dateFromCreatedAt(createdAt, EAST)).toBe("2026-05-07");
    expect(dateFromCreatedAt(createdAt, WEST)).toBe("2026-05-05");
    // The one day a slice can answer with sits between them and is neither profile's.
    expect(createdAt.slice(0, 10)).toBe("2026-05-06");

    const ageOf = (profileId: number, itemId: number) =>
      loadMedicationsData(profileId).dormantPrn.find((d) => d.itemId === itemId)
        ?.daysSince ?? null;
    expect(ageOf(east, eastItem)).toBe(90);
    expect(ageOf(west, westItem)).toBe(90);
  });

  // A med with a LOGGED dose is anchored on `intake_item_logs.date`, which is already a
  // profile-local day (it is written from `today(profileId)`). Nothing about this fix may
  // change that half — the same creation instant that reads 89 days back must stay out of
  // the way once a dose exists.
  it("still measures from the administration day when one exists", () => {
    const p = newProfile("EastDosed", EAST);
    const itemId = seedNeverDosedPrn(p, "Naproxen", "2020-01-01 12:00:00");
    const doseId = Number(
      db
        .prepare(
          `INSERT INTO intake_item_doses (item_id, amount, time_of_day, food_timing, sort)
           VALUES (?, '250 mg', 'anytime', 'any', 0)`
        )
        .run(itemId).lastInsertRowid
    );
    db.prepare(
      `INSERT INTO intake_item_logs (dose_id, item_id, date, status)
       VALUES (?, ?, ?, 'taken')`
    ).run(doseId, itemId, "2026-08-01");

    expect(isFlaggedDormant(p, itemId)).toBe(false);
  });
});
