import { db, today } from "../db";
import { shiftDateStr } from "../date";
import { consumptionRate, RATE_WINDOW_DAYS, type DoseRate } from "../refill";
import { normalizeSeverity, SEVERITY_LABELS } from "../medication-history";
import type {
  DoseTakenOutcome,
  Insight,
  MedicationCourse,
  MedicationSideEffect,
  Supplement,
  SupplementDose,
  SupplementPair,
  SupplementSuggestion,
} from "../types";

// ---- Supplements ----
export function getSupplements(profileId: number): Supplement[] {
  return db
    .prepare(
      `SELECT *,
              (SELECT p.name FROM providers p WHERE p.id = intake_items.provider_id)
                AS provider_name
         FROM intake_items WHERE profile_id = ? ORDER BY active DESC, name`
    )
    .all(profileId) as Supplement[];
}

// All CURRENTLY SCHEDULED doses, ordered for stable rendering. Doses are a
// child of supplements, so they're scoped through the parent's profile_id.
// Retired doses (removed from the schedule by an edit but kept for their
// adherence logs) are excluded — every "current schedule" consumer (the page,
// reminders, refill math, digests) reads through here; history reads join
// intake_item_doses directly and still see retired rows.
export function getSupplementDoses(profileId: number): SupplementDose[] {
  return db
    .prepare(
      `SELECT d.* FROM intake_item_doses d
         JOIN intake_items s ON s.id = d.supplement_id
        WHERE s.profile_id = ? AND d.retired = 0
        ORDER BY d.supplement_id, d.sort, d.id`
    )
    .all(profileId) as SupplementDose[];
}

// Effective consumption rate (doses/day) + its basis for every item that has
// either scheduled doses or logged history, for refill "≈N days left" math
// (issue #38). Prefers the ACTUAL taken-log rate — confirmed doses in the last
// RATE_WINDOW_DAYS ÷ the window — over the scheduled-dose-count estimate, falling
// back to the count when history is thin (see lib/refill's consumptionRate). The
// gather is profile-scoped: the history read JOINs intake_items and filters
// s.profile_id (logs/doses are child tables reached through the parent), and the
// schedule count reuses the profile-scoped getSupplementDoses. Callers (the
// supplements page, Upcoming, and the refill notifier) all read the shared rate
// from here rather than re-approximating it.
export function getRefillRates(
  profileId: number,
  windowDays: number = RATE_WINDOW_DAYS
): Map<number, DoseRate> {
  const todayStr = today(profileId);
  // Inclusive trailing window of `windowDays` calendar days ending today.
  const windowStart = shiftDateStr(todayStr, -(windowDays - 1));
  const todayMs = Date.parse(`${todayStr}T00:00:00Z`);

  // Per-item: confirmations inside the window + the first-ever log date. Every
  // intake_item_logs row is a confirmed (taken) dose, so COUNT is the confirmed
  // count. Profile-scoped through the parent intake_items JOIN.
  const rows = db
    .prepare(
      `SELECT l.supplement_id AS sid,
              SUM(CASE WHEN l.date >= ? THEN 1 ELSE 0 END) AS in_window,
              MIN(l.date) AS first_date
         FROM intake_item_logs l
         JOIN intake_items s ON s.id = l.supplement_id
        WHERE s.profile_id = ?
        GROUP BY l.supplement_id`
    )
    .all(windowStart, profileId) as {
    sid: number;
    in_window: number;
    first_date: string | null;
  }[];
  const history = new Map(rows.map((r) => [r.sid, r]));

  // Fallback rate ≈ number of scheduled dose rows per item.
  const scheduleCount = new Map<number, number>();
  for (const d of getSupplementDoses(profileId)) {
    scheduleCount.set(
      d.supplement_id,
      (scheduleCount.get(d.supplement_id) ?? 0) + 1
    );
  }

  const out = new Map<number, DoseRate>();
  const ids = new Set<number>([...scheduleCount.keys(), ...history.keys()]);
  for (const id of ids) {
    const h = history.get(id);
    const daysSinceFirstLog =
      h?.first_date != null
        ? Math.round(
            (todayMs - Date.parse(`${h.first_date}T00:00:00Z`)) / 86_400_000
          )
        : null;
    out.set(
      id,
      consumptionRate(
        h?.in_window ?? 0,
        daysSinceFirstLog,
        scheduleCount.get(id) ?? 0,
        windowDays
      )
    );
  }
  return out;
}

