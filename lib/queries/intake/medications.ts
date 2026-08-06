// Part of the lib/queries/intake barrel (#319 — same #126 treatment training
// got). The profile-scoping guard walks all of lib/, so these split modules stay
// covered; every read is profile-scoped directly or through the parent
// intake_items JOIN.
// Medication history / lifecycle: courses (episodes), active-flag sync, side
// effects and their promotion to an allergy row.
import { db, today, writeTx, type Tx } from "../../db";
import { casUpdate, readForUpdate } from "../../tx";
import { sqlNow } from "../../clock";
import { normalizeSeverity, SEVERITY_LABELS } from "../../medication-history";
import { strengthFromName } from "../../prescription-parse";
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
import type { IntakeObligation } from "../../types";
// Type-only: the shared pause/resume outcome vocabulary lives with the kind-agnostic
// gate (lib/intake-active-write.ts); the medication half returns the same words.
import type { IntakeActiveOutcome } from "../../intake-active-write";

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
      `SELECT id, name, obligation, rx, date(created_at) AS created_on
         FROM intake_items
        WHERE profile_id = ? AND kind = 'medication' AND active = 1`
    )
    .all(profileId) as {
    id: number;
    name: string;
    obligation: IntakeObligation;
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
    asNeeded: m.obligation === "may",
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
        created_at)
       SELECT ii.id,
              CASE WHEN ? = 1 THEN ? ELSE COALESCE(?, date(ii.created_at)) END,
              CASE WHEN ii.active = 1
                   THEN NULL
                   ELSE CASE WHEN ? = 1 THEN ? ELSE COALESCE(?, date(ii.created_at)) END
              END,
              ?, ?, ?,
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
    itemId,
    profileId
  );
}

// Per-course attribution (#1204): the prescriber (free text) + resolved individual
// provider_id, and a descriptive dose/sig SNAPSHOT as prescribed at this course. Every
// field optional/null for a manual course. (A course is NOT document-keyed — it is
// cleaned via its parent med's CASCADE, #1204's med-lifecycle cleanup model — so there
// is no document_id here, which also keeps it out of the import-footprint blind-spot
// guard, since medication_courses is not a footprint table.)
export interface CourseAttribution {
  prescriber?: string | null;
  providerId?: number | null;
  doseSnapshot?: string | null;
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
// provider_id + a descriptive dose snapshot. Deduped on (item_id, started_on) so a
// REPROCESS of the same renewing document re-adds nothing (the started_on is stable),
// while a genuinely distinct renewal at a NEW period does attach. Re-syncs the med's
// `active` flag to the persisted course state (an open renewal course reactivates a
// paused med). Ownership (profile + kind='medication') is verified first; a forged /
// cross-profile id is a no-op. Returns the new course id, or null when nothing was
// inserted (dedup hit / not owned).
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
            prescriber, provider_id, dose_snapshot, created_at)
         SELECT ?, ?, ?, ?, ?, ?, ?, ?, datetime('now')
          WHERE NOT EXISTS (
            SELECT 1 FROM medication_courses c
             WHERE c.item_id = ? AND c.started_on IS ?
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
        itemId,
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
        prescriber, provider_id, dose_snapshot, created_at)
     SELECT ?, ?, ?, ?, ?, ?, ?, ?, datetime('now')
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

// ---- The course-transition write core (#2132) ------------------------------
//
// The invariant "intake_items.active = 1 ⇔ an open (stopped_on IS NULL) course exists"
// is enforced HERE, structurally: medication_courses is registered in
// STATEFUL_WRITE_TABLES with this module as its only core, so no other module can close
// or open a course without passing a transition below — each of which moves `active` in
// the SAME transaction. Every transition returns a typed, changes-checked outcome
// (#232): a forged id, an already-stopped med, or an already-open course is a refusal
// the caller renders, never a silent no-op behind an unconditional formOk(). The
// in-transaction reads and compare-and-swaps use the Tx-token helpers (lib/tx.ts), so a
// guard evaluated outside the transaction cannot typecheck.

