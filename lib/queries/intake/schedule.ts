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
//
// UNMEMOIZED on purpose (contrast the read behind `withScheduleVersions` below): this is
// what the dose-edit WRITE path reads to decide whether a pre-edit schedule still needs
// backfilling, and that decision must never be made against a cached answer.
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

// The history read behind `withScheduleVersions`, memoized per profile with a short TTL
// (#2066).
//
// WHY THE ATTACH CANNOT SIMPLY BE SKIPPED for callers that "only ask about today". That
// was the tempting reading of the tick's cost, and it is wrong: the hourly intake gather
// (lib/notifications/supplements.ts `gatherWindowDoses`) scores each due dose's ADHERENCE
// STRIP over the trailing window, calling `doseDueOn` for every past day in it. Three of
// the tick's four `getSupplementDoses` call sites reach that gather, so a lean
// "current schedule only" reader would silently re-introduce exactly the retroactive
// re-judgment #1973 exists to prevent. The join is not waste in that path — it is
// REPETITION: the same profile's history was being re-joined for every one of those
// calls, and again for every fan-out of the reader inside a single page render (warnings,
// refill math, upcoming safety and the tab itself all read it).
//
// Modeled on lib/db.ts's `tzMemo`, and for the same reason: three processes share one
// database file, so a process-wide cache has to bound its own staleness rather than
// assume it observes every write. Within one request or one tick — the whole window that
// matters here — the TTL never expires and the repetition collapses to one join.
//
// The one write whose result is rendered immediately, a dose edit, invalidates in-process
// through `invalidateDoseScheduleVersions` (see the recordScheduleVersion call sites), so
// an edited schedule is never read back stale. The two rare admin writers — an undo
// restore and a profile delete — self-heal inside the TTL; a restore additionally clears
// it explicitly. A miss anywhere degrades to `versions` absent, which the resolver reads
// as "this row, always" — the pre-#1973 behaviour, never a WRONG rule.
const versionsMemo = new Map<
  number,
  { at: number; byDose: Map<number, DoseScheduleVersion[]> }
>();
const VERSIONS_MEMO_TTL_MS = 5000;

// Drop the memoized schedule history for a profile (or every profile when omitted) so
// the next current-schedule read re-joins it. Called by the dose-edit write path.
export function invalidateDoseScheduleVersions(profileId?: number): void {
  if (profileId == null) versionsMemo.clear();
  else versionsMemo.delete(profileId);
}

function memoizedDoseScheduleVersions(
  profileId: number
): Map<number, DoseScheduleVersion[]> {
  const hit = versionsMemo.get(profileId);
  // Real time, deliberately: this is a DURATION, which the clock seam must never own.
  const at = Date.now();
  if (hit && at - hit.at < VERSIONS_MEMO_TTL_MS) return hit.byDose;
  const byDose = getDoseScheduleVersions(profileId);
  versionsMemo.set(profileId, { at, byDose });
  return byDose;
}

// Attach each dose's schedule history to the rows a schedule read returns, so every
// consumer of a dose row can ask `doseDueOn` about ANY day and get the rule that was in
// force then (#1973). A dose with no recorded history keeps `versions` absent, which the
// resolver reads as "this row, always" — the pre-#1973 behaviour, unchanged.
//
// The attached arrays are SHARED with the memo above and across the rows of every reader
// that ran inside the TTL. Every consumer of `versions` only ever reads it (the resolvers
// in lib/intake-cadence and lib/supplement-schedule), and a dose's recorded history is
// append-only by construction, so there is nothing here to copy defensively.
function withScheduleVersions(
  profileId: number,
  doses: SupplementDose[]
): SupplementDose[] {
  if (doses.length === 0) return doses;
  const byDose = memoizedDoseScheduleVersions(profileId);
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
