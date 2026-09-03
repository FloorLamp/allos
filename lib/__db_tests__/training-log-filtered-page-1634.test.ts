// DB INTEGRATION TIER — the Log's layered filters over the WHOLE ledger (#1634,
// re-based on #4079's shared-substrate mount).
//
// #1634's defect was that the Log's filters ran in the client over the loaded pages
// only, so a match older than the fetched window reported "no matches" while the row
// sat in `activities`. Its fix was two halves held in sync by a written superset
// contract: SQL picked the DAYS, a pure predicate picked the CARDS.
//
// #4079 retired the private feed for the shared history substrate, which owns the
// window. What is left is ONE question — which of this profile's activities do the
// layered filters admit — so there is one SQL answer, no second predicate, and no
// contract to keep. These pin the answer:
//   • DEPTH IS IRRELEVANT — a match forty days down is admitted like any other; the
//     bound belongs to the substrate, not to the filter.
//   • FREE TEXT REACHES THREE PLACES — title, exercise-set names, component names.
//   • DERIVED FILTERS ARE FINITE PREIMAGES — the muscle/region tag
//     (regionForExercise) and the fault filter (storedActivityFault) are pure
//     TypeScript, so they resolve to IN-lists over the profile's OWN data.
//   • AN EMPTY PREIMAGE ADMITS NOTHING, never everything — the two are different
//     shapes, not a predicate over one shape.
//   • NO FILTER IS `null`, NOT AN EMPTY SET — "unfiltered" and "nothing matches" are
//     rendered differently and must be distinguishable at the source.
//   • PROFILE SCOPING — another profile's matching rows never enter the answer.
//
// Runs against a throwaway DB redirected by lib/__db_tests__/setup.ts.

import { describe, it, expect, beforeAll } from "vitest";
import {
  getTrainingLogMatchingActivityIds,
  resolveTrainingLogFilterSpec,
  getActivityFaults,
  getTrainingLogSourceKeys,
  getTrainingLogTagExercises,
} from "@/lib/queries";
import {
  NO_TRAINING_LOG_QUERY,
  type TrainingLogQuery,
} from "@/lib/training-log-format";
import { shiftDateStr } from "@/lib/date";
import { db } from "@/lib/db";

const query = (over: Partial<TrainingLogQuery>): TrainingLogQuery => ({
  ...NO_TRAINING_LOG_QUERY,
  ...over,
});

// The admitted ids for a query, as titles — the assertion reads as the thing a
// reader would see rather than as a set of row numbers.
function admittedTitles(
  profile: number,
  over: Partial<TrainingLogQuery>
): string[] {
  const ids = getTrainingLogMatchingActivityIds(
    profile,
    resolveTrainingLogFilterSpec(profile, query(over))
  );
  if (ids == null) return ["<no filter>"];
  return [...ids]
    .map(
      (id) =>
        (
          db.prepare("SELECT title FROM activities WHERE id = ?").get(id) as {
            title: string;
          }
        ).title
    )
    .sort();
}

function newProfile(name: string): number {
  return Number(
    db.prepare("INSERT INTO profiles (name) VALUES (?)").run(name)
      .lastInsertRowid
  );
}

function addActivity(
  profileId: number,
  opts: {
    date: string;
    title: string;
    type?: string;
    source?: string | null;
    components?: string | null;
    durationMin?: number | null;
  }
): number {
  return Number(
    db
      .prepare(
        `INSERT INTO activities
           (profile_id, date, type, title, duration_min, components, source)
         VALUES (?, ?, ?, ?, ?, ?, ?)`
      )
      .run(
        profileId,
        opts.date,
        opts.type ?? "cardio",
        opts.title,
        opts.durationMin === undefined ? 30 : opts.durationMin,
        opts.components ?? null,
        opts.source ?? null
      ).lastInsertRowid
  );
}

function addSet(
  activityId: number,
  exercise: string,
  over: { weightKg?: number | null; reps?: number | null; n?: number } = {}
): void {
  db.prepare(
    `INSERT INTO exercise_sets
       (activity_id, exercise, set_number, weight_kg, reps, warmup)
     VALUES (?, ?, ?, ?, ?, 0)`
  ).run(
    activityId,
    exercise,
    over.n ?? 1,
    over.weightKg === undefined ? 60 : over.weightKg,
    over.reps === undefined ? 5 : over.reps
  );
}

const TODAY = "2026-07-12";
// Deep enough that the target sits well past the first TWO pages of the unfiltered
// feed (TRAINING_LOG_PAGE_DAYS = 14 per page).
const DEEP_OFFSET = 40;
const DEEP_DATE = shiftDateStr(TODAY, -DEEP_OFFSET);

let profileId: number;
let otherProfile: number;
let deepActivityId: number;

