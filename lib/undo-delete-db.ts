// Undo / soft-delete for destructive row deletes (issue #30) — the IMPURE half.
//
// Wires the pure kind registry (lib/undo-delete.ts) to SQLite: capture-on-delete,
// restore-on-undo, and the 24h purge sweep. Server-only (uses the sync `db`).
//
// PHI note: the serialized payload holds the deleted row's content (PHI-adjacent),
// but it never leaves this same SQLite file — the same trust boundary as the row it
// came from. The label column is a generic, non-PHI kind descriptor only.

import { db, writeTx } from "./db";
import {
  capturedVideoFiles,
  getKindSpec,
  parsePayload,
  remapRow,
  serializePayload,
  type CapturedVideoFile,
  type ExternalRefSpec,
  type IdMaps,
  type MergeUndoContext,
  type Row,
} from "./undo-delete";
import { unlinkVideoFiles } from "./video/store";
import { revertActivityMerge } from "./merge-activity";
import { restoreAdministrationLog } from "./queries/intake/adherence";
import { unlinkFollowUpsForMedicalRecord } from "./followup-write";
import {
  writeImportTombstoneForRow,
  removeImportTombstoneForRow,
  liveRowIdForCapturedRoot,
} from "./integrations/tombstones";

// Human-readable, NON-PHI descriptors stored in deleted_rows.label (for a possible
// future trash view). Never the user's title/name — that stays in `payload`.
const KIND_LABELS: Record<string, string> = {
  activity: "activity",
  "body-metric": "body metric",
  "biomarker-record": "biomarker record",
  "intake-item": "intake item",
  // PRN administration (#851 item 11) — captured/restored by its own bespoke path
  // (deleteAdministrationLog / restoreAdministrationLog in lib/queries/intake/
  // adherence.ts), because its restore must invert a SUPPLY side effect and the ledger
  // row (intake_item_logs) has no profile_id column, so the generic entity-registry
  // capture/restore (which assumes a profile_id root) doesn't apply.
  administration: "administration",
};

// Does the referenced row still exist? Used at restore to reconcile captured external
// FK links (equipment_id, pair endpoints, medical_records' document_id/provider_id)
// whose target may have been deleted since capture (#202, #375). `ref.table` comes
// from the pure ExternalRefSpec registry (a constant, never user input); ids never
// recycle (AUTOINCREMENT), so an id match is the same row. A profile-owned target adds
// the profile_id scope as defense-in-depth; a GLOBAL target (`providers`, which has no
// profile_id — #375) is probed by id ALONE.
function targetExists(
  ref: ExternalRefSpec,
  id: number,
  profileId: number
): boolean {
  const row = ref.global
    ? db.prepare(`SELECT 1 FROM ${ref.table} WHERE id = ?`).get(id)
    : db
        .prepare(`SELECT 1 FROM ${ref.table} WHERE id = ? AND profile_id = ?`)
        .get(id, profileId);
  return row !== undefined;
}

