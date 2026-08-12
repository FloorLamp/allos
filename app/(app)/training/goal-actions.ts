"use server";
import { requireWriteAccess } from "@/lib/auth";

import { revalidateRoute } from "@/lib/revalidate";
import { db, writeTx } from "@/lib/db";
import { casUpdate, readForUpdate } from "@/lib/tx";
import { instantNow, sqlNow } from "@/lib/clock";
import {
  formError,
  formOk,
  type FormResult,
  type BodyMetricKind,
  type OutcomeGoalDirection,
  type OutcomeGoalMetric,
} from "@/lib/types";
import { getUnitPrefs } from "@/lib/settings";
import { resolveWeightKg, submittedWeightUnit } from "@/lib/units";
import { parseSeconds } from "@/lib/duration";
import {
  BODY_METRIC_LABELS,
  isOutcomeGoalDirection,
  isOutcomeGoalStatus,
} from "@/lib/outcome-goals";
import { isBiomarkerGoalTargetable } from "@/lib/biomarker-goal";
import { getEquipmentById } from "@/lib/equipment";
import {
  getLatestBodyMetric,
  dismissFinding,
  restoreFinding,
  resolveBiomarkerOptionName,
} from "@/lib/queries";
import {
  biomarkerPlot,
  biomarkerTargetUnit,
} from "@/lib/queries/biomarker-plot";
import { GOAL_PACE_PREFIX, goalPaceSignalKey } from "@/lib/goal-pacing";

// Dismiss a goal-pacing finding (issue #45, domain 6): an off-pace goal or the safe-
// rate weight-loss caution. Hides it through the shared findings-bus suppression
// store, keyed by its `goal-pace:…` dedupeKey. Guarded to the goal-pace namespace so
// this action can only silence a goal-pacing key; profile-scoped via dismissFinding.
// The Goals findings surface on the Training page's goals tab, so it revalidates
// /training.
export async function dismissGoalPacing(
  formData: FormData
): Promise<FormResult> {
  const { profile } = await requireWriteAccess();
  const dedupeKey = String(formData.get("dedupe_key") ?? "").trim();
  if (!dedupeKey.startsWith(GOAL_PACE_PREFIX))
    return formError("Couldn't dismiss that goal-pacing item.");
  dismissFinding(profile.id, dedupeKey);
  revalidateRoute("/training");
  return formOk();
}

// All goal columns parsed from the create/edit form, or null when the input is
// invalid (so create/update can bail without writing). Shared by createGoal and
// updateGoal so the two stay in lockstep.
interface GoalCols {
  title: string;
  description: string | null;
  categoryLabel: string | null;
  target_date: string | null;
  exercise: string | null;
  metric: OutcomeGoalMetric | null;
  equipment_id: number | null;
  target_weight_kg: number | null;
  target_reps: number | null;
  target_sets: number | null;
  target_duration_sec: number | null;
  target_value: number | null;
  current_value: number | null;
  unit: string | null;
  body_metric: BodyMetricKind | null;
  biomarker_name: string | null;
  target_direction: OutcomeGoalDirection | null;
}

// The prior canonical (kg) weight values for the goal being edited, so an
// untouched lb-preference edit re-stores the exact stored kg instead of drifting
// it by the display-rounding quantum (issue #194). Null/absent on create.
// `target_date` rides along so updateGoal can clear a stale off-pace dismissal on
// a re-target (#436).
interface StoredWeights {
  target_weight_kg: number | null;
  target_value: number | null;
  target_date: string | null;
}

