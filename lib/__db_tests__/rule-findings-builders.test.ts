// DB INTEGRATION TIER (not the pure unit suite in lib/__tests__).
//
// Issue #448 — the findings-builder backfill. Every confirmed defect in the #45
// behavioral engines lived in the BUILDER'S INPUT LAYER (lib/rule-findings.ts), not
// the threshold logic: the adherence window ignoring dose lifetime (#430), the
// plateau series bypassing the canonical history key (#432), goal pacing fed raw
// all-source rows instead of the deduped daily series (#433), the anomaly detector
// fed cross-source/back-and-forth rows (#434). The pure tier structurally can't see
// those — it takes pre-gathered arrays. These tests seed a realistic fixture and
// assert the END-TO-END finding output of each builder, pinning the exact bug class.
//
// A cheap reflection guard also asserts every dedupeKey the builders emit parses
// against the known-prefix registry, so a new engine can't ship an unguardable key.
//
// Runs via `npm run test:db` (vitest.db.config.ts). The `db` singleton is pointed at
// a throwaway per-file temp DB by lib/__db_tests__/setup.ts.

import { describe, it, expect } from "vitest";
import { db, today } from "@/lib/db";
import { shiftDateStr } from "@/lib/date";
import {
  buildAdherencePatternFindings,
  buildTrainingObservationFindings,
  buildGoalPacingFindings,
  buildBodyHygieneFindings,
  buildFoodSuggestionFindings,
  buildFoodHabitFindings,
  buildOralHealthFindings,
  buildMuscleVolumeFindings,
  collectCoachingFindings,
} from "@/lib/rule-findings";
import {
  muscleVolumeSignalKey,
  MIN_BAND_HISTORY_WEEKS,
} from "@/lib/muscle-volume-bands";
import { periodontalObservationKey } from "@/lib/oral-health-observation";
import { foodSuggestSignalKey, foodReduceSignalKey } from "@/lib/food-suggest";
import { foodHabitSignalKey } from "@/lib/food-habit";
import { matchFoodInteractions } from "@/lib/food-drug-interactions";
import {
  weekdayMissSignalKey,
  ADHERENCE_PREFIX,
} from "@/lib/adherence-patterns";
import { TRAINING_OBS_PREFIX } from "@/lib/training-observations";
import {
  weightAnomalySignalKey,
  detectWeightAnomalies,
} from "@/lib/weight-anomaly";
import {
  getBodyMetricDailySeries,
  getWeights,
  getWeightsOneSourcePerDay,
  getGoals,
  getFindingSuppressions,
  dismissFinding,
  restoreFinding,
} from "@/lib/queries";
import { activeFindings } from "@/lib/findings";
import { projectGoal, type GoalProjection } from "@/lib/trend-projection";
import { PACE_SLACK_DAYS, GOAL_PACE_WINDOW_DAYS } from "@/lib/goal-pacing";
import {
  dedupeKeyHasKnownPrefix,
  tierForDedupeKey,
  declaredReasonCodesFor,
} from "@/lib/rule-finding-prefixes";

// A fresh profile per test — cross-domain rows are inserted directly (modeled on
// lib/__db_tests__/fixtures.ts) so each fixture is self-contained.
function makeProfile(name: string): { profileId: number; anchor: string } {
  const profileId = Number(
    db.prepare("INSERT INTO profiles (name) VALUES (?)").run(name)
      .lastInsertRowid
  );
  return { profileId, anchor: today(profileId) };
}

function isFriday(dateISO: string): boolean {
  return new Date(Date.parse(`${dateISO}T00:00:00Z`)).getUTCDay() === 5;
}

// ---- #430: adherence window respects the dose's lifetime --------------------

describe("buildAdherencePatternFindings — dose lifetime window (#430)", () => {
  it("does not re-accuse a re-timed dose, while a stable dose still flags", () => {
    const { profileId, anchor } = makeProfile("adherence-430");
    const itemCreated = `${shiftDateStr(anchor, -20)} 09:00:00`; // mid the 56-day window
    const reTimedAt = `${shiftDateStr(anchor, -5)} 09:00:00`; // moved recently
    const longAgo = `${shiftDateStr(anchor, -90)} 09:00:00`; // before the window

    // TRAP: an item added 20 days ago whose dose was re-timed evening→morning 5
    // days ago. Its Friday-miss history all happened while it was an evening dose;
    // an unbounded window would render "you miss your MORNING dose most Fridays".
    const trapItem = Number(
      db
        .prepare(
          `INSERT INTO intake_items (profile_id, name, active, kind, condition, priority, as_needed, created_at)
           VALUES (?, 'Trap Magnesium', 1, 'supplement', 'daily', 'high', 0, ?)`
        )
        .run(profileId, itemCreated).lastInsertRowid
    );
    const trapDose = Number(
      db
        .prepare(
          `INSERT INTO intake_item_doses (item_id, amount, time_of_day, food_timing, sort, created_at, updated_at)
           VALUES (?, '1 cap', 'morning', 'any', 0, ?, ?)`
        )
        .run(trapItem, itemCreated, reTimedAt).lastInsertRowid
    );

    // CONTROL: a long-lived, never-re-timed evening dose with the SAME miss pattern.
    // Its full window is legitimate, so the engine SHOULD flag it — proving the trap's
    // empty result is the lifetime clamp, not a dead detector.
    const ctrlItem = Number(
      db
        .prepare(
          `INSERT INTO intake_items (profile_id, name, active, kind, condition, priority, as_needed, created_at)
           VALUES (?, 'Control Zinc', 1, 'supplement', 'daily', 'high', 0, ?)`
        )
        .run(profileId, longAgo).lastInsertRowid
    );
    const ctrlDose = Number(
      db
        .prepare(
          `INSERT INTO intake_item_doses (item_id, amount, time_of_day, food_timing, sort, created_at, updated_at)
           VALUES (?, '1 cap', 'evening', 'any', 0, ?, NULL)`
        )
        .run(ctrlItem, longAgo).lastInsertRowid
    );

    // Taken on every non-Friday across the 56-day window; Fridays left un-logged
    // (a miss) for BOTH doses.
    const logTaken = db.prepare(
      `INSERT INTO intake_item_logs (dose_id, item_id, date, status) VALUES (?, ?, ?, 'taken')`
    );
    for (let i = 55; i >= 0; i--) {
      const date = shiftDateStr(anchor, -i);
      if (isFriday(date)) continue;
      logTaken.run(trapDose, trapItem, date);
      logTaken.run(ctrlDose, ctrlItem, date);
    }

    const findings = buildAdherencePatternFindings(profileId, anchor);

    // Exactly one finding — the control's Friday pattern — and NONE for the re-timed
    // trap dose (its window starts at the re-time, below the min-history gate). The
    // key now carries the #436 episode anchor (the current year).
    const yr = anchor.slice(0, 4);
    expect(findings).toHaveLength(1);
    expect(findings[0].dedupeKey).toBe(weekdayMissSignalKey(ctrlDose, 5, yr));
    expect(
      findings.some(
        (f) => f.dedupeKey === weekdayMissSignalKey(trapDose, 5, yr)
      )
    ).toBe(false);
    // The control's copy suggests a MOVE (evening slot); a bedtime/medication would
    // fall back to the reminder copy (#430.4) — the evening supplement does not.
    expect(findings[0].detail).toMatch(/moving it earlier/i);
  });
});

