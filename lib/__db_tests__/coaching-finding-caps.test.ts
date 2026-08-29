// DB INTEGRATION TIER — issue #3126: the per-family generation bounds.
//
// #3090's acceptance asked that each per-entity family "declares a generation
// bound, asserted by a test that a profile with a large library cannot produce an
// unbounded residual". #3095 declared the bounds (COACHING_ENTITY_FINDING_LIMITS,
// and food–drug variance's adjacent one) and applied them; the assertion half
// never landed for nine of the ten.
//
// The count is the cheaper half and it is not the half that matters. Every one of
// these caps sits AFTER an ordering, so the cap does not only decide how many
// findings a profile sees — it decides WHICH. A test that asserts only
// `toHaveLength(cap)` is green on a build that keeps the wrong rows: `.slice(-1)`
// truncates exactly as well as `.slice(0, 1)` and surfaces the opposite finding.
// So each row below over-supplies the family, states the survivors the ordering
// ahead of the slice is supposed to choose, and asserts the whole ordered list.
//
// The fixtures are deliberately built in an order that is NOT the expected
// survival order wherever the ordering is a real sort, so the identity half can
// fail on its own. Proven able to fail, each measured against a mutant of the
// production line it guards:
//   • every `.slice(0, N)` here rewritten `.slice(-N)`: 9 of 11 red. The two that
//     survive are the two that cannot see it — goalPacing bounds with a `break`
//     rather than a slice, and endurancePlan's bound is unreachable (below).
//   • prolongedBleedingObservations sorted oldest-first: both bleeding cases red.
//   • detectWeightAnomalies sorted oldest-first: bodyHygiene red.
//   • getOutcomeGoals ordered `created_at ASC`: goalPacing red — the one row the
//     slice mutant could not reach.
//   • the food–drug variance slice rewritten `.slice(-N)`: that case red.
//
// prolongedBleeding is the one of the ten with a medically-relevant signal behind
// it, and the only one capped to a single row, so it also gets the "which one"
// question asked directly below the table. It is the case where the count
// assertion is furthest from sufficient: under `.slice(-1)` the app surfaces a
// three-month-old bleed and withholds the current one, and every count in sight
// still reads 1.

import { describe, it, expect } from "vitest";
import { db, today } from "@/lib/db";
import { shiftDateStr } from "@/lib/date";
import { setWeekMode, setProfileBirthdate } from "@/lib/settings";
import {
  buildFoodDrugVarianceFindings,
  FOOD_DRUG_VARIANCE_FINDING_LIMIT,
} from "@/lib/food-drug-ledger-findings";
import {
  COACHING_ENTITY_FINDING_LIMITS,
  buildMedicationDuplicationFindings,
  buildBodyHygieneFindings,
  buildCycleBleedingFindings,
  buildGoalPacingFindings,
  buildAdherencePatternFindings,
  buildDemotionSuggestionFindings,
  buildTargetRightSizeFindings,
  buildTrainingObservationFindings,
  buildEndurancePlanFindings,
} from "@/lib/rule-findings";
import { cycleBleedingSignalKey } from "@/lib/cycle-observation";
import { weightAnomalySignalKey } from "@/lib/weight-anomaly";
import { PROLONGED_PERIOD_DAYS } from "@/lib/cycle";
import { practiceIdentity } from "@/lib/practice";

function makeProfile(name: string): { profileId: number; anchor: string } {
  const profileId = Number(
    db.prepare("INSERT INTO profiles (name) VALUES (?)").run(name)
      .lastInsertRowid
  );
  // Rolling weeks make the right-size history exact trailing 7-day blocks.
  setWeekMode(profileId, "rolling");
  return { profileId, anchor: today(profileId) };
}

// ---- Seeds. Each returns the family's members in the order the production
// ---- ordering AHEAD of the slice is documented to put them, longest first.

// Four ingredient families of two active members each. medicationFamilies is
// documented "family order follows first-member input order" over a `ORDER BY id`
// read, so the surviving families are the three whose first member was created
// first — an ordering with no relevance claim behind it (see the report on #3126).
function seedMedicationFamilies(profileId: number): string[] {
  const insert = db.prepare(
    `INSERT INTO intake_items (profile_id, name, active, kind, condition, obligation)
     VALUES (?, ?, 1, 'medication', 'daily', 'must')`
  );
  const generics = ["Amlodipine", "Bisoprolol", "Cetirizine", "Donepezil"];
  for (const generic of generics) {
    insert.run(profileId, `${generic} 5 mg`);
    insert.run(profileId, `${generic} 10 mg`);
  }
  return generics;
}

