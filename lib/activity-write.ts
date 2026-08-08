// Auth-blind write core for saving an activity (create-or-update, issue #1596).
// Extracted VERBATIM from app/(app)/training/activity-actions.ts::saveActivity so
// the offline replay path can run byte-for-byte the same validation + persistence
// the live form does (the lib/offline/writes.ts contract — one implementation, no
// second drift-prone copy of the rules). Takes profileId first and never imports
// lib/auth: the saveActivity Server Action owns the auth gate (requireSession +
// gateItemProfile) and the cache revalidation; the replay route owns its own
// session + per-intent write-access check. Everything else — the age-gate, the
// title/date guard, unit conversion honoring the CAPTURED unit (#630), the
// composite rollup (#313/#1202), the ownership re-check on an untrusted id, the
// #194 stored-kg snapshot, routine crediting (#740), and the post-workout dose
// dispatch (#1154) — happens HERE, identically for both callers.
//
// Synchronous on purpose: the offline replay applies each queued intent inside one
// IMMEDIATE transaction (lib/offline/writes.ts::applyIntent), and better-sqlite3
// turns this core's own writeTx into a SAVEPOINT there, so a replayed create still
// commits or rolls back atomically with its idempotency-key record.

import { db, today, writeTx } from "@/lib/db";
import { sqlNow } from "@/lib/clock";
import { queuePostWorkoutDispatch } from "@/lib/notifications/post-workout-queue";
import type { ActivityType, SaveActivityOutcome } from "@/lib/types";
import type { WeightUnit, DistanceUnit } from "@/lib/settings";
import {
  toKg,
  toKm,
  resolveWeightKg,
  submittedWeightUnit,
  submittedDistanceUnit,
  type Km,
} from "@/lib/units";
import { minutesBetween, compositeRollup } from "@/lib/activity-meta";
import { isRealIsoDate } from "@/lib/date";
import { isTrainingRestricted, isActivityTypeAllowed } from "@/lib/age-gate";
import { regionForExercise, type MuscleRegion } from "@/lib/lifts";
import { creditRoutineSession } from "@/lib/routines";
import { cleanupOrphanPrDismissals } from "@/lib/queries/upcoming/suppressions";
import { canonicalRpe } from "@/lib/rpe";

interface SetInput {
  exercise: string;
  // Weight is submitted in the user's preferred unit; converted to kg here.
  weight: number | null;
  reps: number | null;
  // Right-side load for per-side (asymmetric) sets; null for bilateral sets.
  weightRight: number | null;
  repsRight: number | null;
  // Hold time (seconds) for timed exercises; null for rep-based sets.
  durationSec: number | null;
  durationSecRight: number | null;
  // User-defined implement for this set (Equipment.id), or null. Manual entry
  // treats the weight as TOTAL load, so no bar weight is added here.
  equipmentId: number | null;
  // Declared intent: planned rep count, or "to failure" (AMRAP). Optional —
  // older clients and integrations don't send them.
  targetReps?: number | null;
  toFailure?: boolean;
  // Warmup flag (#338): a ramp-up set, excluded from working-set math. Optional
  // (older clients/imports don't send it — such sets stay working sets).
  warmup?: boolean;
  // Optional logged RPE (5–10) for the set (#743). Canonicalized to a half-point
  // value at the write boundary (lib/rpe.ts); absent/off-scale ⇒ stored NULL.
  rpe?: number | null;
}

// The stored canonical (kg) loads of the activity's existing sets before an edit
// replaces them, keyed by `${exercise}#${set_number}`. Lets an untouched edit
// re-store the exact stored kg instead of drifting it by the display-rounding
// quantum on every kg↔lb round-trip (issue #194). Empty/absent on create.
type StoredSetWeights = Map<
  string,
  { weight_kg: number | null; weight_kg_right: number | null }
>;
const setKey = (exercise: string, setNumber: number) =>
  `${exercise}#${setNumber}`;

