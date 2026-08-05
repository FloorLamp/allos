// Part of the lib/queries/intake barrel (#319 — same #126 treatment training
// got). The profile-scoping guard walks all of lib/, so these split modules stay
// covered; every read is profile-scoped directly or through the parent
// intake_items JOIN.
// Current-schedule reads: the live supplement/medication items, their currently
// scheduled (non-retired) doses, and the AI suggestions awaiting review.
import {
  cadenceLabel,
  type DoseScheduleVersion,
  type ItemCadence,
} from "../../intake-cadence";
import { db } from "../../db";
import type {
  Supplement,
  SupplementDose,
  SupplementSuggestion,
} from "../../types";

// Whether this profile has ANY intake item (supplement or medication). Drives the
// Nutrition nav entry's visibility for an infant profile (#746): the food-group
// serving log is meaningless before age 1, but infant supplements are real (e.g.
// vitamin D drops), so the nav entry (→ the Supplements tab) stays reachable when
// the profile tracks any intake item even though the Food tab shows a calm note.
export function profileHasIntakeItems(profileId: number): boolean {
  return !!db
    .prepare("SELECT 1 FROM intake_items WHERE profile_id = ? LIMIT 1")
    .get(profileId);
}

// ---- Supplements ----
export function getSupplements(profileId: number): Supplement[] {
  // COALESCE(situations.name, intake_items.situation): a situational item's
  // displayed situation follows its linked ROW (issue #560), so a rename re-keys it
  // (and it stays in lockstep with getActiveSituations, which reads the same table);
  // the free-text column is the fallback for legacy/unlinked rows. The `AS situation`
  // alias comes last, so it wins over intake_items.* on the duplicate column name.
  return db
    .prepare(
      `SELECT intake_items.*,
              COALESCE(situations.name, intake_items.situation) AS situation,
              pause_situations.name AS pause_situation,
              (SELECT p.name FROM providers p WHERE p.id = intake_items.provider_id)
                AS provider_name,
              (SELECT c.name FROM conditions c
                WHERE c.id = intake_items.indication_condition_id
                  AND c.profile_id = intake_items.profile_id)
                AS indication_condition_name,
              (SELECT ss.name FROM shared_supplies ss
                WHERE ss.id = intake_items.supply_id)
                AS supply_name
         FROM intake_items
         LEFT JOIN situations
                ON situations.id = intake_items.situation_id
               AND situations.profile_id = intake_items.profile_id
         LEFT JOIN situations AS pause_situations
                ON pause_situations.id = intake_items.pause_situation_id
               AND pause_situations.profile_id = intake_items.profile_id
        WHERE intake_items.profile_id = ? ORDER BY active DESC, name`
    )
    .all(profileId) as Supplement[];
}

// One medication this profile owns, or null — the scoped single-item read behind
// the /medications/[id] detail page (issue #817). Filters by id AND profile_id AND
// kind='medication', so guessing another profile's id (or a supplement's id) yields
// null and the page 404s (the encounters/[id] precedent). Same COALESCE(situation)/
// provider_name shape as getSupplements so the detail row matches a list row.
export function getMedication(
  profileId: number,
  id: number
): Supplement | null {
  const row = db
    .prepare(
      `SELECT intake_items.*,
              COALESCE(situations.name, intake_items.situation) AS situation,
              pause_situations.name AS pause_situation,
              (SELECT p.name FROM providers p WHERE p.id = intake_items.provider_id)
                AS provider_name,
              (SELECT c.name FROM conditions c
                WHERE c.id = intake_items.indication_condition_id
                  AND c.profile_id = intake_items.profile_id)
                AS indication_condition_name,
              (SELECT ss.name FROM shared_supplies ss
                WHERE ss.id = intake_items.supply_id)
                AS supply_name
         FROM intake_items
         LEFT JOIN situations
                ON situations.id = intake_items.situation_id
               AND situations.profile_id = intake_items.profile_id
         LEFT JOIN situations AS pause_situations
                ON pause_situations.id = intake_items.pause_situation_id
               AND pause_situations.profile_id = intake_items.profile_id
        WHERE intake_items.id = ? AND intake_items.profile_id = ?
          AND intake_items.kind = 'medication'`
    )
    .get(id, profileId) as Supplement | undefined;
  return row ?? null;
}

// Resolve one medication across a viewer's ACCESSIBLE profile ids. This mirrors the
// illness-episode detail boundary: every individual lookup remains profile-scoped, and
// the caller supplies only ids already filtered by the grants layer. A medication owned
// by an ungranted profile therefore remains indistinguishable from a missing id.
export function resolveMedicationAcrossProfiles(
  profileIds: number[],
  id: number
): { profileId: number; medication: Supplement } | null {
  for (const profileId of profileIds) {
    const medication = getMedication(profileId, id);
    if (medication) return { profileId, medication };
  }
  return null;
}

