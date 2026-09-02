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
// RELEVANCE, NOT ALPHABET (#4069). This file first landed pinning what shipped, and
// what shipped for five of the families was an ordering with a DETERMINISM claim and
// no relevance one: trainingPlateau by lift name, adherencePattern by item name,
// demotionSuggestion by name, targetRightSize by label, medicationDuplication by
// first-member row id. A profile plateaued on five lifts saw the three whose names
// sort first and was never told the list was cut. The owner ruled (2026-09-01) that
// relevance is the contract — most recent plateau, worst adherence, longest lapsed,
// furthest from target, most recently added duplicate — with the old stable order
// kept as the TIE-BREAK so determinism survives. These five cases now assert that
// contract; the pin they replaced recorded what shipped, and was never a blessing.
// The owner then settled what three of those signals MEAN (2026-09-02): a shortfall is
// RELATIVE to its floor, a lapse is counted in DAYS, and same-second goals break by
// ascending id. Those three rows and the same-second case below moved with the ruling;
// adherencePattern's miss RATE and trainingPlateau's most-recently-trained were
// ratified as built and are untouched.
//
// A fixture that only proves DETERMINISM is what let the wrong contract ship, so
// each of the five is built with its relevance order the exact REVERSE of the
// alphabetical/row-id order it used to cut on, and seeded in a third order again
// (alphabetical insertion) so neither the alphabet nor the insertion order can
// produce the expected answer. Measured against the pre-ruling production
// orderings — the four detector sorts and the med-dup builder as `main` had them —
// all five cases are RED.
//
// The other six rows keep the proofs they landed with, each measured against a
// mutant of the production line it guards:
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
import {
  ADHERENCE_PATTERN_DAYS,
  weekdayIndex,
  weekdayName,
} from "@/lib/adherence-patterns";
import { cycleBleedingSignalKey } from "@/lib/cycle-observation";
import { weightAnomalySignalKey } from "@/lib/weight-anomaly";
import { PROLONGED_PERIOD_DAYS } from "@/lib/cycle";
import { practiceIdentity } from "@/lib/practice";
import { logPracticeSession } from "@/lib/queries";

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

// Four ingredient families of two active members each, added alphabetically — so
// each family's SECOND member (the one that made it a duplicate) is newer than the
// last family's first. Most recently added duplicate first (#4069) is therefore the
// exact reverse of medicationFamilies' first-member input order, which is what the
// cap used to cut on.
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
  return [...generics].reverse();
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
// created survive. created_at is written explicitly here to make the case about the
// bound rather than the tie-break; the same-second tie-break has its own case below.
// A 13-week rising weight series: every live "cut to 84" goal over it reads
// "trending away".
function seedRisingWeights(profileId: number, anchor: string): void {
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
}

function insertWeightGoal(
  profileId: number,
  anchor: string,
  title: string,
  createdAt: string
): void {
  db.prepare(
    `INSERT INTO goals
       (profile_id, title, category, status, archived, body_metric,
        target_value, target_date, baseline_value, created_at)
     VALUES (?, ?, 'body', 'active', 0, 'weight', 84, ?, 90, ?)`
  ).run(profileId, title, shiftDateStr(anchor, 60), createdAt);
}

