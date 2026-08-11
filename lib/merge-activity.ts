// The impure (DB-touching) half of an activity merge, shared by the Data → Review
// duplicate resolver (app/(app)/data/review-actions.ts) and the Training Log's manual
// pair-merge (app/(app)/training/activity-actions.ts). The pure fold math lives in
// lib/import-review (foldActivityFields in detect.ts; the keeper columns a fold writes,
// keeperFoldState, in conflicts.ts); this writes that result onto the keeper and — on
// undo — writes it back with one member removed. Server-only (uses the sync `db`).
//
// Callers own the DELETE of the discarded row and the recorded pair-decision — the
// two merges differ there: the review resolver deletes via FK cascade (no undo),
// while the training log's manual merge routes the delete through captureDelete so a
// mis-merge can be undone from a toast (issue #64 / #30).

import { db } from "./db";
import {
  keeperFoldState,
  type KeeperFoldState,
  type OverrideChoices,
} from "./import-review/conflicts";
import {
  ACTIVITY_FOLD_FIELDS,
  orderDropsForFold,
} from "./import-review/detect";
import { deletePairDecision } from "./queries/integrations";
import { parsePayload, type MergeUndoContext, type Row } from "./undo-delete";

// What writeActivityFold actually moved for one dropped row, returned so an undoable
// caller (the Training Log merge) can build a per-drop MergeUndoContext that inverts EXACTLY
// what happened (#199/#200). `movedRouteId` is the drop's activity_routes id the fold
// re-parented onto the keeper, or null when the keeper already had a route (so the
// drop kept its own, captured as a child by the generic delete instead).
export interface DropFoldMove {
  dropId: number;
  movedRouteId: number | null;
  movedTelemetryIds: number[];
  movedLapIds: number[];
  movedSegmentEffortIds: number[];
}

function moveOwnedActivityChildren(
  table: "activity_laps" | "activity_segment_efforts",
  profileId: number,
  keepId: number,
  dropId: number
): number[] {
  const ids = (
    db
      .prepare(
        `SELECT id FROM ${table} WHERE profile_id = ? AND activity_id = ? ORDER BY id`
      )
      .all(profileId, dropId) as { id: number }[]
  ).map((row) => row.id);
  if (ids.length > 0) {
    db.prepare(
      `UPDATE ${table} SET activity_id = ?
        WHERE profile_id = ? AND activity_id = ?`
    ).run(keepId, profileId, dropId);
  }
  return ids;
}