// The medication row a transition acts on, read INSIDE the transaction (ownership +
// kind + current flag in one guard read).
function medicationForUpdate(
  tx: Tx,
  profileId: number,
  itemId: number
): { active: number } | undefined {
  return readForUpdate<{ active: number }>(
    tx,
    db.prepare(
      "SELECT active FROM intake_items WHERE id = ? AND profile_id = ? AND kind = 'medication'"
    ),
    itemId,
    profileId
  );
}

export type CourseStopOutcome =
  | "stopped"
  | "already-stopped"
  | "synced"
  | "not-found";

// Stop a medication: close its open course(s) (stopped_on = date + reason, note
// appended) AND clear the live `active` flag so scheduling/reminders stop, in one
// transaction. Optionally records a side effect linked to the just-closed course.
// Refusals: `not-found` (forged/cross-profile id), `already-stopped` (no open course,
// active already 0). `synced` repairs the one remaining state — no open course but
// active still 1 — by clearing the flag, which upholds the invariant without minting
// course history.
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
): CourseStopOutcome {
  return writeTx((tx): CourseStopOutcome => {
    const item = medicationForUpdate(tx, profileId, itemId);
    if (!item) return "not-found";
    const openCourses = db
      .prepare(
        "SELECT id FROM medication_courses WHERE item_id = ? AND stopped_on IS NULL ORDER BY started_on, id"
      )
      .all(itemId) as { id: number }[];
    // The close carries its expectation in the WHERE (stopped_on IS NULL): `stale`
    // means there was nothing open to stop.
    const closed = casUpdate(
      tx,
      db.prepare(
        `UPDATE medication_courses
            SET stopped_on = ?, stop_reason = ?, notes = COALESCE(?, notes)
          WHERE item_id = ? AND stopped_on IS NULL`
      ),
      opts.date,
      opts.reason,
      opts.note ?? null,
      itemId
    );
    if (closed.kind === "stale") {
      if (item.active !== 1) return "already-stopped";
      db.prepare(
        "UPDATE intake_items SET active = 0 WHERE id = ? AND profile_id = ?"
      ).run(itemId, profileId);
      return "synced";
    }
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
    return "stopped";
  });
}

export type CourseRestartOutcome =
  | "restarted"
  | "already-open"
  | "synced"
  | "not-found";

// Restart a medication: open a NEW course (preserving prior courses) and set `active`
// back on. Refusals: `not-found`, `already-open` (an open course exists and the med is
// already active — a stale tab's second Restart). `synced` repairs the open-course/
// inactive desync by setting the flag without stacking a second open course.
export function restartMedicationCourse(
  profileId: number,
  itemId: number,
  date: string
): CourseRestartOutcome {
  return writeTx((tx): CourseRestartOutcome => {
    const item = medicationForUpdate(tx, profileId, itemId);
    if (!item) return "not-found";
    const open = readForUpdate<{ id: number }>(
      tx,
      db.prepare(
        "SELECT id FROM medication_courses WHERE item_id = ? AND stopped_on IS NULL LIMIT 1"
      ),
      itemId
    );
    if (open) {
      if (item.active === 1) return "already-open";
      db.prepare(
        "UPDATE intake_items SET active = 1 WHERE id = ? AND profile_id = ?"
      ).run(itemId, profileId);
      return "synced";
    }
    db.prepare(
      "INSERT INTO medication_courses (item_id, started_on, stopped_on) VALUES (?,?,NULL)"
    ).run(itemId, date);
    db.prepare(
      "UPDATE intake_items SET active = 1 WHERE id = ? AND profile_id = ?"
    ).run(itemId, profileId);
    return "restarted";
  });
}

