// Undo / soft-delete for destructive row deletes (issue #30) — the IMPURE half.
//
// Wires the pure kind registry (lib/undo-delete.ts) to SQLite: capture-on-delete,
// restore-on-undo, the retention purge sweep, and the two by-hand purges the Trash
// surface adds (#2013). Server-only (uses the sync `db`).
//
// PHI note: the serialized payload holds the deleted row's content (PHI-adjacent),
// but it never leaves this same SQLite file — the same trust boundary as the row it
// came from. The label column is a generic, non-PHI kind descriptor only.

import { db, writeTx } from "./db";
import { DEFAULT_TRASH_RETENTION_DAYS, daysAgoModifier } from "./retention";
import { dayCounterSpecFor } from "./day-counter-ledger";
import { dayCounterLedger } from "./day-counter-ledger-db";
import {
  capturedPhotoFiles,
  capturedVideoFiles,
  getKindSpec,
  parsePayload,
  remapRow,
  serializePayload,
  type CapturedPhotoDomain,
  type CapturedPhotoFile,
  type CapturedVideoFile,
  type EntitySpec,
  type ExternalRefSpec,
  type IdMaps,
  type MergeUndoContext,
  type Row,
} from "./undo-delete";
import { unlinkVideoFiles } from "./video/store";
import { thumbSiblingPath, unlinkPhotoFiles } from "./photo/store";
import {
  unlinkFollowUpsForSkinLesion,
  unlinkFollowUpsForClinicalObservation,
} from "./followup-write";
import { revertActivityMerge } from "./merge-activity";
import { restoreAdministrationLog } from "./queries/intake/adherence";
import { invalidateDoseScheduleVersions } from "./queries/intake/schedule";
import {
  writeImportTombstoneForRow,
  removeImportTombstoneForRow,
  liveRowIdForCapturedRoot,
} from "./integrations/tombstones";
import { practiceIdentity } from "./practice";
import { TRASH_EXCLUDED_KIND } from "./trash";

// A captured counter row's identity values BESIDE profile_id and date, positional to the
// ledger's `keyColumns` (i.e. the `CounterSpec.key` order minus `date`). Read straight
// off the snapshot, which is why the delete arm and the restore arm address the same row
// without either of them re-deriving the coordinate.
function counterKeyValues(
  key: readonly string[],
  row: Row
): (string | number)[] {
  return key.filter((c) => c !== "date").map((c) => row[c] as string | number);
}

// Human-readable, NON-PHI descriptors stored in deleted_rows.label. The "possible
// future trash view" this column was written for is now Data → Trash (#2013,
// app/(app)/data/TrashSection.tsx), which renders this label as the row's kind.
// Never the user's title/name — that stays in `payload`, and the Trash reads it from
// there through the pure lib/trash.ts derivation, behind the same gates as every
// other (app) surface.
const KIND_LABELS: Record<string, string> = {
  activity: "activity",
  "body-metric": "body metric",
  "biomarker-record": "biomarker record",
  "intake-item": "intake item",
  "wellness-practice": "wellness practice",
  "wellness-practice-history": "wellness practice history",
  "substance-alcohol-history": "substance use history",
  "substance-history": "substance use history",
  "practice-session": "practice session",
  cycle: "period",
  "food-serving": "food serving",
  // Clinical passport kinds (#1847). Generic and non-PHI like every label here —
  // "allergy", never the substance; "condition", never the diagnosis.
  allergy: "allergy",
  condition: "condition",
  immunization: "immunization",
  "skin-lesion": "skin lesion",
  // PRN administration (#851 item 11) — captured/restored by its own bespoke path
  // (deleteAdministrationLog / restoreAdministrationLog in lib/queries/intake/
  // adherence.ts), because its restore must invert a SUPPLY side effect and the ledger
  // row (intake_item_logs) has no profile_id column, so the generic entity-registry
  // capture/restore (which assumes a profile_id root) doesn't apply.
  administration: "administration",
};