function seedOffPaceGoals(profileId: number, anchor: string): string[] {
  seedRisingWeights(profileId, anchor);
  const titles: string[] = [];
  for (let age = 4; age >= 1; age--) {
    const title = `Cut to 84 (goal ${age})`;
    insertWeightGoal(
      profileId,
      anchor,
      title,
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

// Four should-tier supplements established for four months, each with ONE follow-through
// inside the 30-day window and none since — so all four are candidates (a single take is
// far under DEMOTION_MAX_TAKEN_RATE) and their lapses run 15, 17, 21 and 25 DAYS to the
// window's last settled day. Longest lapsed first (#4069) is the exact reverse of the
// alphabetical order the cap used to cut on, and the items are inserted alphabetically
// so insertion order cannot produce it either.
//
// Three of the four are due every OTHER day, which is what separates the two readings
// of "longest lapsed" the ruling had to choose between (2026-09-02: days). Measured
// through the detector, their lapses in scheduled OCCURRENCES are 15, 8, 10 and 12 — a
// different order AND a different surviving three (Ashwagandha in, Berberine out), so a
// build ranking on occurrences cannot produce the expectation below. Every-other-day
// still clears DEMOTION_MIN_OCCURRENCES: 14 due days in the window against a floor of 10.
function seedDemotionCandidates(profileId: number, anchor: string): string[] {
  const logTaken = db.prepare(
    `INSERT INTO intake_item_logs (dose_id, item_id, date, status) VALUES (?, ?, ?, 'taken')`
  );
  // Days since the last follow-through, and the cadence that decides how many
  // occurrences those days hold. Every "days ago" is EVEN, which is an on-day for the
  // interval items: their anchor is 120 days back, so the parity of the window is the
  // parity of the offset.
  const items: [
    name: string,
    lastTakenDaysAgo: number,
    everyOtherDay: boolean,
  ][] = [
    ["Ashwagandha", 16, false],
    ["Berberine", 18, true],
    ["Creatine", 22, true],
    ["Dandelion", 26, true],
  ];
  for (const [name, ago, everyOtherDay] of items) {
    const { itemId, doseId } = seedDailyItem(profileId, anchor, name);
    if (everyOtherDay) {
      db.prepare(
        `UPDATE intake_items
            SET cadence_kind = 'interval', cadence_interval_days = 2,
                cadence_anchor_date = ?
          WHERE id = ?`
      ).run(shiftDateStr(anchor, -120), itemId);
    }
    logTaken.run(doseId, itemId, shiftDateStr(anchor, -ago));
  }
  return items.map(([name]) => `${name}: move it to May?`).reverse();
}

// Four practice floors chronically under-met, each at a different size and each with a
// different best week — so the RELATIVE shortfall (the share of the floor left unmet)
// is 0.500, 0.556, 0.667 and 1.000. Furthest from target first (#4069) is the exact
// reverse of the alphabetical order the cap used to cut on, and the targets are
// inserted alphabetically so insertion order cannot produce it either.
//
// The ABSOLUTE gap `floor - best` runs the other way — 6, 5, 4, 3 — which is exactly
// alphabetical, so a build ranking on it produces the pre-ruling answer and is red
// against the expectation below. That is the pair the ruling chose between
// (2026-09-02: relative). Every best week clears RIGHTSIZE_MAX_ATTAINMENT, which is
// itself a ratio, so all four stay candidates.
function seedRightSizeTargets(profileId: number, anchor: string): string[] {
  const insert = db.prepare(
    `INSERT INTO frequency_targets
       (profile_id, scope_kind, scope_value, scope_identity, per_week, created_at)
     VALUES (?, ?, ?, ?, ?, ?)`
  );
  const floors: [label: string, perWeek: number, bestWeek: number][] = [
    ["Breathwork", 12, 6],
    ["Cold plunge", 9, 4],
    ["Journaling", 6, 2],
    ["Stretching", 3, 0],
  ];
  for (const [label, perWeek, bestWeek] of floors) {
    insert.run(
      profileId,
      "practice",
      label,
      practiceIdentity(label),
      perWeek,
      `${shiftDateStr(anchor, -200)} 08:00:00`
    );
    // The best week's sessions, one a day inside the NEWEST completed week (days 13
    // through 7 back, in the rolling mode makeProfile sets). The three older completed
    // weeks stay empty, so this week is the maximum and `best` is exactly it.
    for (let i = 0; i < bestWeek; i++)
      logPracticeSession(
        profileId,
        label,
        shiftDateStr(anchor, -(13 - i)),
        "page"
      );
  }
  return floors
    .map(([label]) => `${label}: right-size the weekly target?`)
    .reverse();
}

// Four evening supplements, each taken every day except on ONE shared weekday it
// slips on — 5, 6, 7 and 8 of that weekday's eight occurrences missed, so the miss
// rates are 0.625, 0.75, 0.875 and 1.0. Worst adherence first (#4069) is the exact
// reverse of the alphabetical order the cap used to cut on, and the items are
// inserted alphabetically so insertion order cannot produce it either.
//
// The slipping weekday is chosen three days off the ANCHOR's own weekday, which is
// what makes the denominator independent of the calendar: the window is exactly
// eight of each weekday, and the newest day is always a taken one, so
// stripWithoutTrailingPending never drops it and every rate above is exact on any
// day this suite runs.
function seedWeekdayMisses(profileId: number, anchor: string): string[] {
  const slipWeekday = (weekdayIndex(anchor) + 3) % 7;
  const misses: [string, number][] = [
    ["Alpha lipoic", 5],
    ["Biotin", 6],
    ["Choline", 7],
    ["D3", 8],
  ];
  const logTaken = db.prepare(
    `INSERT INTO intake_item_logs (dose_id, item_id, date, status) VALUES (?, ?, ?, 'taken')`
  );
  const day = weekdayName(slipWeekday);
  for (const [name, slips] of misses) {
    const { itemId, doseId } = seedDailyItem(profileId, anchor, name);
    let left = slips;
    for (let ago = ADHERENCE_PATTERN_DAYS - 1; ago >= 0; ago--) {
      const date = shiftDateStr(anchor, -ago);
      // The misses are taken from the OLDEST end, so the newest slipping day is a
      // take for every item but the worst — one more reason the trailing day never
      // reads as pending.
      if (weekdayIndex(date) === slipWeekday && left > 0) {
        left -= 1;
        continue;
      }
      logTaken.run(doseId, itemId, date);
    }
  }
  return misses.map(([name]) => `${name}: ${day}s slip`).reverse();
}

// Four lifts each flat at one load for six weeks, staggered so each was last trained
// two days before the next: Zercher 2 days ago, Pendlay 4, Landmine 6, Front Squat 8.
// Every series keeps four points spanning 33 days inside the 42-day plateau window.
// Most recent plateau first (#4069) is the exact reverse of the alphabetical order the
// cap used to cut on, and the lifts are inserted alphabetically so insertion order
// cannot produce it either.
function seedPlateaus(profileId: number, anchor: string): string[] {
  const insertActivity = db.prepare(
    `INSERT INTO activities (profile_id, date, type, title, duration_min)
     VALUES (?, ?, 'strength', 'Plateau session', 45)`
  );
  const insertSet = db.prepare(
    `INSERT INTO exercise_sets (activity_id, exercise, set_number, weight_kg, reps)
     VALUES (?, ?, 1, 60, 5)`
  );
  const lifts: [string, number][] = [
    ["Front Squat", 8],
    ["Landmine Press", 6],
    ["Pendlay Row", 4],
    ["Zercher Squat", 2],
  ];
  for (const [lift, lastTrainedDaysAgo] of lifts) {
    for (const step of [33, 22, 11, 0]) {
      const activityId = Number(
        insertActivity.run(
          profileId,
          shiftDateStr(anchor, -(lastTrainedDaysAgo + step))
        ).lastInsertRowid
      );
      insertSet.run(activityId, lift);
    }
  }
  return lifts.map(([lift]) => `${lift} has plateaued`).reverse();
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

// The other half of the #4069 ruling: relevance decides the cut, and where two
// members are EQUALLY relevant the pre-ruling stable order still decides, so
// determinism survives the re-pointing. Four floors of the same size with the same
// (zero) best week are exactly that state — inserted in reverse so the tie-break has
// to reorder them rather than merely preserve the row order it was handed.
describe("#4069 — equal relevance falls back to the old stable order", () => {
  it("keeps the alphabetically first three when every shortfall is the same", () => {
    const { profileId, anchor } = makeProfile("tiebreak-rightsize");
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

    expect(
      buildTargetRightSizeFindings(profileId, anchor).map((f) => f.title)
    ).toEqual(
      labels
        .slice(0, COACHING_ENTITY_FINDING_LIMITS.targetRightSize)
        .map((label) => `${label}: right-size the weekly target?`)
    );
  });
});

// The two mechanics defects #4069 recorded next to the ruling. Both are about the
// goal-pacing family, and neither is a relevance judgment — they are a shared counter
// and a missing tie-break.
describe("#4069 — goal pacing's two halves are bounded separately", () => {
  it("a full body-metric half does not silence the biomarker half", () => {
    const { profileId, anchor } = makeProfile("goalpace-two-loops");
    seedRisingWeights(profileId, anchor);
    // Exactly the family's cap in off-pace WEIGHT goals: enough to fill one shared
    // counter on its own.
    const cap = COACHING_ENTITY_FINDING_LIMITS.goalPacing;
    for (let age = cap; age >= 1; age--) {
      insertWeightGoal(
        profileId,
        anchor,
        `Cut to 84 (goal ${age})`,
        `${shiftDateStr(anchor, -age)} 08:00:00`
      );
    }
    // …and one lab goal whose every draw since has moved AWAY from the target.
    const insertLab = db.prepare(
      `INSERT INTO medical_records
         (profile_id, date, category, name, value, unit, canonical_name, value_num)
       VALUES (?, ?, 'lab', 'LDL Cholesterol', ?, 'mg/dL', 'LDL Cholesterol', ?)`
    );
    for (const [ago, value] of [
      [240, 150],
      [150, 158],
      [60, 166],
      [20, 172],
    ] as const) {
      insertLab.run(
        profileId,
        shiftDateStr(anchor, -ago),
        String(value),
        value
      );
    }
    db.prepare(
      `INSERT INTO goals
         (profile_id, title, category, status, archived, target_value, unit,
          biomarker_name, target_direction, target_date, baseline_value, created_at)
       VALUES (?, 'LDL under 100', 'biomarker', 'active', 0, 100, 'mg/dL',
               'LDL Cholesterol', 'below', ?, 150, ?)`
    ).run(
      profileId,
      shiftDateStr(anchor, 120),
      `${shiftDateStr(anchor, -250)} 09:00:00`
    );

    const titles = buildGoalPacingFindings(profileId, anchor).map(
      (f) => f.title
    );
    // The weight half still fills its own bound…
    expect(titles.filter((t) => t.includes("Cut to 84"))).toHaveLength(cap);
    // …and the lab goal is still told about. Under one shared counter it was not.
    expect(titles).toContain("“LDL under 100” is off pace");
  });

  // `id ASC`, not DESC (owner ruling 2026-09-02): an imported set keeps the order it
  // was written in, so the goals list people already see does not reverse under them.
  // What this case CAN see is the direction — a build ordering `id DESC` keeps the
  // last three of the import instead of the first and is red here. What it cannot see
  // is the tiebreak's ABSENCE: ascending id is also the order a table scan returns, so
  // this expectation is the same one a build with no tiebreak at all would satisfy.
  // That is the point of the ruling rather than a hole in it — the column was chosen
  // to preserve the de-facto order, and the same-second case exists to keep it defined.
  it("goals written in the same second keep the order the import wrote them in", () => {
    const { profileId, anchor } = makeProfile("goalpace-same-second");
    seedRisingWeights(profileId, anchor);
    // An import: four goals, one created_at, so `created_at DESC` alone leaves the
    // survival order to whatever the read happens to return.
    const stamp = `${shiftDateStr(anchor, -5)} 08:00:00`;
    const titles = ["import 1", "import 2", "import 3", "import 4"].map(
      (n) => `Cut to 84 (${n})`
    );
    for (const title of titles)
      insertWeightGoal(profileId, anchor, title, stamp);

    expect(
      buildGoalPacingFindings(profileId, anchor).map((f) => f.title)
    ).toEqual(
      titles
        .slice(0, COACHING_ENTITY_FINDING_LIMITS.goalPacing)
        .map((t) => `“${t}” is off pace`)
    );
  });
});
