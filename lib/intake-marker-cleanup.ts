// Shared cleanup for the notification dedup markers an intake item (supplement /
// medication) leaves behind when it's deleted. Two delete paths must sweep the SAME
// two marker families identically: the per-item low-supply refill episode marker
// (`notify_last_refill_<id>`, #203) and each dose's missed-dose escalation marker
// (`notify_last_esc_<doseId>`, #328). Ids never recycle, so a stranded marker is a
// dead row rather than wrong suppression — but "one delete path sweeps, the other
// doesn't" is the inconsistency #328 closed, so both `deleteSupplement`
// (app/(app)/medicine/actions.ts) and the Data → Manage bulk delete
// (app/(app)/data/manage-actions.ts) route through here.
//
// The escalation markers are keyed by dose id, and a cascade delete removes the
// dose rows, so callers must capture the ids via `intakeItemDoseIds` BEFORE the
// delete and pass them to `sweepIntakeItemMarkers` after.

import { db } from "@/lib/db";
import { deleteProfileSetting } from "@/lib/settings";
import { refillMarkerKey } from "@/lib/refill-nudge";
import { escalationMarkerKey } from "@/lib/notifications/escalation-keys";

// The dose ids of a live intake item (profile-scoped via the parent JOIN). Call
// this BEFORE a cascade delete removes the doses, so `sweepIntakeItemMarkers` can
// clear each dose's escalation marker afterward.
export function intakeItemDoseIds(profileId: number, itemId: number): number[] {
  return (
    db
      .prepare(
        `SELECT d.id AS id FROM intake_item_doses d
           JOIN intake_items ii ON ii.id = d.item_id
          WHERE d.item_id = ? AND ii.profile_id = ?`
      )
      .all(itemId, profileId) as { id: number }[]
  ).map((r) => r.id);
}

// Drop a deleted item's low-supply refill marker and each of its doses' escalation
// markers. `doseIds` must be captured via `intakeItemDoseIds` before the cascade
// delete (the rows are gone by the time this runs). No-op when a marker isn't set.
export function sweepIntakeItemMarkers(
  profileId: number,
  itemId: number,
  doseIds: readonly number[]
): void {
  deleteProfileSetting(profileId, refillMarkerKey(itemId));
  for (const doseId of doseIds) {
    deleteProfileSetting(profileId, escalationMarkerKey(doseId));
  }
}