// Substance history is keyed by day. If a user deletes today's aggregate, logs
// another unit, and then taps Undo, that new row occupies the captured row's
// natural key. Restoring must fold the captured amount into the live aggregate
// instead of failing its UNIQUE constraint. Newer live metadata wins; a captured
// note only fills an otherwise blank live note. Alcohol's captured event rows are
// restored separately by the generic entity loop below.
function mergeRecreatedSubstanceHistoryRoot(
  profileId: number,
  kind: string,
  row: Row
): number | null {
  if (kind === "substance-alcohol-history") {
    if (
      row.group_key !== "alcohol" ||
      typeof row.date !== "string" ||
      typeof row.servings !== "number"
    )
      return null;
    const live = db
      .prepare(
        `SELECT id FROM food_log
         WHERE profile_id = ? AND date = ? AND group_key = ?`
      )
      .get(profileId, row.date, row.group_key) as { id: number } | undefined;
    if (!live) return null;
    db.prepare(
      `UPDATE food_log
       SET servings = servings + ?,
           notes = CASE WHEN notes IS NULL OR trim(notes) = '' THEN ? ELSE notes END
       WHERE id = ? AND profile_id = ?`
    ).run(
      row.servings,
      typeof row.notes === "string" ? row.notes : null,
      live.id,
      profileId
    );
    return live.id;
  }

  if (kind === "substance-history") {
    if (
      typeof row.substance !== "string" ||
      typeof row.date !== "string" ||
      typeof row.units !== "number"
    )
      return null;
    const live = db
      .prepare(
        `SELECT id FROM substance_log
         WHERE profile_id = ? AND date = ? AND substance = ?`
      )
      .get(profileId, row.date, row.substance) as { id: number } | undefined;
    if (!live) return null;
    db.prepare(
      `UPDATE substance_log
       SET units = units + ?,
           notes = CASE WHEN notes IS NULL OR trim(notes) = '' THEN ? ELSE notes END,
           edited = MAX(edited, ?)
       WHERE id = ? AND profile_id = ?`
    ).run(
      row.units,
      typeof row.notes === "string" ? row.notes : null,
      row.edited === 1 ? 1 : 0,
      live.id,
      profileId
    );
    return live.id;
  }

  return null;
}

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

