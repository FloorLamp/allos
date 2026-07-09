// Shared fixture builder for the query smoke tests (lib/__db_tests__). NOT a test
// file (the config only collects *.test.ts), so it's never executed on its own.
//
// It seeds a minimal but cross-domain set of rows for one profile via direct
// inserts (modeled on scripts/seed.ts) and returns the ids, so a test can call a
// representative read from each query module and assert the seeded shape comes
// back. Every value is tagged with a caller-supplied `tag` string so a two-profile
// scoping test can prove profile A's reads never surface profile B's rows.
//
// Importing this pulls in the `db` singleton — which is already redirected at the
// per-file temp DB by lib/__db_tests__/setup.ts (a setupFile that runs before any
// test module loads), so this touches only the throwaway database.

import { db, today } from "@/lib/db";

export interface SeededProfile {
  profileId: number;
  tag: string;
  todayStr: string;
  strengthActivityId: number;
  cardioActivityId: number;
  supplementId: number;
  supplementDoseId: number;
  medicationId: number;
  goalId: number;
  documentId: number;
  glucoseValueNum: number;
  weightKg: number;
  /** A vaccine code carrying a `declined` override, for the immunization read. */
  declinedVaccine: string;
  /** A vaccine code with a seeded dose. */
  dosedVaccine: string;
}

export interface SeedOpts {
  weightKg?: number;
  /** Glucose reading; the default (130) is above the canonical ref_high (99) so
   *  reconcileFlags derives a 'high' flag. */
  glucoseValueNum?: number;
  /** Units on hand for the tracked supplement (default 8 → below the 10-day
   *  low-supply threshold, so the refill read reports "low"). */
  quantityOnHand?: number;
}

