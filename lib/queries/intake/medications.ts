// Part of the lib/queries/intake barrel (#319 — same #126 treatment training
// got). The profile-scoping guard walks all of lib/, so these split modules stay
// covered; every read is profile-scoped directly or through the parent
// intake_items JOIN.
// Medication history / lifecycle: courses (episodes), active-flag sync, side
// effects and their promotion to an allergy row.
import { db, writeTx } from "../../db";
import { normalizeSeverity, SEVERITY_LABELS } from "../../medication-history";
import { parsePrescription } from "../../prescription-parse";
import type { MedicationCourse, MedicationSideEffect } from "../../types";

// ---- Medication history / lifecycle ----

// Every medication course for the profile, oldest first per medication. Courses
// are a child of intake_items, so they're scoped through the parent's profile_id.
export function getMedicationCourses(profileId: number): MedicationCourse[] {
  return db
    .prepare(
      `SELECT c.* FROM medication_courses c
         JOIN intake_items ii ON ii.id = c.item_id
        WHERE ii.profile_id = ?
        ORDER BY c.item_id, c.started_on, c.id`
    )
    .all(profileId) as MedicationCourse[];
}

// Every side effect noted for the profile's medications, most-recently-noted
// first per medication. Scoped through the parent intake_items row.
export function getMedicationSideEffects(
  profileId: number
): MedicationSideEffect[] {
  return db
    .prepare(
      `SELECT se.* FROM intake_item_side_effects se
         JOIN intake_items ii ON ii.id = se.item_id
        WHERE ii.profile_id = ?
        ORDER BY se.item_id, se.noted_on DESC, se.id DESC`
    )
    .all(profileId) as MedicationSideEffect[];
}

// Ensure a medication has at least one course, creating an initial course when
// it has none (the "ensure-course-on-create" invariant used by the manual add
// action and the import persist). The course upholds active=1 ⇔ an open course:
// it's left OPEN only when the med is active, and CLOSED (stopped_on = its start
// date) when the med is already paused (active=0) — so flipping a PAUSED
// supplement to a medication lands it in Past, not Current. started_on falls back
// to the med's created_at date when the caller has no better start date. A single
// INSERT...SELECT that is:
//   - profile-scoped (references intake_items WHERE profile_id = ?),
//   - a no-op unless the row is a medication with NO existing course,
// so it's idempotent and safe to call on every create/update. Never touches a
// supplement (kind guard) and never opens a second course.
export function ensureMedicationCourse(
  profileId: number,
  itemId: number,
  startedOn: string | null
): void {
  db.prepare(
    `INSERT INTO medication_courses (item_id, started_on, stopped_on, created_at)
       SELECT ii.id, COALESCE(?, date(ii.created_at)),
              CASE WHEN ii.active = 1
                   THEN NULL
                   ELSE COALESCE(?, date(ii.created_at)) END,
              datetime('now')
         FROM intake_items ii
        WHERE ii.id = ? AND ii.profile_id = ? AND ii.kind = 'medication'
          AND NOT EXISTS (
            SELECT 1 FROM medication_courses c WHERE c.item_id = ii.id
          )`
  ).run(startedOn, startedOn, itemId, profileId);
}