// Capture a profile-owned row + its cascade children into the undo holding table
// and delete the row — all in ONE transaction, so the holding copy and the delete
// commit together (never a delete without an undo record, nor vice versa). Children
// are removed by the FK ON DELETE CASCADE (foreign_keys = ON), so only the root
// DELETE is issued. Returns the new deleted_rows id (the undo token), or null when
// the row doesn't exist / isn't this profile's (nothing was deleted).
//
// `merge` (issues #199/#200): the optional merge-undo context, present ONLY when the
// captured row is the DISCARDED side of an activity merge. It rides in the payload so
// restoreDeletedRow can invert the merge (move re-parented sets back, restore the
// keeper's pre-fold fields, clear the pair decision). Omitted for a plain delete.
export function captureDelete(
  kind: string,
  profileId: number,
  rootId: number,
  merge?: MergeUndoContext
): number | null {
  const spec = getKindSpec(kind);
  const root = spec.entities[0];

  return writeTx((): number | null => {
    const rootRow = db
      .prepare(`SELECT * FROM ${root.table} WHERE id = ? AND profile_id = ?`)
      .get(rootId, profileId) as Row | undefined;
    if (!rootRow) return null;

    const rows: Record<string, Row[]> = { [root.entity]: [rootRow] };
    for (const child of spec.entities.slice(1)) {
      const binds = Array.from({ length: child.childBinds ?? 1 }, () => rootId);
      rows[child.entity] = db
        .prepare(`SELECT * FROM ${child.table} WHERE ${child.childWhere}`)
        .all(...binds) as Row[];
    }

    const payload = serializePayload(kind, rows, merge);
    const info = db
      .prepare(
        `INSERT INTO deleted_rows (profile_id, kind, label, payload) VALUES (?, ?, ?, ?)`
      )
      .run(profileId, kind, KIND_LABELS[kind] ?? kind, payload);

    // Detach INBOUND references before the root delete (row-ops null-out rule): a
    // protocol can link an intake item as its intervention (protocols.intake_item_id,
    // issue #660) — a real FK with no ON DELETE action — so the DELETE below would
    // throw while a protocol still points at this supplement/medication. Null it in
    // the same transaction; the protocol survives, its intervention link is honestly
    // gone (not restored on undo, like the sibling equipment_id/supply-decrement
    // side effects). Centralized here so both delete paths — deleteSupplement and the
    // Data → Manage bulk delete — inherit it.
    if (spec.ownedTable === "intake_items") {
      db.prepare(
        `UPDATE protocols SET intake_item_id = NULL
          WHERE intake_item_id = ? AND profile_id = ?`
      ).run(rootId, profileId);
      // An episode's stopped-med reversal record (#1140 Part B) may reference THIS med
      // (item_id) and its just-closed course (course_id) — both REFERENCES FKs with no
      // ON DELETE (migration 095). Delete those link rows first (id-keyed, #203) so the
      // intake_items DELETE below can't trip the FK; not restored on undo (like the
      // protocol/supply side effects) — the reopen-restore link is honestly gone.
      db.prepare(
        `DELETE FROM episode_stopped_meds
          WHERE item_id = ? AND profile_id = ?`
      ).run(rootId, profileId);
    }

    // A flagged-lab follow-up (#700) may link this reading as its SOURCE finding, or a
    // resolution may cite it as the resolving record — both carry a REFERENCES FK
    // (migration 057) with no ON DELETE. NULL those links first (degrading the
    // follow-up to a generic care-plan item, keeping any resolution's outcome text) so
    // the medical_records DELETE below can't trip the care_plan_items FK. Not restored
    // on undo (like the equipment_id / supply-decrement side effects) — the reading
    // returns, its follow-up linkage stays honestly gone.
    if (spec.ownedTable === "medical_records") {
      unlinkFollowUpsForMedicalRecord(profileId, rootId);
      // A projected medication (#1051) may link this prescription record as its
      // source_record_id (a REFERENCES FK, no ON DELETE). NULL it first so the
      // medical_records DELETE below can't trip the FK; the med survives, its
      // provenance link honestly gone (not restored on undo, like the follow-up
      // links above).
      db.prepare(
        `UPDATE intake_items SET source_record_id = NULL
          WHERE source_record_id = ? AND profile_id = ?`
      ).run(rootId, profileId);
    }

    // Delete the root; children cascade. Profile-scoped for defense in depth.
    db.prepare(`DELETE FROM ${root.table} WHERE id = ? AND profile_id = ?`).run(
      rootId,
      profileId
    );

    // Re-import tombstone (#507/#508): when the deleted root is a source-owned row
    // (a Strava/HC activity, an imported scale reading, an imported vital), record its
    // natural key so the next rolling-window resync doesn't resurrect it. No-op for a
    // manual row (importTombstoneForRow returns null). Undo removes it (restore below).
    writeImportTombstoneForRow(profileId, spec.ownedTable, rootRow);

    return Number(info.lastInsertRowid);
  });
}