// Fold the DISCARDED row's gap-filling fields into the KEEPER — COALESCE(keep, drop)
// per column, so the keeper's own values always win and the discarded row only fills
// a gap — and mark the keeper `edited = 1` so a later re-ingest of the rolling window
// won't clobber the merged result (the user-edit-wins lock, same convention
// saveActivity uses). PROFILE-SCOPED (the UPDATE filters profile_id); the caller has
// already verified both rows are the acting profile's. `keep`/`drop` are the full
// activity rows the caller SELECTed.
//
// `overrides` (issue #100, per-member since #1431): the conflict-picker per-field
// choices — a validated map of fold-field name → the MEMBER row id (keeper or any
// drop) whose value should win that field. For those fields the chosen member's own
// value wins regardless of fold order; all other fields fold exactly as before.
// Empty (the default) is the unchanged keeper-wins fold. The values are ALWAYS
// taken from the re-read rows here — the caller only forwards NAMES and IDS, never
// client-supplied values, and an id outside the merge resolves to nothing.
//
// RE-PARENTING (issue #199): before the caller deletes the discarded row, its
// `exercise_sets` are moved onto the keeper so a merge can NEVER lose typed-in
// training history to the FK cascade. Doing it HERE fixes both merge paths at once
// (the undoable Training Log merge and the plain-delete Review resolver) — neither caller
// can forget it. It is strictly safe: PR detection + volume math already handle
// multi-exercise activities, so the keeper simply carries both rows' sets.
export function writeActivityFold(
  profileId: number,
  keepId: number,
  keep: Record<string, unknown>,
  drops: Record<string, unknown>[],
  overrides: OverrideChoices = {}
): DropFoldMove[] {
  // Fold every drop into the keeper in a DETERMINISTIC order (by activityToken, #1081)
  // so an N-way fold is reproducible across a re-sync. Each step is the same
  // keeper-wins COALESCE gap-fill; the accumulated keeper only ever GAINS a value
  // where it had a gap, so the fold is associative and the order only decides which
  // drop fills a shared gap first. The per-field member choices (#100/#1431) are
  // applied AFTER the fold, so a chosen value wins regardless of fold order.
  const ordered = orderDropsForFold(
    drops as unknown as Parameters<typeof orderDropsForFold>[0]
  ) as unknown as Record<string, unknown>[];
  // The keeper columns this fold writes — the SAME pure computation the undo runs in
  // reverse (#1884), so a partial undo can only ever land the keeper on a state some
  // subset of this fold would have produced.
  const state = keeperFoldState(keep, ordered, overrides);

  // Re-parent every drop's children onto the keeper (#199, now for N drops). Track
  // whether the keeper has a GPS route yet (activity_routes is UNIQUE(activity_id)):
  // move a drop's route only when the keeper still has none, so the first drop with a
  // route wins the keeper's slot and later drops keep their own (captured by the undo
  // path). Return the actual per-drop route move so the undo context can invert
  // EXACTLY what happened.
  let keeperHasRoute =
    db
      .prepare(`SELECT 1 FROM activity_routes WHERE activity_id = ?`)
      .get(keepId) != null;
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
    // Cycling artifacts are activity children just like routes and form-check
    // videos. Move them before the drop is deleted so Review and automatic merges
    // cannot cascade away a Strava ride's sensor history. Telemetry is unique per
    // activity/source, so keep an existing keeper snapshot for a conflicting source.
    // Undoable merges capture the duplicate left on the drop; permanent merges still
    // retain the keeper's same-source snapshot.
    const keeperTelemetrySources = new Set(
      (
        db
          .prepare(
            `SELECT source FROM activity_telemetry
              WHERE profile_id = ? AND activity_id = ?`
          )
          .all(profileId, keepId) as { source: string }[]
      ).map((row) => row.source)
    );
    const dropTelemetry = db
      .prepare(
        `SELECT id, source FROM activity_telemetry
          WHERE profile_id = ? AND activity_id = ? ORDER BY id`
      )
      .all(profileId, dropId) as { id: number; source: string }[];
    const movedTelemetryIds: number[] = [];
    for (const telemetry of dropTelemetry) {
      if (keeperTelemetrySources.has(telemetry.source)) continue;
      db.prepare(
        `UPDATE activity_telemetry SET activity_id = ?
          WHERE id = ? AND profile_id = ? AND activity_id = ?`
      ).run(keepId, telemetry.id, profileId, dropId);
      keeperTelemetrySources.add(telemetry.source);
      movedTelemetryIds.push(telemetry.id);
    }
    const movedLapIds = moveOwnedActivityChildren(
      "activity_laps",
      profileId,
      keepId,
      dropId
    );
    const movedSegmentEffortIds = moveOwnedActivityChildren(
      "activity_segment_efforts",
      profileId,
      keepId,
      dropId
    );
    // Re-parent the drop's form-check video clips onto the keeper (#1224, #199) — a
    // blind move (many-per-activity, no uniqueness). activity_videos is profile-owned,
    // so the WHERE names profile_id (unlike the child exercise_sets/activity_routes).
    db.prepare(
      `UPDATE activity_videos SET activity_id = ?
        WHERE activity_id = ? AND profile_id = ?`
    ).run(keepId, dropId, profileId);
    moves.push({
      dropId,
      movedRouteId,
      movedTelemetryIds,
      movedLapIds,
      movedSegmentEffortIds,
    });
  }

  writeKeeperFoldState(profileId, keepId, state);
  return moves;
}

