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
} from "@/lib/rule-findings";
import {
  weekdayMissSignalKey,
  ADHERENCE_PREFIX,
} from "@/lib/adherence-patterns";
import { TRAINING_OBS_PREFIX } from "@/lib/training-observations";
import { weightAnomalySignalKey } from "@/lib/weight-anomaly";
import { getBodyMetricDailySeries, getWeights, getGoals } from "@/lib/queries";
import { projectGoal, type GoalProjection } from "@/lib/trend-projection";
import { PACE_SLACK_DAYS, GOAL_PACE_WINDOW_DAYS } from "@/lib/goal-pacing";
import { dedupeKeyHasKnownPrefix } from "@/lib/rule-finding-prefixes";

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
    // trap dose (its window starts at the re-time, below the min-history gate).
    expect(findings).toHaveLength(1);
    expect(findings[0].dedupeKey).toBe(weekdayMissSignalKey(ctrlDose, 5));
    expect(
      findings.some((f) => f.dedupeKey === weekdayMissSignalKey(trapDose, 5))
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

    const keys = [
      ...buildAdherencePatternFindings(profileId, anchor),
      ...buildTrainingObservationFindings(profileId, anchor),
      ...buildGoalPacingFindings(profileId, anchor),
      ...buildBodyHygieneFindings(profileId, anchor, "kg"),
    ].map((f) => f.dedupeKey);

    // At least one finding fired in each domain, and EVERY key parses against the
    // known prefix registry (so a page's prefix-guarded dismiss action can match it).
    expect(keys.length).toBeGreaterThan(0);
    expect(keys.some((k) => k.startsWith(ADHERENCE_PREFIX))).toBe(true);
    for (const k of keys) {
      expect(dedupeKeyHasKnownPrefix(k), `unguardable dedupeKey: ${k}`).toBe(
        true
      );
    }
  });
});
