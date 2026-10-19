import { IMPORTED } from "@/lib/logged-via";

import { activityClockHHMM } from "@/lib/activity-meta";
import { sqlNow } from "@/lib/clock";
import { isRealIsoDate } from "@/lib/date";
import { db, today, writeTx } from "@/lib/db";
import { getEquipment } from "@/lib/equipment";
import {
  applyImportFollowups,
  persistDocumentlessImport,
} from "@/lib/import-persist";
import { extractionToPersistInput } from "@/lib/import-shape";
import { isStrengthTrainingRelevant } from "@/lib/life-stage";
import { suggestTitle } from "@/lib/lifts";
import {
  type ExtractedImmunization,
  type ExtractedResult,
  type ExtractionMeta,
} from "@/lib/medical-extract";
import { revalidateRoute } from "@/lib/revalidate";
import { getProfileAge, getUnitPrefs } from "@/lib/settings";
import { toKg } from "@/lib/units";
import { type ExtractedWorkout } from "@/lib/workout-extract";

// AI-supplied dates: require a real ISO calendar date (shape + validity) before
// it lands in a YYYY-MM-DD column.
const isIsoDate = isRealIsoDate;

// Step 2a: import confirmed workouts into activities + exercise_sets. Each
// workout becomes one strength activity; weights convert to kg from their
// source unit (falling back to the user's preferred unit).
export function commitWorkoutsCore(
  profileId: number,
  loginId: number,
  workouts: ExtractedWorkout[]
): { ok: true; workouts: number; sets: number } | { ok: false; error: string } {
  const profile = { id: profileId };
  const login = { id: loginId };
  if (!isStrengthTrainingRelevant(getProfileAge(profile.id)))
    return {
      ok: false,
      error:
        "Strength workout imports aren’t available for this profile’s age.",
    };
  if (!Array.isArray(workouts) || workouts.length === 0)
    return { ok: false, error: "Nothing to import." };

  const prefs = getUnitPrefs(login.id);
  // Resolve the extracted equipment name to a user-defined row (case-insensitive).
  // includeRetired: an imported set that names retired gear should still link to
  // the existing row rather than losing its implement (issue #341).
  const equipByName = new Map(
    getEquipment(profile.id, { includeRetired: true }).map((e) => [
      e.name.trim().toLowerCase(),
      e,
    ])
  );
  // `created_at` is BOUND from the clock seam rather than left to the column's
  // `datetime('now')` DEFAULT (#2287) — workout presence reads it as the row's
  // first-seen instant and subtracts it from a seam-derived now.
  const insertActivity = db.prepare(
    `INSERT INTO activities
       (date, type, title, notes, intensity, start_time, end_time, duration_min, profile_id, created_at, logged_via)
     VALUES (?, 'strength', ?, ?, ?, ?, ?, ?, ?, ?, ?)`
  );
  const insertSet = db.prepare(
    `INSERT INTO exercise_sets
       (activity_id, exercise, set_number, weight_kg, reps, weight_kg_right, reps_right,
        duration_sec, duration_sec_right, target_reps, to_failure, equipment_id)
     VALUES (?,?,?,?,?,?,?,?,NULL,?,?,?)`
  );

  let nWorkouts = 0;
  let nSets = 0;
  writeTx(() => {
    for (const w of workouts) {
      const sets = Array.isArray(w?.sets)
        ? w.sets.filter((s) => s?.exercise?.trim())
        : [];
      if (sets.length === 0) continue;
      const exNames = [...new Set(sets.map((s) => s.exercise.trim()))];
      const date = isIsoDate(w.date) ? w.date : today(profile.id);
      const title = w.title?.trim() || suggestTitle(exNames);
      const aid = Number(
        insertActivity.run(
          date,
          title,
          w.notes ?? null,
          w.intensity ?? null,
          // The extractor's contract deliberately accepts "HH:MM" OR an ISO timestamp
          // from a source document — a training log legitimately contains either. The
          // COLUMN takes one shape, a profile-local HH:MM (lib/time-columns.ts), so
          // the fold happens here at the persist boundary rather than by narrowing
          // what a document may say; anything else lands NULL (#2245).
          activityClockHHMM(w.start_time),
          activityClockHHMM(w.end_time),
          w.duration_min ?? null,
          profile.id,
          sqlNow(),
          // A bulk training-log IMPORT, not a session anybody tapped (#3087).
          //
          // `source` STAYS NULL HERE, RULED 2026-09-01 (#3808, question 2) rather
          // than left open (#3566): this action receives only the extracted
          // workouts — no document id is in scope to build a `document:<n>` from —
          // and plumbing one through was overruled. The two flips it would buy
          // (Trends folds series by `source`; lib/activity-draft.ts reads
          // `source != null` as "not a draft") are not worth attribution nobody has
          // asked for. lib/logged-via.ts's `import` sentence says "where known"
          // because of these rows; this note is the record of why they are the
          // exception, and it is not a TODO.
          IMPORTED
        ).lastInsertRowid
      );
      const counters: Record<string, number> = {};
      for (const s of sets) {
        const ex = s.exercise.trim();
        counters[ex] = (counters[ex] ?? 0) + 1;
        const unit = s.weight_unit ?? prefs.weightUnit;
        // Logged weight is the TOTAL load as-is — the bar's own weight is never
        // added, so weight / 1RM / volume numbers stay consistent with the source.
        const weightKg = s.weight != null ? toKg(s.weight, unit) : null;
        const weightKgRight =
          s.weight_right != null ? toKg(s.weight_right, unit) : null;
        const equip = s.equipment
          ? equipByName.get(s.equipment.trim().toLowerCase())
          : undefined;
        insertSet.run(
          aid,
          ex,
          counters[ex],
          weightKg,
          s.reps ?? null,
          weightKgRight,
          s.reps_right ?? null,
          s.duration_sec ?? null,
          s.target_reps ?? null,
          s.to_failure ?? null,
          equip?.id ?? null
        );
        nSets++;
      }
      nWorkouts++;
    }
  });

  revalidateRoute("/training");
  revalidateRoute("/");
  return { ok: true, workouts: nWorkouts, sets: nSets };
}