// Four isolated day-over-day weight jumps, seeded OLDEST first so insertion order
// is the reverse of the survival order. Each pair is >3 days from its neighbours,
// so the consecutive scan sees four independent jumps and no out-and-back.
function seedWeightJumps(profileId: number, anchor: string): string[] {
  const insert = db.prepare(
    `INSERT INTO body_metrics (profile_id, date, weight_kg) VALUES (?, ?, ?)`
  );
  const suspectIds: number[] = [];
  for (const daysAgo of [34, 24, 14, 4]) {
    insert.run(profileId, shiftDateStr(anchor, -(daysAgo + 1)), 80);
    suspectIds.push(
      Number(
        insert.run(profileId, shiftDateStr(anchor, -daysAgo), 92)
          .lastInsertRowid
      )
    );
  }
  // "Newest suspect first" (lib/weight-anomaly).
  return suspectIds.reverse().map(weightAnomalySignalKey);
}

// Three closed periods at or past PROLONGED_PERIOD_DAYS, inserted OLDEST first so
// the newest-first contract cannot be satisfied by row order.
function seedProlongedPeriods(profileId: number, anchor: string): string[] {
  const insert = db.prepare(
    `INSERT INTO cycles (profile_id, period_start, period_end) VALUES (?, ?, ?)`
  );
  const starts: string[] = [];
  for (const endedDaysAgo of [70, 40, 6]) {
    const end = shiftDateStr(anchor, -endedDaysAgo);
    const start = shiftDateStr(end, -(PROLONGED_PERIOD_DAYS + 1));
    insert.run(profileId, start, end);
    starts.push(start);
  }
  // A short period the family must stay silent about.
  insert.run(profileId, shiftDateStr(anchor, -20), shiftDateStr(anchor, -16));
  return starts.reverse().map(cycleBleedingSignalKey);
}

// Four live weight goals over one rising series, so all four read "trending away".
// getOutcomeGoals sorts live goals `created_at DESC`, so the three most recently
// created survive — created_at is written explicitly because the column's default
// would give all four the same second and leave the order undefined.
function seedOffPaceGoals(profileId: number, anchor: string): string[] {
  const insertWeight = db.prepare(
    `INSERT INTO body_metrics (profile_id, date, weight_kg) VALUES (?, ?, ?)`
  );
  for (let week = 12; week >= 0; week--) {
    insertWeight.run(
      profileId,
      shiftDateStr(anchor, -week * 7),
      90 + (12 - week) * 0.2
    );
  }
  const insertGoal = db.prepare(
    `INSERT INTO goals
       (profile_id, title, category, status, archived, body_metric,
        target_value, target_date, baseline_value, created_at)
     VALUES (?, ?, 'body', 'active', 0, 'weight', 84, ?, 90, ?)`
  );
  const titles: string[] = [];
  for (let age = 4; age >= 1; age--) {
    const title = `Cut to 84 (goal ${age})`;
    insertGoal.run(
      profileId,
      title,
      shiftDateStr(anchor, 60),
      `${shiftDateStr(anchor, -age)} 08:00:00`
    );
    titles.push(title);
  }
  return titles.reverse().map((t) => `“${t}” is off pace`);
}

// One daily supplement with one dose, created before every window that reads it.
function seedDailyItem(
  profileId: number,
  anchor: string,
  name: string
): { itemId: number; doseId: number } {
  const createdAt = `${shiftDateStr(anchor, -120)} 08:00:00`;
  const itemId = Number(
    db
      .prepare(
        `INSERT INTO intake_items
           (profile_id, name, active, kind, condition, obligation, qty_per_dose, created_at)
         VALUES (?, ?, 1, 'supplement', 'daily', 'should', 1, ?)`
      )
      .run(profileId, name, createdAt).lastInsertRowid
  );
  const doseId = Number(
    db
      .prepare(
        `INSERT INTO intake_item_doses
           (item_id, amount, time_of_day, food_timing, sort, created_at)
         VALUES (?, '1 unit', 'evening', 'any', 0, ?)`
      )
      .run(itemId, createdAt).lastInsertRowid
  );
  return { itemId, doseId };
}