// Write a computed KeeperFoldState onto the keeper row. The ONE statement that moves
// the keeper's fold columns, shared by the fold and its undo (#1884) so the two can
// never drift apart on which columns a merge owns. Profile-scoped.
function writeKeeperFoldState(
  profileId: number,
  keeperId: number,
  state: KeeperFoldState
): void {
  const f = state.fields;
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
    f.notes ?? null,
    f.duration_min ?? null,
    f.distance_km ?? null,
    f.intensity ?? null,
    f.start_time ?? null,
    f.end_time ?? null,
    f.components ?? null,
    f.avg_hr ?? null,
    f.max_hr ?? null,
    f.elevation_m ?? null,
    f.avg_speed_kmh ?? null,
    f.max_speed_kmh ?? null,
    f.relative_effort ?? null,
    f.avg_power_w ?? null,
    f.max_power_w ?? null,
    f.weighted_avg_power_w ?? null,
    f.avg_cadence ?? null,
    f.avg_temp_c ?? null,
    f.kilojoules ?? null,
    f.workout_type ?? null,
    state.equipmentId,
    state.edited,
    keeperId,
    profileId
  );
}

// Snapshot the keeper's PRE-fold state for a fully-invertible merge undo (#200):
// its fold-field values plus its prior `edited` flag, taken from the row the caller
// SELECTed BEFORE writeActivityFold ran. It is the BASE the undo re-folds from
// (#1884): restoring the last drop lands the keeper exactly here, so undo removes
// every gap-fill the merge added (the wholesale-inherited `components` array is the
// sharpest double-count) and restores the keeper's original edit-lock. Pure.
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

// The activity rows of the OTHER drops of the same merge that are still folded into
// the keeper — i.e. whose undo token is still sitting in `deleted_rows` un-restored
// (#1884). `excludeUndoId` is the token being restored right now, which
// restoreDeletedRow only deletes AFTER this inversion runs.
//
// Merge identity is the payload-level `mergeId` every drop of one merge shares. A
// payload captured before #1884 has none; it yields no siblings, which is exactly the
// pre-#1884 whole-snapshot behaviour, and those payloads age out within the retention
// window. A sibling that was already restored has had its holding row deleted, so it
// correctly stops counting as folded-in. Profile-scoped; a malformed payload is
// skipped rather than aborting the undo.
function foldedSiblingDrops(
  profileId: number,
  mergeId: string,
  excludeUndoId: number
): Row[] {
  const held = db
    .prepare(
      `SELECT id, payload FROM deleted_rows
        WHERE profile_id = ? AND kind = 'activity' AND id != ?`
    )
    .all(profileId, excludeUndoId) as { id: number; payload: string }[];
  const out: Row[] = [];
  for (const row of held) {
    try {
      const payload = parsePayload(row.payload);
      if (payload.merge?.mergeId !== mergeId) continue;
      const drop = payload.rows.activity?.[0];
      if (drop) out.push(drop);
    } catch {
      // an unparseable / non-registry payload is not a sibling of this merge
    }
  }
  return out;
}