// ---- #432: plateau series merges variant + base under the canonical key -----

describe("buildTrainingObservationFindings — merged plateau series (#432)", () => {
  it("merges a lift logged under a variant and its base into ONE plateau series", () => {
    const { profileId, anchor } = makeProfile("training-432");

    // Alternate the SAME lift's spellings across four flat sessions spanning >21
    // days inside the 42-day plateau window: "Barbell Curl" and "Curl" collapse to
    // one canonical history ("curl"). Split by a raw name key, each spelling would
    // hold 2 points (< PLATEAU_MIN_POINTS 4) and the real plateau would be missed.
    const sessions: { day: number; exercise: string }[] = [
      { day: -35, exercise: "Barbell Curl" },
      { day: -28, exercise: "Curl" },
      { day: -14, exercise: "Barbell Curl" },
      { day: 0, exercise: "Curl" },
    ];
    const insAct = db.prepare(
      `INSERT INTO activities (profile_id, date, type, title, duration_min)
       VALUES (?, ?, 'strength', 'Arms', 30)`
    );
    const insSet = db.prepare(
      `INSERT INTO exercise_sets (activity_id, exercise, set_number, weight_kg, reps)
       VALUES (?, ?, 1, 30, 5)`
    );
    for (const s of sessions) {
      const actId = Number(
        insAct.run(profileId, shiftDateStr(anchor, s.day)).lastInsertRowid
      );
      insSet.run(actId, s.exercise); // fixed 30 kg × 5 reps → flat e1RM, flat reps
    }

    const findings = buildTrainingObservationFindings(profileId, anchor);
    const plateaus = findings.filter((f) => f.domain === "training-plateau");
    expect(plateaus).toHaveLength(1);
    expect(
      plateaus[0].dedupeKey.startsWith(`${TRAINING_OBS_PREFIX}plateau:`)
    ).toBe(true);
    expect(plateaus[0].title.toLowerCase()).toContain("curl");
  });
});

// ---- #742: per-muscle weekly volume-band shortfall builder ------------------

// Log `n` sets of a catalog lift on `day` (relative to anchor). "Lateral Raise"
// credits ONLY side-delts (1.0 primary, no secondary), so n sets → n side-delt sets.
function logStrengthSets(
  profileId: number,
  anchorDay: string,
  day: number,
  exercise: string,
  n: number
): void {
  const actId = Number(
    db
      .prepare(
        `INSERT INTO activities (profile_id, date, type, title, duration_min)
         VALUES (?, ?, 'strength', 'Session', 30)`
      )
      .run(profileId, shiftDateStr(anchorDay, day)).lastInsertRowid
  );
  const insSet = db.prepare(
    `INSERT INTO exercise_sets (activity_id, exercise, set_number, weight_kg, reps)
     VALUES (?, ?, ?, 10, 12)`
  );
  for (let s = 1; s <= n; s++) insSet.run(actId, exercise, s);
}

describe("buildMuscleVolumeFindings — below-band shortfall (#742)", () => {
  it("flags a trained-but-under-floor muscle once cold start is cleared", () => {
    const { profileId, anchor } = makeProfile("volume-742-below");

    // This week: only 2 Lateral Raise sets → side-delts = 2, below its floor of 8.
    logStrengthSets(profileId, anchor, 0, "Lateral Raise", 2);
    // A session TWO weeks ago clears the 2-distinct-week cold-start gate but sits
    // OUTSIDE the trailing 7-day coverage window, so it doesn't lift side-delts.
    logStrengthSets(profileId, anchor, -14, "Lateral Raise", 3);

    const findings = buildMuscleVolumeFindings(profileId, anchor);
    expect(findings).toHaveLength(1);
    const f = findings[0];
    expect(f.domain).toBe("muscle-volume");
    expect(f.dedupeKey).toBe(
      muscleVolumeSignalKey("side-delts", anchor.slice(0, 7))
    );
    expect(f.tone).toBe("info"); // calm coaching tier (#449)
    // #860 Track A — registered coaching tier.
    expect(tierForDedupeKey(f.dedupeKey)).toBe("coaching");
    expect(f.detail).toContain("Side delts");
    expect(f.detail).toContain("8"); // the band floor is named

    // Coaching tier: it flows through the unified rollup, never a push/hero.
    const rolled = collectCoachingFindings(profileId, anchor, "kg").map(
      (r) => r.dedupeKey
    );
    expect(rolled).toContain(f.dedupeKey);
  });

  it("COLD START: emits nothing with fewer than the min distinct training weeks", () => {
    const { profileId, anchor } = makeProfile("volume-742-coldstart");

    // Two same-week sessions of the same under-floor lift: side-delts is clearly
    // below its band, but the profile has only ONE distinct training week — an
    // unanswered question, not "everything below target" (#719).
    logStrengthSets(profileId, anchor, 0, "Lateral Raise", 2);
    logStrengthSets(profileId, anchor, -1, "Lateral Raise", 1);
    // Sanity: this fixture is one week of history, below the gate.
    expect(MIN_BAND_HISTORY_WEEKS).toBeGreaterThan(1);

    expect(buildMuscleVolumeFindings(profileId, anchor)).toEqual([]);
  });
});