function goalColsFromForm(
  formData: FormData,
  loginId: number,
  profileId: number,
  stored?: StoredWeights
): GoalCols | null {
  const kind = String(formData.get("kind") ?? "freeform");
  // Parse to a finite number, or null (so non-numeric input doesn't silently
  // store NaN→NULL and leave the goal stuck at 0%).
  const num = (k: string) => {
    const raw = formData.get(k);
    if (raw == null || String(raw).trim() === "") return null;
    const n = Number(raw);
    return Number.isFinite(n) ? n : null;
  };
  const str = (k: string) => (formData.get(k) as string)?.trim() || null;

  // Honor the unit the weight target was CAPTURED in (issue #630): the form posts
  // the render-time unit, and we trust it over the login's current stored pref so
  // a mid-edit pref flip in another tab can't re-convert a correctly-entered
  // target. Falls back to the stored pref when the field is absent (older client).
  const weightUnit = submittedWeightUnit(
    formData.get("weight_unit"),
    getUnitPrefs(loginId).weightUnit
  );

  if (kind === "exercise") {
    const exercise = String(formData.get("exercise") ?? "").trim();
    const metric = String(
      formData.get("metric") ?? ""
    ).trim() as OutcomeGoalMetric;
    const ALLOWED: OutcomeGoalMetric[] = ["weight", "reps", "sets", "hold"];
    if (!exercise || !ALLOWED.includes(metric)) return null;
    const weightUser = num("target_weight");
    const targetWeightKg =
      weightUser != null
        ? resolveWeightKg(weightUser, stored?.target_weight_kg, weightUnit)
        : null;
    const targetReps = num("target_reps");
    const targetSets = num("target_sets");
    const durStr = String(formData.get("target_duration") ?? "").trim();
    const targetDurationSec = durStr ? parseSeconds(durStr) : null;

    // The metric's primary target must be present and positive, else progress
    // can never be computed (target 0/null → permanently 0%).
    const primary =
      metric === "weight"
        ? targetWeightKg
        : metric === "reps"
          ? targetReps
          : metric === "sets"
            ? targetSets
            : targetDurationSec;
    if (primary == null || primary <= 0) return null;
    if (metric === "sets" && (targetReps == null || targetReps <= 0))
      return null;

    // Optional load context (#1610). Validated against THIS profile's registry, so a
    // hand-posted id can't scope a goal to another profile's machine; an unknown or
    // blank value falls back to NULL — the movement-wide default every pre-#1610 goal
    // already has. Retired rows stay selectable: they still label history, and a goal
    // may legitimately track a machine you've stopped using.
    const equipmentRaw = num("equipment_id");
    const equipmentId =
      equipmentRaw != null &&
      Number.isInteger(equipmentRaw) &&
      getEquipmentById(profileId, equipmentRaw) != null
        ? equipmentRaw
        : null;

    return {
      title: String(formData.get("title") ?? "").trim() || exercise,
      description: str("description"),
      categoryLabel: null,
      target_date: str("target_date"),
      exercise,
      metric,
      equipment_id: equipmentId,
      target_weight_kg: targetWeightKg,
      target_reps: targetReps,
      target_sets: targetSets,
      target_duration_sec: targetDurationSec,
      target_value: null,
      current_value: null,
      unit: null,
      body_metric: null,
      biomarker_name: null,
      target_direction: null,
    };
  }

  if (kind === "body") {
    const bm = String(
      formData.get("body_metric") ?? ""
    ).trim() as BodyMetricKind;
    const ALLOWED: BodyMetricKind[] = ["weight", "body_fat", "resting_hr"];
    if (!ALLOWED.includes(bm)) return null;
    const raw = num("body_target");
    if (raw == null || raw <= 0) return null;
    // Weight target is entered in the user's unit → store canonical kg; body fat
    // (%) and resting HR (bpm) are stored as entered.
    const target =
      bm === "weight"
        ? resolveWeightKg(raw, stored?.target_value, weightUnit)
        : raw;
    return {
      title:
        String(formData.get("title") ?? "").trim() ||
        `${BODY_METRIC_LABELS[bm]} goal`,
      description: str("description"),
      categoryLabel: null,
      target_date: str("target_date"),
      exercise: null,
      metric: null,
      equipment_id: null,
      target_weight_kg: null,
      target_reps: null,
      target_sets: null,
      target_duration_sec: null,
      target_value: target,
      current_value: null,
      unit: null,
      body_metric: bm,
      biomarker_name: null,
      target_direction: null,
    };
  }

  // Biomarker goal (#1853): "LDL under 100 by June". The analyte is validated
  // against the profile's own canonical vocabulary — the SAME ranked option list the
  // picker offered — so a hand-posted name can't create a goal on an analyte the app
  // has no notion of, and the UNIT is resolved server-side from the analyte's own
  // plot rather than trusted from the client. A target's unit is not decoration: a
  // lipid in mg/dL and the same lipid in mmol/L differ by ~39×, so the number is
  // stored beside the unit the series is actually charted in.
  if (kind === "biomarker") {
    const name = String(formData.get("biomarker_name") ?? "").trim();
    const direction = String(formData.get("target_direction") ?? "").trim();
    if (!name || !isOutcomeGoalDirection(direction)) return null;
    const canonical = resolveBiomarkerOptionName(profileId, name);
    // Same membership rule the picker applied, enforced again here: a rule the client
    // alone honours is a rule a hand-posted form ignores, and a "Weight" biomarker
    // goal would be a second way to say what `body_metric` already says.
    if (!canonical || !isBiomarkerGoalTargetable(canonical)) return null;
    const value = num("biomarker_target");
    if (value == null) return null;
    return {
      title:
        String(formData.get("title") ?? "").trim() ||
        `${canonical} ${direction === "below" ? "under" : "over"} ${value}`,
      description: str("description"),
      categoryLabel: null,
      target_date: str("target_date"),
      exercise: null,
      metric: null,
      equipment_id: null,
      target_weight_kg: null,
      target_reps: null,
      target_sets: null,
      target_duration_sec: null,
      target_value: value,
      current_value: null,
      unit: biomarkerTargetUnit(profileId, canonical),
      body_metric: null,
      biomarker_name: canonical,
      target_direction: direction,
    };
  }

  // Freeform goal.
  const title = String(formData.get("title") ?? "").trim();
  if (!title) return null;
  return {
    title,
    description: str("description"),
    categoryLabel: str("category"),
    target_date: str("target_date"),
    exercise: null,
    metric: null,
    equipment_id: null,
    target_weight_kg: null,
    target_reps: null,
    target_sets: null,
    target_duration_sec: null,
    target_value: num("target_value"),
    current_value: num("current_value") ?? 0,
    unit: str("unit"),
    body_metric: null,
    biomarker_name: null,
    target_direction: null,
  };
}