// Restore a captured delete: re-insert the root + children (NEW ids, FKs remapped)
// and drop the holding row — in ONE transaction. Returns true on success, false if
// the holding row is gone (already restored, swept, or another profile's). Idempotent
// in the sense that a second undo of the same token finds nothing and returns false.
export function restoreDeletedRow(profileId: number, undoId: number): boolean {
  const spec0 = db
    .prepare(
      `SELECT kind, payload FROM deleted_rows WHERE id = ? AND profile_id = ?`
    )
    .get(undoId, profileId) as { kind: string; payload: string } | undefined;
  if (!spec0) return false;

  // PRN administration (#851 item 11): a bespoke restore that re-inserts the ledger row
  // and RE-applies the supply decrement (the generic entity-registry path re-inserts
  // verbatim and inverts no data side effect, and the ledger has no profile_id root).
  if (spec0.kind === "administration") {
    return restoreAdministrationLog(profileId, undoId);
  }

  const payload = parsePayload(spec0.payload);
  const spec = getKindSpec(payload.kind);

  const rootEntity = spec.entities[0];

  writeTx(() => {
    const idMaps: IdMaps = {};
    for (const entity of spec.entities) {
      const isRoot = entity.entity === rootEntity.entity;
      const map = new Map<number, number>();
      idMaps[entity.entity] = map;
      const captured = payload.rows[entity.entity] ?? [];
      for (const row of captured) {
        const oldId = row.id;
        // Natural-key collision on the source-owned root (#509): between the delete
        // and this undo a resync may have re-created a row under the same
        // external_id / (date, source) — verbatim re-insert would throw on the UNIQUE
        // index. When a live row already occupies the key, adopt it as the restored
        // row (map old id -> live id, skip the insert) rather than throwing: children
        // remap onto it and a merge-undo inverts the keeper against it. With the
        // tombstone in place the resync never re-inserted, so this only fires for a
        // pre-tombstone delete; either way undo never crashes.
        if (isRoot && typeof oldId === "number") {
          const liveId = liveRowIdForCapturedRoot(
            profileId,
            spec.ownedTable,
            row
          );
          if (liveId !== null) {
            map.set(oldId, liveId);
            continue;
          }
        }
        const toInsert = remapRow(row, idMaps, entity.fks);
        // Reconcile captured FK links that point OUTSIDE this capture and may have
        // been deleted between capture and undo (#202): null a now-dangling nullable
        // link (e.g. exercise_sets.equipment_id — deleteEquipment nulls only live
        // sets, so a captured set kept its id), or DROP a join row whose required
        // far endpoint is gone (an intake_item_pairs whose partner item was deleted
        // — the live cascade would have removed it). Without this the verbatim
        // re-insert violates the FK (foreign_keys = ON) and aborts the whole undo.
        let drop = false;
        for (const ref of entity.externalRefs ?? []) {
          const v = toInsert[ref.column];
          if (typeof v !== "number") continue; // null / absent → nothing to check
          if (targetExists(ref, v, profileId)) continue;
          if (ref.onMissing === "drop") {
            drop = true;
            break;
          }
          toInsert[ref.column] = null; // onMissing === "null"
        }
        if (drop) continue;
        // Re-canonicalize an ordered pair (intake_item_pairs a_id/b_id) whose order
        // the remap may have inverted, so its CHECK (a_id < b_id) holds (#97).
        if (entity.orderedPair) {
          const [lo, hi] = entity.orderedPair;
          const x = toInsert[lo];
          const y = toInsert[hi];
          if (typeof x === "number" && typeof y === "number" && x > y) {
            toInsert[lo] = y;
            toInsert[hi] = x;
          }
        }
        const cols = Object.keys(toInsert);
        const info = db
          .prepare(
            `INSERT INTO ${entity.table} (${cols.join(", ")}) VALUES (${cols
              .map(() => "?")
              .join(", ")})`
          )
          .run(...cols.map((c) => toInsert[c]));
        if (typeof oldId === "number")
          map.set(oldId, Number(info.lastInsertRowid));
      }
    }

    // Merge-undo inversion (#199/#200): when the captured row was the discarded side
    // of an activity merge, also reverse the merge's keeper-side effects now that the
    // drop row is back — move its re-parented sets off the keeper, restore the
    // keeper's pre-fold fields, and clear the recorded pair decision. Gated on the
    // presence of the merge context, so every OTHER undo kind is untouched.
    if (payload.merge) {
      const rootEntity = spec.entities[0].entity;
      const oldRootId = payload.rows[rootEntity]?.[0]?.id;
      const newDropId =
        typeof oldRootId === "number"
          ? idMaps[rootEntity]?.get(oldRootId)
          : undefined;
      if (typeof newDropId === "number")
        revertActivityMerge(profileId, payload.merge, newDropId);
    }

    // Remove the re-import tombstone the delete/merge wrote (#200 side-effect
    // inversion): the row is back, so the rolling window should resume ingesting its
    // natural key. No-op for a manual root (no tombstone was written).
    const capturedRoot = payload.rows[rootEntity.entity]?.[0];
    if (capturedRoot)
      removeImportTombstoneForRow(profileId, spec.ownedTable, capturedRoot);

    db.prepare(`DELETE FROM deleted_rows WHERE id = ? AND profile_id = ?`).run(
      undoId,
      profileId
    );
  });
  return true;
}