// Create the medication COURSES an import DERIVED from the source's effective
// period(s) + status, and sync the med's `active` flag to
// the resulting course state. The import persist path calls this INSTEAD of
// ensureMedicationCourse when the source carried period(s); it falls back to the
// single ensure-course when it did not. Courses are deduped by (item_id,
// started_on) — a NOT EXISTS guard that also sees the inserts made earlier in
// this same call — so a reprocess (which first deletes the med, cascading its
// courses) or a repeated period never stacks a duplicate. `active` upholds the
// invariant active=1 ⇔ an open (stopped_on IS NULL) course: it is derived from
// what ACTUALLY PERSISTED (a scoped EXISTS-open query AFTER the inserts), NOT from
// the input array — the (item_id, started_on) dedup keeps the FIRST course at a
// shared start, so a `[closed, open]` union at the same start would insert only
// the closed row; reading `active` back from the surviving rows keeps it from
// disagreeing with the persisted courses regardless of dedup/order. Ownership
// (profile + kind='medication') is verified first, so a forged / cross-profile id
// is a no-op. medication_courses is a child of intake_items (scoped via the
// parent), so the INSERT keys on item_id and the active sync is profile_id-scoped
// through intake_items.
export function createImportedMedicationCourses(
  profileId: number,
  itemId: number,
  courses: {
    started_on: string | null;
    stopped_on: string | null;
    stop_reason: string | null;
    notes: string | null;
  }[]
): void {
  if (ownedMedicationId(profileId, itemId) == null) return;
  if (courses.length === 0) return;
  const insert = db.prepare(
    `INSERT INTO medication_courses
       (item_id, started_on, stopped_on, stop_reason, notes, created_at)
     SELECT ?, ?, ?, ?, ?, datetime('now')
      WHERE NOT EXISTS (
        SELECT 1 FROM medication_courses c
         WHERE c.item_id = ? AND c.started_on IS ?
      )`
  );
  writeTx(() => {
    for (const c of courses) {
      insert.run(
        itemId,
        c.started_on,
        c.stopped_on,
        c.stop_reason,
        c.notes,
        itemId,
        c.started_on
      );
    }
    // Sync `active` to the PERSISTED course state (not the input array): 1 iff a
    // surviving course is open. Scoped through intake_items via the UPDATE's
    // profile_id; the EXISTS keys on the child item_id.
    db.prepare(
      `UPDATE intake_items SET active =
         CASE WHEN EXISTS (
           SELECT 1 FROM medication_courses c
            WHERE c.item_id = ? AND c.stopped_on IS NULL
         ) THEN 1 ELSE 0 END
       WHERE id = ? AND profile_id = ?`
    ).run(itemId, itemId, profileId);
  });
}

// Confirm a medication belongs to the profile (kind guard). Returns its id or
// null. The single ownership gate every lifecycle mutation runs first, so the
// child-table statements below can key on item_id alone.
export function ownedMedicationId(
  profileId: number,
  itemId: number
): number | null {
  const row = db
    .prepare(
      "SELECT id FROM intake_items WHERE id = ? AND profile_id = ? AND kind = 'medication'"
    )
    .get(itemId, profileId) as { id: number } | undefined;
  return row ? row.id : null;
}

// Stop a medication: close its open course(s) (stopped_on = date + reason, note
// appended) AND clear the live `active` flag so scheduling/reminders stop.
// Optionally records a side effect linked to the just-closed course. All within
// one transaction. Ownership is verified first; a forged id is a no-op.
export function stopMedicationCourses(
  profileId: number,
  itemId: number,
  opts: {
    date: string;
    reason: string;
    note?: string | null;
    effect?: string | null;
    severity?: string | null;
  }
): void {
  if (ownedMedicationId(profileId, itemId) == null) return;
  writeTx(() => {
    const openCourses = db
      .prepare(
        "SELECT id FROM medication_courses WHERE item_id = ? AND stopped_on IS NULL ORDER BY started_on, id"
      )
      .all(itemId) as { id: number }[];
    db.prepare(
      `UPDATE medication_courses
          SET stopped_on = ?, stop_reason = ?, notes = COALESCE(?, notes)
        WHERE item_id = ? AND stopped_on IS NULL`
    ).run(opts.date, opts.reason, opts.note ?? null, itemId);
    db.prepare(
      "UPDATE intake_items SET active = 0 WHERE id = ? AND profile_id = ?"
    ).run(itemId, profileId);
    if (opts.effect) {
      const courseId = openCourses.length
        ? openCourses[openCourses.length - 1].id
        : null;
      db.prepare(
        `INSERT INTO intake_item_side_effects
           (item_id, course_id, effect, severity, noted_on, resolved)
         VALUES (?,?,?,?,?,0)`
      ).run(itemId, courseId, opts.effect, opts.severity ?? null, opts.date);
    }
  });
}

// Restart a medication: open a NEW course (preserving prior courses) and set
// `active` back on. Guarded so it never stacks a second open course.
export function restartMedicationCourse(
  profileId: number,
  itemId: number,
  date: string
): void {
  if (ownedMedicationId(profileId, itemId) == null) return;
  writeTx(() => {
    const openCount = (
      db
        .prepare(
          "SELECT COUNT(*) AS c FROM medication_courses WHERE item_id = ? AND stopped_on IS NULL"
        )
        .get(itemId) as { c: number }
    ).c;
    if (openCount === 0) {
      db.prepare(
        "INSERT INTO medication_courses (item_id, started_on, stopped_on) VALUES (?,?,NULL)"
      ).run(itemId, date);
    }
    db.prepare(
      "UPDATE intake_items SET active = 1 WHERE id = ? AND profile_id = ?"
    ).run(itemId, profileId);
  });
}