function writeSets(
  activityId: number,
  formData: FormData,
  weightUnit: "kg" | "lb",
  stored?: StoredSetWeights
) {
  const raw = formData.get("sets");
  if (!raw) return;
  let sets: SetInput[] = [];
  try {
    sets = JSON.parse(String(raw));
  } catch {
    sets = [];
  }
  const setStmt = db.prepare(
    `INSERT INTO exercise_sets
       (activity_id, exercise, set_number, weight_kg, reps, weight_kg_right, reps_right,
        duration_sec, duration_sec_right, equipment_id, target_reps, to_failure, warmup, rpe)
     VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?)`
  );
  const counters: Record<string, number> = {};
  for (const s of sets) {
    if (!s.exercise?.trim()) continue;
    const ex = s.exercise.trim();
    counters[ex] = (counters[ex] ?? 0) + 1;
    const prior = stored?.get(setKey(ex, counters[ex]));
    setStmt.run(
      activityId,
      ex,
      counters[ex],
      s.weight != null
        ? resolveWeightKg(s.weight, prior?.weight_kg, weightUnit)
        : null,
      s.reps ?? null,
      s.weightRight != null
        ? resolveWeightKg(s.weightRight, prior?.weight_kg_right, weightUnit)
        : null,
      s.repsRight ?? null,
      s.durationSec ?? null,
      s.durationSecRight ?? null,
      s.equipmentId ?? null,
      // Canonicalize intent at the write boundary (like toKg above): a target
      // must be a positive integer, and an AMRAP set carries no target —
      // otherwise a stray 0 would make every session judge as "hit target".
      !s.toFailure && Number.isInteger(s.targetReps) && s.targetReps! > 0
        ? s.targetReps
        : null,
      s.toFailure ? 1 : null,
      // Warmup flag (#338): canonicalize to 0/1 at the write boundary (the
      // column is NOT NULL DEFAULT 0).
      s.warmup ? 1 : 0,
      // RPE (#743): snap to a half point / reject off-scale at the boundary; the
      // CHECK (5–10) only ever sees a valid value or NULL.
      canonicalRpe(s.rpe)
    );
  }
}