beforeAll(() => {
  profileId = newProfile("training-log-filter");
  otherProfile = newProfile("training-log-filter-other");

  // 60 consecutive days of ordinary sessions, so the newest window is nowhere near
  // the interesting rows below.
  for (let d = 0; d < 60; d++) {
    addActivity(profileId, {
      date: shiftDateStr(TODAY, -d),
      title: `Filler session ${d}`,
      components: JSON.stringify([
        { name: "Walking", type: "cardio", distance_km: 2, duration_min: 30 },
      ]),
    });
  }

  // THE deep match: an activity 40 days back whose title nothing else shares.
  deepActivityId = addActivity(profileId, {
    date: DEEP_DATE,
    title: "Kayaking on Reserved Lake",
    type: "sport",
    components: JSON.stringify([
      { name: "Kayaking", type: "sport", distance_km: 6, duration_min: 75 },
    ]),
  });

  // A deep STRENGTH session, for the region-tag preimage — the exercise name is
  // free text the catalog knows only through liftInfo's contains-fallback.
  const legDay = addActivity(profileId, {
    date: shiftDateStr(TODAY, -35),
    title: "Leg day",
    type: "strength",
    components: JSON.stringify([{ name: "Back Squat", type: "strength" }]),
  });
  addSet(legDay, "Back Squat", { weightKg: 100, reps: 5 });

  // A deep IMPORTED row and a deep MANUAL row on the SAME day, so the source
  // filter has to tell two same-day rows apart rather than two days.
  const mixedDay = shiftDateStr(TODAY, -30);
  addActivity(profileId, {
    date: mixedDay,
    title: "Tempo effort",
    source: "strava",
  });
  addActivity(profileId, { date: mixedDay, title: "Tempo cooldown" });
  // A document-extracted row: its raw source is unique per document, but it must
  // collapse into ONE "document" option.
  addActivity(profileId, {
    date: shiftDateStr(TODAY, -31),
    title: "Clinic treadmill test",
    source: "document:77",
  });

  // A deep FAULTY row: a strength session with components listing a part that has
  // a half-filled set (weight, no reps) — the editor can't re-save it.
  const faulty = addActivity(profileId, {
    date: shiftDateStr(TODAY, -45),
    title: "Legacy import",
    type: "strength",
    components: JSON.stringify([{ name: "Back Squat", type: "strength" }]),
  });
  addSet(faulty, "Back Squat", { weightKg: 80, reps: null });

  // Another profile's rows must never enter this profile's filtered pages.
  addActivity(otherProfile, {
    date: DEEP_DATE,
    title: "Kayaking on Reserved Lake",
    type: "sport",
  });
});

describe("the layered filters, over the whole ledger (#1634/#4079)", () => {
  // ONE TABLE, because these cases differ only in the query and the titles it must
  // admit. Depth is not a column: EVERY row below sits 30–45 days back, past two of
  // the retired pager's windows, which is exactly what #1634's defect could not reach.
  it.each([
    // Free text: title only, component name only, exercise-set name only.
    [{ q: "kayak" }, ["Kayaking on Reserved Lake"]],
    [{ q: "kayaking" }, ["Kayaking on Reserved Lake"]],
    [{ q: "back squat" }, ["Leg day", "Legacy import"]],
    // A LIKE wildcard is a literal character, not a pattern.
    [{ q: "%" }, []],
    // Type, across the whole ledger.
    [{ type: "sport" as const }, ["Kayaking on Reserved Lake"]],
    // Provenance: two rows on ONE day, told apart by source.
    [{ source: "strava" }, ["Tempo effort"]],
    // Every document-extracted row collapses into ONE option's selection.
    [{ source: "document" }, ["Clinic treadmill test"]],
    // A finite preimage over the names this profile actually logged.
    [
      { tag: { kind: "region" as const, value: "Legs" } },
      ["Leg day", "Legacy import"],
    ],
    // An empty preimage admits NOTHING — not everything.
    [{ tag: { kind: "muscle" as const, value: "Gills" } }, []],
    // The fault preimage: ids, because storedActivityFault is not SQL.
    [{ fault: true }, ["Legacy import"]],
    // Filters AND: a type that excludes the text match yields nothing.
    [{ q: "kayak", type: "strength" as const }, []],
  ])("admits exactly the right rows for %o", (over, expected) => {
    expect(admittedTitles(profileId, over)).toEqual(expected);
  });

  it("returns null — not an empty set — when nothing is filtered", () => {
    // The two shapes are what the mount renders as "your whole log" versus "nothing
    // matches these filters", so they must be distinguishable at the source.
    expect(
      getTrainingLogMatchingActivityIds(
        profileId,
        resolveTrainingLogFilterSpec(profileId, NO_TRAINING_LOG_QUERY)
      )
    ).toBeNull();
  });

  it("never admits another profile's matching row", () => {
    // The other profile owns a row with the SAME title on the SAME day.
    const mine = getTrainingLogMatchingActivityIds(
      profileId,
      resolveTrainingLogFilterSpec(profileId, query({ q: "kayak" }))
    )!;
    expect(mine.size).toBe(1);
    expect(mine.has(deepActivityId)).toBe(true);
    const theirs = getTrainingLogMatchingActivityIds(
      otherProfile,
      resolveTrainingLogFilterSpec(otherProfile, query({ q: "kayak" }))
    )!;
    expect([...theirs]).not.toContain(deepActivityId);
  });

  it("resolves the region preimage from logged names, not from the catalog", () => {
    // regionForExercise has a contains-fallback over free text, so the preimage is
    // evaluated in JS over the names the profile ACTUALLY logged.
    const names = getTrainingLogTagExercises(profileId, {
      kind: "region",
      value: "Legs",
    });
    expect(names).toContain("back squat");
    expect(names).not.toContain("walking");
  });

  it("offers exactly one source option per provider", () => {
    expect(getTrainingLogSourceKeys(profileId)).toEqual([
      "manual",
      "document",
      "strava",
    ]);
  });

  it("counts exactly one row the editor cannot re-save", () => {
    expect(getActivityFaults(profileId).count).toBe(1);
  });
});