// Keep a medication's course history in sync with a plain active-flag toggle
// (the Pause/Resume control). Pausing closes the open course (no reason);
// resuming opens a fresh one when none is open. Ownership is verified first
// (matching its stop/restart siblings) so a forged / cross-profile id is a no-op.
export function setMedicationActive(
  profileId: number,
  itemId: number,
  active: 0 | 1,
  date: string
): void {
  if (ownedMedicationId(profileId, itemId) == null) return;
  writeTx(() => {
    db.prepare(
      "UPDATE intake_items SET active = ? WHERE id = ? AND profile_id = ?"
    ).run(active, itemId, profileId);
    if (active === 0) {
      db.prepare(
        "UPDATE medication_courses SET stopped_on = ? WHERE item_id = ? AND stopped_on IS NULL"
      ).run(date, itemId);
    } else {
      const openCount = (
        db
          .prepare(
            "SELECT COUNT(*) AS c FROM medication_courses WHERE item_id = ? AND stopped_on IS NULL"
          )
          .get(itemId) as { c: number }
      ).c;
      if (openCount === 0) {
        db.prepare(
          "INSERT INTO medication_courses (item_id, started_on, stopped_on) VALUES (?,?,NULL)"
        ).run(itemId, date);
      }
    }
  });
}

// Add a side effect to a medication. course_id is validated to belong to the same
// medication (else NULL) so a forged id can't cross-link. Ownership verified.
export function insertMedicationSideEffect(
  profileId: number,
  itemId: number,
  opts: {
    effect: string;
    severity?: string | null;
    notedOn: string;
    notes?: string | null;
    courseId?: number | null;
  }
): void {
  if (ownedMedicationId(profileId, itemId) == null) return;
  const courseId =
    opts.courseId != null &&
    db
      .prepare("SELECT 1 FROM medication_courses WHERE id = ? AND item_id = ?")
      .get(opts.courseId, itemId)
      ? opts.courseId
      : null;
  db.prepare(
    `INSERT INTO intake_item_side_effects
       (item_id, course_id, effect, severity, noted_on, notes, resolved)
     VALUES (?,?,?,?,?,?,0)`
  ).run(
    itemId,
    courseId,
    opts.effect,
    opts.severity ?? null,
    opts.notedOn,
    opts.notes ?? null
  );
}

// A side effect owned by the profile (via its parent medication), or undefined.
export function getOwnedSideEffect(
  profileId: number,
  id: number
): { id: number; item_id: number; effect: string } | undefined {
  return db
    .prepare(
      `SELECT se.id, se.item_id, se.effect
         FROM intake_item_side_effects se
         JOIN intake_items ii ON ii.id = se.item_id
        WHERE se.id = ? AND ii.profile_id = ?`
    )
    .get(id, profileId) as
    { id: number; item_id: number; effect: string } | undefined;
}

export function updateMedicationSideEffect(
  profileId: number,
  id: number,
  opts: {
    effect: string;
    severity?: string | null;
    notedOn?: string | null;
    notes?: string | null;
    resolved: 0 | 1;
  }
): void {
  if (!getOwnedSideEffect(profileId, id)) return;
  db.prepare(
    `UPDATE intake_item_side_effects
        SET effect = ?, severity = ?, noted_on = COALESCE(?, noted_on),
            notes = ?, resolved = ?
      WHERE id = ?`
  ).run(
    opts.effect,
    opts.severity ?? null,
    opts.notedOn ?? null,
    opts.notes ?? null,
    opts.resolved,
    id
  );
}

export function toggleMedicationSideEffectResolved(
  profileId: number,
  id: number
): void {
  if (!getOwnedSideEffect(profileId, id)) return;
  db.prepare(
    "UPDATE intake_item_side_effects SET resolved = 1 - resolved WHERE id = ?"
  ).run(id);
}

export function deleteMedicationSideEffect(
  profileId: number,
  id: number
): void {
  if (!getOwnedSideEffect(profileId, id)) return;
  db.prepare("DELETE FROM intake_item_side_effects WHERE id = ?").run(id);
}