// Set (or clear) a medication's END DATE from the edit form (#1140 Part D). The end date
// IS the current course's `stopped_on` under the active=1 ⇔ open-course invariant. This is
// the ONE place the edit-form date path lives, so it and the Stop/Restart buttons can't
// diverge (#221) and the invariant always holds. Routes the two real transitions through
// the SHARED cores:
//   - endDate = null → REACTIVATE via restartMedicationCourse (opens a course, active=1).
//   - endDate set, an OPEN course exists → STOP as of that date via stopMedicationCourses
//     (closes it, active=0) — so you can log the real "finished last Tuesday", not only today.
//   - endDate set, latest course already CLOSED → CORRECT that course's stopped_on in place
//     (active stays 0; the invariant is unaffected) rather than manufacturing spurious
//     course history. This is the sole in-place stopped_on write, kept here so no other
//     path hand-writes the column. Ownership is verified; a forged id is a no-op.
export type CourseEndDateOutcome =
  | CourseStopOutcome
  | CourseRestartOutcome
  | "reactivated"
  | "corrected"
  | "no-course";

export function setMedicationEndDate(
  profileId: number,
  itemId: number,
  endDate: string | null
): CourseEndDateOutcome {
  return writeTx((tx): CourseEndDateOutcome => {
    if (!medicationForUpdate(tx, profileId, itemId)) return "not-found";
    if (endDate == null) {
      // Clearing the end date REACTIVATES via the shared restart core (nested writeTx
      // is a SAVEPOINT); its refusals pass through so a stale form can't silently
      // re-confirm.
      const r = restartMedicationCourse(profileId, itemId, today(profileId));
      return r === "restarted" ? "reactivated" : r;
    }
    const openCourse = readForUpdate<{ id: number }>(
      tx,
      db.prepare(
        "SELECT id FROM medication_courses WHERE item_id = ? AND stopped_on IS NULL ORDER BY started_on, id LIMIT 1"
      ),
      itemId
    );
    if (openCourse) {
      // Close the open course as of the given date (active → 0), through the shared stop
      // core so the active-flag sync + course close stay identical to the Stop button.
      return stopMedicationCourses(profileId, itemId, {
        date: endDate,
        reason: "course_finished",
      });
    }
    // No open course — correct the LATEST closed course's end date in place. Active is
    // already 0, so the invariant holds without touching it; no new course row is minted.
    const latest = readForUpdate<{ id: number }>(
      tx,
      db.prepare(
        "SELECT id FROM medication_courses WHERE item_id = ? ORDER BY started_on DESC, id DESC LIMIT 1"
      ),
      itemId
    );
    if (!latest) return "no-course";
    const corrected = casUpdate(
      tx,
      db.prepare(
        "UPDATE medication_courses SET stopped_on = ? WHERE id = ? AND item_id = ?"
      ),
      endDate,
      latest.id,
      itemId
    );
    return corrected.kind === "applied" ? "corrected" : "no-course";
  });
}

// Keep a medication's course history in sync with the Pause/Resume control (#2133):
// pausing closes the open course (no reason); resuming opens a fresh one when none is
// open. The transition is STATE-NAMED — `to` is the intended state, compare-and-swapped
// against the current flag inside the transaction — so a stale tab's "Pause" on an
// already-paused med refuses with `already-paused` instead of silently resuming it.
// Shares IntakeActiveOutcome with the supplement core (lib/intake-active-write.ts), the
// kind-agnostic gate the Server Action calls.
export function setMedicationActive(
  profileId: number,
  itemId: number,
  to: 0 | 1,
  date: string
): IntakeActiveOutcome {
  return writeTx((tx): IntakeActiveOutcome => {
    const item = medicationForUpdate(tx, profileId, itemId);
    if (!item) return "not-found";
    if (item.active === to) {
      return to === 1 ? "already-active" : "already-paused";
    }
    const flipped = casUpdate(
      tx,
      db.prepare(
        "UPDATE intake_items SET active = ? WHERE id = ? AND profile_id = ? AND active = ?"
      ),
      to,
      itemId,
      profileId,
      to === 1 ? 0 : 1
    );
    if (flipped.kind === "stale") {
      // Unreachable inside the transaction after the guard read; kept so the write can
      // never be confirmed without having landed.
      return to === 1 ? "already-active" : "already-paused";
    }
    if (to === 0) {
      db.prepare(
        "UPDATE medication_courses SET stopped_on = ? WHERE item_id = ? AND stopped_on IS NULL"
      ).run(date, itemId);
    } else {
      const open = readForUpdate<{ id: number }>(
        tx,
        db.prepare(
          "SELECT id FROM medication_courses WHERE item_id = ? AND stopped_on IS NULL LIMIT 1"
        ),
        itemId
      );
      if (!open) {
        db.prepare(
          "INSERT INTO medication_courses (item_id, started_on, stopped_on) VALUES (?,?,NULL)"
        ).run(itemId, date);
      }
    }
    return to === 1 ? "resumed" : "paused";
  });
}

