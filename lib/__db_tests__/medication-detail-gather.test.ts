// DB INTEGRATION TIER — the /medications/[id] detail gather (#2114).
//
// The detail page runs the full board gather (loadMedicationsData) and then the month
// adherence calendar. The calendar used to re-run six reads the board had just done —
// the medication rows, their doses, the activity-date set, the active situations and
// their event log, and the course list — which is the #2060 shape verbatim: two
// functions on one page each re-running the same gather.
//
// The bar for a read-path consolidation is that BEHAVIOUR IS UNCHANGED, so this file
// pins both halves: the calendar's OUTPUT still equals the one the independent gather
// produced (reconstructed inline from the very same query functions), and the shared
// reads are now issued once instead of twice.
//
// Fixtures are 100% synthetic (a throwaway per-file DB via setup.ts). No AI, no network.

import { describe, it, expect, afterEach, vi } from "vitest";
import { db, today } from "@/lib/db";
import {
  loadMedicationsData,
  getMedicationAdherenceCalendar,
  ADHERENCE_MONTH_DAYS,
} from "@/app/(app)/medications/med-data";
import {
  getMedications,
  getIntakeDoses,
  getActivityDates,
  getIntakeLogsInRange,
  getMedicationCourses,
} from "@/lib/queries";
import {
  getActiveSituations,
  getSituationEvents,
  getTimezone,
} from "@/lib/settings";
import { situationHistoryResolver } from "@/lib/trend-annotations";
import { medicationStartDate } from "@/lib/profile-summary";
import { lastNDates, shiftDateStr } from "@/lib/date";
import { indexTakenByDose, intakeAdherenceStrip } from "@/lib/intake-adherence";
import { buildAdherenceCalendar } from "@/lib/adherence-calendar";

// Statement counting (the #885 shape, as tick-scoped-gathers.test.ts uses it): the
// query layer prepares its SQL inline on every call, so counting prepares of a
// signature counts evaluations of the read that owns it. One spy for every signature —
// vi.spyOn returns the SAME spy for an already-spied method, so two independent spies
// would leave the second calling through to itself.
function countPrepareSet(...signatures: RegExp[]): { calls: () => number }[] {
  const counts = signatures.map(() => 0);
  const real = db.prepare.bind(db);
  vi.spyOn(db, "prepare").mockImplementation(((sql: string) => {
    signatures.forEach((s, i) => {
      if (s.test(sql)) counts[i]++;
    });
    return real(sql);
  }) as typeof db.prepare);
  return signatures.map((_, i) => ({ calls: () => counts[i] }));
}

afterEach(() => {
  vi.restoreAllMocks();
});

function makeProfile(name: string): number {
  const id = Number(
    db.prepare("INSERT INTO profiles (name) VALUES (?)").run(name)
      .lastInsertRowid
  );
  db.prepare(
    "INSERT INTO profile_settings (profile_id, key, value) VALUES (?, 'timezone', 'UTC')"
  ).run(id);
  return id;
}

// A daily scheduled (non-PRN) medication with one 'any'-time dose.
function addScheduledMed(
  profileId: number,
  name: string
): { itemId: number; doseId: number } {
  const itemId = Number(
    db
      .prepare(
        `INSERT INTO intake_items
           (profile_id, name, active, kind, condition, obligation)
         VALUES (?, ?, 1, 'medication', 'daily', 'must')`
      )
      .run(profileId, name).lastInsertRowid
  );
  const doseId = Number(
    db
      .prepare(
        `INSERT INTO intake_item_doses (item_id, amount, time_of_day, food_timing, sort)
         VALUES (?, '1 tablet', 'any', 'any', 0)`
      )
      .run(itemId).lastInsertRowid
  );
  return { itemId, doseId };
}

// A profile whose calendar window carries every input the strip consults: a course
// start inside the window, taken/skipped logs on several days, a logged workout day,
// and a situation the med is not keyed to (so the resolver is exercised without
// changing dueness).
function seedDetailFixture(name: string): {
  profileId: number;
  itemId: number;
} {
  const profileId = makeProfile(name);
  const { itemId, doseId } = addScheduledMed(profileId, "Detail Med");
  const todayStr = today(profileId);
  db.prepare(
    `INSERT INTO medication_courses (item_id, started_on, notes)
     VALUES (?, ?, 'start of therapy')`
  ).run(itemId, shiftDateStr(todayStr, -20));
  for (const [offset, status] of [
    [-1, "taken"],
    [-2, "taken"],
    [-3, "skipped"],
    [-9, "taken"],
    [-18, "taken"],
  ] as const) {
    db.prepare(
      "INSERT INTO intake_item_logs (dose_id, date, status) VALUES (?, ?, ?)"
    ).run(doseId, shiftDateStr(todayStr, offset), status);
  }
  db.prepare(
    `INSERT INTO activities (profile_id, date, type, title)
     VALUES (?, ?, 'cardio', 'Run')`
  ).run(profileId, shiftDateStr(todayStr, -4));
  db.prepare(
    "INSERT INTO profile_settings (profile_id, key, value) VALUES (?, 'situation_events', ?)"
  ).run(
    profileId,
    JSON.stringify([
      {
        date: shiftDateStr(todayStr, -10),
        situation: "Travel",
        change: "start",
      },
      { date: shiftDateStr(todayStr, -6), situation: "Travel", change: "stop" },
    ])
  );
  return { profileId, itemId };
}

