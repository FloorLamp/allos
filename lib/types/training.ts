// Training / activities domain types (activities, exercise sets, equipment,
// body metrics, goals, frequency targets). Split out of lib/types.ts (#319); the
// `@/lib/types` barrel re-exports everything here, so import paths are unchanged.

// Type-only import (erased at compile) from the lift catalog, which imports nothing
// — no runtime cycle. Routine day `focus` is a MuscleRegion[].
import type { MuscleRegion } from "../lifts";

// `recovery` (issue #840, folding in #344) is the HABIT-tier mobility/flexibility
// session — one activity row whose `components` are the tapped moves, no per-move
// sets/weights. Distinct from the performance-tier strength/cardio/sport types: it
// never carries volume/1RM semantics and mobility coverage is kept a separate view
// from strength coverage (#482: trained ≠ mobilized).
export type ActivityType = "strength" | "cardio" | "sport" | "recovery";

export interface Activity {
  id: number;
  date: string;
  type: ActivityType;
  title: string;
  notes: string | null;
  duration_min: number | null;
  distance_km: number | null;
  intensity: string | null;
  start_time: string | null;
  end_time: string | null;
  components: string | null; // JSON ActivityComponent[]
  created_at: string;
  // Last-edited timestamp (issue #11); NULL until the row is first updated. Same
  // UTC datetime form as created_at.
  updated_at: string | null;
  // Integration provenance + idempotent dedup key. NULL for manual entries; set
  // for imported rows (e.g. source 'health-connect', external_id 'health-connect:<start>').
  source: string | null;
  external_id: string | null;
  // 1 when a source-owned (imported) row has been hand-edited; 0/NULL otherwise.
  edited: number | null;
  // Richer per-activity metrics from pull integrations (Strava). All nullable:
  // NULL for manual entries / providers that don't supply them. Power, cadence,
  // and kilojoules are populated for cycling only; avg_temp_c for any outdoor
  // activity; workout_type is a label ('race' | 'long run' | 'workout').
  avg_hr: number | null;
  max_hr: number | null;
  elevation_m: number | null;
  avg_speed_kmh: number | null;
  max_speed_kmh: number | null;
  relative_effort: number | null;
  avg_power_w: number | null;
  max_power_w: number | null;
  weighted_avg_power_w: number | null;
  avg_cadence: number | null;
  avg_temp_c: number | null;
  kilojoules: number | null;
  workout_type: string | null;
  // ESTIMATED calorie burn for a MANUAL activity (issue #151): the auto-value the
  // activity form fills from the MET dataset × nearest bodyweight × duration, or the
  // user's manual override of it. NULL for legacy/seed rows and every imported row —
  // device energy lives in metric_samples (active_kcal), never here, so an estimate
  // can't shadow a measured value. Distinct from `kilojoules` (Strava mechanical
  // work). See lib/calorie-estimate.ts.
  est_calories: number | null;
  // The piece of gear the whole SESSION was performed with (Equipment.id), or NULL
  // (issue #342). Session-level — a ride's bike, a run's shoes, a sauna session's
  // sauna — distinct from the per-set implement link (exercise_sets.equipment_id),
  // which stays for strength. deleteEquipment nulls this so a removed row's history
  // survives; the FK is enforced (migration 019).
  equipment_id: number | null;
}

// A single component of a (possibly multi-type) activity. Strength components
// carry their sets in exercise_sets (keyed by name); others carry distance/duration.
export interface ActivityComponent {
  name: string;
  type: ActivityType;
  distance_km: number | null;
  duration_min: number | null;
}

// Parse an activity's stored `components` JSON into a components array. Centralizes
// the try/catch + array-guard that was open-coded at every read site (the journal
// feed, the editor seed, the validator, the icon resolver, the goal/effort queries).
// Absent (null/empty), malformed, or non-array JSON all yield [] — a caller that
// must distinguish "no components list at all" from "an empty list" checks the raw
// string's presence itself (`raw ? parseComponents(raw) : null`), since a valid
// stored "[]" and a malformed blob both parse to []. The elements are trusted to be
// ActivityComponent-shaped (we only ever write JSON.stringify(ActivityComponent[])).
export function parseComponents(
  json: string | null | undefined
): ActivityComponent[] {
  if (!json) return [];
  try {
    const parsed = JSON.parse(json);
    return Array.isArray(parsed) ? (parsed as ActivityComponent[]) : [];
  } catch {
    return [];
  }
}

