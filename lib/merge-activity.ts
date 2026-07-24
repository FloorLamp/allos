// The impure (DB-touching) half of an activity merge, shared by the Data → Review
// duplicate resolver (app/(app)/data/review-actions.ts) and the Journal's manual
// pair-merge (app/(app)/journal/actions.ts). The pure fold math lives in
// lib/import-review/detect.ts (foldActivityFields); this writes the folded result
// onto the keeper. Server-only (uses the sync `db`).
//
// Callers own the DELETE of the discarded row and the recorded pair-decision — the
// two merges differ there: the review resolver deletes via FK cascade (no undo),
// while the journal's manual merge routes the delete through captureDelete so a
// mis-merge can be undone from a toast (issue #64 / #30).

import { db } from "./db";
import { foldActivityFieldsWithOverrides } from "./import-review/conflicts";
import { ACTIVITY_FOLD_FIELDS, orderDropsForFold } from "./import-review/detect";
import { deletePairDecision } from "./queries/integrations";
import type { MergeUndoContext } from "./undo-delete";

// What writeActivityFold actually moved for one dropped row, returned so an undoable
// caller (the Journal merge) can build a per-drop MergeUndoContext that inverts EXACTLY
// what happened (#199/#200). `movedRouteId` is the drop's activity_routes id the fold
// re-parented onto the keeper, or null when the keeper already had a route (so the
// drop kept its own, captured as a child by the generic delete instead).
export interface DropFoldMove {
  dropId: number;
  movedRouteId: number | null;
}