const GOAL_COLS =
  "title, description, category, target_date, exercise, metric, equipment_id, " +
  "target_weight_kg, target_reps, target_sets, target_duration_sec, " +
  "target_value, current_value, unit, body_metric, biomarker_name, target_direction";

function goalValues(c: GoalCols) {
  return [
    c.title,
    c.description,
    c.categoryLabel,
    c.target_date,
    c.exercise,
    c.metric,
    c.equipment_id,
    c.target_weight_kg,
    c.target_reps,
    c.target_sets,
    c.target_duration_sec,
    c.target_value,
    c.current_value,
    c.unit,
    c.body_metric,
    c.biomarker_name,
    c.target_direction,
  ];
}

export async function createGoal(formData: FormData): Promise<FormResult> {
  const { login, profile } = await requireWriteAccess();
  const c = goalColsFromForm(formData, login.id, profile.id);
  if (!c) return formError("Check the goal's required fields and try again.");
  // Measured goals capture their metric's current value as the baseline, so progress
  // can run baseline → target (handling reduction goals). A biomarker goal's baseline
  // is the latest point of the SAME plot its progress will be read from, so the two
  // ends of the bar are guaranteed to be in one unit; null when the profile has no
  // reading yet, which the progress reader handles as a direction-only goal.
  const baseline = c.body_metric
    ? getLatestBodyMetric(profile.id, c.body_metric)
    : c.biomarker_name
      ? (biomarkerPlot(profile.id, c.biomarker_name)?.points.at(-1)?.value ??
        null)
      : null;
  // created_at from the CLOCK SEAM (sqlNow, #1534): with no explicit date this
  // stamp IS the record's Timeline day (`substr(created_at, 1, 10)` /
  // dateFromCreatedAt), compared against `today()`-derived bounds.
  db.prepare(
    `INSERT INTO goals (${GOAL_COLS}, baseline_value, profile_id, status, created_at)
     VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?, ?, ?, 'active', ?)`
  ).run(...goalValues(c), baseline, profile.id, sqlNow());
  revalidateRoute("/training");
  revalidateRoute("/");
  return formOk();
}