// Supplement ids with at least one dose logged on `date` (supplement-level view
// for the dashboard / AI summary).
export function getSupplementLogsForDate(
  profileId: number,
  date: string
): Set<number> {
  const rows = db
    .prepare(
      `SELECT DISTINCT l.supplement_id FROM intake_item_logs l
         JOIN intake_items s ON s.id = l.supplement_id
        WHERE s.profile_id = ? AND l.date = ? AND l.supplement_id IS NOT NULL`
    )
    .all(profileId, date) as { supplement_id: number }[];
  return new Set(rows.map((r) => r.supplement_id));
}

// Dose ids logged on `date` (per-dose view for the schedule check-offs), scoped
// to the profile through the dose's parent supplement.
export function getTakenDoseIds(profileId: number, date: string): Set<number> {
  const rows = db
    .prepare(
      `SELECT l.dose_id FROM intake_item_logs l
         JOIN intake_item_doses d ON d.id = l.dose_id
         JOIN intake_items s ON s.id = d.supplement_id
        WHERE s.profile_id = ? AND l.date = ?`
    )
    .all(profileId, date) as { dose_id: number }[];
  return new Set(rows.map((r) => r.dose_id));
}

// Refill decrement/increment. Adjust an item's on-hand
// quantity by one dose's worth (qty_per_dose), only when tracking is enabled
// (quantity_on_hand not null). Profile-scoped, so a forged id can't touch another
// profile's row. Callers keep the adjustment in lock-step with the existing
// per-(dose,date) log dedup, so confirming twice never double-counts.
//
// The decrement is NOT floored at 0: an over-logged item is allowed to go
// negative so that incrementSupply (on untoggle) is its exact inverse and can
// never over-credit supply above the original. If we clamped here, untoggling a
// dose taken while already near/at empty would hand back a full qty_per_dose that
// was never removed, inventing supply. A negative on-hand reads as "out" (days-
// of-supply math floors <=0 to 0, and the edit form clamps the shown value), and
// a manual refill overwrites it outright.
export function decrementSupply(profileId: number, supplementId: number): void {
  db.prepare(
    `UPDATE intake_items
        SET quantity_on_hand = quantity_on_hand - qty_per_dose
      WHERE id = ? AND profile_id = ? AND quantity_on_hand IS NOT NULL`
  ).run(supplementId, profileId);
}

export function incrementSupply(profileId: number, supplementId: number): void {
  db.prepare(
    `UPDATE intake_items
        SET quantity_on_hand = quantity_on_hand + qty_per_dose
      WHERE id = ? AND profile_id = ? AND quantity_on_hand IS NOT NULL`
  ).run(supplementId, profileId);
}