// ---- #433: goal pacing feeds the deduped daily series, not raw all-source ---

// Classify a projection the way assessGoalPace / the chart caption do: away, late
// (reaching but past the deadline by more than the slack), or on-pace/none.
function classifyProjection(
  p: GoalProjection | null
): "away" | "late" | "onpace" {
  if (!p) return "onpace";
  if (p.status === "away") return "away";
  if (p.daysEarly != null && p.daysEarly < -PACE_SLACK_DAYS) return "late";
  return "onpace";
}

function classifyFinding(
  detail: string | null | undefined
): "away" | "late" | "onpace" {
  if (!detail) return "onpace";
  if (/trending away/i.test(detail)) return "away";
  if (/you'll reach it/i.test(detail)) return "late";
  return "onpace";
}

describe("buildGoalPacingFindings — deduped daily series parity (#433)", () => {
  it("agrees with the chart caption on a multi-source fixture, not the raw rows", () => {
    const { profileId, anchor } = makeProfile("goalpace-433");

    // A weight-LOSS goal (baseline 90 → target 84). The PRIMARY (manual) daily
    // series is flat-to-rising → trending AWAY. A second device ('health-connect')
    // reports much LOWER same-day readings that steadily fall; folded into the RAW
    // getWeights rows they drag the slope downward and read as "on pace", but the
    // chart's deduped daily series (manual wins the day, #14) never sees them.
    const insWeight = db.prepare(
      `INSERT INTO body_metrics (profile_id, date, weight_kg, source) VALUES (?, ?, ?, ?)`
    );
    for (let wk = 12; wk >= 0; wk--) {
      const date = shiftDateStr(anchor, -wk * 7);
      const manual = 90 + (12 - wk) * 0.06; // 90.0 → ~90.7, gently rising
      const device = 90 - (12 - wk) * 0.5; // 90.0 → 84.0, steadily falling
      insWeight.run(profileId, date, manual, null); // manual (primary)
      insWeight.run(profileId, date, device, "health-connect");
    }

    const goalId = Number(
      db
        .prepare(
          `INSERT INTO goals (profile_id, title, category, status, archived, body_metric, target_value, target_date, baseline_value)
           VALUES (?, '433 Cut to 84', 'body', 'active', 0, 'weight', 84, ?, 90)`
        )
        .run(profileId, shiftDateStr(anchor, 60)).lastInsertRowid
    );

    const goal = getGoals(profileId).find((g) => g.id === goalId)!;
    const windowStart = shiftDateStr(anchor, -(GOAL_PACE_WINDOW_DAYS - 1));

    // Chart-caption path: projectGoal over the deduped daily series windowed to the
    // shared window (kg — status is unit-invariant).
    const dailySeries = getBodyMetricDailySeries(profileId, "weight").filter(
      (p) => p.date >= windowStart
    );
    const chart = classifyProjection(
      projectGoal(
        dailySeries,
        goal.target_value!,
        goal.target_date!,
        goal.baseline_value
      )
    );

    // Raw path (what the builder used to feed): every source's rows, unwindowed.
    const rawSeries = getWeights(profileId)
      .map((w) => ({ date: w.date, value: w.weight_kg }))
      .sort((a, b) => a.date.localeCompare(b.date));
    const raw = classifyProjection(
      projectGoal(
        rawSeries,
        goal.target_value!,
        goal.target_date!,
        goal.baseline_value
      )
    );

    // The fixture is a genuine trap: raw disagrees with the chart caption.
    expect(chart).toBe("away");
    expect(raw).not.toBe("away");

    // The builder's finding must match the chart caption (the deduped series), NOT
    // the raw rows.
    const findings = buildGoalPacingFindings(profileId, anchor);
    const paceFinding = findings.find((f) =>
      f.dedupeKey.includes(`goal:${goalId}`)
    );
    expect(classifyFinding(paceFinding?.detail)).toBe(chart);
  });
});

// ---- #434: weight anomaly collapses an out-and-back to one finding ----------

describe("buildBodyHygieneFindings — out-and-back collapse (#434)", () => {
  it("emits exactly one finding naming the middle (suspect) row", () => {
    const { profileId, anchor } = makeProfile("anomaly-434");

    // 80.0 → 176.4 (an lb value typed as kg) → 80.2 (the correct recovery). The
    // naive consecutive scan flags BOTH the bad row AND the recovery; the collapse
    // keeps one finding pointed at the middle row.
    const insWeight = db.prepare(
      `INSERT INTO body_metrics (profile_id, date, weight_kg) VALUES (?, ?, ?)`
    );
    insWeight.run(profileId, shiftDateStr(anchor, -3), 80.0);
    const midId = Number(
      insWeight.run(profileId, shiftDateStr(anchor, -2), 176.4).lastInsertRowid
    );
    const recoveryId = Number(
      insWeight.run(profileId, shiftDateStr(anchor, -1), 80.2).lastInsertRowid
    );

    const findings = buildBodyHygieneFindings(profileId, anchor, "kg");

    expect(findings).toHaveLength(1);
    expect(findings[0].dedupeKey).toBe(weightAnomalySignalKey(midId));
    // Never accuses the correct recovery reading.
    expect(
      findings.some((f) => f.dedupeKey === weightAnomalySignalKey(recoveryId))
    ).toBe(false);
    // The middle row reads as a unit mix-up (ratio ≈ 2.2×).
    expect(findings[0].detail).toMatch(/kg\/lb entry mix-up/i);
  });
});

// ---- #634: weight anomaly collapses cross-source rows (the #434 other half) --

describe("buildBodyHygieneFindings — cross-source collapse (#634)", () => {
  it("does not flag two scales disagreeing on the same day", () => {
    const { profileId, anchor } = makeProfile("anomaly-634");

    // A stable Health Connect weight trend, plus a single day where a SECOND scale
    // (Withings) also reported — 3.5% lower. Raw all-source rows sort the two
    // same-day readings adjacent (gap 0) and read as a day-over-day "jump"; the
    // primary-source-per-day collapse keeps ONE reading per day, so there is no
    // cross-source pair to flag.
    const insWeight = db.prepare(
      `INSERT INTO body_metrics (profile_id, date, weight_kg, source) VALUES (?, ?, ?, ?)`
    );
    insWeight.run(profileId, shiftDateStr(anchor, -3), 80.0, "health-connect");
    insWeight.run(profileId, shiftDateStr(anchor, -2), 80.1, "health-connect");
    insWeight.run(profileId, shiftDateStr(anchor, -1), 80.0, "health-connect");
    // The disputed second scale on the most recent day (Withings reads 77.2).
    insWeight.run(profileId, shiftDateStr(anchor, -1), 77.2, "withings");

    // The collapse keeps exactly one row per day (health-connect wins the disputed
    // day per the default provider preference) — the id is preserved for linking.
    const collapsed = getWeightsOneSourcePerDay(profileId);
    expect(collapsed).toHaveLength(3);
    expect(collapsed.every((r) => typeof r.id === "number")).toBe(true);

    // Genuine trap: the RAW all-source rows would have produced a false anomaly.
    const rawAnomalies = detectWeightAnomalies(
      getWeights(profileId).map((w) => ({
        id: w.id,
        date: w.date,
        weightKg: w.weight_kg,
      })),
      anchor
    );
    expect(rawAnomalies.length).toBeGreaterThan(0);

    // The builder, fed the collapsed one-source-per-day rows, flags nothing.
    expect(buildBodyHygieneFindings(profileId, anchor, "kg")).toHaveLength(0);
  });

  it("still flags a genuine within-source jump after the collapse", () => {
    const { profileId, anchor } = makeProfile("anomaly-634-control");
    const insWeight = db.prepare(
      `INSERT INTO body_metrics (profile_id, date, weight_kg, source) VALUES (?, ?, ?, ?)`
    );
    insWeight.run(profileId, shiftDateStr(anchor, -2), 80.0, "health-connect");
    const badId = Number(
      insWeight.run(
        profileId,
        shiftDateStr(anchor, -1),
        176.4,
        "health-connect"
      ).lastInsertRowid
    );

    const findings = buildBodyHygieneFindings(profileId, anchor, "kg");
    expect(findings).toHaveLength(1);
    expect(findings[0].dedupeKey).toBe(weightAnomalySignalKey(badId));
  });
});

// ---- #436: episode-anchored dedupe keys + dual-read legacy suppression ------

describe("episode-anchored dedupe keys (#436)", () => {
  // Seed a flat curl plateau at 30 kg (the #432 merged-curl fixture) and return the
  // profile + a live re-read of its plateau finding.
  function seedPlateau(name: string) {
    const { profileId, anchor } = makeProfile(name);
    const insAct = db.prepare(
      `INSERT INTO activities (profile_id, date, type, title, duration_min)
       VALUES (?, ?, 'strength', 'Arms', 30)`
    );
    const insSet = db.prepare(
      `INSERT INTO exercise_sets (activity_id, exercise, set_number, weight_kg, reps)
       VALUES (?, ?, 1, 30, 5)`
    );
    for (const s of [
      { day: -35, ex: "Barbell Curl" },
      { day: -28, ex: "Curl" },
      { day: -14, ex: "Barbell Curl" },
      { day: 0, ex: "Curl" },
    ]) {
      const actId = Number(
        insAct.run(profileId, shiftDateStr(anchor, s.day)).lastInsertRowid
      );
      insSet.run(actId, s.ex);
    }
    const plateauOf = () =>
      buildTrainingObservationFindings(profileId, anchor).find(
        (f) => f.domain === "training-plateau"
      );
    return { profileId, anchor, plateauOf };
  }

  it("plateau: the key carries an episode anchor and a legacy supersedes", () => {
    const { plateauOf } = seedPlateau("plateau-shape-436");
    const plateau = plateauOf()!;
    expect(plateau).toBeTruthy();
    // Episodic key = training-obs:plateau:<name>:<e1RM level bucket>.
    expect(plateau.dedupeKey).toMatch(/^training-obs:plateau:.+:\d+$/);
    // Dual-read legacy key = the pre-#436 episode-less shape; the episodic key is it
    // plus the level-bucket anchor.
    expect(plateau.supersedes).toMatch(/^training-obs:plateau:.+[^:\d]$/);
    expect(plateau.dedupeKey.startsWith(`${plateau.supersedes}:`)).toBe(true);
  });

  it("plateau: a same-episode dismissal hides it; a different-episode one does not", () => {
    const { profileId, anchor, plateauOf } = seedPlateau("plateau-episode-436");
    const plateau = plateauOf()!;
    const visible = () =>
      activeFindings(
        buildTrainingObservationFindings(profileId, anchor),
        getFindingSuppressions(profileId),
        anchor
      ).some((f) => f.domain === "training-plateau");

    expect(visible()).toBe(true);

    // (a) Dismiss THIS episode's key → hidden.
    dismissFinding(profileId, plateau.dedupeKey);
    expect(visible()).toBe(false);
    restoreFinding(profileId, plateau.dedupeKey);

    // (b) A dismissal for a DIFFERENT episode (a plateau at another level) must NOT
    //     silence the current one — the bug #436 fixes.
    dismissFinding(profileId, `${plateau.supersedes}:999`);
    expect(visible()).toBe(true);
    restoreFinding(profileId, `${plateau.supersedes}:999`);
  });

  it("plateau: a legacy (pre-#436, episode-less) dismissal still suppresses the current finding (no orphan)", () => {
    const { profileId, anchor, plateauOf } = seedPlateau("plateau-legacy-436");
    const plateau = plateauOf()!;
    // A dismissal stored under the OLD key shape keeps working (dual-read), so
    // upgrading the key never re-surfaces a finding the user already dismissed.
    dismissFinding(profileId, plateau.supersedes!);
    const visible = activeFindings(
      buildTrainingObservationFindings(profileId, anchor),
      getFindingSuppressions(profileId),
      anchor
    ).some((f) => f.domain === "training-plateau");
    expect(visible).toBe(false);
  });

  it("adherence: the weekday key carries the year anchor and a legacy supersedes", () => {
    const { profileId, anchor } = makeProfile("adherence-episode-436");
    const longAgo = `${shiftDateStr(anchor, -90)} 09:00:00`;
    const item = Number(
      db
        .prepare(
          `INSERT INTO intake_items (profile_id, name, active, kind, condition, priority, as_needed, created_at)
           VALUES (?, 'Episode Zinc', 1, 'supplement', 'daily', 'high', 0, ?)`
        )
        .run(profileId, longAgo).lastInsertRowid
    );
    const dose = Number(
      db
        .prepare(
          `INSERT INTO intake_item_doses (item_id, amount, time_of_day, food_timing, sort, created_at)
           VALUES (?, '1 cap', 'evening', 'any', 0, ?)`
        )
        .run(item, longAgo).lastInsertRowid
    );
    const logTaken = db.prepare(
      `INSERT INTO intake_item_logs (dose_id, item_id, date, status) VALUES (?, ?, ?, 'taken')`
    );
    for (let i = 55; i >= 0; i--) {
      const date = shiftDateStr(anchor, -i);
      if (!isFriday(date)) logTaken.run(dose, item, date);
    }
    const f = buildAdherencePatternFindings(profileId, anchor).find(
      (x) => x.domain === "adherence-weekday"
    )!;
    expect(f).toBeTruthy();
    expect(f.dedupeKey).toBe(
      `${weekdayMissSignalKey(dose, 5, anchor.slice(0, 4))}`
    );
    expect(f.supersedes).toBe(`${ADHERENCE_PREFIX}weekday:${dose}:5`);

    // No-orphan: a legacy (year-less) dismissal still suppresses it.
    dismissFinding(profileId, f.supersedes!);
    expect(
      activeFindings(
        buildAdherencePatternFindings(profileId, anchor),
        getFindingSuppressions(profileId),
        anchor
      ).some((x) => x.domain === "adherence-weekday")
    ).toBe(false);
  });
});

// ---- #577: deterministic biomarker→food suggestions -------------------------
// The builder's INPUT LAYER (the current-reading filter #557, the family collapse, the
// allergy/medication/condition gathers) is exactly what the pure tier can't see — this
// seeds a real fixture and asserts the end-to-end finding.
describe("buildFoodSuggestionFindings (#577)", () => {
  const insertReading = (
    profileId: number,
    name: string,
    flag: string,
    date: string
  ) =>
    db
      .prepare(
        `INSERT INTO medical_records
           (profile_id, date, category, name, value, unit, canonical_name, flag)
         VALUES (?, ?, 'lab', ?, '3.0', '% by wt', ?, ?)`
      )
      .run(profileId, date, name, name, flag);

  it("low omega-3 → a food-suggest:omega-3 finding (fatty fish)", () => {
    const { profileId, anchor } = makeProfile("food-omega3");
    insertReading(profileId, "Omega-3 Total (OmegaCheck)", "low", anchor);

    const findings = buildFoodSuggestionFindings(profileId);
    expect(findings).toHaveLength(1);
    expect(findings[0].dedupeKey).toBe(foodSuggestSignalKey("omega-3"));
    expect(findings[0].detail?.toLowerCase()).toContain("fatty fish");
    expect(findings[0].evidence?.toLowerCase()).toContain("not medical advice");
  });

  it("a SUPERSEDED low reading (a later normal) does not trigger — current-reading filter #557", () => {
    const { profileId, anchor } = makeProfile("food-superseded");
    insertReading(profileId, "Ferritin", "low", shiftDateStr(anchor, -200));
    insertReading(profileId, "Ferritin", "normal", anchor);

    expect(buildFoodSuggestionFindings(profileId)).toEqual([]);
  });

  it("a fish allergy swaps fatty fish for the alternative on the same finding", () => {
    const { profileId, anchor } = makeProfile("food-allergy");
    insertReading(profileId, "Omega-3 EPA", "low", anchor);
    db.prepare(
      `INSERT INTO allergies (profile_id, substance, status) VALUES (?, 'fish', 'active')`
    ).run(profileId);

    const findings = buildFoodSuggestionFindings(profileId);
    expect(findings).toHaveLength(1);
    expect(findings[0].detail?.toLowerCase()).toMatch(/walnut|flax|algae/);
    expect(findings[0].detail?.toLowerCase()).not.toContain("salmon");
  });

  // #774: a flagged-low selenium yields a "try brazil nuts" suggestion end-to-end.
  it("low selenium → a food-suggest:selenium finding (brazil nuts) — #774", () => {
    const { profileId, anchor } = makeProfile("food-selenium");
    insertReading(profileId, "Selenium", "low", anchor);

    const findings = buildFoodSuggestionFindings(profileId);
    expect(findings).toHaveLength(1);
    expect(findings[0].dedupeKey).toBe(foodSuggestSignalKey("selenium"));
    expect(findings[0].detail?.toLowerCase()).toContain("brazil");
  });

  // #775: a flagged-HIGH biomarker yields a reduce (food-reduce:*) finding.
  it("high HbA1c → a food-reduce:glucose finding (reduce added sugar) — #775", () => {
    const { profileId, anchor } = makeProfile("food-reduce-a1c");
    insertReading(profileId, "Hemoglobin A1c", "high", anchor);

    const findings = buildFoodSuggestionFindings(profileId);
    expect(findings).toHaveLength(1);
    const f = findings[0];
    expect(f.dedupeKey).toBe(foodReduceSignalKey("glucose"));
    expect(f.title?.toLowerCase()).toContain("cut back");
    expect(f.detail?.toLowerCase()).toContain("high");
    expect(f.detail?.toLowerCase()).toMatch(/added sugar|sugary/);
    // Coaching-tier only (#449): informational, never a red attention flag.
    expect(f.tone).toBe("info");
  });

  // #775: an elevated mercury tempers the app's own fish encouragement — the note
  // rides the low-omega-3 ADD finding, not a standalone reduce card.
  it("high mercury + low omega-3 → the fish finding carries the low-mercury-species note — #775", () => {
    const { profileId, anchor } = makeProfile("food-mercury");
    insertReading(profileId, "Omega-3 EPA", "low", anchor);
    insertReading(profileId, "Mercury", "high", anchor);

    const findings = buildFoodSuggestionFindings(profileId);
    // One finding (the omega-3 add card), qualified by the mercury note.
    expect(findings).toHaveLength(1);
    expect(findings[0].dedupeKey).toBe(foodSuggestSignalKey("omega-3"));
    expect(findings[0].detail?.toLowerCase()).toContain("mercury");
    expect(findings[0].detail?.toLowerCase()).toMatch(/tuna|swordfish/);
  });

  // #775 true-negative: an in-range core-panel reading yields no reduce finding, and
  // low-side suggestions still work alongside a reduce one.
  it("in-range LDL yields no reduce finding; a low + a high coexist", () => {
    const { profileId, anchor } = makeProfile("food-mixed");
    insertReading(profileId, "LDL Cholesterol", "normal", anchor);
    expect(buildFoodSuggestionFindings(profileId)).toEqual([]);

    insertReading(profileId, "Ferritin", "low", anchor);
    insertReading(profileId, "Uric Acid", "high", anchor);
    const keys = buildFoodSuggestionFindings(profileId).map((f) => f.dedupeKey);
    expect(keys).toContain(foodSuggestSignalKey("iron"));
    expect(keys).toContain(foodReduceSignalKey("urate"));
  });
});

// ---- #580: behind-target food-habit findings --------------------------------
describe("buildFoodHabitFindings (#580)", () => {
  function addFoodTarget(profileId: number, group: string, perWeek: number) {
    db.prepare(
      `INSERT INTO frequency_targets (profile_id, scope_kind, scope_value, per_week)
       VALUES (?, 'food_group', ?, ?)`
    ).run(profileId, group, perWeek);
  }
  function logServing(profileId: number, group: string, date: string) {
    db.prepare(
      `INSERT INTO food_log (profile_id, date, group_key, servings) VALUES (?, ?, ?, 1)
       ON CONFLICT (profile_id, date, group_key) DO UPDATE SET servings = servings + 1`
    ).run(profileId, date, group);
  }

  it("fires a food-habit:<group> finding when this week's servings are behind", () => {
    const { profileId, anchor } = makeProfile("food-habit-behind");
    addFoodTarget(profileId, "fatty_fish", 2);
    logServing(profileId, "fatty_fish", anchor); // 1 of 2

    const findings = buildFoodHabitFindings(profileId);
    expect(findings).toHaveLength(1);
    expect(findings[0].dedupeKey).toBe(foodHabitSignalKey("fatty_fish"));
    expect(findings[0].detail).toContain("1 of 2");
  });

  it("does not fire when the weekly target is met", () => {
    const { profileId, anchor } = makeProfile("food-habit-met");
    addFoodTarget(profileId, "fatty_fish", 2);
    logServing(profileId, "fatty_fish", anchor);
    logServing(profileId, "fatty_fish", anchor); // 2 of 2 (two servings one day)

    expect(buildFoodHabitFindings(profileId)).toEqual([]);
  });

  // #661: a behind food-habit target that conflicts with the active stack carries the
  // SAME interaction note the medication's own row shows — encouragement and warning
  // from one computation.
  it("a behind leafy-greens habit on warfarin carries the vitamin-K note (same as the med row)", () => {
    const { profileId, anchor } = makeProfile("food-habit-warfarin");
    // Active warfarin medication in the stack.
    db.prepare(
      `INSERT INTO intake_items (profile_id, name, active, kind, condition, priority, as_needed)
       VALUES (?, 'Warfarin', 1, 'medication', 'daily', 'high', 0)`
    ).run(profileId);
    addFoodTarget(profileId, "leafy_greens", 5);
    logServing(profileId, "leafy_greens", anchor); // 1 of 5 → behind

    const findings = buildFoodHabitFindings(profileId);
    expect(findings).toHaveLength(1);
    expect(findings[0].dedupeKey).toBe(foodHabitSignalKey("leafy_greens"));
    // Parity with the medication surface: the exact vitamin-K advice appears.
    const medAdvice = matchFoodInteractions({
      name: "Warfarin",
      rxcui: null,
      rxcuiIngredients: null,
    }).find((h) => h.key === "vitamin-k-warfarin")!.advice;
    expect(findings[0].detail).toContain(medAdvice);
    expect(findings[0].detail).toContain("You take Warfarin");
    // The encouragement is still present alongside the warning.
    expect(findings[0].detail).toContain("1 of 5");
  });
});

// ---- Reflection guard: every builder key parses against the registry --------

describe("rule-findings builders — dedupeKey prefix registry (#448)", () => {
  it("every emitted dedupeKey belongs to a known builder namespace", () => {
    const { profileId, anchor } = makeProfile("reflection-448");

    // Seed enough cross-domain state to make each builder emit at least one finding.
    // (a) adherence: a long-lived Friday-miss dose.
    const longAgo = `${shiftDateStr(anchor, -90)} 09:00:00`;
    const item = Number(
      db
        .prepare(
          `INSERT INTO intake_items (profile_id, name, active, kind, condition, priority, as_needed, created_at)
           VALUES (?, 'Ref Magnesium', 1, 'supplement', 'daily', 'high', 0, ?)`
        )
        .run(profileId, longAgo).lastInsertRowid
    );
    const dose = Number(
      db
        .prepare(
          `INSERT INTO intake_item_doses (item_id, amount, time_of_day, food_timing, sort, created_at)
           VALUES (?, '1 cap', 'evening', 'any', 0, ?)`
        )
        .run(item, longAgo).lastInsertRowid
    );
    const logTaken = db.prepare(
      `INSERT INTO intake_item_logs (dose_id, item_id, date, status) VALUES (?, ?, ?, 'taken')`
    );
    for (let i = 55; i >= 0; i--) {
      const date = shiftDateStr(anchor, -i);
      if (!isFriday(date)) logTaken.run(dose, item, date);
    }

    // (b) training plateau (merged curl, as above).
    const insAct = db.prepare(
      `INSERT INTO activities (profile_id, date, type, title, duration_min)
       VALUES (?, ?, 'strength', 'Arms', 30)`
    );
    const insSet = db.prepare(
      `INSERT INTO exercise_sets (activity_id, exercise, set_number, weight_kg, reps)
       VALUES (?, ?, 1, 30, 5)`
    );
    for (const s of [
      { day: -35, ex: "Barbell Curl" },
      { day: -28, ex: "Curl" },
      { day: -14, ex: "Barbell Curl" },
      { day: 0, ex: "Curl" },
    ]) {
      const actId = Number(
        insAct.run(profileId, shiftDateStr(anchor, s.day)).lastInsertRowid
      );
      insSet.run(actId, s.ex);
    }

    // (c) body hygiene: an out-and-back weight glitch.
    const insWeight = db.prepare(
      `INSERT INTO body_metrics (profile_id, date, weight_kg) VALUES (?, ?, ?)`
    );
    insWeight.run(profileId, shiftDateStr(anchor, -3), 80.0);
    insWeight.run(profileId, shiftDateStr(anchor, -2), 176.4);
    insWeight.run(profileId, shiftDateStr(anchor, -1), 80.2);

    // (d) goal pacing: a weight-loss goal trending away.
    const insW2 = db.prepare(
      `INSERT INTO body_metrics (profile_id, date, weight_kg, source) VALUES (?, ?, ?, 'manual')`
    );
    for (let wk = 12; wk >= 0; wk--) {
      insW2.run(
        profileId,
        shiftDateStr(anchor, -wk * 7 - 100),
        90 + (12 - wk) * 0.1
      );
    }
    db.prepare(
      `INSERT INTO goals (profile_id, title, category, status, archived, body_metric, target_value, target_date, baseline_value)
       VALUES (?, 'Ref Cut', 'body', 'active', 0, 'weight', 84, ?, 90)`
    ).run(profileId, shiftDateStr(anchor, 60));

    // (e) nutrition output: a currently-low omega-3 → a food-suggest finding.
    db.prepare(
      `INSERT INTO medical_records
         (profile_id, date, category, name, value, unit, canonical_name, flag)
       VALUES (?, ?, 'lab', 'Omega-3 EPA', '0.3', '% by wt', 'Omega-3 EPA', 'low')`
    ).run(profileId, anchor);

    // (f) nutrition input: a behind food-habit target → a food-habit finding.
    db.prepare(
      `INSERT INTO frequency_targets (profile_id, scope_kind, scope_value, per_week)
       VALUES (?, 'food_group', 'fatty_fish', 2)`
    ).run(profileId);

    const findings = [
      ...buildAdherencePatternFindings(profileId, anchor),
      ...buildTrainingObservationFindings(profileId, anchor),
      ...buildMuscleVolumeFindings(profileId, anchor),
      ...buildGoalPacingFindings(profileId, anchor),
      ...buildBodyHygieneFindings(profileId, anchor, "kg"),
      ...buildFoodSuggestionFindings(profileId),
      ...buildFoodHabitFindings(profileId),
    ];
    const keys = findings.map((f) => f.dedupeKey);

    // At least one finding fired in each domain, and EVERY key parses against the
    // known prefix registry (so a page's prefix-guarded dismiss action can match it).
    expect(keys.length).toBeGreaterThan(0);
    expect(keys.some((k) => k.startsWith(ADHERENCE_PREFIX))).toBe(true);
    for (const f of findings) {
      const k = f.dedupeKey;
      expect(dedupeKeyHasKnownPrefix(k), `unguardable dedupeKey: ${k}`).toBe(
        true
      );
      // #860 Track A — tier binding: these are all coaching-tier builders, so every
      // key must resolve to the "coaching" tier in the registry. A builder registered
      // under the wrong tier (or unregistered) fails here.
      expect(tierForDedupeKey(k), `wrong/absent tier: ${k}`).toBe("coaching");
      // Reason-source binding: any #656 Reason a builder attaches must have its code
      // declared for this prefix (these builders declare none, so must carry none).
      const declared = declaredReasonCodesFor(k) ?? [];
      for (const r of f.reasons ?? []) {
        expect(
          declared as readonly string[],
          `undeclared reason "${r.code}" on ${k}`
        ).toContain(r.code);
      }
    }
  });
});

// #449 — the dashboard "Coaching observations" rollup renders collectCoachingFindings,
// which must be the EXACT union of the four tab builders (same dedupeKeys) so a dismiss
// on either surface silences the other through the shared bus. This pins that the
// aggregator forks nothing: same keys, same guardability.
describe("collectCoachingFindings — the #449 unified rollup", () => {
  it("returns the exact union of the four builders, with guardable keys", () => {
    const { profileId, anchor } = makeProfile("rollup-449");

    // A long-lived Friday-miss dose → an adherence finding (the cheapest domain to
    // provoke deterministically); one firing domain is enough to prove union parity.
    const longAgo = `${shiftDateStr(anchor, -90)} 09:00:00`;
    const item = Number(
      db
        .prepare(
          `INSERT INTO intake_items (profile_id, name, active, kind, condition, priority, as_needed, created_at)
           VALUES (?, 'Rollup Magnesium', 1, 'supplement', 'daily', 'high', 0, ?)`
        )
        .run(profileId, longAgo).lastInsertRowid
    );
    const dose = Number(
      db
        .prepare(
          `INSERT INTO intake_item_doses (item_id, amount, time_of_day, food_timing, sort, created_at)
           VALUES (?, '1 cap', 'evening', 'any', 0, ?)`
        )
        .run(item, longAgo).lastInsertRowid
    );
    const logTaken = db.prepare(
      `INSERT INTO intake_item_logs (dose_id, item_id, date, status) VALUES (?, ?, ?, 'taken')`
    );
    for (let i = 55; i >= 0; i--) {
      const date = shiftDateStr(anchor, -i);
      if (!isFriday(date)) logTaken.run(dose, item, date);
    }

    const union = [
      ...buildTrainingObservationFindings(profileId, anchor),
      ...buildMuscleVolumeFindings(profileId, anchor),
      ...buildBodyHygieneFindings(profileId, anchor, "kg"),
      ...buildGoalPacingFindings(profileId, anchor),
      ...buildAdherencePatternFindings(profileId, anchor),
      ...buildFoodSuggestionFindings(profileId),
      ...buildFoodHabitFindings(profileId),
    ].map((f) => f.dedupeKey);

    const rolled = collectCoachingFindings(profileId, anchor, "kg").map(
      (f) => f.dedupeKey
    );

    // Same set of keys (order-independent): the rollup is a formatter over the same
    // computation, not a second engine that can drift.
    expect([...rolled].sort()).toEqual([...union].sort());
    expect(rolled.length).toBeGreaterThan(0);
    for (const k of rolled) {
      expect(dedupeKeyHasKnownPrefix(k), `unguardable dedupeKey: ${k}`).toBe(
        true
      );
      // #860 Track A — tier binding: everything collectCoachingFindings aggregates is
      // coaching tier by definition (#449). A builder added to the rollup but
      // registered `care` (or unregistered) fails CI here.
      expect(tierForDedupeKey(k), `not coaching-tier: ${k}`).toBe("coaching");
    }
  });
});

// #706 — the diabetes↔periodontitis coaching observation. A builder that GATHERS
// the active-conditions state and hands "has diabetes" to the pure decision engine,
// per the #448 findings-builder rule (one fixture per builder, end-to-end output).
describe("buildOralHealthFindings — diabetes↔periodontitis note (#706)", () => {
  it("emits nothing for a profile without diabetes", () => {
    const { profileId } = makeProfile("oral-no-dm");
    expect(buildOralHealthFindings(profileId)).toEqual([]);
  });

  it("emits the calm, guardable note for a profile with active diabetes", () => {
    const { profileId } = makeProfile("oral-dm");
    db.prepare(
      `INSERT INTO conditions (profile_id, name, status)
         VALUES (?, 'Type 2 diabetes mellitus', 'active')`
    ).run(profileId);

    const findings = buildOralHealthFindings(profileId);
    expect(findings).toHaveLength(1);
    expect(findings[0].dedupeKey).toBe(periodontalObservationKey());
    expect(findings[0].tone).toBe("info");
    expect(dedupeKeyHasKnownPrefix(findings[0].dedupeKey)).toBe(true);
    // #860 Track A — registered coaching tier.
    expect(tierForDedupeKey(findings[0].dedupeKey)).toBe("coaching");
    // Coaching tier: it flows through the unified rollup (never a push, never hero).
    const rolled = collectCoachingFindings(
      profileId,
      today(profileId),
      "kg"
    ).map((f) => f.dedupeKey);
    expect(rolled).toContain(periodontalObservationKey());
  });

  it("does not fire for a RESOLVED diabetes condition", () => {
    const { profileId } = makeProfile("oral-dm-resolved");
    db.prepare(
      `INSERT INTO conditions (profile_id, name, status)
         VALUES (?, 'Type 2 diabetes mellitus', 'resolved')`
    ).run(profileId);
    expect(buildOralHealthFindings(profileId)).toEqual([]);
  });
});