// Fold the DISCARDED row's gap-filling fields into the KEEPER — COALESCE(keep, drop)
// per column, so the keeper's own values always win and the discarded row only fills
// a gap — and mark the keeper `edited = 1` so a later re-ingest of the rolling window
// won't clobber the merged result (the user-edit-wins lock, same convention
// saveActivity uses). PROFILE-SCOPED (the UPDATE filters profile_id); the caller has
// already verified both rows are the acting profile's. `keep`/`drop` are the full
// activity rows the caller SELECTed.
//
// `overrideFields` (issue #100): the conflict-preview per-field overrides — a
// validated list of fold-field names where the user chose the DISCARDED row's value
// instead of the keeper's. For those fields the discarded row's own value wins; all
// other fields fold exactly as before. Empty (the default) is the unchanged
// keeper-wins fold. The values are ALWAYS taken from the re-read `drop` row here —
// the caller only forwards NAMES, never client-supplied values.
//
// RE-PARENTING (issue #199): before the caller deletes the discarded row, its
// `exercise_sets` are moved onto the keeper so a merge can NEVER lose typed-in
// training history to the FK cascade. Doing it HERE fixes both merge paths at once
// (the undoable Journal merge and the plain-delete Review resolver) — neither caller
// can forget it. It is strictly safe: PR detection + volume math already handle
// multi-exercise activities, so the keeper simply carries both rows' sets.
export function writeActivityFold(
  profileId: number,
  keepId: number,
  keep: Record<string, unknown>,
  drops: Record<string, unknown>[],
  overrideFields: Iterable<string> = []
): DropFoldMove[] {
  // Fold every drop into the keeper in a DETERMINISTIC order (by activityToken, #1081)
  // so an N-way fold is reproducible across a re-sync. Each step is the same
  // keeper-wins COALESCE gap-fill (foldActivityFieldsWithOverrides); the accumulated
  // keeper only ever GAINS a value where it had a gap, so the fold is associative and
  // the order only decides which drop fills a shared gap first. The per-field
  // conflict overrides (#100) are a pairwise affordance — they apply to the FIRST
  // drop in the order (the only meaningful case is a 2-row merge, drops.length === 1).
  const ordered = orderDropsForFold(
    drops as unknown as Parameters<typeof orderDropsForFold>[0]
  ) as unknown as Record<string, unknown>[];
  let folded: Record<string, unknown> = keep;
  ordered.forEach((drop, i) => {
    const step = foldActivityFieldsWithOverrides(
      folded,
      drop,
      i === 0 ? overrideFields : []
    );
    folded = { ...folded, ...step };
  });
  const f = folded as Record<(typeof ACTIVITY_FOLD_FIELDS)[number], unknown>;
  // Session-level equipment link (#342): keeper-wins COALESCE across the keeper then
  // every drop in order — the keeper's gear stands, the drops only fill a gap.
  // Handled explicitly (not via ACTIVITY_FOLD_FIELDS) so the link stays out of the
  // fold's richness scoring and conflict-preview UI, which are for measurement gap-fill.
  let foldedEquipmentId =
    (keep.equipment_id as number | null | undefined) ?? null;
  for (const drop of ordered) {
    foldedEquipmentId =
      foldedEquipmentId ?? (drop.equipment_id as number | null | undefined) ?? null;
  }

  // Re-parent every drop's children onto the keeper (#199, now for N drops). Track
  // whether the keeper has a GPS route yet (activity_routes is UNIQUE(activity_id)):
  // move a drop's route only when the keeper still has none, so the first drop with a
  // route wins the keeper's slot and later drops keep their own (captured by the undo
  // path). Return the actual per-drop route move so the undo context can invert
  // EXACTLY what happened.
  let keeperHasRoute =
    db.prepare(`SELECT 1 FROM activity_routes WHERE activity_id = ?`).get(keepId) !=
    null;
  const moves: DropFoldMove[] = [];
  for (const drop of ordered) {
    const dropId = drop.id;
    if (typeof dropId !== "number") continue;
    // exercise_sets is a child table (no profile_id of its own); the caller has
    // verified every activity belongs to the acting profile, so scoping by
    // activity_id is sufficient (mirrors saveActivity's own set writes).
    db.prepare(
      `UPDATE exercise_sets SET activity_id = ? WHERE activity_id = ?`
    ).run(keepId, dropId);
    let movedRouteId: number | null = null;
    if (!keeperHasRoute) {
      const route = db
        .prepare(`SELECT id FROM activity_routes WHERE activity_id = ?`)
        .get(dropId) as { id: number } | undefined;
      if (route) {
        db.prepare(
          `UPDATE activity_routes SET activity_id = ? WHERE activity_id = ?`
        ).run(keepId, dropId);
        movedRouteId = route.id;
        keeperHasRoute = true;
      }
    }
    // Re-parent the drop's form-check video clips onto the keeper (#1224, #199) — a
    // blind move (many-per-activity, no uniqueness). activity_videos is profile-owned,
    // so the WHERE names profile_id (unlike the child exercise_sets/activity_routes).
    db.prepare(
      `UPDATE activity_videos SET activity_id = ?
        WHERE activity_id = ? AND profile_id = ?`
    ).run(keepId, dropId, profileId);
    moves.push({ dropId, movedRouteId });
  }

  db.prepare(
    `UPDATE activities
        SET notes = ?, duration_min = ?, distance_km = ?, intensity = ?,
            start_time = ?, end_time = ?, components = ?,
            avg_hr = ?, max_hr = ?, elevation_m = ?, avg_speed_kmh = ?,
            max_speed_kmh = ?, relative_effort = ?, avg_power_w = ?,
            max_power_w = ?, weighted_avg_power_w = ?, avg_cadence = ?,
            avg_temp_c = ?, kilojoules = ?, workout_type = ?,
            equipment_id = ?,
            edited = 1
      WHERE id = ? AND profile_id = ?`
  ).run(
    f.notes,
    f.duration_min,
    f.distance_km,
    f.intensity,
    f.start_time,
    f.end_time,
    f.components,
    f.avg_hr,
    f.max_hr,
    f.elevation_m,
    f.avg_speed_kmh,
    f.max_speed_kmh,
    f.relative_effort,
    f.avg_power_w,
    f.max_power_w,
    f.weighted_avg_power_w,
    f.avg_cadence,
    f.avg_temp_c,
    f.kilojoules,
    f.workout_type,
    foldedEquipmentId,
    keepId,
    profileId
  );
  return moves;
}

// Snapshot the keeper's PRE-fold state for a fully-invertible merge undo (#200):
// its fold-field values plus its prior `edited` flag, taken from the row the caller
// SELECTed BEFORE writeActivityFold ran. restoreDeletedRow writes these back so undo
// removes every gap-fill the merge added (the wholesale-inherited `components` array
// is the sharpest double-count) and restores the keeper's original edit-lock. Pure.
export function snapshotKeeperFold(
  keep: Record<string, unknown>
): Record<string, unknown> {
  const snap: Record<string, unknown> = {};
  for (const f of ACTIVITY_FOLD_FIELDS) snap[f] = keep[f] ?? null;
  snap.edited = keep.edited ?? 0;
  // Session-level equipment link (#342): captured alongside the fold fields so undo
  // restores the keeper's pre-fold gear, undoing any gap-fill the merge applied.
  snap.equipment_id = keep.equipment_id ?? null;
  return snap;
}