// Four abandoned should-tier supplements: due daily for four months, never logged.
// detectDemotionCandidates is documented "deterministic (by name, then item id)",
// so the survivors are the three alphabetically first — seeded in reverse.
function seedDemotionCandidates(profileId: number, anchor: string): string[] {
  const names = ["Ashwagandha", "Berberine", "Creatine", "Dandelion"];
  for (const name of [...names].reverse())
    seedDailyItem(profileId, anchor, name);
  return names.map((name) => `${name}: move it to May?`);
}

// Four practice floors nobody has ever met (no sessions at all).
// detectRightSizeCandidates is documented "deterministic (by label, then target
// id)", so the survivors are the three alphabetically first — seeded in reverse.
function seedRightSizeTargets(profileId: number, anchor: string): string[] {
  const insert = db.prepare(
    `INSERT INTO frequency_targets
       (profile_id, scope_kind, scope_value, scope_identity, per_week, created_at)
     VALUES (?, 'practice', ?, ?, 4, ?)`
  );
  const labels = ["Breathwork", "Cold plunge", "Journaling", "Stretching"];
  for (const label of [...labels].reverse()) {
    insert.run(
      profileId,
      label,
      practiceIdentity(label),
      `${shiftDateStr(anchor, -200)} 08:00:00`
    );
  }
  return labels.map((label) => `${label}: right-size the weekly target?`);
}

// Four evening supplements taken every day except Fridays for eight weeks.
// detectAdherencePatterns is documented "deterministic (by item name, then dose
// id)", so the survivors are the three alphabetically first — seeded in reverse.
function seedWeekdayMisses(profileId: number, anchor: string): string[] {
  const names = ["Alpha lipoic", "Biotin", "Choline", "D3"];
  const logTaken = db.prepare(
    `INSERT INTO intake_item_logs (dose_id, item_id, date, status) VALUES (?, ?, ?, 'taken')`
  );
  for (const name of [...names].reverse()) {
    const { itemId, doseId } = seedDailyItem(profileId, anchor, name);
    for (let ago = 55; ago >= 0; ago--) {
      const date = shiftDateStr(anchor, -ago);
      const isFriday =
        new Date(Date.parse(`${date}T00:00:00Z`)).getUTCDay() === 5;
      if (!isFriday) logTaken.run(doseId, itemId, date);
    }
  }
  return names.map((name) => `${name}: Fridays slip`);
}

// Four lifts each flat at one load for six weeks. detectPlateaus is documented
// "Alphabetical for deterministic ordering across surfaces" — an ordering with no
// relevance claim behind it — so the survivors are the alphabetically first three.
// Seeded in reverse so alphabetical order is not insertion order.
function seedPlateaus(profileId: number, anchor: string): string[] {
  const insertActivity = db.prepare(
    `INSERT INTO activities (profile_id, date, type, title, duration_min)
     VALUES (?, ?, 'strength', 'Plateau session', 45)`
  );
  const insertSet = db.prepare(
    `INSERT INTO exercise_sets (activity_id, exercise, set_number, weight_kg, reps)
     VALUES (?, ?, 1, 60, 5)`
  );
  const lifts = [
    "Front Squat",
    "Landmine Press",
    "Pendlay Row",
    "Zercher Squat",
  ];
  for (const lift of [...lifts].reverse()) {
    for (const daysAgo of [35, 24, 13, 2]) {
      const activityId = Number(
        insertActivity.run(profileId, shiftDateStr(anchor, -daysAgo))
          .lastInsertRowid
      );
      insertSet.run(activityId, lift);
    }
  }
  return lifts.map((lift) => `${lift} has plateaued`);
}

interface CapCase {
  family: keyof typeof COACHING_ENTITY_FINDING_LIMITS;
  // Over-supply the family; return every member it generates, in the order the
  // production ordering ahead of the slice puts them.
  seed: (profileId: number, anchor: string) => string[];
  // The shipped builder's output, reduced to the same identity the seed names.
  built: (profileId: number, anchor: string) => string[];
}

