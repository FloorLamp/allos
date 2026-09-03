// DB INTEGRATION TIER (#4891): `measurementsQuickEntry` (lib/quick-entry-measurements.ts)
// is the one reader that resolves the measurements quick-add form's props — the
// three age-based visibility gates (`showCompositionEntry`/`showGrowth`/
// `showHeadCirc`, keyed on age and, for head circumference, age-in-months from
// birthdate), the day's `defaultStatedAt`, and `maxDate` as the subject's own
// profile-local today. Nothing in the repo called it directly before this file:
// components/__tests__/history-add-door.test.tsx hand-writes a literal MEASUREMENTS
// mock object with fixed field values, so none of this function's own branches were
// ever exercised.

import { describe, it, expect, beforeAll, afterAll } from "vitest";
import { db, today } from "@/lib/db";
import { setTimezone } from "@/lib/settings";
import {
  setProfileBirthdate,
  setStoredAge,
} from "@/lib/settings/profile-attrs";
import { measurementsQuickEntry } from "@/lib/quick-entry-measurements";
import { HEAD_CIRC_ENTRY_MAX_AGE_MONTHS } from "@/lib/growth-metrics";
import { GROWTH_CHART_MAX_AGE } from "@/lib/life-stage";

function makeProfile(name: string): number {
  return Number(
    db.prepare("INSERT INTO profiles (name) VALUES (?)").run(name)
      .lastInsertRowid
  );
}

// `getManualBodyMetricStatedAt` reads only rows with a NULL `source` — a manual
// entry, as opposed to an offline-replayed or imported one — so the fixture has to
// say so explicitly rather than relying on a column default the schema might change.
function seedManualBodyMetric(
  profileId: number,
  date: string,
  occurredAt: string
) {
  db.prepare(
    `INSERT INTO body_metrics (profile_id, date, weight_kg, occurred_at, source)
     VALUES (?, ?, 70, ?, NULL)`
  ).run(profileId, date, occurredAt);
}

const DATE = "2026-06-15";
const LOGIN_ID = 1; // getUnitPrefs degrades to defaults for an unknown login; the
// unit prefs are not this file's subject.

