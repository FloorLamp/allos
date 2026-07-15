// Part of the lib/queries/intake barrel (#319 — same #126 treatment training
// got). The profile-scoping guard walks all of lib/, so these split modules stay
// covered; every read is profile-scoped directly or through the parent
// intake_items JOIN.
// Current-schedule reads: the live supplement/medication items, their currently
// scheduled (non-retired) doses, and the AI suggestions awaiting review.
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
              (SELECT p.name FROM providers p WHERE p.id = intake_items.provider_id)
                AS provider_name
         FROM intake_items
         LEFT JOIN situations
                ON situations.id = intake_items.situation_id
               AND situations.profile_id = intake_items.profile_id
        WHERE intake_items.profile_id = ? ORDER BY active DESC, name`
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
         JOIN intake_items s ON s.id = d.item_id
        WHERE s.profile_id = ? AND d.retired = 0
        ORDER BY d.item_id, d.sort, d.id`
    )
    .all(profileId) as SupplementDose[];
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