// Purge holding rows older than `maxAgeHours` (default 24h). GLOBAL by design — one
// call per hourly notify tick clears every profile's expired undo records (purged
// means purged), so it is intentionally NOT profile-scoped (allowlisted in the
// profile-scoping test). Returns the number of rows removed. Never throws.
//
// Purge-time file cleanup (#1290): a captured delete's clip FILES (activity_videos /
// symptom_videos stored_path + poster_path) survive the delete+undo window on disk so
// a restore re-points at them, but a purge WITHOUT a restore leaves them orphaned —
// rows gone (unservable) yet present on disk, which the strictest-privacy tier these
// clips sit in can't tolerate. So BEFORE the delete we read the expiring payloads and
// collect their captured clip files, and AFTER the delete we unlink each one that no
// LIVE row still references (content-hash dedup means a re-upload can share the file).
export function sweepDeletedRows(maxAgeHours = 24): number {
  try {
    const cutoff = `-${maxAgeHours} hours`;

    // Collect the captured clip/poster files of the rows about to be purged. A
    // malformed/legacy payload (e.g. the bespoke `administration` kind) never blocks
    // the sweep — its parse is caught and skipped.
    const expiring = db
      .prepare(
        `SELECT payload FROM deleted_rows WHERE deleted_at < datetime('now', ?)`
      )
      .all(cutoff) as { payload: string }[];
    const videoFiles: CapturedVideoFile[] = [];
    for (const r of expiring) {
      try {
        videoFiles.push(...capturedVideoFiles(parsePayload(r.payload)));
      } catch {
        // an unparseable / non-registry payload carries no reclaimable video files
      }
    }

    const changes = db
      .prepare(`DELETE FROM deleted_rows WHERE deleted_at < datetime('now', ?)`)
      .run(cutoff).changes;

    // After the holding rows are gone, unlink the now-unreferenced clip files.
    unlinkPurgedVideoFiles(videoFiles);

    return changes;
  } catch {
    return 0;
  }
}

// Unlink the clip/poster files of purged captures, SKIPPING any path a live
// activity_videos / symptom_videos row still references — content-hash dedup means a
// re-upload of the identical clip after the delete re-created a live row pointing at
// the SAME on-disk file (stored_path is content-named), so unlinking it would break a
// live clip. The actual unlink is path-contained per domain root (unlinkVideoFiles),
// best-effort, and never throws (the row deletes already committed). (#1290)
function unlinkPurgedVideoFiles(files: readonly CapturedVideoFile[]): void {
  for (const f of files) {
    const table =
      f.domain === "activity" ? "activity_videos" : "symptom_videos";
    const stillLive = db.prepare(
      `SELECT 1 FROM ${table} WHERE stored_path = ? OR poster_path = ?`
    );
    const toUnlink: string[] = [];
    for (const p of [f.storedPath, f.posterPath]) {
      if (!p) continue;
      if (stillLive.get(p, p) === undefined) toUnlink.push(p);
    }
    if (toUnlink.length) unlinkVideoFiles(f.domain, toUnlink);
  }
}