const CASES: CapCase[] = [
  {
    family: "prolongedBleeding",
    seed: seedProlongedPeriods,
    built: (p, anchor) =>
      buildCycleBleedingFindings(p, anchor).map((f) => f.dedupeKey),
  },
  {
    family: "medicationDuplication",
    seed: seedMedicationFamilies,
    built: (p) =>
      buildMedicationDuplicationFindings(p).map(
        (f) => f.title.split(" appears in")[0]
      ),
  },
  {
    family: "bodyHygiene",
    seed: seedWeightJumps,
    built: (p, anchor) =>
      buildBodyHygieneFindings(p, anchor, "kg").map((f) => f.dedupeKey),
  },
  {
    family: "goalPacing",
    seed: seedOffPaceGoals,
    built: (p, anchor) =>
      buildGoalPacingFindings(p, anchor).map((f) => f.title),
  },
  {
    family: "adherencePattern",
    seed: seedWeekdayMisses,
    built: (p, anchor) =>
      buildAdherencePatternFindings(p, anchor).map((f) => f.title),
  },
  {
    family: "demotionSuggestion",
    seed: seedDemotionCandidates,
    built: (p, anchor) =>
      buildDemotionSuggestionFindings(p, anchor).map((f) => f.title),
  },
  {
    family: "targetRightSize",
    seed: seedRightSizeTargets,
    built: (p, anchor) =>
      buildTargetRightSizeFindings(p, anchor).map((f) => f.title),
  },
  {
    family: "trainingPlateau",
    seed: seedPlateaus,
    built: (p, anchor) =>
      buildTrainingObservationFindings(p, anchor)
        .filter((f) => f.domain === "training-plateau")
        .map((f) => f.title),
  },
];

describe("#3126 — every per-family generation bound is asserted", () => {
  it.each(CASES)(
    "$family: a large library truncates at the bound AND keeps the intended rows",
    ({ family, seed, built }) => {
      const { profileId, anchor } = makeProfile(`cap-${family}`);
      const cap = COACHING_ENTITY_FINDING_LIMITS[family];
      const generated = seed(profileId, anchor);

      // The fixture really over-supplies — otherwise the assertion below passes
      // vacuously on a build with no cap at all.
      expect(generated.length).toBeGreaterThan(cap);

      // Count AND identity AND order, in one comparison: a build that truncates
      // from the wrong end is red here and green under toHaveLength(cap).
      expect(built(profileId, anchor)).toEqual(generated.slice(0, cap));
    }
  );

  // The tenth family's cap is not on findings but on the NAMES inside one
  // collapsed finding's title, so it reads differently: past the bound the copy
  // stops counting and says "Several", and the three names it does print are the
  // three most recently lapsed (detectStaleExercises: "Newest-lapse first (most
  // recently trained → most likely still intended)").
  it("staleExerciseNames: a fifth lapsed lift renames the group and keeps the newest three", () => {
    const { profileId, anchor } = makeProfile("cap-staleExerciseNames");
    const insertActivity = db.prepare(
      `INSERT INTO activities (profile_id, date, type, title, duration_min)
       VALUES (?, ?, 'strength', 'Lapsed session', 45)`
    );
    const insertSet = db.prepare(
      `INSERT INTO exercise_sets (activity_id, exercise, set_number, weight_kg, reps)
       VALUES (?, ?, 1, 40, 8)`
    );
    // Four established lifts, each three sessions, each past the 21-day lapse
    // floor. Seeded OLDEST-lapse first so the printed order is not insertion order.
    const byLastTrained = [
      ["Hack Squat", 40],
      ["Pull Up", 34],
      ["Deadlift", 28],
      ["Chin Up", 23],
    ] as const;
    for (const [exercise, lastDay] of byLastTrained) {
      for (let session = 0; session < 3; session++) {
        const activityId = Number(
          insertActivity.run(
            profileId,
            shiftDateStr(anchor, -(lastDay + session * 7))
          ).lastInsertRowid
        );
        insertSet.run(activityId, exercise);
      }
    }

    const stale = buildTrainingObservationFindings(profileId, anchor).filter(
      (f) => f.domain === "training-stale"
    );
    expect(stale).toHaveLength(1);
    // Four lapsed, three named: "Several" rather than "4 lifts", and the three
    // names are the newest-lapse three in that order. Hack Squat, the oldest
    // lapse, is the one the bound drops.
    expect(stale[0].title).toBe(
      "Several lifts have lapsed — Chin Up, Deadlift, and Pull Up"
    );
  });

  // endurancePlan's bound of 3 cannot truncate: the schema allows at most three
  // ACTIVE plans per profile (idx_endurance_plans_active_discipline is unique on
  // (profile_id, discipline) for active rows, and discipline is CHECK-constrained
  // to run/ride/swim), and the builder reads only active plans. The bound is real
  // as a declaration and unreachable as a behaviour — recorded here rather than
  // proved with a fixture that cannot exist.
  it("endurancePlan: the schema bounds the family below the declared cap", () => {
    const { profileId, anchor } = makeProfile("cap-endurancePlan");
    const insert = db.prepare(
      `INSERT INTO endurance_plans
         (profile_id, event_name, discipline, event_date, target_distance_km, status)
       VALUES (?, ?, ?, ?, 21, 'active')`
    );
    for (const discipline of ["run", "ride", "swim"]) {
      insert.run(
        profileId,
        `${discipline} event`,
        discipline,
        shiftDateStr(anchor, 30)
      );
    }
    expect(() =>
      insert.run(profileId, "second run", "run", shiftDateStr(anchor, 40))
    ).toThrow();
    expect(
      buildEndurancePlanFindings(profileId, anchor).length
    ).toBeLessThanOrEqual(COACHING_ENTITY_FINDING_LIMITS.endurancePlan);
  });
});