export interface ExerciseSet {
  id: number;
  activity_id: number;
  exercise: string;
  set_number: number;
  weight_kg: number | null;
  reps: number | null;
  // Right-side load for per-side (asymmetric) unilateral sets. NULL for normal
  // bilateral sets; when present, weight_kg/reps are the left side.
  weight_kg_right: number | null;
  reps_right: number | null;
  // Hold time (seconds) for timed exercises (planks, dead hangs); NULL for
  // rep-based sets. *_right is the right side of a per-side timed hold.
  duration_sec: number | null;
  duration_sec_right: number | null;
  // Declared intent for rep-based sets: the planned rep count, or "to failure"
  // (AMRAP, 1 = true). NULL when no intent was declared.
  target_reps: number | null;
  to_failure: number | null;
  // The user-defined implement this set was performed with (Equipment.id), or
  // NULL when no specific implement is recorded. Informational: stored weight_kg
  // is always the TOTAL load regardless of the implement.
  equipment_id: number | null;
  // Warmup flag (issue #338): 1 marks a ramp-up/warmup set. A warmup is stored
  // and shown but INERT to every derived metric — target judgment, volume,
  // records/e1RM, plateau series, and the next-set seed all exclude it. NOT NULL
  // DEFAULT 0, so imported/legacy rows are working sets exactly as before.
  warmup: number;
  // Optional per-set RPE (Rate of Perceived Exertion) on the 5–10 half-point
  // scale (issue #743), or NULL when unlogged. Composes with target_reps/
  // to_failure; the anchor set's rating modifies the next-set progression.
  rpe: number | null;
}

// A user-defined piece of equipment (a custom bar/implement). `weight_kg` is the
// implement's own weight (kg, nullable), kept for reference only — logged set
// weights are always the TOTAL load, so the bar weight is never added in.
export interface Equipment {
  id: number;
  name: string;
  weight_kg: number | null;
  category: string | null;
  // Soft-retire flag (0/1), mirroring intake_item_doses.retired: a retired row is
  // hidden from pickers/recency-defaulting but keeps labelling historical sets
  // (see lib/equipment.ts). Sold/broken gear is retired, not deleted, so "which bar
  // did I PR on" survives. Hard delete stays available for genuine mistakes.
  retired: number;
  created_at: string;
}

// Equipment types — ONE deliberate, fixed set (issue #341), enforced by a DB CHECK
// on equipment.category (migration 018) so the TS union and the DB constraint can't
// drift (parity pinned in lib/__db_tests__/enum-parity.test.ts). Grouped by kind via
// kindOf() below: strength, cardio, recovery, other. Only "Barbell" enables the
// plate builder (isBarbell). NULL is a legal stored value (category unknown).
export const EQUIPMENT_CATEGORIES = [
  "Barbell",
  "Dumbbell",
  "Kettlebell",
  "Machine",
  "Bike",
  "Shoes",
  "Sauna",
  "Cold plunge",
  "Red light",
  "Massage device",
  "Other",
] as const;
export type EquipmentCategory = (typeof EQUIPMENT_CATEGORIES)[number];

// The functional grouping a category belongs to. Lets pickers filter by context
// (a strength log offers strength implements; #345's recommendations reason over
// recovery gear) without hard-coding category lists at each call site.
export type EquipmentKind = "strength" | "cardio" | "recovery" | "other";

const EQUIPMENT_KIND: Record<EquipmentCategory, EquipmentKind> = {
  Barbell: "strength",
  Dumbbell: "strength",
  Kettlebell: "strength",
  Machine: "strength",
  Bike: "cardio",
  Shoes: "cardio",
  Sauna: "recovery",
  "Cold plunge": "recovery",
  "Red light": "recovery",
  "Massage device": "recovery",
  Other: "other",
};

// The kind of an equipment category (case-insensitive). An unknown/NULL category
// reads as "other" — the safe default for legacy or unclassified rows.
export function kindOf(category: string | null | undefined): EquipmentKind {
  const c = (category ?? "").trim().toLowerCase();
  const match = EQUIPMENT_CATEGORIES.find((x) => x.toLowerCase() === c);
  return match ? EQUIPMENT_KIND[match] : "other";
}

// Whether an equipment row is a barbell (case-insensitive); gates plate builder.
export function isBarbell(category: string | null | undefined): boolean {
  return (category ?? "").trim().toLowerCase() === "barbell";
}

// One dated body-metrics row (table: body_metrics). weight_kg is nullable
// so a row can carry only body fat and/or resting HR (a vitals panel or wearable
// with no scale weight). Distinct from BodyMetricKind below, which names *which*
// metric a value is (weight / body_fat / resting_hr).
export interface BodyMetric {
  id: number;
  date: string;
  weight_kg: number | null;
  body_fat_pct: number | null;
  resting_hr: number | null;
  notes: string | null;
  // Integration provenance: NULL for manual entries, set (e.g. 'health-connect')
  // for imported rows so ingest can keep at most one imported row per day.
  // Rows imported from an uploaded medical document use 'document:<id>'.
  source: string | null;
  // 1 when a source-owned (imported) row has been hand-edited, so ingest leaves it
  // alone on re-sync (#133); 0/NULL otherwise. Drives the edit-lock badge (#659).
  edited: number | null;
}

// A body-metrics row with its provenance resolved for display: document-sourced
// rows carry the document's id (for linking) and a human label (its lab/provider,
// doc type, or filename); integration ids resolve to the integration's display
// name; manual rows label as "Manual".
export interface BodyMetricWithSource extends BodyMetric {
  source_label: string;
  document_id: number | null;
}