describe("measurementsQuickEntry (#4891)", () => {
  // ── The two YEAR-keyed gates move together, on the SAME boundary ───────────
  // showCompositionEntry and showGrowth are each other's negation
  // (!isGrowthTracked / isGrowthTracked), so one profile per side of
  // GROWTH_CHART_MAX_AGE proves both at once.
  it.each([
    [
      GROWTH_CHART_MAX_AGE - 1,
      true,
      false,
      "growth-tracked (under the ceiling)",
    ],
    [GROWTH_CHART_MAX_AGE, false, true, "adult (at the ceiling)"],
  ] as const)(
    "age %i: %s, %s (%s)",
    (age, expectGrowth, expectComposition, _label) => {
      const profileId = makeProfile(`growth-boundary-${age}`);
      setStoredAge(profileId, age);
      const entry = measurementsQuickEntry(LOGIN_ID, profileId, DATE);
      expect(entry.showGrowth).toBe(expectGrowth);
      expect(entry.showCompositionEntry).toBe(expectComposition);
    }
  );

  // ── The head-circumference gate is MONTH-keyed off a real birthdate, and its
  // boundary is a different axis entirely from the two above — a growth-tracked
  // toddler and a growth-tracked ten-year-old both fail isGrowthTracked's negation
  // identically, so this needs its own fixture to move independently. Dates are
  // exact calendar months apart so the boundary is not a rounding accident.
  it.each([
    [
      "2023-07-15", // exactly 35 calendar months before DATE: just under the ceiling.
      true,
      "one month short of the ceiling",
    ],
    [
      "2023-06-15", // exactly HEAD_CIRC_ENTRY_MAX_AGE_MONTHS (36) calendar months before DATE.
      false,
      "exactly at the ceiling",
    ],
  ] as const)(
    "head circumference at birthdate %s (%s)",
    (birthdate, expected, _label) => {
      const profileId = makeProfile(`head-circ-${birthdate}`);
      setProfileBirthdate(profileId, birthdate);
      const entry = measurementsQuickEntry(LOGIN_ID, profileId, DATE);
      expect(entry.showHeadCirc).toBe(expected);
    }
  );

  it(`stays hidden past ${HEAD_CIRC_ENTRY_MAX_AGE_MONTHS} months regardless of the year-keyed gates`, () => {
    // A growth-tracked 10-year-old: showGrowth is true, but the head-circ window
    // closed at 3. Proves the two gates are genuinely independent rather than one
    // riding the other's boundary by coincidence.
    const profileId = makeProfile("head-circ-older-child");
    setProfileBirthdate(profileId, "2016-06-15"); // age 10 on DATE
    const entry = measurementsQuickEntry(LOGIN_ID, profileId, DATE);
    expect(entry.showGrowth).toBe(true);
    expect(entry.showHeadCirc).toBe(false);
  });

  // ── defaultStatedAt reflects the day's own manual row, or is null ───────────
  it("defaultStatedAt reflects an existing manual body-metrics row's stated time for the day", () => {
    const profileId = makeProfile("stated-at-present");
    const occurredAt = `${DATE}T07:15:00`;
    seedManualBodyMetric(profileId, DATE, occurredAt);
    const entry = measurementsQuickEntry(LOGIN_ID, profileId, DATE);
    expect(entry.defaultStatedAt).toBe(occurredAt);
  });

  it("defaultStatedAt is null when the day has no manual row", () => {
    const profileId = makeProfile("stated-at-absent");
    const entry = measurementsQuickEntry(LOGIN_ID, profileId, DATE);
    expect(entry.defaultStatedAt).toBeNull();
  });

  it("defaultStatedAt ignores a NON-manual row (a stamped source) for the same day", () => {
    const profileId = makeProfile("stated-at-non-manual");
    db.prepare(
      `INSERT INTO body_metrics (profile_id, date, weight_kg, occurred_at, source)
       VALUES (?, ?, 70, ?, 'offline-replay')`
    ).run(profileId, DATE, `${DATE}T07:15:00`);
    const entry = measurementsQuickEntry(LOGIN_ID, profileId, DATE);
    expect(entry.defaultStatedAt).toBeNull();
  });

  // ── maxDate is the SUBJECT's own local today, never the process wall clock ──
  // Two zones, straddling a day boundary from one frozen instant, so a maxDate
  // that silently fell back to the process clock (whatever zone this box runs in)
  // could only agree with ONE of the two profiles at most — the discriminating
  // shape #3573/#3836/#3901/#3884 exist to catch, per this repo's own dose-window
  // tests (past-dose-day.actions.test.ts).
  const NOW_ISO = "2026-08-28T10:30:00Z";
  let priorNow: string | undefined;
  beforeAll(() => {
    priorNow = process.env.ALLOS_TEST_NOW;
    process.env.ALLOS_TEST_NOW = NOW_ISO;
  });
  afterAll(() => {
    if (priorNow == null) delete process.env.ALLOS_TEST_NOW;
    else process.env.ALLOS_TEST_NOW = priorNow;
  });

  it.each([
    ["Pacific/Kiritimati", "2026-08-29"],
    ["Pacific/Midway", "2026-08-27"],
  ] as const)("maxDate is the profile-local today in %s", (tz, localToday) => {
    const profileId = makeProfile(`maxdate-${tz}`);
    setTimezone(profileId, tz);
    expect(today(profileId)).toBe(localToday);
    // No `date` argument: the function's own default is `today(profileId)`, so this
    // also proves the default resolves per-subject rather than to one shared value.
    const entry = measurementsQuickEntry(LOGIN_ID, profileId);
    expect(entry.maxDate).toBe(localToday);
    expect(entry.defaultDate).toBe(localToday);
  });
});