// The eleventh bound, declared next to its own family rather than in the shared
// record: FOOD_DRUG_VARIANCE_FINDING_LIMIT. Its comment names the case exactly —
// "one profile may track arbitrarily many matching medications" — and the catalog
// carries a single variance rule (vitamin K / warfarin), so over-supplying it
// means four warfarin items rather than four rules. detectFoodDrugVariance sorts
// by item id then rule id, so the survivors are the three recorded first.
describe("#3126 — the food–drug variance bound", () => {
  it("four matching medications on one swing week truncate to the bound, oldest items first", () => {
    const { profileId, anchor } = makeProfile("cap-foodDrugVariance");
    setProfileBirthdate(profileId, "1986-04-02");
    const brands = ["Coumadin", "Jantoven", "Marevan", "Warfant"];
    expect(brands.length).toBeGreaterThan(FOOD_DRUG_VARIANCE_FINDING_LIMIT);
    for (const brand of brands) {
      const itemId = Number(
        db
          .prepare(
            `INSERT INTO intake_items (profile_id, name, kind, active, obligation)
             VALUES (?, ?, 'medication', 1, 'must')`
          )
          .run(profileId, `${brand} (warfarin)`).lastInsertRowid
      );
      db.prepare(
        `INSERT INTO intake_item_doses (item_id, amount, time_of_day, start_date)
         VALUES (?, '1 tab', 'morning', ?)`
      ).run(itemId, shiftDateStr(anchor, -60));
    }
    const logServing = db.prepare(
      `INSERT INTO food_daily_totals (profile_id, date, group_key, servings)
       VALUES (?, ?, 'leafy_greens', ?)`
    );
    for (let ago = 13; ago >= 7; ago--)
      logServing.run(profileId, shiftDateStr(anchor, -ago), 0.5);
    for (let ago = 6; ago >= 0; ago--)
      logServing.run(profileId, shiftDateStr(anchor, -ago), 2);

    expect(
      buildFoodDrugVarianceFindings(profileId, anchor).map((f) => f.title)
    ).toEqual(
      brands
        .slice(0, FOOD_DRUG_VARIANCE_FINDING_LIMIT)
        .map((brand) => `Leafy greens up this week — ${brand} (warfarin)`)
    );
  });
});

// The one cap of the ten with a medically-relevant signal behind it, and the only
// one set to 1 — so "which row survives" is the whole behaviour. A count
// assertion cannot see this: `.slice(-1)` and a reversed sort both keep exactly
// one finding, and the one they keep is a bleed from up to three months ago while
// the current one goes unmentioned.
describe("#3126 — the prolonged-bleeding bound keeps the CURRENT bleed", () => {
  it("surfaces the newest qualifying period and names neither older one", () => {
    const { profileId, anchor } = makeProfile("cap-bleeding-identity");
    const keysNewestFirst = seedProlongedPeriods(profileId, anchor);
    const findings = buildCycleBleedingFindings(profileId, anchor);

    expect(findings).toHaveLength(1);
    expect(findings[0].dedupeKey).toBe(keysNewestFirst[0]);
    // Both older bleeds are withheld, so widening the bound is red here too.
    for (const older of keysNewestFirst.slice(1)) {
      expect(findings.map((f) => f.dedupeKey)).not.toContain(older);
    }
  });
});