// Create a new activity, or update an existing one when formData carries an `id`.
// Returns a typed SaveActivityOutcome (issue #332): a validation or ownership
// failure must reach the caller as an explicit `{ ok: false }` — never `undefined`,
// which the auto-saving form once read as success while nothing persisted.
// `fallbackUnits` are the login's stored unit prefs, used only when the form
// didn't stamp the unit each value was CAPTURED in (#630 — older clients).
export function saveActivityCore(
  profileId: number,
  formData: FormData,
  fallbackUnits: { weightUnit: WeightUnit; distanceUnit: DistanceUnit }
): SaveActivityOutcome {
  const profile = { id: profileId };
  const id = formData.get("id") ? Number(formData.get("id")) : null;
  const type = String(formData.get("type")) as ActivityType;
  // Training-restriction gate — TYPE-AWARE (#489, evolving #488). A profile below
  // the instance min_training_age keeps duration-based SPORT/CARDIO logging but
  // still cannot log a STRENGTH session. Authoritative HERE at the write boundary
  // so the create and view paths agree regardless of what the UI offers (a stale
  // editor / command palette / queued offline intent can't slip a strength row
  // past the restriction, nor lose a legitimate sport log).
  if (!isActivityTypeAllowed(type, isTrainingRestricted(profile.id)))
    return { ok: false, reason: "restricted" };
  const title = String(formData.get("title") ?? "").trim();
  const date = String(formData.get("date") ?? "").trim();
  // Reject non-ISO dates server-side too: the client gates on this, but the
  // core must not persist "2026-07" / "Friday" if a bad value slips through.
  if (!title || !isRealIsoDate(date)) return { ok: false, reason: "invalid" };

  // Honor the unit each value was CAPTURED in (issue #630) instead of re-reading
  // the login's pref at write time — a debounced auto-save (or a queued offline
  // intent) can land after the login flipped its unit in another tab, which would
  // mis-convert a correctly-entered set/distance. Falls back to the stored pref
  // when the form didn't send a unit (older clients).
  const weightUnit = submittedWeightUnit(
    formData.get("weight_unit"),
    fallbackUnits.weightUnit
  );
  const distanceUnit = submittedDistanceUnit(
    formData.get("distance_unit"),
    fallbackUnits.distanceUnit
  );
  const notes = (formData.get("notes") as string)?.trim() || null;
  const intensity = (formData.get("intensity") as string)?.trim() || null;
  const startTime = (formData.get("start_time") as string)?.trim() || null;
  const endTime = (formData.get("end_time") as string)?.trim() || null;

  // Components: [{ name, type, distance (user unit) | null, duration_min | null }].
  // NOT parseComponents (issue #334): this is the untrusted FORM payload whose
  // `distance` is in the user's unit and gets converted to `distance_km` below — a
  // different shape from the stored ActivityComponent[] that parseComponents returns.
  let rawComponents: {
    name: string;
    type: ActivityType;
    distance: number | null;
    duration_min: number | null;
  }[] = [];
  try {
    rawComponents = JSON.parse(String(formData.get("components") ?? "[]"));
  } catch {
    rawComponents = [];
  }
  // Numeric fields arrive from parsed JSON and may be strings ("5") — coerce with
  // Number + a finiteness guard so a string can't concatenate in the reduces below
  // or persist as a string, and a garbage value becomes null rather than NaN.
  const num = (v: unknown): number | null => {
    if (v == null || v === "") return null;
    const n = Number(v);
    return Number.isFinite(n) ? n : null;
  };
  // The PERSISTED component shape (it is what `components` JSON stores). `distance_km`
  // is annotated with the canonical brand (#2149) so that dropping the `toKm` below —
  // writing the submitted display-unit number straight into storage, the exact silent
  // corruption a units-preference app is prone to — stops compiling.
  const components: {
    name: string;
    type: ActivityType;
    distance_km: Km | null;
    duration_min: number | null;
  }[] = rawComponents
    .filter((c) => c.name?.trim())
    .map((c) => {
      const distance = num(c.distance);
      return {
        name: c.name.trim(),
        type: c.type,
        distance_km: distance != null ? toKm(distance, distanceUnit) : null,
        duration_min: num(c.duration_min),
      };
    });
  const componentsJson = components.length ? JSON.stringify(components) : null;

  // Roll the legs up into the parent's distance + the two formalized times via the
  // shared compositeRollup (#313/#1202): sum-of-parts distance, ACTIVE duration
  // (Σ legs for cardio, the entered total for strength — the clock span is no longer
  // preferred, so a benign edit can't flip a paused import's active up to its
  // rest-inflated elapsed), and ELAPSED (the clock span, kept only when ≥ active).
  const clockDurationMin =
    startTime && endTime ? minutesBetween(startTime, endTime) : null;
  const enteredDurationValue = num(formData.get("duration_min"));
  const enteredDurationMin =
    enteredDurationValue != null && enteredDurationValue > 0
      ? enteredDurationValue
      : null;
  const {
    distanceKm: rolledDistanceKm,
    durationMin,
    elapsedMin,
    hasStrength,
  } = compositeRollup(
    components,
    clockDurationMin ?? enteredDurationMin,
    clockDurationMin
  );
  // Σ of the legs' kilometres is kilometres — but ARITHMETIC erases the brand, since
  // TypeScript cannot know that km + km is km while km × km is not. So the rollup's
  // total is re-minted here through the identity conversion (free at runtime) to keep
  // the value bound into `activities.distance_km` a `Km` (#2149).
  const distanceKm: Km | null =
    rolledDistanceKm == null ? null : toKm(rolledDistanceKm, "km");
  const explicitComponentDuration = components.reduce(
    (total, component) => total + (component.duration_min ?? 0),
    0
  );
  if (
    hasStrength &&
    durationMin != null &&
    explicitComponentDuration > durationMin
  )
    return { ok: false, reason: "invalid" };

  // Estimated calories (issue #151): the activity form fills this from the MET
  // dataset × nearest bodyweight × duration, and the user can override it. Stored
  // ONLY for MANUAL activities (a fresh insert is always manual; an edit only sets
  // it when the row is source-null, below) so an estimate never shadows a device
  // value. A blank/invalid field clears it. Rounded, non-negative.
  const estCalories = (() => {
    const n = num(formData.get("est_calories"));
    return n != null && n >= 0 ? Math.round(n) : null;
  })();

  // Session-level equipment link (issue #342): the gear the whole activity used —
  // a bike for a ride, shoes for a run. Untrusted, so resolve it to an id THIS
  // profile actually owns (equipment is profile-owned); a blank/foreign/garbage
  // value becomes null rather than writing a dangling or cross-profile FK.
  const equipmentId = (() => {
    const raw = formData.get("equipment_id");
    if (raw == null || String(raw).trim() === "") return null;
    const n = Number(raw);
    if (!Number.isInteger(n) || n <= 0) return null;
    const owned = db
      .prepare("SELECT 1 FROM equipment WHERE id = ? AND profile_id = ?")
      .get(n, profile.id);
    return owned ? n : null;
  })();

  const activityId = writeTx((): number | null => {
    let activityId: number;
    let storedSets: StoredSetWeights | undefined;
    if (id) {
      // Verify the activity belongs to this profile before touching it or its
      // sets — the form id is untrusted. Bail (no-op) when it isn't owned.
      const owned = db
        .prepare("SELECT 1 FROM activities WHERE id = ? AND profile_id = ?")
        .get(id, profile.id);
      if (!owned) return null;
      db.prepare(
        `UPDATE activities
         SET date = ?, type = ?, title = ?, notes = ?, duration_min = ?, elapsed_min = ?, distance_km = ?,
             intensity = ?, start_time = ?, end_time = ?, components = ?,
             equipment_id = ?,
             -- Estimated calories (issue #151): only for MANUAL rows (source +
             -- external_id null) so an estimate never overwrites an imported row's
             -- device energy; imported rows keep their existing value untouched.
             est_calories = CASE WHEN source IS NULL AND external_id IS NULL
                                 THEN ? ELSE est_calories END,
             -- Stamp last-edited (UTC, same form as created_at) so the Journal can
             -- show "edited …" alongside "added …" (issue #11). Bound from the
             -- CLOCK SEAM (#2287), not SQL's own clock: this column is the LIVENESS
             -- signal computeWorkoutPresence reads (lastTouchMs), and it subtracts it
             -- from a seam-derived now. A row stamped by SQL's real clock and read
             -- against a frozen now answers "quiet for 58 minutes" about a draft
             -- saved seconds ago, which is the stale-dock defect #2287 reproduced.
             updated_at = ?,
             -- Mark integration-owned rows as hand-edited so re-ingest won't
             -- clobber this edit (no-op for manual rows: source/external_id null).
             edited = CASE WHEN source IS NOT NULL OR external_id IS NOT NULL
                           THEN 1 ELSE edited END
         WHERE id = ? AND profile_id = ?`
      ).run(
        date,
        type,
        title,
        notes,
        durationMin,
        elapsedMin,
        distanceKm,
        intensity,
        startTime,
        endTime,
        componentsJson,
        equipmentId,
        estCalories,
        sqlNow(),
        id,
        profile.id
      );
      activityId = id;
      // Snapshot the existing sets' canonical loads keyed by (exercise, set
      // number) BEFORE replacing them, so an untouched edit re-stores the exact
      // stored kg rather than drifting it on a kg↔lb round-trip (issue #194).
      storedSets = new Map();
      for (const row of db
        .prepare(
          "SELECT exercise, set_number, weight_kg, weight_kg_right FROM exercise_sets WHERE activity_id = ?"
        )
        .all(id) as {
        exercise: string;
        set_number: number;
        weight_kg: number | null;
        weight_kg_right: number | null;
      }[]) {
        storedSets.set(setKey(row.exercise, row.set_number), {
          weight_kg: row.weight_kg,
          weight_kg_right: row.weight_kg_right,
        });
      }
      // Replace sets wholesale (parent ownership verified above).
      db.prepare("DELETE FROM exercise_sets WHERE activity_id = ?").run(id);
    } else {
      // `created_at` is BOUND below, not left to the column's own SQL-clock DEFAULT
      // (#2287). It is the first-seen instant computeWorkoutPresence falls back to
      // while a freshly INSERTed draft has no `updated_at` yet, and it is subtracted
      // from a seam-derived now — so the two have to come off the same clock.
      // `sqlNow()` is byte-identical to what SQLite would have written in production;
      // it only differs where the seam is frozen.
      const res = db
        .prepare(
          `INSERT INTO activities
             (date, type, title, notes, duration_min, elapsed_min, distance_km, intensity, start_time, end_time, components, equipment_id, est_calories, profile_id, created_at)
           VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)`
        )
        .run(
          date,
          type,
          title,
          notes,
          durationMin,
          elapsedMin,
          distanceKm,
          intensity,
          startTime,
          endTime,
          componentsJson,
          equipmentId,
          estCalories,
          profile.id,
          sqlNow()
        );
      activityId = Number(res.lastInsertRowid);
    }
    if (hasStrength) writeSets(activityId, formData, weightUnit, storedSets);
    return activityId;
  });
  // The tx returns null when the (untrusted) form id isn't this profile's — the
  // ownership check bailed, so nothing was written. Report it instead of a silent
  // no-op the form would confirm as "Saved ✓".
  if (activityId == null) return { ok: false, reason: "not-owned" };

  // An EDIT can un-back a personal-record celebration's dismissal (#1931): re-spelling
  // a set's exercise, moving it to another implement, or dropping the profile's last
  // set of a movement leaves a `pr:strength:` / `pr:cardio:` suppression row pointing
  // at history that no longer exists — and a name the user later reuses would inherit
  // that stale silence. Sweep here rather than only at the delete seams, because an
  // edit removes backing just as effectively as a delete does. Short-circuits without
  // reading history when the profile holds no PR dismissals (the common case).
  cleanupOrphanPrDismissals(profile.id);

  // Advance the active routine's position when this session credits today's
  // routine day (#740). Derived ENTIRELY from the logged data — the strength
  // regions of the persisted sets (via regionForExercise → LiftDef.region) and
  // whether the activity included cardio — never a stored link column. The write
  // core is once-per-profile-local-day and credited-only; keyed on the activity's
  // date (the profile-local day the session belongs to). Best-effort: a routine
  // hiccup must never fail an otherwise-successful save.
  try {
    const regions: MuscleRegion[] = [];
    if (hasStrength) {
      const seen = new Set<MuscleRegion>();
      for (const row of db
        .prepare(
          "SELECT DISTINCT exercise FROM exercise_sets WHERE activity_id = ?"
        )
        .all(activityId) as { exercise: string }[]) {
        const r = regionForExercise(row.exercise);
        if (r && !seen.has(r)) {
          seen.add(r);
          regions.push(r);
        }
      }
    }
    const hasCardio =
      type === "cardio" || components.some((c) => c.type === "cardio");
    creditRoutineSession(profile.id, date, { regions, hasCardio });
  } catch {
    // Crediting is advisory; swallow so the save still confirms.
  }

  // Delayed post-workout dose dispatch (#1154 §B): a save landing a session on
  // TODAY arms (or RE-arms — finish→unfinish→re-finish coalesces to one send)
  // the ~60s dispatch timer. Covers BOTH the live Finish (end_time just set) and
  // a retroactive completed log. Non-blocking — the caller returns immediately;
  // the timer's fire-time verification skips a row that isn't a completed
  // today-session (a still-live draft, an undone finish), and the hourly tick
  // stays the mandatory backstop if the process restarts inside the window. The
  // shared one-shot marker keeps the two paths to a single send.
  if (date === today(profile.id)) {
    queuePostWorkoutDispatch(profile.id, activityId);
  }

  // Return the row id so the auto-saving form can switch from create to update.
  return { ok: true, id: activityId };
}