// The ids of a to-be-discarded row's exercise_sets, read BEFORE writeActivityFold
// re-parents them (#199). Captured into the merge-undo context so undo can move
// exactly these sets back off the keeper.
export function dropSetIds(dropId: number): number[] {
  return (
    db
      .prepare(`SELECT id FROM exercise_sets WHERE activity_id = ?`)
      .all(dropId) as { id: number }[]
  ).map((r) => r.id);
}

// INVERT an activity merge on undo (#199/#200): given the restored discarded row's
// NEW id, move its re-parented sets back off the keeper, restore the keeper's
// pre-fold fields, and clear the recorded pair decision so the pair resurfaces in
// Review. Called from restoreDeletedRow inside its restore transaction — the drop
// row itself is re-inserted by the generic restore, so this only reverses the
// keeper-side effects the merge applied. Profile-scoped on the keeper write.
export function revertActivityMerge(
  profileId: number,
  merge: MergeUndoContext,
  newDropId: number
): void {
  // 1. Move the drop's sets back off the keeper onto the restored row (#199). Bound
  //    by id AND the keeper's current parent so a set since moved/deleted is skipped.
  if (merge.movedSetIds.length > 0) {
    const placeholders = merge.movedSetIds.map(() => "?").join(", ");
    db.prepare(
      `UPDATE exercise_sets SET activity_id = ?
        WHERE activity_id = ? AND id IN (${placeholders})`
    ).run(newDropId, merge.keeperId, ...merge.movedSetIds);
  }

  // 1b. Move the drop's re-parented GPS route back off the keeper onto the restored
  //     row (#569). Bound by id AND the keeper's current parent so a route since
  //     moved/deleted is skipped; the restored row has a fresh id with no route, so
  //     the UNIQUE(activity_id) constraint can't collide.
  if (merge.movedRouteId != null) {
    db.prepare(
      `UPDATE activity_routes SET activity_id = ?
        WHERE activity_id = ? AND id = ?`
    ).run(newDropId, merge.keeperId, merge.movedRouteId);
  }

  // 2. Restore the keeper's pre-fold fold-field values + prior edited flag (#200),
  //    undoing every gap-fill (incl. the inherited components) the fold added.
  const before = merge.keeperBefore;
  // The captured pre-fold equipment_id points at an equipment row OUTSIDE this
  // merge-undo context. If that gear was deleted after the merge (deleteEquipment
  // nulls only LIVE activities.equipment_id, so this snapshot kept its id), writing
  // it back verbatim would violate activities.equipment_id's FK (migration 019) and
  // abort the ENTIRE undo (#598) — the same #202/#375 dangling-target class the
  // generic externalRefs reconciliation handles, which never sees the merge context.
  // Probe it (profile-scoped, since equipment is profile-owned) and null a dead link.
  const beforeEquipmentId =
    typeof before.equipment_id === "number" &&
    !db
      .prepare("SELECT 1 FROM equipment WHERE id = ? AND profile_id = ?")
      .get(before.equipment_id, profileId)
      ? null
      : (before.equipment_id ?? null);
  db.prepare(
    `UPDATE activities
        SET notes = ?, duration_min = ?, distance_km = ?, intensity = ?,
            start_time = ?, end_time = ?, components = ?,
            avg_hr = ?, max_hr = ?, elevation_m = ?, avg_speed_kmh = ?,
            max_speed_kmh = ?, relative_effort = ?, avg_power_w = ?,
            max_power_w = ?, weighted_avg_power_w = ?, avg_cadence = ?,
            avg_temp_c = ?, kilojoules = ?, workout_type = ?,
            equipment_id = ?,
            edited = ?
      WHERE id = ? AND profile_id = ?`
  ).run(
    before.notes ?? null,
    before.duration_min ?? null,
    before.distance_km ?? null,
    before.intensity ?? null,
    before.start_time ?? null,
    before.end_time ?? null,
    before.components ?? null,
    before.avg_hr ?? null,
    before.max_hr ?? null,
    before.elevation_m ?? null,
    before.avg_speed_kmh ?? null,
    before.max_speed_kmh ?? null,
    before.relative_effort ?? null,
    before.avg_power_w ?? null,
    before.max_power_w ?? null,
    before.weighted_avg_power_w ?? null,
    before.avg_cadence ?? null,
    before.avg_temp_c ?? null,
    before.kilojoules ?? null,
    before.workout_type ?? null,
    beforeEquipmentId,
    before.edited ?? 0,
    merge.keeperId,
    profileId
  );

  // 3. Clear the recorded 'merged' decision so the un-merged pair re-detects (#200).
  deletePairDecision(profileId, merge.domain, merge.signature);
}
