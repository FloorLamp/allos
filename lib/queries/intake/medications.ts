// Part of the lib/queries/intake barrel (#319 — same #126 treatment training
// got). The profile-scoping guard walks all of lib/, so these split modules stay
// covered; every read is profile-scoped directly or through the parent
// intake_items JOIN.
// Medication history / lifecycle: courses (episodes), active-flag sync, side
// effects and their promotion to an allergy row.
import { db, today, writeTx } from "../../db";
import { normalizeSeverity, SEVERITY_LABELS } from "../../medication-history";
import { parsePrescription, strengthFromName } from "../../prescription-parse";
import { resolveExactPrescriberId } from "../../providers-db";
import { profileAgeMonths } from "../../settings";
import { getLatestBodyMetricDated } from "../metrics";
import { getEpisodeRow } from "../../illness-episode-store";
import { shiftDateStr } from "../../date";
import {
  episodeMedChecklist,
  type EpisodeMedInput,
  type EpisodeMedSuggestion,
} from "../../episode-med-reconcile";
import type { PediatricFormContext } from "../../prn-dosing";
import type { WeightUnit } from "../../settings";
import type { MedicationCourse, MedicationSideEffect } from "../../types";

// The pediatric label-dosing context (#798) for a medication form: the profile's age
// in months + its latest recorded weight, so a PRN med form (full or the #843 quick-
// add) can reproduce the OTC weight-band suggestion and the resolver can source a
// child's dose amount from the band. ONE computation shared by the Medications loader
// and the symptom-card quick-add, so both surfaces read the same context.
export function getPediatricFormContext(
  profileId: number,
  weightUnit: WeightUnit = "kg"
): PediatricFormContext {
  const todayStr = today(profileId);
  const latestWeight = getLatestBodyMetricDated(profileId, "weight");
  return {
    ageMonths: profileAgeMonths(profileId, todayStr),
    weightKg: latestWeight?.value ?? null,
    weightDate: latestWeight?.date ?? null,
    weightUnit,
    today: todayStr,
  };
}

// ---- Episode-end medication reconciliation (issue #880) ----

// The episode-associated ACTIVE medications for the end-episode reconciliation checklist.
// Gathers each active med's identity (PRN? Rx?), created date, and 'taken' administration
// dates, then hands them to the pure episodeMedChecklist against the episode's [start,
// endInclusive] window. Association is DERIVED (no FKs, the house pattern): created during
// the range, or PRN used entirely within it. The checklist is SUGGEST-ONLY (#560) — Rx
// courses are listed unchecked. The range's end is the episode's last active day for a
// closed row, else today (the episode being ended now). Every read is profile-scoped
// (direct profile_id, or a JOIN to intake_items). Returns [] for a missing episode.
export function getEpisodeMedReconciliation(
  profileId: number,
  episodeId: number
): EpisodeMedSuggestion[] {
  const row = getEpisodeRow(profileId, episodeId);
  if (!row) return [];
  const start = row.started_at;
  const endInclusive = row.ended_at
    ? shiftDateStr(row.ended_at, -1)
    : today(profileId);

  const meds = db
    .prepare(
      `SELECT id, name, as_needed, rx, date(created_at) AS created_on
         FROM intake_items
        WHERE profile_id = ? AND kind = 'medication' AND active = 1`
    )
    .all(profileId) as {
    id: number;
    name: string;
    as_needed: number;
    rx: number;
    created_on: string;
  }[];
  if (meds.length === 0) return [];

  const adminRows = db
    .prepare(
      `SELECT l.item_id AS item_id, l.date AS date
         FROM intake_item_logs l
         JOIN intake_items ii ON ii.id = l.item_id
        WHERE ii.profile_id = ? AND ii.kind = 'medication' AND ii.active = 1
          AND l.status = 'taken'`
    )
    .all(profileId) as { item_id: number; date: string }[];
  const datesByItem = new Map<number, string[]>();
  for (const r of adminRows) {
    const arr = datesByItem.get(r.item_id) ?? [];
    arr.push(r.date);
    datesByItem.set(r.item_id, arr);
  }

  const inputs: EpisodeMedInput[] = meds.map((m) => ({
    itemId: m.id,
    name: m.name,
    asNeeded: m.as_needed === 1,
    rx: m.rx === 1,
    hasOpenCourse: true, // active=1 upholds the "active ⇔ open course" invariant
    createdOn: m.created_on,
    administrationDates: datesByItem.get(m.id) ?? [],
  }));
  return episodeMedChecklist(inputs, { start, endInclusive });
}