// The id of a LIVE row already occupying the captured row's declared UNIQUE natural
// key, or null when the key is free / not declared / not fully populated on the
// snapshot (#1847). Column names come from the constant registry (never user input);
// the values are bound. A partial index (…WHERE external_id IS NOT NULL) only
// constrains rows with every key column present, so a snapshot missing one — a manual
// allergy with no external_id — is outside the index and never adopts.
function liveRowIdForUniqueKey(
  profileId: number,
  entity: EntitySpec,
  row: Row
): number | null {
  const key = entity.uniqueKey;
  if (!key || key.length === 0) return null;
  const values = key.map((c) => row[c]);
  if (values.some((v) => v == null)) return null;
  const where = key.map((c) => `${c} = ?`).join(" AND ");
  const found = db
    .prepare(`SELECT id FROM ${entity.table} WHERE profile_id = ? AND ${where}`)
    .get(profileId, ...(values as (string | number)[])) as
    { id: number } | undefined;
  return found ? found.id : null;
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
  merge?: MergeUndoContext,
  capturedChildren?: Record<string, Row[]>
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
      rows[child.entity] =
        capturedChildren?.[child.entity] ??
        (db
          .prepare(`SELECT * FROM ${child.table} WHERE ${child.childWhere}`)
          .all(...binds) as Row[]);
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
    // side effects). Centralized here so both delete paths — deleteIntakeItem and the
    // Data → Manage bulk delete — inherit it.
    if (spec.ownedTable === "intake_items") {
      db.prepare(
        `UPDATE protocols SET intake_item_id = NULL
          WHERE intake_item_id = ? AND profile_id = ?`
      ).run(rootId, profileId);
      // An episode's stopped-med reversal record (#1140 Part B) may reference THIS med
      // (item_id) and its just-closed course (course_id). Since migration 137 (#1808)
      // both links are ON DELETE SET NULL, so the DELETE below can no longer trip the FK
      // — but this path still removes the record OUTRIGHT, deliberately. Erasing a med by
      // hand is a statement about the med itself ("this row should not exist"), unlike a
      // document delete/reprocess, which is a statement about the SOURCE and leaves the
      // episode's narrative standing by name. Id-keyed (#203); not restored on undo, like
      // the protocol/supply side effects above.
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
      unlinkFollowUpsForClinicalObservation(profileId, rootId);
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

    // Clinical inbound null-outs (#1847), centralized here for the same reason the
    // intake_items ones above are: BOTH delete paths (the record surface and the Data →
    // Manage bulk delete, which routes through DATASET_UNDO_KIND) must detach the
    // inbound REFERENCES before the root DELETE, or foreign_keys = ON aborts it. Like
    // every sibling null-out in this function they are side effects undo does NOT
    // invert: the clinical row comes back, the other row's link stays honestly cleared.
    if (spec.ownedTable === "conditions") {
      // A medication may name this condition as its indication (#1052) — a REFERENCES
      // FK with no ON DELETE. (Before #1847 only deleteCondition nulled it, so a bulk
      // delete of a condition a med treated threw on the FK.)
      db.prepare(
        `UPDATE intake_items SET indication_condition_id = NULL
          WHERE indication_condition_id = ? AND profile_id = ?`
      ).run(rootId, profileId);
    }
    if (spec.ownedTable === "skin_lesions") {
      // A recheck follow-up may link this observation as its SOURCE finding, or a
      // resolution may cite it as the resolving record (#700) — the medical_records
      // treatment one domain over: the follow-up degrades to a generic care-plan item
      // and keeps its planned care.
      unlinkFollowUpsForSkinLesion(profileId, rootId);
    }

    // A wellness practice target can be adopted by protocols. The accepted
    // lifecycle posture is to null those optional links (matching Stop tracking)
    // before the target delete; the protocols survive and never hold a dangling FK.
    if (kind === "wellness-practice") {
      db.prepare(
        `UPDATE protocols
            SET frequency_target_id = NULL, owns_frequency_target = 0
          WHERE frequency_target_id = ? AND profile_id = ?`
      ).run(rootId, profileId);
    }

    // A day COUNTER the root is one tick of (#2038): decrement it by one and drop the
    // row only when the day empties. The counted fact leaves with the root row, so this
    // happens in the SAME transaction as the capture and the delete — the ledger row and
    // its day counter are one fact in two shapes and must never be observable apart.
    // Table/column names come from the constant registry, never from user input.
    //
    // The arithmetic is the shared day-counter ledger since #2037: the guarded clamped
    // decrement and the drop-at-zero here are the SAME two rules `undoFoodServingCore`
    // applies, so the delete path and the write path cannot drift about what taking one
    // tick back means. The captured row carries the counter's whole natural key (its
    // `childWhere` selected on exactly that), so keying the unbump naturally rather than
    // by id addresses the identical row under the table's UNIQUE index.
    for (const child of spec.entities.slice(1)) {
      if (!child.counter) continue;
      const ledger = dayCounterLedger(
        dayCounterSpecFor(child.table, child.counter.column, child.counter.key)
      );
      for (const row of rows[child.entity] ?? []) {
        ledger.unbump(
          profileId,
          String(row.date),
          counterKeyValues(child.counter.key, row),
          1
        );
      }
    }

    // Convention-owned children (practice sessions and their suppression row) have
    // no cascade FK. Delete exactly the rows captured above, under profile scope,
    // before removing the root so capture + delete remain one atomic operation.
    for (const child of spec.entities.slice(1)) {
      if (!child.deleteExplicitly) continue;
      for (const row of rows[child.entity] ?? []) {
        const id = row.id;
        if (typeof id !== "number") continue;
        db.prepare(
          `DELETE FROM ${child.table} WHERE id = ? AND profile_id = ?`
        ).run(id, profileId);
        writeImportTombstoneForRow(profileId, child.table, row);
      }
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

// The ONE lookup that RESOLVES which profile a capture belongs to (#2104). An undo
// token arrives from a CLIENT, and the only profile that means anything for the
// restore is the one the capture actually carries — the ROW's profile stamped by
// captureDelete, which on a multi-view surface is NOT the acting profile (deleting
// Mia's reading while acting as Dad stamps Mia). Filtering by a caller-supplied
// profile_id here would presuppose the answer; instead the undo action feeds this
// straight to requireProfileWriteAccess and then passes the SAME id back to
// restoreDeletedRow, whose `profile_id = ?` filter stays as the anti-replay compare.
// portalIdentityProfile's shape (#1747), one table over.
export function deletedRowProfile(undoId: number): number | null {
  const row = db
    .prepare(`SELECT profile_id AS profileId FROM deleted_rows WHERE id = ?`)
    .get(undoId) as { profileId: number } | undefined;
  return row?.profileId ?? null;
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
      // A day COUNTER (#2038): give back the one tick the delete took, rather than
      // re-inserting the captured row whole — the day may have gained or lost other
      // servings in the meantime and they are none of this undo's business. Only when
      // the delete emptied the day and dropped the row is the snapshot re-inserted,
      // with the count back at one, which is also what restores its notes.
      if (entity.counter) {
        const { column, key } = entity.counter;
        const ledger = dayCounterLedger(
          dayCounterSpecFor(entity.table, column, key)
        );
        for (const row of captured) {
          // Give the one tick back through the shared ledger. `bumpExisting` is the
          // arm a plain bump cannot serve: when the delete emptied the day and dropped
          // the row, the SNAPSHOT (notes and all) is what has to come back, not a bare
          // counter row — so the ledger reports whether the row is still there and this
          // branch owns the re-insert.
          if (
            ledger.bumpExisting(
              profileId,
              String(row.date),
              counterKeyValues(key, row),
              1
            )
          )
            continue;
          const toInsert = remapRow(row, idMaps, entity.fks, entity.keyRefs);
          toInsert[column] = 1;
          const cols = Object.keys(toInsert);
          db.prepare(
            `INSERT INTO ${entity.table} (${cols.join(", ")}) VALUES (${cols
              .map(() => "?")
              .join(", ")})`
          ).run(...cols.map((c) => toInsert[c]));
        }
        continue;
      }
      for (const row of captured) {
        const oldId = row.id;
        if (isRoot && typeof oldId === "number") {
          const liveId = mergeRecreatedSubstanceHistoryRoot(
            profileId,
            payload.kind,
            row
          );
          if (liveId !== null) {
            map.set(oldId, liveId);
            continue;
          }
        }
        // Natural-key collision on the source-owned root (#509): between the delete
        // and this undo a resync may have re-created a row under the same
        // external_id / (date, source) — verbatim re-insert would throw on the UNIQUE
        // index. When a live row already occupies the key, adopt it as the restored
        // row (map old id -> live id, skip the insert) rather than throwing: children
        // remap onto it and a merge-undo inverts the keeper against it. With the
        // tombstone in place the resync never re-inserted, so this only fires for a
        // pre-tombstone delete; either way undo never crashes.
        if ((isRoot || entity.deleteExplicitly) && typeof oldId === "number") {
          const liveId = liveRowIdForCapturedRoot(
            profileId,
            isRoot ? spec.ownedTable : entity.table,
            row
          );
          if (liveId !== null) {
            map.set(oldId, liveId);
            continue;
          }
        }
        // The registry-declared UNIQUE natural key (#1847): the clinical passport
        // tables carry a partial UNIQUE(profile_id, external_id) and their importer
        // re-inserts with OR IGNORE, so a document reprocess inside the (30-day)
        // window can re-take a deleted imported row's key. Adopt the live row rather
        // than aborting the whole restore on the index — the #509 treatment, declared
        // as data because these tables are not sync-tombstoned.
        if (isRoot && typeof oldId === "number") {
          const liveId = liveRowIdForUniqueKey(profileId, entity, row);
          if (liveId !== null) {
            map.set(oldId, liveId);
            continue;
          }
        }
        const toInsert = remapRow(row, idMaps, entity.fks, entity.keyRefs);
        // A practice target captured before migration 123 has no persisted
        // scope_identity. Rebuild it from the same domain identity before restore
        // so legacy undo payloads satisfy the new database invariant.
        if (
          entity.table === "frequency_targets" &&
          toInsert.scope_kind === "practice" &&
          typeof toInsert.scope_value === "string" &&
          typeof toInsert.scope_identity !== "string"
        ) {
          toInsert.scope_identity = practiceIdentity(toInsert.scope_value);
        }
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
    // drop row is back — move its re-parented sets off the keeper, re-fold the keeper
    // from the drops still merged into it (#1884), and clear the recorded pair
    // decision. Gated on the presence of the merge context, so every OTHER undo kind
    // is untouched. `undoId` is passed so the inversion can tell THIS drop's holding
    // row (deleted just below, still present now) from its still-folded siblings'.
    if (payload.merge) {
      const rootEntity = spec.entities[0].entity;
      const oldRootId = payload.rows[rootEntity]?.[0]?.id;
      const newDropId =
        typeof oldRootId === "number"
          ? idMaps[rootEntity]?.get(oldRootId)
          : undefined;
      if (typeof newDropId === "number")
        revertActivityMerge(profileId, payload.merge, newDropId, undoId);
    }

    // Remove the re-import tombstone the delete/merge wrote (#200 side-effect
    // inversion): the row is back, so the rolling window should resume ingesting its
    // natural key. No-op for a manual root (no tombstone was written).
    const capturedRoot = payload.rows[rootEntity.entity]?.[0];
    if (capturedRoot)
      removeImportTombstoneForRow(profileId, spec.ownedTable, capturedRoot);
    for (const entity of spec.entities.slice(1)) {
      if (!entity.deleteExplicitly) continue;
      for (const row of payload.rows[entity.entity] ?? [])
        removeImportTombstoneForRow(profileId, entity.table, row);
    }

    db.prepare(`DELETE FROM deleted_rows WHERE id = ? AND profile_id = ?`).run(
      undoId,
      profileId
    );
  });
  // A restored supplement brings back its dose schedule history (the `doseVersions`
  // entity above), and the current-schedule readers memoize that history per profile
  // (#2066). Dropping the entry here means the restored item's past days are judged by
  // the rules it actually had, immediately, rather than by the pre-#1973 "this row,
  // always" fallback for the remainder of the TTL. Unconditional because it costs one
  // re-join at most and no restore kind is worth reasoning about separately.
  invalidateDoseScheduleVersions(profileId);
  return true;
}

// Purge holding rows older than `maxAgeDays` (default: the 30-day Trash window,
// #2013). GLOBAL by design — one call per hourly notify tick clears every profile's
// expired undo records (purged means purged), so it is intentionally NOT
// profile-scoped (allowlisted in the profile-scoping test). Returns the number of
// rows removed. Never throws.
//
// THE UNIT IS DAYS, and it is the only unit in this function (#2013). It used to be
// `maxAgeHours = 24`, which read as "one day" at every call site anyway; now that the
// window is an admin-configured DAY count, converting once here rather than carrying
// hours internally keeps the signature honest about what the caller passes. The tick
// supplies `getTrashRetentionDays()`; the default exists so a stray argless call in a
// test still means the shipped policy.
//
// Purge-time file cleanup (#1290, extended to photos by #1847): a captured delete's
// MEDIA files — activity/symptom clip + poster paths, and since the clinical kinds a
// lesion photo and its derived thumbnail sibling — survive the delete+undo window on
// disk so a restore re-points at them, but a purge WITHOUT a restore leaves them
// orphaned: rows gone (unservable) yet present on disk, which the strictest-privacy
// tier this media sits in can't tolerate. So BEFORE the delete we read the expiring
// payloads and collect their captured files, and AFTER the delete we unlink each one
// that no LIVE row still references (content-hash dedup means a re-upload can share
// the file).
export function sweepDeletedRows(
  maxAgeDays = DEFAULT_TRASH_RETENTION_DAYS
): number {
  try {
    const cutoff = daysAgoModifier(maxAgeDays);

    // Collect the captured media files of the rows about to be purged.
    const files = capturedFilesOf(
      db
        .prepare(
          `SELECT payload FROM deleted_rows WHERE deleted_at < datetime('now', ?)`
        )
        .all(cutoff) as { payload: string }[]
    );

    const changes = db
      .prepare(`DELETE FROM deleted_rows WHERE deleted_at < datetime('now', ?)`)
      .run(cutoff).changes;

    // After the holding rows are gone, unlink the now-unreferenced media files.
    unlinkPurgedFiles(files);

    return changes;
  } catch {
    return 0;
  }
}

// Delete ONE capture for good, before its window runs out (#2013). The affordance a
// 30-day trash needs and a 15s toast didn't: "I deleted this and I meant it."
//
// Routes through the SAME file-unlinking path as the expiry sweep — a permanent
// delete that removed only the deleted_rows row would leak the captured clips onto
// disk with nothing left pointing at them, which is the #1290 leak re-opened by hand.
// Profile-scoped: a token from another profile is simply not found.
//
// Typed outcome rather than a boolean (#2013): "gone" is a real, unsurprising state —
// another tab purged it, the tick swept it, or it was already restored — and the
// surface renders that differently from a purge it actually performed.
export type PurgeOutcome = { kind: "purged" } | { kind: "gone" };

export function purgeDeletedRow(
  profileId: number,
  undoId: number
): PurgeOutcome {
  const files = writeTx((): CapturedFiles | null => {
    const row = db
      .prepare(
        `SELECT payload FROM deleted_rows
          WHERE id = ? AND profile_id = ? AND kind <> ?`
      )
      .get(undoId, profileId, TRASH_EXCLUDED_KIND) as
      { payload: string } | undefined;
    if (!row) return null;
    const captured = capturedFilesOf([row]);
    db.prepare(
      `DELETE FROM deleted_rows WHERE id = ? AND profile_id = ? AND kind <> ?`
    ).run(undoId, profileId, TRASH_EXCLUDED_KIND);
    return captured;
  });
  if (files === null) return { kind: "gone" };
  // Outside the transaction: the row delete is committed and authoritative, and the
  // unlink is best-effort filesystem work that must never hold the write lock.
  unlinkPurgedFiles(files);
  return { kind: "purged" };
}

// Empty the acting profile's whole trash (#2013). PROFILE-SCOPED, deliberately and
// unlike sweepDeletedRows: the sweep is instance maintenance over an expired window,
// this is one person saying "clear mine" — emptying a household member's captures
// from your own Trash button would be someone else's data disappearing on your tap.
// Same file-unlinking path again. Returns how many captures were purged.
export function emptyTrash(profileId: number): number {
  const { purged, files } = writeTx(() => {
    const captured = capturedFilesOf(
      db
        .prepare(
          `SELECT payload FROM deleted_rows WHERE profile_id = ? AND kind <> ?`
        )
        .all(profileId, TRASH_EXCLUDED_KIND) as { payload: string }[]
    );
    const changes = db
      .prepare(`DELETE FROM deleted_rows WHERE profile_id = ? AND kind <> ?`)
      .run(profileId, TRASH_EXCLUDED_KIND).changes;
    return { purged: changes, files: captured };
  });
  unlinkPurgedFiles(files);
  return purged;
}

// Every media file a set of holding rows captured — clips (#1290) AND photos
// (#1847). One shape so the sweep and both by-hand purges reclaim BOTH kinds through
// a single call rather than each remembering a list; a media core added later has one
// place to join. A malformed / legacy / non-registry payload (the bespoke
// `administration` kind) never blocks a purge — its parse is caught and skipped,
// because such a payload carries no reclaimable files.
interface CapturedFiles {
  video: CapturedVideoFile[];
  photo: CapturedPhotoFile[];
}

function capturedFilesOf(rows: readonly { payload: string }[]): CapturedFiles {
  const out: CapturedFiles = { video: [], photo: [] };
  for (const r of rows) {
    try {
      const payload = parsePayload(r.payload);
      out.video.push(...capturedVideoFiles(payload));
      out.photo.push(...capturedPhotoFiles(payload));
    } catch {
      // an unparseable / non-registry payload carries no reclaimable media files
    }
  }
  return out;
}

function unlinkPurgedFiles(files: CapturedFiles): void {
  unlinkPurgedVideoFiles(files.video);
  unlinkPurgedPhotoFiles(files.photo);
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

// The live table each photo domain's rows sit in — the read side of the registry's
// PHOTO_FILE_TABLES, kept here because the probe is SQL.
const PHOTO_TABLE_FOR_DOMAIN: Record<CapturedPhotoDomain, string> = {
  progress: "progress_photos",
  lesion: "lesion_photos",
  symptom: "symptom_photos",
};

// The photo half of the same rule (#1847). Two differences from the clips above:
//
//  • THE THUMBNAIL IS DERIVED. Since the photo core landed (#1844 phase 3) a lesion /
//    symptom photo has no thumb_path column — its thumbnail is a SIBLING of the stored
//    file (thumbSiblingPath, the one rule the writer and every reader share), so a
//    purge that reclaimed stored_path alone would leave a thumbnail of a deleted
//    dermatology close-up on disk indefinitely. A domain that DOES carry the column
//    (progress_photos) hands its own value over instead of re-deriving one.
//  • The liveness probe is on stored_path only: the thumbnail's justification is its
//    photo's, so if a re-upload re-created a live row at this content-named path, both
//    files are still in use and neither is touched.
function unlinkPurgedPhotoFiles(files: readonly CapturedPhotoFile[]): void {
  for (const f of files) {
    if (!f.storedPath) continue;
    const table = PHOTO_TABLE_FOR_DOMAIN[f.domain];
    const stillLive = db
      .prepare(`SELECT 1 FROM ${table} WHERE stored_path = ?`)
      .get(f.storedPath);
    if (stillLive !== undefined) continue;
    unlinkPhotoFiles(f.domain, [
      f.storedPath,
      f.thumbPath ?? thumbSiblingPath(f.storedPath),
    ]);
  }
}
