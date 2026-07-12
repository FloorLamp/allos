"use server";
import { requireWriteAccess } from "@/lib/auth";

import { revalidatePath } from "next/cache";
import { db } from "@/lib/db";
import {
  formError,
  formOk,
  type FormResult,
  type BodyMetricKind,
  type GoalMetric,
} from "@/lib/types";
import { getUnitPrefs } from "@/lib/settings";
import { toKg, resolveWeightKg } from "@/lib/units";
import { parseSeconds } from "@/lib/duration";
import { BODY_METRIC_LABELS, isGoalStatus } from "@/lib/goals";
import {
  getLatestBodyMetric,
  dismissFinding,
  restoreFinding,
} from "@/lib/queries";
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
  revalidatePath("/training");
  return formOk();
}

// All goal columns parsed from the create/edit form, or null when the input is
// invalid (so create/update can bail without writing). Shared by createGoal and
// updateGoal so the two stay in lockstep.
interface GoalCols {
  title: string;
  description: string | null;
  category: string | null;
  target_date: string | null;
  exercise: string | null;
  metric: GoalMetric | null;
  target_weight_kg: number | null;
  target_reps: number | null;
  target_sets: number | null;
  target_duration_sec: number | null;
  target_value: number | null;
  current_value: number | null;
  unit: string | null;
  body_metric: BodyMetricKind | null;
}

// The prior canonical (kg) weight values for the goal being edited, so an
// untouched lb-preference edit re-stores the exact stored kg instead of drifting
// it by the display-rounding quantum (issue #194). Null/absent on create.
interface StoredWeights {
  target_weight_kg: number | null;
  target_value: number | null;
}

function goalColsFromForm(
  formData: FormData,
  loginId: number,
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

  if (kind === "exercise") {
    const exercise = String(formData.get("exercise") ?? "").trim();
    const metric = String(formData.get("metric") ?? "").trim() as GoalMetric;
    const ALLOWED: GoalMetric[] = ["weight", "reps", "sets", "hold"];
    if (!exercise || !ALLOWED.includes(metric)) return null;
    const prefs = getUnitPrefs(loginId);
    const weightUser = num("target_weight");
    const targetWeightKg =
      weightUser != null
        ? resolveWeightKg(
            weightUser,
            stored?.target_weight_kg,
            prefs.weightUnit
          )
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

    return {
      title: String(formData.get("title") ?? "").trim() || exercise,
      description: str("description"),
      category: "strength",
      target_date: str("target_date"),
      exercise,
      metric,
      target_weight_kg: targetWeightKg,
      target_reps: targetReps,
      target_sets: targetSets,
      target_duration_sec: targetDurationSec,
      target_value: null,
      current_value: null,
      unit: null,
      body_metric: null,
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
        ? resolveWeightKg(
            raw,
            stored?.target_value,
            getUnitPrefs(loginId).weightUnit
          )
        : raw;
    return {
      title:
        String(formData.get("title") ?? "").trim() ||
        `${BODY_METRIC_LABELS[bm]} goal`,
      description: str("description"),
      category: "body",
      target_date: str("target_date"),
      exercise: null,
      metric: null,
      target_weight_kg: null,
      target_reps: null,
      target_sets: null,
      target_duration_sec: null,
      target_value: target,
      current_value: null,
      unit: null,
      body_metric: bm,
    };
  }

  // Freeform goal.
  const title = String(formData.get("title") ?? "").trim();
  if (!title) return null;
  return {
    title,
    description: str("description"),
    category: str("category"),
    target_date: str("target_date"),
    exercise: null,
    metric: null,
    target_weight_kg: null,
    target_reps: null,
    target_sets: null,
    target_duration_sec: null,
    target_value: num("target_value"),
    current_value: num("current_value") ?? 0,
    unit: str("unit"),
    body_metric: null,
  };
}

const GOAL_COLS =
  "title, description, category, target_date, exercise, metric, " +
  "target_weight_kg, target_reps, target_sets, target_duration_sec, " +
  "target_value, current_value, unit, body_metric";

function goalValues(c: GoalCols) {
  return [
    c.title,
    c.description,
    c.category,
    c.target_date,
    c.exercise,
    c.metric,
    c.target_weight_kg,
    c.target_reps,
    c.target_sets,
    c.target_duration_sec,
    c.target_value,
    c.current_value,
    c.unit,
    c.body_metric,
  ];
}

export async function createGoal(formData: FormData): Promise<FormResult> {
  const { login, profile } = await requireWriteAccess();
  const c = goalColsFromForm(formData, login.id);
  if (!c) return formError("Check the goal's required fields and try again.");
  // Body goals capture the metric's current value as the baseline, so progress
  // can run baseline → target (handling reduction goals).
  const baseline = c.body_metric
    ? getLatestBodyMetric(profile.id, c.body_metric)
    : null;
  db.prepare(
    `INSERT INTO goals (${GOAL_COLS}, baseline_value, profile_id, status)
     VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?, ?, ?, 'active')`
  ).run(...goalValues(c), baseline, profile.id);
  revalidatePath("/training");
  revalidatePath("/");
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
      "SELECT target_weight_kg, target_value FROM goals WHERE id = ? AND profile_id = ?"
    )
    .get(id, profile.id) as StoredWeights | undefined;
  const c = goalColsFromForm(formData, login.id, stored);
  if (!c) return formError("Check the goal's required fields and try again.");
  // baseline_value is intentionally left untouched on edit — the starting point
  // for progress shouldn't move when the target is tweaked.
  db.prepare(
    `UPDATE goals SET
       title = ?, description = ?, category = ?, target_date = ?, exercise = ?, metric = ?,
       target_weight_kg = ?, target_reps = ?, target_sets = ?, target_duration_sec = ?,
       target_value = ?, current_value = ?, unit = ?, body_metric = ?
     WHERE id = ? AND profile_id = ?`
  ).run(...goalValues(c), id, profile.id);
  revalidatePath("/training");
  revalidatePath("/");
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
  revalidatePath("/training");
  revalidatePath("/");
  return formOk();
}

export async function setStatus(formData: FormData): Promise<FormResult> {
  const { profile } = await requireWriteAccess();
  const id = Number(formData.get("id"));
  const status = String(formData.get("status"));
  if (!id) return formError("Couldn't find that goal.");
  if (!isGoalStatus(status)) return formError("Unknown goal status.");
  db.prepare("UPDATE goals SET status = ? WHERE id = ? AND profile_id = ?").run(
    status,
    id,
    profile.id
  );
  revalidatePath("/training");
  revalidatePath("/");
  return formOk();
}

// Archiving is independent of status, so an achieved goal stays achieved.
export async function setArchived(formData: FormData): Promise<FormResult> {
  const { profile } = await requireWriteAccess();
  const id = Number(formData.get("id"));
  if (!id) return formError("Couldn't find that goal.");
  const archived = String(formData.get("archived")) === "1" ? 1 : 0;
  db.prepare(
    "UPDATE goals SET archived = ? WHERE id = ? AND profile_id = ?"
  ).run(archived, id, profile.id);
  revalidatePath("/training");
  revalidatePath("/");
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
  revalidatePath("/training");
  revalidatePath("/");
  return formOk();
}