// The most recent 'taken' administration DATE per medication for the profile, for the
// dormant-PRN sweep (#880 item 3). Scoped through the parent intake_items JOIN.
export function getLastAdministrationDateByItem(
  profileId: number
): Map<number, string> {
  const rows = db
    .prepare(
      `SELECT l.item_id AS item_id, MAX(l.date) AS last_date
         FROM intake_item_logs l
         JOIN intake_items ii ON ii.id = l.item_id
        WHERE ii.profile_id = ? AND l.status = 'taken'
        GROUP BY l.item_id`
    )
    .all(profileId) as { item_id: number; last_date: string }[];
  return new Map(rows.map((r) => [r.item_id, r.last_date]));
}

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
// supplement to a medication lands it in Past, not Current. started_on normally
// falls back to the med's created_at date when the caller has no better start date;
// manual PRN entry can explicitly preserve an unknown (NULL) start instead. A single
// INSERT...SELECT that is:
//   - profile-scoped (references intake_items WHERE profile_id = ?),
//   - a no-op unless the row is a medication with NO existing course,
// so it's idempotent and safe to call on every create/update. Never touches a
// supplement (kind guard) and never opens a second course.
export function ensureMedicationCourse(
  profileId: number,
  itemId: number,
  startedOn: string | null,
  preserveUnknownStart = false,
  attribution?: CourseAttribution
): void {
  db.prepare(
    `INSERT INTO medication_courses
       (item_id, started_on, stopped_on, prescriber, provider_id, dose_snapshot,
        document_id, created_at)
       SELECT ii.id,
              CASE WHEN ? = 1 THEN ? ELSE COALESCE(?, date(ii.created_at)) END,
              CASE WHEN ii.active = 1
                   THEN NULL
                   ELSE CASE WHEN ? = 1 THEN ? ELSE COALESCE(?, date(ii.created_at)) END
              END,
              ?, ?, ?, ?,
              datetime('now')
         FROM intake_items ii
        WHERE ii.id = ? AND ii.profile_id = ? AND ii.kind = 'medication'
          AND NOT EXISTS (
            SELECT 1 FROM medication_courses c WHERE c.item_id = ii.id
          )`
  ).run(
    preserveUnknownStart ? 1 : 0,
    startedOn,
    startedOn,
    preserveUnknownStart ? 1 : 0,
    startedOn,
    startedOn,
    attribution?.prescriber ?? null,
    attribution?.providerId ?? null,
    attribution?.doseSnapshot ?? null,
    attribution?.documentId ?? null,
    itemId,
    profileId
  );
}

// Per-course attribution (#1204): the prescriber (free text) + resolved individual
// provider_id, a descriptive dose/sig SNAPSHOT as prescribed at this course, and the
// source document a course was imported from (so a cross-document re-prescription's
// courses can be cleared when THAT document reprocesses — the med itself is owned by
// its FIRST document). Every field optional/null for a manual course.
export interface CourseAttribution {
  prescriber?: string | null;
  providerId?: number | null;
  doseSnapshot?: string | null;
  documentId?: number | null;
}

// The lifecycle + known-strength state of each of a profile's tracked medications —
// the input the #1204 renewal-vs-separate classifier needs (medication-renewal.ts).
// `strengths` are parsed off the med NAME plus its dose amounts (mirrors
// medication-record-match's trackedStrengths). Every read is profile-scoped (direct
// or through the parent intake_items JOIN).
export interface MedMatchState {
  id: number;
  name: string;
  brand: string | null;
  rxcui: string | null;
  rxcuiIngredients: string[] | null;
  hasOpenCourse: boolean;
  strengths: string[];
}

export function getMedMatchStates(profileId: number): MedMatchState[] {
  const meds = db
    .prepare(
      `SELECT id, name, brand, rxcui, rxcui_ingredients AS rxcuiIngredients
         FROM intake_items WHERE profile_id = ? AND kind = 'medication'`
    )
    .all(profileId) as {
    id: number;
    name: string;
    brand: string | null;
    rxcui: string | null;
    rxcuiIngredients: string | null;
  }[];
  if (meds.length === 0) return [];
  const openByItem = new Set(
    (
      db
        .prepare(
          `SELECT DISTINCT c.item_id AS itemId
             FROM medication_courses c
             JOIN intake_items ii ON ii.id = c.item_id
            WHERE ii.profile_id = ? AND c.stopped_on IS NULL`
        )
        .all(profileId) as { itemId: number }[]
    ).map((r) => r.itemId)
  );
  const dosesByItem = new Map<number, string[]>();
  for (const d of db
    .prepare(
      `SELECT d.item_id AS itemId, d.amount AS amount
         FROM intake_item_doses d
         JOIN intake_items ii ON ii.id = d.item_id
        WHERE ii.profile_id = ? AND ii.kind = 'medication'`
    )
    .all(profileId) as { itemId: number; amount: string | null }[]) {
    if (!d.amount) continue;
    const arr = dosesByItem.get(d.itemId) ?? [];
    arr.push(d.amount);
    dosesByItem.set(d.itemId, arr);
  }
  return meds.map((m) => {
    const strengths: string[] = [];
    for (const raw of [m.name, ...(dosesByItem.get(m.id) ?? [])]) {
      const s = raw ? strengthFromName(raw) : null;
      if (s) strengths.push(s);
    }
    return {
      id: m.id,
      name: m.name,
      brand: m.brand,
      rxcui: m.rxcui,
      rxcuiIngredients: m.rxcuiIngredients
        ? (JSON.parse(m.rxcuiIngredients) as string[])
        : null,
      hasOpenCourse: openByItem.has(m.id),
      strengths,
    };
  });
}