// All CURRENTLY SCHEDULED doses, ordered for stable rendering. Doses are a
// child of supplements, so they're scoped through the parent's profile_id.
// Retired doses (removed from the schedule by an edit but kept for their
// adherence logs) are excluded — every "current schedule" consumer (the page,
// reminders, refill math, digests) reads through here; history reads join
// intake_item_doses directly and still see retired rows.
export function getSupplementDoses(profileId: number): SupplementDose[] {
  return withScheduleVersions(
    profileId,
    db
      .prepare(
        `SELECT d.* FROM intake_item_doses d
         JOIN intake_items s ON s.id = d.item_id
        WHERE s.profile_id = ? AND d.retired = 0
        ORDER BY d.item_id, d.sort, d.id`
      )
      .all(profileId) as SupplementDose[]
  );
}

// Every dose's effective-dated schedule history (#1973, migration 151), oldest first,
// keyed by dose id. Scoped through the parent item's profile_id like every other read in
// this module (the version table is a grandchild and carries no profile_id of its own).
//
// ONE query for the whole profile rather than a per-dose lookup: the callers that need
// history need it for every dose they are about to iterate (an adherence window, a
// digest, a reminder pass), and a dose's history is a handful of rows.
export function getDoseScheduleVersions(
  profileId: number
): Map<number, DoseScheduleVersion[]> {
  const rows = db
    .prepare(
      `SELECT v.dose_id, v.effective_from, v.time_of_day,
              v.weekdays, v.start_date, v.end_date
         FROM intake_dose_schedule_versions v
         JOIN intake_item_doses d ON d.id = v.dose_id
         JOIN intake_items s ON s.id = d.item_id
        WHERE s.profile_id = ?
        ORDER BY v.dose_id, v.effective_from, v.id`
    )
    .all(profileId) as (DoseScheduleVersion & { dose_id: number })[];
  const out = new Map<number, DoseScheduleVersion[]>();
  for (const { dose_id, ...version } of rows) {
    const list = out.get(dose_id);
    if (list) list.push(version);
    else out.set(dose_id, [version]);
  }
  return out;
}

// Attach each dose's schedule history to the rows a schedule read returns, so every
// consumer of a dose row can ask `doseDueOn` about ANY day and get the rule that was in
// force then (#1973). A dose with no recorded history keeps `versions` absent, which the
// resolver reads as "this row, always" — the pre-#1973 behaviour, unchanged.
function withScheduleVersions(
  profileId: number,
  doses: SupplementDose[]
): SupplementDose[] {
  if (doses.length === 0) return doses;
  const byDose = getDoseScheduleVersions(profileId);
  for (const d of doses) {
    const versions = byDose.get(d.id);
    if (versions) d.versions = versions;
  }
  return doses;
}

// Every dose row, including retired doses retained for adherence history. This is
// deliberately separate from getSupplementDoses: current-schedule consumers must
// never accidentally surface or make a retired dose actionable.
export function getSupplementDosesForHistory(
  profileId: number
): SupplementDose[] {
  return withScheduleVersions(
    profileId,
    db
      .prepare(
        `SELECT d.* FROM intake_item_doses d
         JOIN intake_items s ON s.id = d.item_id
        WHERE s.profile_id = ?
        ORDER BY d.item_id, d.sort, d.id`
      )
      .all(profileId) as SupplementDose[]
  );
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

// The cadence phrase for the item owning `doseId` ("Mondays", "Every 3 days"), or null
// when it has no calendar rule (#1602). Profile-scoped through the parent item, so a
// forged dose id from another profile reads null rather than leaking a schedule.
//
// It exists for the OFF-DAY confirm answer: a tap arriving from a frozen Telegram
// message needs the phrase to say "logged — note: scheduled for Mondays" instead of a
// bare ✓. Looked up only on that branch, so the ordinary confirm path costs nothing.
export function getDoseCadenceLabel(
  profileId: number,
  doseId: number
): string | null {
  const row = db
    .prepare(
      `SELECT s.cadence_kind AS cadence_kind,
              s.cadence_weekdays AS cadence_weekdays,
              s.cadence_interval_days AS cadence_interval_days,
              s.cadence_anchor_date AS cadence_anchor_date
         FROM intake_item_doses d
         JOIN intake_items s ON s.id = d.item_id
        WHERE d.id = ? AND s.profile_id = ?`
    )
    .get(doseId, profileId) as ItemCadence | undefined;
  return row ? cadenceLabel(row) : null;
}
