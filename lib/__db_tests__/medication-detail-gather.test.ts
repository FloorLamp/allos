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
  getIntakeAdherenceEvidence,
  getMedicationCourses,
} from "@/lib/queries";
import { getTimezone } from "@/lib/settings";
import { effectiveSituationResolver } from "@/lib/queries/derived-situations";
import { medicationStartDate } from "@/lib/profile-summary";
import { lastNDates, shiftDateStr } from "@/lib/date";
import {
  indexTakenByDose,
  intakeAdherenceStrip,
  stripWithoutTrailingPending,
} from "@/lib/intake-adherence";
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
// board data. Kept in the test so the consolidation is pinned against the behaviour it
// replaced rather than against itself.
//
// ONE of those six reads has moved since, and it had to move here too (#3988): the
// strip's evidence now comes from `getIntakeAdherenceEvidence`, because the LIFETIME
// half of the question it answers is not a windowed one. Leaving the old
// `getIntakeLogsInRange` here would not have pinned the consolidation — it would have
// asserted that the strip disagrees with itself, and the fixture below is a live
// example of the divergence rather than a hypothetical: it logs an administration 18
// days back while the item row is created today, so at a 14-day window the four days
// before the earliest visible log used to score `na` — the app saying the medication
// owed nothing on days a course started 20 days ago and a taken row 18 days ago both
// prove it existed. That is asserted outright in the case below rather than left to
// ride inside an equality between two things that moved together.
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
  // The DUENESS resolver the page passes, not a declared-only reconstruction of it
  // (#3993): `med-data.ts` builds `effectiveSituationResolver` over the month window the
  // calendar draws, so a fixture on any other resolver would stop mirroring the gather
  // it claims to reproduce — and would agree with it only on profiles with no derived
  // context, which is a fixture asserting its own silence.
  const situationsOn = effectiveSituationResolver(profileId, {
    from: dates[0],
    to: dates[dates.length - 1],
  });
  const takenByDose = indexTakenByDose(
    getIntakeAdherenceEvidence(profileId, days)
  );
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
    medicationStartDate(courses, med.created_at, getTimezone(profileId))
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
    const narrow = getMedicationAdherenceCalendar(profileId, data, itemId, 14);
    expect(narrow).toEqual(calendarTheOldWay(profileId, itemId, 14));
    // AND WHAT THE NARROW WINDOW SAYS ABOUT DAYS IT CANNOT SEE THE PROOF FOR (#3988).
    // The equality above is between two expressions that moved together, so on its own
    // it would have gone on passing whichever answer they agreed on. The day-13 dot is
    // the one the fixture's day-18 administration is the only evidence for: `na` there
    // is the app asserting the day owed nothing, on a course that started day-20.
    expect(
      narrow.weeks
        .flat()
        .find((d) => d?.date === shiftDateStr(today(profileId), -13))
    ).toEqual({ date: shiftDateStr(today(profileId), -13), state: "missed" });
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

  // Today, still pending (#2796). The fixture logs nothing for today, and the detail
  // page still offers "Mark taken" for it — but the calendar was rendering that cell
  // as a red "Missed" and counting it in the legend. This is the DB tier because the
  // claim is about what the real gather produces for a real medication on the real
  // profile-local today, not about a hand-built strip.
  it("marks today's unconfirmed dose pending, not missed", () => {
    const { profileId, itemId } = seedDetailFixture("Detail Gather Pending");
    const data = loadMedicationsData(profileId);
    const todayStr = today(profileId);

    const calendar = getMedicationAdherenceCalendar(profileId, data, itemId);
    const todayCell = calendar.weeks
      .flat()
      .find((cell) => cell.date === todayStr);

    expect(todayCell).toEqual({ date: todayStr, state: "pending" });
    expect(calendar.counts.pending).toBe(1);

    // And it is exactly the day the percentage refuses to score, so the legend and
    // the summary cannot disagree about which day is unsettled.
    const strip = data.byId.get(itemId)!.strip;
    const settled = stripWithoutTrailingPending(strip);
    expect(settled).toHaveLength(strip.length - 1);
    expect(strip[strip.length - 1].date).toBe(todayStr);
  });

  it("still counts a real earlier lapse as missed", () => {
    // The guard is for TODAY only. A medication with a genuine unlogged day inside its
    // course must keep showing it — a fix that quietly swallowed misses would be a
    // worse defect than the one it replaced.
    const { profileId, itemId } = seedDetailFixture("Detail Gather Lapse");
    const data = loadMedicationsData(profileId);
    const calendar = getMedicationAdherenceCalendar(profileId, data, itemId);

    // The fixture logs 5 of the ~20 days since the course started; the rest are real
    // misses, and only ONE day (today) is pending.
    expect(calendar.counts.missed).toBeGreaterThan(0);
    expect(calendar.counts.pending).toBe(1);
  });

  it("confirming today's dose settles the cell", () => {
    const { profileId, itemId } = seedDetailFixture("Detail Gather Confirm");
    const todayStr = today(profileId);
    const doseId = (
      db
        .prepare("SELECT id FROM intake_item_doses WHERE item_id = ?")
        .get(itemId) as { id: number }
    ).id;
    db.prepare(
      "INSERT INTO intake_item_logs (dose_id, date, status) VALUES (?, ?, 'taken')"
    ).run(doseId, todayStr);

    const calendar = getMedicationAdherenceCalendar(
      profileId,
      loadMedicationsData(profileId),
      itemId
    );
    const todayCell = calendar.weeks
      .flat()
      .find((cell) => cell.date === todayStr);

    expect(todayCell).toEqual({ date: todayStr, state: "taken" });
    expect(calendar.counts.pending).toBe(0);
  });
});