// Add a new COURSE to an EXISTING medication for a re-prescription / renewal
// (#1204): a later refill CCD, a second provider's order, or a manual track-of-an-
// already-tracked drug. Carries the course's period + prescriber + resolved
// provider_id + a descriptive dose snapshot + its source document. Deduped on
// (item_id, document_id, started_on) so a REPROCESS of the same renewing document
// re-adds nothing, while a genuinely distinct renewal (another document/period) does
// attach. Re-syncs the med's `active` flag to the persisted course state (an open
// renewal course reactivates a paused med). Ownership (profile + kind='medication')
// is verified first; a forged / cross-profile id is a no-op. Returns the new course
// id, or null when nothing was inserted (dedup hit / not owned).
export function addRenewalCourse(
  profileId: number,
  itemId: number,
  opts: {
    startedOn: string | null;
    stoppedOn?: string | null;
    stopReason?: string | null;
    notes?: string | null;
    attribution?: CourseAttribution;
  }
): number | null {
  if (ownedMedicationId(profileId, itemId) == null) return null;
  return writeTx(() => {
    const attr = opts.attribution ?? {};
    const info = db
      .prepare(
        `INSERT INTO medication_courses
           (item_id, started_on, stopped_on, stop_reason, notes,
            prescriber, provider_id, dose_snapshot, document_id, created_at)
         SELECT ?, ?, ?, ?, ?, ?, ?, ?, ?, datetime('now')
          WHERE NOT EXISTS (
            SELECT 1 FROM medication_courses c
             WHERE c.item_id = ?
               AND c.document_id IS ?
               AND c.started_on IS ?
          )`
      )
      .run(
        itemId,
        opts.startedOn,
        opts.stoppedOn ?? null,
        opts.stopReason ?? null,
        opts.notes ?? null,
        attr.prescriber ?? null,
        attr.providerId ?? null,
        attr.doseSnapshot ?? null,
        attr.documentId ?? null,
        itemId,
        attr.documentId ?? null,
        opts.startedOn
      );
    if (info.changes === 0) return null;
    // Re-sync active to the persisted course state (an open renewal course
    // reactivates a paused med; a closed-only set keeps it paused).
    db.prepare(
      `UPDATE intake_items SET active =
         CASE WHEN EXISTS (
           SELECT 1 FROM medication_courses c
            WHERE c.item_id = ? AND c.stopped_on IS NULL
         ) THEN 1 ELSE 0 END
       WHERE id = ? AND profile_id = ?`
    ).run(itemId, itemId, profileId);
    return Number(info.lastInsertRowid);
  });
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
  }[],
  attribution?: CourseAttribution
): void {
  if (ownedMedicationId(profileId, itemId) == null) return;
  if (courses.length === 0) return;
  const insert = db.prepare(
    `INSERT INTO medication_courses
       (item_id, started_on, stopped_on, stop_reason, notes,
        prescriber, provider_id, dose_snapshot, document_id, created_at)
     SELECT ?, ?, ?, ?, ?, ?, ?, ?, ?, datetime('now')
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
        attribution?.prescriber ?? null,
        attribution?.providerId ?? null,
        attribution?.doseSnapshot ?? null,
        attribution?.documentId ?? null,
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
      `SELECT id, name, value, unit, notes, document_id, provider_id
         FROM medical_records
        WHERE id = ? AND profile_id = ? AND category = 'prescription'`
    )
    .get(recordId, profileId) as
    | {
        id: number;
        name: string;
        value: string | null;
        unit: string | null;
        notes: string | null;
        document_id: number | null;
        provider_id: number | null;
      }
    | undefined;
  if (!rec || !rec.name?.trim()) return null;

  const med = parsePrescription({
    name: rec.name,
    value: rec.value,
    unit: rec.unit,
    notes: rec.notes,
  });

  // Prescriber link (#1051 semantics decision (a)): carry the source record's
  // structured provider_id THROUGH when it is an INDIVIDUAL (the prescriber the
  // import already resolved into the registry — "the structured link it is holding");
  // an org/absent link falls back to resolving the parsed prescriber TEXT into an
  // existing individual row (exact only, never an org / near-miss). Either way an
  // organization never occupies the prescriber link.
  let providerId: number | null = null;
  if (rec.provider_id != null) {
    const p = db
      .prepare("SELECT type FROM providers WHERE id = ?")
      .get(rec.provider_id) as { type: string } | undefined;
    if (p?.type === "individual") providerId = rec.provider_id;
  }
  if (providerId == null && med.prescriber) {
    providerId = resolveExactPrescriberId(med.prescriber);
  }

  return writeTx(() => {
    const info = db
      .prepare(
        `INSERT INTO intake_items
           (name, notes, active, condition, priority, kind,
            prescriber, pharmacy, rx_number, as_needed,
            document_id, source, provider_id, source_record_id, profile_id)
         VALUES (?,?,1,'daily','high','medication',?,?,?,?,?,'extracted',?,?,?)`
      )
      .run(
        med.name,
        med.sig,
        med.prescriber,
        med.pharmacy,
        med.rxNumber,
        med.asNeeded ? 1 : 0,
        rec.document_id,
        providerId,
        rec.id,
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