// Achievement state. Archiving is a separate flag (Goal.archived) so an achieved
// goal stays achieved when filed away. The runtime array is the single source of
// truth for the union AND the goals.status CHECK (migration 016); the enum-parity
// DB test (lib/__db_tests__/enum-parity.test.ts) fails if the two drift.
export const GOAL_STATUSES = ["active", "achieved"] as const;
export type GoalStatus = (typeof GOAL_STATUSES)[number];

// Exercise-linked goals measure one of these; progress is auto-derived from sets.
export type GoalMetric = "weight" | "reps" | "sets" | "hold";
// Which body metric a body goal targets (and the metric-kind selector shared by
// getLatestBodyMetric and the document-import classifier in body-metric-extract).
export type BodyMetricKind = "weight" | "body_fat" | "resting_hr";

export interface Goal {
  id: number;
  title: string;
  description: string | null;
  category: string | null;
  target_value: number | null;
  current_value: number | null;
  unit: string | null;
  target_date: string | null;
  status: GoalStatus;
  created_at: string;
  // Exercise-linked goal fields (all null for freeform goals). A goal is
  // exercise-linked when `exercise` and `metric` are both set.
  exercise: string | null;
  metric: GoalMetric | null;
  target_weight_kg: number | null;
  target_reps: number | null;
  target_sets: number | null;
  target_duration_sec: number | null;
  // Body-metric goal fields (null otherwise). A goal is body-linked when
  // `body_metric` is set; progress runs baseline_value → target_value.
  body_metric: BodyMetricKind | null;
  baseline_value: number | null;
  // Filed away (0/1). Independent of status, so achieved goals stay achieved.
  archived: number;
}

// region/group/type are training scopes (muscle region, body group, activity type);
// food_group (#580) is a food-habit scope (a lib/food-groups.json slug) whose progress
// is the #579 weekly serving rollup; mobility_region (#840) is a mobility-habit scope
// (a MuscleRegion) whose progress counts recovery-session mobilized days — SEPARATE from
// `region` (#482: trained ≠ mobilized). Same target table, different data sources.
export type FrequencyScopeKind =
  | "region"
  | "group"
  | "type"
  | "food_group"
  | "mobility_region";

// A user-defined "hit X at least N times/week" target.
export interface FrequencyTarget {
  id: number;
  scope_kind: FrequencyScopeKind;
  scope_value: string;
  per_week: number;
  created_at: string;
}

// ── Routines (#738, migration 039) ─────────────────────────────────────────────
// A routine is a declarative, user-owned program the user ADOPTS (from the
// lib/routine-templates.ts catalog) or AUTHORS. Templates and custom routines share
// ONE runtime representation: adopting a template copies it into these tables, after
// which it is indistinguishable from a hand-authored routine (#559: the engine
// resolves and fills it, it never invents one).
export type RoutineSource = "template" | "custom";

// A routine row. `focus`/`candidates` on the children are JSON-decoded into arrays
// by the query layer (their DB columns are JSON TEXT).
export interface Routine {
  id: number;
  name: string;
  source: RoutineSource;
  // The catalog id when source='template' (else null); purely provenance — after
  // adoption the copied rows are the source of truth.
  template_id: string | null;
  // At most ONE routine per profile is active (enforced in the write core).
  active: number;
  // Set on activation (profile-local date); null before first activation.
  started_date: string | null;
  // Rotation cursor into routine_days; advanced by session crediting (#740), reset
  // to 0 on activation.
  position: number;
  // Mesocycle length in weeks; NULL = no cycle. Inert until #741.
  cycle_weeks: number | null;
  created_at: string;
}

// A day within a routine (e.g. "Push day"). `focus` is the muscle regions the day
// targets, used for session crediting and coverage.
export interface RoutineDay {
  id: number;
  routine_id: number;
  ordinal: number;
  label: string;
  focus: MuscleRegion[];
}

// One exercise slot within a day. `candidates` is an ordered list of exercise names
// (catalog or custom); the recommendation engine (#740) fills the slot with the
// first candidate the user can actually do.
export interface RoutineSlot {
  id: number;
  routine_day_id: number;
  ordinal: number;
  candidates: string[];
  sets: number;
  rep_min: number;
  rep_max: number;
}

// A routine with its days and each day's slots — the shape the builder (#739) and
// recommendation (#740) read.
export interface RoutineWithDays extends Routine {
  days: (RoutineDay & { slots: RoutineSlot[] })[];
}

// Outcome of saveActivity (issue #332). The activity form auto-saves, so it must
// confirm ONLY a save that actually persisted. Previously a validation failure
// (`return;`) or a failed ownership check (`return null`) reached the client as
// `undefined`, which persist() read as success — it advanced its saved signature,
// showed "Saved ✓" and marked the form clean, so the auto-saver never retried and
// the user's edits were silently lost. The action now answers with the persisted
// outcome (same principle as the DoseTakenOutcome convention below): never
// unconditionally confirm; report what really happened.
export type SaveActivityOutcome =
  | { ok: true; id: number } // row inserted/updated; `id` is its row id
  // "restricted": the active profile is below the instance min_training_age (#488) —
  // the view/edit/delete surfaces are hidden for it, so the create path refuses too,
  // rather than persisting an activity its owner can never see.
  | { ok: false; reason: "invalid" | "not-owned" | "restricted" };