export async function updateGoal(formData: FormData): Promise<FormResult> {
  const { login, profile } = await requireWriteAccess();
  const id = Number(formData.get("id"));
  if (!id) return formError("Couldn't find that goal.");
  // Read the stored canonical weight values so an untouched edit is a true no-op
  // (issue #194) instead of a kg↔lb round-trip drift on every save.
  const stored = db
    .prepare(
      "SELECT target_weight_kg, target_value, target_date FROM goals WHERE id = ? AND profile_id = ?"
    )
    .get(id, profile.id) as StoredWeights | undefined;
  const c = goalColsFromForm(formData, login.id, profile.id, stored);
  if (!c) return formError("Check the goal's required fields and try again.");
  // baseline_value is intentionally left untouched on edit — the starting point
  // for progress shouldn't move when the target is tweaked.
  db.prepare(
    `UPDATE goals SET
       title = ?, description = ?, category = ?, target_date = ?, exercise = ?, metric = ?,
       equipment_id = ?,
       target_weight_kg = ?, target_reps = ?, target_sets = ?, target_duration_sec = ?,
       target_value = ?, current_value = ?, unit = ?, body_metric = ?,
       biomarker_name = ?, target_direction = ?
     WHERE id = ? AND profile_id = ?`
  ).run(...goalValues(c), id, profile.id);
  // RE-TARGET clears a stale off-pace dismissal (#436/#203). The `goal-pace:goal:<id>`
  // key encodes the goal, not the target — so dismissing "off pace for Sep 1", then
  // moving the deadline to Dec 1, must not leave the new pacing question silenced by
  // the old dismissal (deleteGoal already sweeps this key; updateGoal did not). A
  // changed target DATE or VALUE is a new question, so drop the suppression row and
  // let the finding re-assess against the new target. A no-op when nothing changed.
  if (
    stored != null &&
    (stored.target_date !== c.target_date ||
      stored.target_value !== c.target_value)
  ) {
    restoreFinding(profile.id, goalPaceSignalKey(id));
  }
  revalidateRoute("/training");
  revalidateRoute("/");
  return formOk();
}

export async function updateProgress(formData: FormData): Promise<FormResult> {
  const { profile } = await requireWriteAccess();
  const id = Number(formData.get("id"));
  const current = formData.get("current_value");
  if (!id) return formError("Couldn't find that goal.");
  if (current == null) return formError("Enter a value.");
  // Reject a non-finite value (empty/garbage) rather than writing NaN, mirroring
  // goalColsFromForm's numeric guard.
  const value = Number(current);
  if (!Number.isFinite(value)) return formError("Enter a valid number.");
  db.prepare(
    "UPDATE goals SET current_value = ? WHERE id = ? AND profile_id = ?"
  ).run(value, id, profile.id);
  revalidateRoute("/training");
  revalidateRoute("/");
  return formOk();
}