// Step 2b: import a confirmed paste/CSV extraction. This routes the SAME
// extraction output a file upload produces through the SAME persist core
// (persistDocumentlessImport), so a pasted weight/body-fat reading reaches
// body_metrics (weight charts / growth card), a height/head-circ lands in
// metric_samples, and a pasted prescription is projected into a structured
// intake_items medication — none of which the old direct-INSERT paste path did
// (#418). There is no stored document, so the rows carry a NULL document_id and a
// NULL/'manual' source (manual-like) and are deliberately exempt from the
// import-footprint clear/reassign/tally contract (see persistDocumentlessImport).
export function commitBiomarkersCore(
  profileId: number,
  results: ExtractedResult[],
  meta: ExtractionMeta | null,
  immunizations?: ExtractedImmunization[]
):
  | {
      ok: true;
      count: number;
      immCount: number;
      bodyMetricCount: number;
      medCount: number;
      sampleCount: number;
    }
  | { ok: false; error: string } {
  const profile = { id: profileId };
  const rows = Array.isArray(results) ? results : [];
  const imms = Array.isArray(immunizations) ? immunizations : [];
  if (rows.length === 0 && imms.length === 0)
    return { ok: false, error: "Nothing to import." };

  const fallbackDate = isIsoDate(meta?.document_date)
    ? meta.document_date
    : today(profile.id);

  // Reduce the raw extraction to the one canonical PersistInput shape — the SAME
  // adapter the file-upload path uses — so body-metric / height / head-circ /
  // prescription routing all come for free. `raw`/`model` are unused by the
  // documentless writer (no medical_documents row) but the "done" shape requires
  // them, so pass empty placeholders.
  const input = extractionToPersistInput(
    {
      status: "done",
      meta: meta ?? {
        document_type: null,
        source: null,
        patient_name: null,
        patient_sex: null,
        patient_birthdate: null,
        patient_age: null,
        document_date: null,
      },
      results: rows,
      immunizations: imms,
      // The paste/CSV path carries tabular results + immunizations only — no
      // clinical-narrative domains (those come from the AI document extractor).
      conditions: [],
      allergies: [],
      procedures: [],
      encounters: [],
      familyHistory: [],
      carePlanItems: [],
      careGoals: [],
      drops: [],
      model: "",
      raw: "",
    },
    fallbackDate
  );

  // One transaction inside the persist core: an immunization-only paste still
  // saves, and a mid-commit failure rolls back everything so a retry can't
  // duplicate already-committed rows.
  const outcome = persistDocumentlessImport(profile.id, input);

  // Register canonical names, backfill the profile (sex/birthdate/name) when
  // unset, and reconcile flags — the same follow-ups every document import runs
  // (shared with lib/import-persist so the two can't drift). These records are
  // standalone (document_id NULL), but the follow-ups are document-agnostic.
  const adopted = applyImportFollowups(profile.id, {
    demographics: input.demographics,
    canonicalNames: input.canonicalNamesToRegister,
    insertedObservationIds: outcome.insertedObservationIds,
  });
  const sampleCount =
    outcome.heightCount + outcome.headCircCount + outcome.waistCircCount;
  revalidateRoute("/results");
  revalidateRoute("/data");
  revalidateRoute("/");
  if (outcome.immCount) revalidateRoute("/records");
  if (outcome.bodyMetricCount || sampleCount) {
    revalidateRoute("/trends");
    // Height / head-circumference samples land on the growth charts, which are a
    // route of their own (the old standalone /body page is long gone). The waist
    // sample lands on /trends, already revalidated above.
    revalidateRoute("/trends/growth");
  }
  if (outcome.medCount) revalidateRoute("/medications");
  if (adopted.changed) revalidateRoute("/settings");
  return {
    ok: true,
    count: outcome.recCount,
    immCount: outcome.immCount,
    bodyMetricCount: outcome.bodyMetricCount,
    medCount: outcome.medCount,
    sampleCount,
  };
}