// The calendar exactly as it was gathered before #2114 — six independent reads, no
// board data. Kept verbatim in the test so the consolidation is pinned against the
// behaviour it replaced rather than against itself.
function calendarTheOldWay(
  profileId: number,
  itemId: number,
  days: number = ADHERENCE_MONTH_DAYS
) {
  const med = getMedications(profileId).find((item) => item.id === itemId);
  if (!med) return buildAdherenceCalendar([]);
  const medDoses = getIntakeDoses(profileId).filter(
    (d) => d.item_id === itemId
  );
  const dates = lastNDates(today(profileId), days);
  const workoutDays = new Set(getActivityDates(profileId));
  const situationsOn = situationHistoryResolver(
    new Set(getActiveSituations(profileId)),
    getSituationEvents(profileId)
  );
  const takenByDose = indexTakenByDose(getIntakeLogsInRange(profileId, days));
  const strip = intakeAdherenceStrip(
    med,
    medDoses,
    dates,
    workoutDays,
    situationsOn,
    takenByDose,
    getTimezone(profileId)
  );
  const courses = getMedicationCourses(profileId).filter(
    (course) => course.item_id === itemId
  );
  return buildAdherenceCalendar(
    strip,
    medicationStartDate(courses, med.created_at)
  );
}

describe("getMedicationAdherenceCalendar reads the board gather (#2114)", () => {
  it("produces the calendar the independent gather produced", () => {
    const { profileId, itemId } = seedDetailFixture("Detail Gather Sam");
    const data = loadMedicationsData(profileId);

    const after = getMedicationAdherenceCalendar(profileId, data, itemId);
    expect(after).toEqual(calendarTheOldWay(profileId, itemId));
    // The fixture is real: a five-week grid whose window carries scored days.
    expect(after.weeks.length).toBeGreaterThan(0);
    expect(
      after.weeks.flat().filter((d) => d && d.state === "taken").length
    ).toBeGreaterThan(0);
  });

  it("honours a non-default window the same way", () => {
    const { profileId, itemId } = seedDetailFixture("Detail Gather Riley");
    const data = loadMedicationsData(profileId);
    expect(getMedicationAdherenceCalendar(profileId, data, itemId, 14)).toEqual(
      calendarTheOldWay(profileId, itemId, 14)
    );
  });

  it("returns an empty grid for an unknown or foreign medication id", () => {
    const { profileId } = seedDetailFixture("Detail Gather Ash");
    const other = seedDetailFixture("Detail Gather Other");
    const data = loadMedicationsData(profileId);
    const empty = buildAdherenceCalendar([]);
    expect(getMedicationAdherenceCalendar(profileId, data, 999999)).toEqual(
      empty
    );
    // Another profile's medication id resolves to nothing on THIS board — the same
    // refusal the getMedications(profileId) lookup gave before.
    expect(
      getMedicationAdherenceCalendar(profileId, data, other.itemId)
    ).toEqual(empty);
  });

  it("re-reads nothing the board gather already read", () => {
    const { profileId, itemId } = seedDetailFixture("Detail Gather Count");
    const data = loadMedicationsData(profileId);

    const [items, doses, activityDates, courses, logs] = countPrepareSet(
      /FROM intake_items\s+LEFT JOIN situations/,
      /FROM intake_item_doses\s+JOIN intake_items/,
      /SELECT DISTINCT date FROM activities/,
      /FROM medication_courses/,
      /FROM intake_item_logs l\s+JOIN intake_item_doses d/
    );
    getMedicationAdherenceCalendar(profileId, data, itemId);

    expect(items.calls()).toBe(0);
    expect(doses.calls()).toBe(0);
    expect(activityDates.calls()).toBe(0);
    expect(courses.calls()).toBe(0);
    // The ONE read that is genuinely the calendar's own: the board scores 14 days,
    // the month grid scores 35, so this window is not the board's to widen.
    expect(logs.calls()).toBe(1);
  });
});