// Insert a profile plus a handful of rows across every domain module, returning
// their ids. `tag` is embedded in text columns (titles/names) so scoping asserts
// can distinguish two profiles' rows.
export function seedProfile(tag: string, opts: SeedOpts = {}): SeededProfile {
  const weightKg = opts.weightKg ?? 80;
  const glucoseValueNum = opts.glucoseValueNum ?? 130;
  const quantityOnHand = opts.quantityOnHand ?? 8;
  const declinedVaccine = "hpv";
  const dosedVaccine = "mmr";

  const seed = db.transaction((): SeededProfile => {
    const profileId = Number(
      db.prepare("INSERT INTO profiles (name) VALUES (?)").run(tag)
        .lastInsertRowid
    );
    const todayStr = today(profileId);

    // ---- training: a strength session (with sets) + a cardio session ----
    const strengthActivityId = Number(
      db
        .prepare(
          `INSERT INTO activities (profile_id, date, type, title, duration_min)
           VALUES (?, ?, 'strength', ?, 45)`
        )
        .run(profileId, todayStr, `${tag} Strength Day`).lastInsertRowid
    );
    db.prepare(
      `INSERT INTO exercise_sets (activity_id, exercise, set_number, weight_kg, reps)
       VALUES (?, 'Back Squat', 1, 100, 5)`
    ).run(strengthActivityId);
    db.prepare(
      `INSERT INTO exercise_sets (activity_id, exercise, set_number, weight_kg, reps)
       VALUES (?, 'Back Squat', 2, 100, 5)`
    ).run(strengthActivityId);

    const cardioActivityId = Number(
      db
        .prepare(
          `INSERT INTO activities (profile_id, date, type, title, duration_min, distance_km)
           VALUES (?, ?, 'cardio', ?, 30, 5)`
        )
        .run(profileId, todayStr, `${tag} Run`).lastInsertRowid
    );

    // ---- metrics: a weigh-in + an integration steps sample ----
    db.prepare(
      `INSERT INTO body_metrics (profile_id, date, weight_kg) VALUES (?, ?, ?)`
    ).run(profileId, todayStr, weightKg);
    db.prepare(
      `INSERT INTO metric_samples
         (profile_id, source, metric, date, start_time, end_time, value)
       VALUES (?, 'health-connect', 'steps', ?, ?, ?, 8000)`
    ).run(profileId, todayStr, `${todayStr}T00:00`, `${todayStr}T23:59`);

    // ---- medical / biomarkers: a Glucose reading (canonical, chartable) +
    //      a star + a source document ----
    db.prepare(
      `INSERT INTO medical_records
         (profile_id, date, category, name, value, unit, canonical_name, value_num, panel)
       VALUES (?, ?, 'lab', 'Glucose', ?, 'mg/dL', 'Glucose', ?, 'Metabolic')`
    ).run(profileId, todayStr, String(glucoseValueNum), glucoseValueNum);
    db.prepare(
      `INSERT INTO starred_biomarkers (profile_id, canonical_name) VALUES (?, 'Glucose')`
    ).run(profileId);
    const documentId = Number(
      db
        .prepare(
          `INSERT INTO medical_documents
             (profile_id, filename, stored_path, extraction_status, doc_type)
           VALUES (?, ?, '', 'done', 'lab')`
        )
        .run(profileId, `${tag}-labs.pdf`).lastInsertRowid
    );

    // ---- immunizations: an MMR dose + a declined override on another vaccine ----
    db.prepare(
      `INSERT INTO immunizations (profile_id, date, vaccine, dose_label)
       VALUES (?, '2001-06-01', ?, '1')`
    ).run(profileId, dosedVaccine);
    db.prepare(
      `INSERT INTO immunization_overrides (profile_id, vaccine, kind, reason)
       VALUES (?, ?, 'declined', 'not tracking')`
    ).run(profileId, declinedVaccine);

    // ---- intake: a tracked supplement (with a dose + a taken log) + a medication ----
    const supplementId = Number(
      db
        .prepare(
          `INSERT INTO intake_items
             (profile_id, name, active, kind, condition, priority, quantity_on_hand, qty_per_dose)
           VALUES (?, ?, 1, 'supplement', 'daily', 'high', ?, 1)`
        )
        .run(profileId, `${tag} Vitamin D`, quantityOnHand).lastInsertRowid
    );
    const supplementDoseId = Number(
      db
        .prepare(
          `INSERT INTO intake_item_doses
             (supplement_id, amount, time_of_day, food_timing, sort)
           VALUES (?, '1 cap', 'morning', 'any', 0)`
        )
        .run(supplementId).lastInsertRowid
    );
    db.prepare(
      `INSERT INTO intake_item_logs (dose_id, supplement_id, date) VALUES (?, ?, ?)`
    ).run(supplementDoseId, supplementId, todayStr);

    const medicationId = Number(
      db
        .prepare(
          `INSERT INTO intake_items
             (profile_id, name, active, kind, condition, priority, prescriber, as_needed)
           VALUES (?, ?, 1, 'medication', 'daily', 'high', 'Dr Who', 0)`
        )
        .run(profileId, `${tag} Lisinopril`).lastInsertRowid
    );
    db.prepare(
      `INSERT INTO intake_item_doses
         (supplement_id, amount, time_of_day, food_timing, sort)
       VALUES (?, '10 mg', 'morning', 'any', 0)`
    ).run(medicationId);

    // ---- goals: an active freeform goal ----
    const goalId = Number(
      db
        .prepare(
          `INSERT INTO goals (profile_id, title, category, status, archived)
           VALUES (?, ?, 'strength', 'active', 0)`
        )
        .run(profileId, `${tag} Squat 140`).lastInsertRowid
    );

    return {
      profileId,
      tag,
      todayStr,
      strengthActivityId,
      cardioActivityId,
      supplementId,
      supplementDoseId,
      medicationId,
      goalId,
      documentId,
      glucoseValueNum,
      weightKg,
      declinedVaccine,
      dosedVaccine,
    };
  });

  return seed();
}