// Log a single dose as taken on `date`, idempotently — the non-React-context
// counterpart to the toggleTaken server action, callable from the notification
// webhook. Mirrors toggleTaken's insert (dose_id + supplement_id + date +
// amount snapshot) so the supplements page's per-dose adherence reflects it;
// never deletes. Returns what actually happened so the caller (the Telegram
// tap handler) can answer honestly: a tap on a button whose dose was since
// deleted/retired by an edit, or whose item was paused, logs NOTHING and must
// not be acknowledged as "Logged".
export function markDoseTaken(
  profileId: number,
  doseId: number,
  supplementId: number | null,
  date: string
): DoseTakenOutcome {
  // The dose id arrives from a Telegram callback, so verify it belongs to this
  // profile (via its parent supplement) before logging anything against it. Read
  // the supplement id from the row rather than trusting the callback token. A
  // retired dose is no longer part of the schedule — treat it like a deleted one.
  const owned = db
    .prepare(
      `SELECT d.supplement_id AS supplement_id, d.amount AS amount,
              s.active AS active
         FROM intake_item_doses d
         JOIN intake_items s ON s.id = d.supplement_id
        WHERE d.id = ? AND s.profile_id = ? AND d.retired = 0`
    )
    .get(doseId, profileId) as
    | { supplement_id: number; amount: string | null; active: number }
    | undefined;
  if (!owned) return "stale-dose";
  // A paused/stopped item keeps its buttons in old messages; refuse the tap so
  // a lingering reminder can't silently log doses (and burn supply) for an item
  // the user has deliberately paused.
  if (!owned.active) return "inactive";
  const existing = db
    .prepare("SELECT 1 FROM intake_item_logs WHERE dose_id = ? AND date = ?")
    .get(doseId, date);
  if (existing) return "already-logged"; // don't re-decrement supply
  // Snapshot the dose amount at confirm time: history must keep showing what
  // was actually taken even after a later dosage edit rewrites the dose row.
  db.prepare(
    "INSERT INTO intake_item_logs (dose_id, supplement_id, date, amount) VALUES (?,?,?,?)"
  ).run(doseId, supplementId ?? owned.supplement_id, date, owned.amount);
  // Guarded by the dedup above: a confirmed dose decrements on-hand supply once.
  decrementSupply(profileId, owned.supplement_id);
  return "logged";
}

// Per-dose taken dates over the last `days` days, for the adherence strip.
// `since` is computed in the configured app timezone so it matches the strip's
// displayed columns (app/medicine lastDates() uses the same today()-based
// window); a UTC window could drop a taken dose on the oldest column.
export function getSupplementLogsInRange(
  profileId: number,
  days = 14
): { dose_id: number; date: string }[] {
  const since = shiftDateStr(today(profileId), -(days - 1));
  return db
    .prepare(
      `SELECT l.dose_id, l.date FROM intake_item_logs l
         JOIN intake_item_doses d ON d.id = l.dose_id
         JOIN intake_items s ON s.id = d.supplement_id
        WHERE s.profile_id = ? AND l.date >= ? ORDER BY l.date`
    )
    .all(profileId, since) as { dose_id: number; date: string }[];
}

// "Take together" / "keep apart" pairs, with both supplement names joined in.
export function getSupplementPairs(profileId: number): SupplementPair[] {
  return db
    .prepare(
      `SELECT p.*, a.name AS a_name, b.name AS b_name
       FROM intake_item_pairs p
       JOIN intake_items a ON a.id = p.a_id
       JOIN intake_items b ON b.id = p.b_id
       WHERE a.profile_id = ?
       ORDER BY p.id`
    )
    .all(profileId) as SupplementPair[];
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
  const tx = db.transaction(() => {
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
  tx();
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
  const tx = db.transaction(() => {
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
  tx();
}

// Restart a medication: open a NEW course (preserving prior courses) and set
// `active` back on. Guarded so it never stacks a second open course.
export function restartMedicationCourse(
  profileId: number,
  itemId: number,
  date: string
): void {
  if (ownedMedicationId(profileId, itemId) == null) return;
  const tx = db.transaction(() => {
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
  tx();
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
  const tx = db.transaction(() => {
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
  tx();
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
  const tx = db.transaction(() => {
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
  tx();
  return true;
}

// AI suggestions still awaiting review, newest first.
export function getPendingSuggestions(
  profileId: number
): SupplementSuggestion[] {
  return db
    .prepare(
      "SELECT * FROM intake_item_suggestions WHERE profile_id = ? AND status = 'pending' ORDER BY created_at DESC, id DESC"
    )
    .all(profileId) as SupplementSuggestion[];
}

// ---- Insights ----
export function getInsight(
  profileId: number,
  date: string
): Insight | undefined {
  return db
    .prepare("SELECT * FROM insights WHERE profile_id = ? AND date = ?")
    .get(profileId, date) as Insight | undefined;
}

export function getInsights(profileId: number, limit = 30): Insight[] {
  return db
    .prepare(
      "SELECT * FROM insights WHERE profile_id = ? ORDER BY date DESC LIMIT ?"
    )
    .all(profileId, limit) as Insight[];
}