// INVERT one drop's share of an activity merge on undo (#199/#200, made partial-safe
// by #1884): given the restored discarded row's NEW id, move ITS re-parented sets and
// route back off the keeper, re-fold the keeper from the drops that are STILL folded
// in, and clear this pair's recorded decision so the pair resurfaces in Review. Called
// from restoreDeletedRow inside its restore transaction — the drop row itself is
// re-inserted by the generic restore, so this only reverses the keeper-side effects.
// Profile-scoped on the keeper write.
//
// ── The model: incremental un-fold, not a whole-snapshot reset (#1884) ─────────────
// A multi-drop merge's undo is a BATCH of independent per-token restores, and by
// undoDeletes' documented #202 design a token that throws is isolated so the rest
// still restore. So this inversion must be correct for ANY SUBSET of the merge's drops
// coming back, in any order. Writing the pre-fold `keeperBefore` snapshot
// unconditionally was not: undoing drops A and C while B's restore failed reset the
// keeper past the point where it carried B's contribution while B stayed deleted and
// B's re-parented sets stayed on the keeper unaccounted for — B's data reachable from
// nowhere.
//
// Instead the keeper is RECOMPUTED as `fold(keeperBefore, drops still folded in)`:
// the fold is a pure function of its inputs (keeperFoldState), so removing one member
// from that set removes exactly that member's contribution and leaves every other
// drop's intact. Restoring the last drop makes the set empty, which reproduces
// `keeperBefore` — so a full undo is unchanged, and a retry of a failed token later
// converges to the same fully-undone state.
//
// Children follow their own row, always: a restored drop's sets/route move back onto
// it; an un-restored drop's sets/route stay on the keeper, which is where they live
// for as long as that drop is still merged in. No row's data is ever unreachable.
//
// Why not make the batch atomic instead (one transaction over the merge's tokens)?
// That would fix the batch path only — a single-token undo of one drop of an N-way
// merge has the same defect — and it would carve an exception into #202's per-token
// isolation to work around an inversion that simply wasn't compositional. Making the
// inversion compositional keeps the isolation design intact and correct.
export function revertActivityMerge(
  profileId: number,
  merge: MergeUndoContext,
  newDropId: number,
  undoId: number
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

  // 1c. Cycling artifacts moved before the cascade follow their restored drop on
  // undo. Older pending undo payloads do not carry these arrays, so default them to
  // empty for compatibility across a deployment.
  const restoreOwnedChildren = (
    table: "activity_telemetry" | "activity_laps" | "activity_segment_efforts",
    ids: number[]
  ) => {
    if (ids.length === 0) return;
    const placeholders = ids.map(() => "?").join(", ");
    db.prepare(
      `UPDATE ${table} SET activity_id = ?
        WHERE profile_id = ? AND activity_id = ? AND id IN (${placeholders})`
    ).run(newDropId, profileId, merge.keeperId, ...ids);
  };
  restoreOwnedChildren("activity_telemetry", merge.movedTelemetryIds ?? []);
  restoreOwnedChildren("activity_laps", merge.movedLapIds ?? []);
  restoreOwnedChildren(
    "activity_segment_efforts",
    merge.movedSegmentEffortIds ?? []
  );

  // 2. Re-fold the keeper from the drops STILL folded into it (#200/#1884). With none
  //    left this is exactly the pre-fold snapshot, undoing every gap-fill (incl. the
  //    inherited components) and restoring the keeper's own edit lock; with siblings
  //    still merged it keeps precisely their contributions and drops only this one's.
  //    The keeper's own id rides on the snapshot so a per-field member choice naming
  //    the keeper still resolves (#1431).
  const before = merge.keeperBefore;
  const siblings = merge.mergeId
    ? foldedSiblingDrops(profileId, merge.mergeId, undoId)
    : [];
  const state = keeperFoldState(
    { ...before, id: merge.keeperId },
    siblings,
    merge.overrides ?? {}
  );
  // The folded equipment_id points at an equipment row OUTSIDE this merge-undo context
  // (the keeper's own pre-fold gear, or a still-folded drop's). If that gear was
  // deleted after the merge (deleteEquipment nulls only LIVE
  // activities.equipment_id, so the captured copies kept its id), writing it back
  // verbatim would violate activities.equipment_id's FK (migration 019) and abort the
  // ENTIRE undo (#598) — the same #202/#375 dangling-target class the generic
  // externalRefs reconciliation handles, which never sees the merge context. Probe it
  // (profile-scoped, since equipment is profile-owned) and null a dead link.
  if (
    state.equipmentId != null &&
    !db
      .prepare("SELECT 1 FROM equipment WHERE id = ? AND profile_id = ?")
      .get(state.equipmentId, profileId)
  )
    state.equipmentId = null;
  writeKeeperFoldState(profileId, merge.keeperId, state);

  // 3. Clear the recorded 'merged' decision so the un-merged pair re-detects (#200).
  deletePairDecision(profileId, merge.domain, merge.signature);
}