// Promote a medication side effect into a manual allergies/intolerance row.
// Reads the effect + its severity off the side effect row, inserts a
// profile-scoped `allergies` row (severity stored as its display label), and
// marks the side effect resolved (kept for the medication's history). Returns
// false when the side effect isn't owned by the profile.
//
// IDEMPOTENT: the allergy row is keyed on a deterministic external_id
// (`med-se:<sideEffectId>`) and inserted with INSERT OR IGNORE, so the per-profile
// partial-unique external_id index dedups a double-click / re-promote to a single
// row — no matter that the row is manual (NULL document_id, so the import
// delete-set never touches it). The UI also hides Promote once the effect is
// resolved.
// "Track this" from the records bridge (issue #817): materialize an imported
// prescription record (medical_records category='prescription') into a structured
// kind='medication' intake_items row — the same projection the import does
// automatically (persistExtractedMedications), applied to ONE user-chosen record.
//
// The created row carries `source='extracted'` + the record's `document_id`, so it
// JOINS the document's import footprint (IMPORT_FOOTPRINT_TABLES keys extracted meds
// by document_id AND source='extracted'): a later reassign moves it and a delete
// removes it with the source document, keeping row side-state whole (#199-#203). A
// record with no document_id yields a durable unlinked med (still source='extracted',
// null document_id). Scheduling is conservative via parsePrescription — a clear sig
// becomes scheduled doses, an unparseable one an as-needed med, never a fabricated
// reminder. Ownership + category are verified (id AND profile_id AND
// category='prescription'); a forged/foreign/non-prescription id is a no-op (null).
// Returns the new med's id + name, or null.
export function createMedicationFromRecord(
  profileId: number,
  recordId: number
): { id: number; name: string } | null {
  const rec = db
    .prepare(
      `SELECT name, value, unit, notes, document_id
         FROM medical_records
        WHERE id = ? AND profile_id = ? AND category = 'prescription'`
    )
    .get(recordId, profileId) as
    | {
        name: string;
        value: string | null;
        unit: string | null;
        notes: string | null;
        document_id: number | null;
      }
    | undefined;
  if (!rec || !rec.name?.trim()) return null;

  const med = parsePrescription({
    name: rec.name,
    value: rec.value,
    unit: rec.unit,
    notes: rec.notes,
  });

  return writeTx(() => {
    const info = db
      .prepare(
        `INSERT INTO intake_items
           (name, notes, active, condition, priority, kind,
            prescriber, pharmacy, rx_number, as_needed,
            document_id, source, profile_id)
         VALUES (?,?,1,'daily','high','medication',?,?,?,?,?,'extracted',?)`
      )
      .run(
        med.name,
        med.sig,
        med.prescriber,
        med.pharmacy,
        med.rxNumber,
        med.asNeeded ? 1 : 0,
        rec.document_id,
        profileId
      );
    const medId = Number(info.lastInsertRowid);
    ensureMedicationCourse(profileId, medId, null);
    const insDose = db.prepare(
      `INSERT INTO intake_item_doses (item_id, amount, time_of_day, food_timing, sort)
       VALUES (?,?,?, 'any', ?)`
    );
    if (!med.asNeeded && med.timeBuckets.length > 0) {
      med.timeBuckets.forEach((bucket, i) =>
        insDose.run(medId, med.strength, bucket, i)
      );
    } else if (med.strength) {
      insDose.run(medId, med.strength, null, 0);
    }
    return { id: medId, name: med.name };
  });
}

export function promoteMedicationSideEffect(
  profileId: number,
  id: number,
  date: string
): boolean {
  const row = db
    .prepare(
      `SELECT se.id, se.effect, se.severity, se.notes, ii.name AS med_name
         FROM intake_item_side_effects se
         JOIN intake_items ii ON ii.id = se.item_id
        WHERE se.id = ? AND ii.profile_id = ?`
    )
    .get(id, profileId) as
    | {
        id: number;
        effect: string;
        severity: string | null;
        notes: string | null;
        med_name: string;
      }
    | undefined;
  if (!row) return false;
  const severity = normalizeSeverity(row.severity);
  const severityLabel = severity ? SEVERITY_LABELS[severity] : null;
  writeTx(() => {
    db.prepare(
      `INSERT OR IGNORE INTO allergies
         (substance, reaction, severity, status, onset_date, notes, source,
          external_id, profile_id)
       VALUES (?,?,?,?,?,?,NULL,?,?)`
    ).run(
      row.effect,
      `Reaction to ${row.med_name}`,
      severityLabel,
      "active",
      date,
      row.notes ?? `Promoted from a ${row.med_name} side effect.`,
      `med-se:${id}`,
      profileId
    );
    db.prepare(
      "UPDATE intake_item_side_effects SET resolved = 1 WHERE id = ?"
    ).run(id);
  });
  return true;
}