// The status flip is a LIFECYCLE transition, so it is changes-checked (#2140): the
// UPDATE's WHERE (id + profile) is the expectation, and a swap that matched no row —
// a forged or since-deleted id — returns the refusal for the menu to render instead
// of an unconditional formOk behind an optimistic "Goal achieved" toast. Re-stating
// the CURRENT status still matches its row and stays idempotent success.
export async function setStatus(formData: FormData): Promise<FormResult> {
  const { profile } = await requireWriteAccess();
  const id = Number(formData.get("id"));
  const status = String(formData.get("status"));
  if (!id) return formError("Couldn't find that goal.");
  if (!isOutcomeGoalStatus(status)) return formError("Unknown goal status.");
  // THE ACHIEVEMENT INSTANT IS WRITTEN HERE, AND ONLY HERE (#2394, migration 182).
  // `status` said WHETHER a goal was reached and nothing said WHEN, so the recap had
  // to window on `target_date` — the deadline — and could therefore announce a goal
  // reached early a month after the fact, never announce one reached late, and never
  // announce a goal with no deadline at all. `achieved_at` is the missing fact.
  //
  // COALESCE, so re-stating an existing `achieved` (the idempotent path this action
  // deliberately keeps as success) does not re-stamp the goal into the current week and
  // announce it a second time. Flipping back to `active` NULLs it: the goal has not been
  // achieved, and reaching it again is a new event with a new instant.
  //
  // instantNow() (lib/clock.ts → lib/date.ts utcInstant), never SQL's own datetime('now')
  // — the column is on the canonical `…Z` convention and comparison is lexical. The
  // guard read shares the IMMEDIATE transaction with the swap (readForUpdate), so the
  // "keep the instant already there" decision cannot race another writer.
  const cas = writeTx((tx) => {
    const prior = readForUpdate<{ achieved_at: string | null }>(
      tx,
      db.prepare(
        "SELECT achieved_at FROM goals WHERE id = ? AND profile_id = ?"
      ),
      id,
      profile.id
    );
    const achievedAt =
      status === "achieved" ? (prior?.achieved_at ?? instantNow()) : null;
    return casUpdate(
      tx,
      db.prepare(
        "UPDATE goals SET status = ?, achieved_at = ? WHERE id = ? AND profile_id = ?"
      ),
      status,
      achievedAt,
      id,
      profile.id
    );
  });
  if (cas.kind === "stale") return formError("Couldn't find that goal.");
  revalidateRoute("/training");
  revalidateRoute("/");
  return formOk();
}

// Archiving is independent of status, so an achieved goal stays achieved.
// Changes-checked like setStatus above (#2140).
export async function setArchived(formData: FormData): Promise<FormResult> {
  const { profile } = await requireWriteAccess();
  const id = Number(formData.get("id"));
  if (!id) return formError("Couldn't find that goal.");
  const archived = String(formData.get("archived")) === "1" ? 1 : 0;
  const cas = writeTx((tx) =>
    casUpdate(
      tx,
      db.prepare(
        "UPDATE goals SET archived = ? WHERE id = ? AND profile_id = ?"
      ),
      archived,
      id,
      profile.id
    )
  );
  if (cas.kind === "stale") return formError("Couldn't find that goal.");
  revalidateRoute("/training");
  revalidateRoute("/");
  return formOk();
}

export async function deleteGoal(formData: FormData): Promise<FormResult> {
  const { profile } = await requireWriteAccess();
  const id = Number(formData.get("id"));
  if (!id) return formError("Couldn't find that goal.");
  db.prepare("DELETE FROM goals WHERE id = ? AND profile_id = ?").run(
    id,
    profile.id
  );
  // Sweep the goal's suppression markers with it (issue #328): the `goal:<id>`
  // Upcoming/timeline dismissal and the `goal-pace:goal:<id>` off-pace finding
  // suppression, both keyed by goal id in upcoming_dismissals. Dead rows rather than
  // wrong suppression (goal ids never recycle), but leaving them stranded is the same
  // marker-sweep inconsistency this issue closes elsewhere. restoreFinding just drops
  // the suppression row by key; profile-scoped.
  restoreFinding(profile.id, `goal:${id}`);
  restoreFinding(profile.id, goalPaceSignalKey(id));
  revalidateRoute("/training");
  revalidateRoute("/");
  return formOk();
}