// Set a course's started_on (the edit form's course-start field, #1140; and the
// historical-PRN backdated course extension, #1933). Runs INSIDE the caller's
// transaction — the Tx token is the proof — and is changes-checked: `not-found` means
// the (course, item, profile, kind) scope didn't match and nothing was written.
export function setCourseStartDate(
  tx: Tx,
  profileId: number,
  itemId: number,
  courseId: number,
  startedOn: string | null
): "updated" | "not-found" {
  const res = casUpdate(
    tx,
    db.prepare(
      `UPDATE medication_courses
          SET started_on = ?
        WHERE id = ? AND item_id = ?
          AND EXISTS (
            SELECT 1 FROM intake_items ii
             WHERE ii.id = medication_courses.item_id
               AND ii.profile_id = ? AND ii.kind = 'medication'
          )`
    ),
    startedOn,
    courseId,
    itemId,
    profileId
  );
  return res.kind === "applied" ? "updated" : "not-found";
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

export type SideEffectResolvedOutcome =
  | "resolved"
  | "reopened"
  | "already-resolved"
  | "already-open"
  | "not-found";

// Set a side effect's resolved flag to an INTENDED state (#2133's sibling fix): the old
// `SET resolved = 1 - resolved` blind toggle inverted a stale tab's tap. The caller
// posts the state its render promised ("Mark resolved" / "Reopen"), the compare-and-swap
// runs inside the transaction, and a mismatch refuses with the state that already holds.
export function setMedicationSideEffectResolved(
  profileId: number,
  id: number,
  to: 0 | 1
): SideEffectResolvedOutcome {
  return writeTx((tx): SideEffectResolvedOutcome => {
    const row = readForUpdate<{ resolved: number }>(
      tx,
      db.prepare(
        `SELECT se.resolved FROM intake_item_side_effects se
           JOIN intake_items ii ON ii.id = se.item_id
          WHERE se.id = ? AND ii.profile_id = ?`
      ),
      id,
      profileId
    );
    if (!row) return "not-found";
    if (row.resolved === to) {
      return to === 1 ? "already-resolved" : "already-open";
    }
    const res = casUpdate(
      tx,
      db.prepare(
        "UPDATE intake_item_side_effects SET resolved = ? WHERE id = ? AND resolved = ?"
      ),
      to,
      id,
      to === 1 ? 0 : 1
    );
    if (res.kind === "stale") {
      return to === 1 ? "already-resolved" : "already-open";
    }
    return to === 1 ? "resolved" : "reopened";
  });
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
  writeTx(() => {
    db.prepare(
      `INSERT OR IGNORE INTO allergies
         (substance, reaction, severity, status, onset_date, notes, source,
          external_id, profile_id, created_at)
       VALUES (?,?,?,?,?,?,NULL,?,?,?)`
    ).run(
      row.effect,
      `Reaction to ${row.med_name}`,
      severityLabel,
      "active",
      date,
      row.notes ?? `Promoted from a ${row.med_name} side effect.`,
      `med-se:${id}`,
      profileId,
      // created_at from the clock seam (#1534) — the Timeline day fallback.
      sqlNow()
    );
    db.prepare(
      "UPDATE intake_item_side_effects SET resolved = 1 WHERE id = ?"
    ).run(id);
  });
  return true;
}
