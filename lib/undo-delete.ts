// Undo / soft-delete for destructive row deletes (issue #30, shape A).
//
// This module is the PURE half: the kind registry (which tables + child relations
// make up an undoable delete, and the order to re-insert them) plus the pure
// serialize / restore-plan / FK-remap transforms. It imports NOTHING impure (no
// `db`, no network) so it lives in the pure vitest suite (lib/__tests__), and the
// impure capture/restore/sweep executor (lib/undo-delete-db.ts) wires it to SQLite.
//
// ── The model ─────────────────────────────────────────────────────────────────
// Each undoable KIND is a small DAG of ENTITIES (tables). The first entity is the
// ROOT — the profile-owned parent the user deleted (an activity, a body metric, a
// biomarker record, an intake item). The rest are its cascade CHILDREN, listed in
// dependency (topological) order so a parent is always re-inserted before a child
// that references it.
//
// Capture (impure) reads the root row + every child row into a payload keyed by
// entity. Restore (impure) walks the entities in order, re-inserting each row with
// a NEW autoincrement id and remapping every FK column from the OLD captured id to
// the NEW one via `remapRow`. New ids are acceptable and intentional: nothing else
// in the app references these rows by a stable external id, and remapping keeps the
// parent↔child links intact. A far-endpoint FK whose target was NOT part of this
// capture (e.g. a "take together" pair's OTHER supplement, which still exists) is
// left as-is — see remapRow.

export interface FkSpec {
  // The FK column on this entity's rows.
  column: string;
  // The entity key this column references. During restore, an old value found in
  // that entity's id map is rewritten to the new id; a value NOT in the map (a row
  // outside this capture that still exists) is left untouched.
  ref: string;
}

// A captured FK column that points OUTSIDE this capture — at a row that may have
// been deleted between the capture and the undo (#202). remapRow leaves such a
// value verbatim (it's not in any id map), so a verbatim re-insert would violate
// the FK (foreign_keys = ON) and abort the whole restore. At restore time the
// executor probes the live target and, when it's gone, applies `onMissing`:
//   - "null": set the column to NULL — for a nullable link whose live delete nulls
//     it anyway (deleteEquipment nulls exercise_sets.equipment_id);
//   - "drop": skip re-inserting the row — for a join row whose far endpoint is
//     REQUIRED (an intake_item_pairs row whose partner item is gone), matching what
//     the live cascade would have removed.
export interface ExternalRefSpec {
  // The FK column on this entity's rows that may dangle at restore time.
  column: string;
  // The physical table the column references (a constant) — probed for existence.
  table: string;
  // What to do when the referenced row no longer exists at restore.
  onMissing: "null" | "drop";
  // When the referenced table is GLOBAL (no profile_id column) — e.g. `providers`,
  // which is shared across the whole family/instance — the existence probe is by id
  // ALONE. Default (absent/false): the target is profile-owned (equipment,
  // medical_documents) and the probe adds the acting profile_id as defense in depth.
  global?: boolean;
}

export interface EntitySpec {
  // Logical key within a kind (used to key the payload + the id maps).
  entity: string;
  // The physical table name (a constant, never user input).
  table: string;
  // FK columns to remap on restore. Empty for the root.
  fks: FkSpec[];
  // Captured FK columns pointing OUTSIDE this capture whose target may have been
  // deleted since capture — reconciled (null/drop) on restore. Absent when none.
  externalRefs?: ExternalRefSpec[];
  // Two columns that must stay canonically ordered (col[0] < col[1]) on the row —
  // e.g. intake_item_pairs (a_id, b_id), which carries CHECK (a_id < b_id) since
  // issue #97. Remapping a captured endpoint to a restored item's NEW (larger) id
  // can invert the order, so restore re-canonicalizes these two columns after the
  // remap. Absent when the entity has no ordered pair.
  orderedPair?: [string, string];
  // For a CHILD entity, how to select its rows given the root id: a WHERE fragment
  // and how many times the root id is bound into it. Omitted for the root (which is
  // captured by `id = ? AND profile_id = ?`). Static SQL — no user input.
  childWhere?: string;
  childBinds?: number;
}

export interface KindSpec {
  kind: string;
  // The profile-owned parent table (the root entity's table). Used for the capture
  // ownership check and to keep the registry honest against OWNED_TABLES.
  ownedTable: string;
  // Entities in dependency order; entities[0] is the root.
  entities: EntitySpec[];
}

// A captured/serialized delete: the kind plus the rows of each entity (each row is
// the raw table row, INCLUDING its original id, which restore drops).
export type Row = Record<string, unknown>;
export interface Payload {
  v: 1;
  kind: string;
  rows: Record<string, Row[]>;
  // OPTIONAL merge-undo context (issues #199/#200). Present ONLY when this deleted
  // row is the discarded side of an activity merge; absent for a plain delete. When
  // set, restore additionally INVERTS the merge that produced this delete: it moves
  // the drop's re-parented exercise_sets back off the keeper, restores the keeper's
  // pre-fold field values, and clears the recorded pair decision so the pair can be
  // re-detected. A plain delete never carries it, so its restore is unchanged.
  merge?: MergeUndoContext;
}

// The context an activity-merge delete carries so its undo can fully invert the
// merge (issues #199/#200). Captured at merge time from the pre-fold keeper + the
// discarded row; consumed by restoreDeletedRow.
export interface MergeUndoContext {
  // The keeper the discarded row was folded into.
  keeperId: number;
  // The decision domain + stable pair signature recorded for this merge — deleted on
  // undo so the (now un-merged) pair resurfaces in Review (#200).
  domain: string;
  signature: string;
  // The keeper's fold-field values BEFORE the fold (plus its prior `edited` flag),
  // so undo restores the keeper exactly, undoing the gap-fills that would otherwise
  // double-count with the restored row (#200).
  keeperBefore: Record<string, unknown>;
  // ids of the discarded row's exercise_sets that were re-parented onto the keeper
  // at merge time (#199). Undo moves exactly these back onto the restored row.
  movedSetIds: number[];
  // id of the discarded row's activity_routes row that was re-parented onto the
  // keeper at merge time (#569), or null when the keeper already had a route (so the
  // drop's route stayed on the drop and was captured as a child instead). Undo moves
  // exactly this route back onto the restored row. Mirrors movedSetIds.
  movedRouteId: number | null;
}

// ── The kind registry ─────────────────────────────────────────────────────────
// Adding a new undoable kind = one entry here + wiring its delete action to
// captureDelete(kind, ...). The root table MUST be in OWNED_TABLES.
export const UNDO_KINDS: Record<string, KindSpec> = {
  activity: {
    kind: "activity",
    ownedTable: "activities",
    entities: [
      {
        entity: "activity",
        table: "activities",
        fks: [],
        // The session-level gear link (activities.equipment_id, #342) points at an
        // equipment row OUTSIDE this capture. If that equipment was deleted after the
        // activity was captured (deleteEquipment nulls only LIVE activities, so this
        // captured row kept its equipment_id), null it on restore rather than
        // re-inserting a dangling FK (#202) — same treatment as the per-set link.
        externalRefs: [
          { column: "equipment_id", table: "equipment", onMissing: "null" },
        ],
      },
      {
        entity: "sets",
        table: "exercise_sets",
        fks: [{ column: "activity_id", ref: "activity" }],
        // equipment_id points at an equipment row OUTSIDE this capture. If that
        // equipment was deleted after the activity was (deleteEquipment nulls only
        // LIVE sets, so this captured set kept its equipment_id), null it on restore
        // rather than re-inserting a dangling FK (#202).
        externalRefs: [
          { column: "equipment_id", table: "equipment", onMissing: "null" },
        ],
        childWhere: "activity_id = ?",
        childBinds: 1,
      },
      {
        // The GPS route (#569) — a 1:1 child cascade-deleted with the activity, so a
        // plain delete captures and restores it exactly like the sets. It has no FK
        // outside this capture, so no externalRefs.
        entity: "route",
        table: "activity_routes",
        fks: [{ column: "activity_id", ref: "activity" }],
        childWhere: "activity_id = ?",
        childBinds: 1,
      },
      {
        // Training form-check video clips (#1224) — many-per-activity children
        // cascade-deleted with the activity (activity_videos.activity_id ON DELETE
        // CASCADE), so a plain delete CAPTURES and RESTORES their rows exactly like
        // the sets/route (#199/#200). The clip FILES on disk are content-named and
        // survive the delete+undo window untouched, so a restored row re-points at
        // the same file. They have no FK outside this capture, so no externalRefs.
        entity: "video",
        table: "activity_videos",
        fks: [{ column: "activity_id", ref: "activity" }],
        childWhere: "activity_id = ?",
        childBinds: 1,
      },
    ],
  },

  "body-metric": {
    kind: "body-metric",
    ownedTable: "body_metrics",
    entities: [{ entity: "metric", table: "body_metrics", fks: [] }],
  },

  "biomarker-record": {
    kind: "biomarker-record",
    ownedTable: "medical_records",
    entities: [
      {
        entity: "record",
        table: "medical_records",
        fks: [],
        // document_id → medical_documents and provider_id → providers are REAL
        // enforced FKs since migration 006 (foreign_keys = ON) that point OUTSIDE
        // this single-row capture. Deleting the source document
        // (clearImportedDocumentRows) or merging/deleting the provider
        // (mergeProviders re-points only LIVE rows) AFTER the record was captured
        // leaves the captured copy holding a dead id, so a verbatim re-insert would
        // violate the FK and abort the undo — leaving the record permanently
        // unrestorable (#375). Null the now-dangling link on restore: the record
        // survives, its provenance link is honestly gone — the same treatment the
        // sibling activity/equipment_id link got for the #202 class. `providers` is a
        // GLOBAL (family-shared) table with no profile_id, so it's probed by id alone.
        externalRefs: [
          {
            column: "document_id",
            table: "medical_documents",
            onMissing: "null",
          },
          {
            column: "provider_id",
            table: "providers",
            onMissing: "null",
            global: true,
          },
          // Visit link (#1050): if the linked encounter was deleted since capture,
          // restore the record with the link NULLed (the document_id treatment).
          {
            column: "encounter_id",
            table: "encounters",
            onMissing: "null",
          },
        ],
      },
    ],
  },

  // Supplement OR medication (both live in intake_items). Captures the full
  // cascade: scheduled doses, "take together / apart" pairs, adherence logs (which
  // reference a dose), medication courses, and side effects (which reference a
  // course). Restore re-inserts them in this order so every FK target exists first.
  "intake-item": {
    kind: "intake-item",
    ownedTable: "intake_items",
    entities: [
      {
        entity: "item",
        table: "intake_items",
        fks: [],
        // provider_id → providers is a REAL enforced FK since migration 006
        // (foreign_keys = ON) that points OUTSIDE this capture. Merging or deleting
        // the prescriber (mergeProviders re-points only LIVE rows) AFTER the item
        // was captured leaves the captured copy holding a dead id, so a verbatim
        // re-insert would violate the FK and abort the undo — leaving the
        // supplement/medication permanently unrestorable (the #375 class, here for
        // intake_items). Null the now-dangling link on restore: the item survives,
        // its prescriber link is honestly gone. `providers` is a GLOBAL
        // (family-shared) table with no profile_id, so it's probed by id alone.
        //
        // document_id → medical_documents is ALSO a real enforced FK (001-baseline,
        // converged by migration 006): an extracted prescription auto-structured into
        // a kind='medication' row carries the source document_id (#414). Deleting that
        // source document (deleteMedicalDocument / clearImportedDocumentRows clears
        // only LIVE extracted meds) AFTER the item was captured leaves the captured
        // copy holding a dead document_id, so a verbatim re-insert would violate the
        // FK and abort the undo (#598). medical_documents is profile-owned, so it's
        // probed WITH the profile_id scope (not global).
        externalRefs: [
          {
            column: "provider_id",
            table: "providers",
            onMissing: "null",
            global: true,
          },
          {
            column: "document_id",
            table: "medical_documents",
            onMissing: "null",
          },
          // situation_id → situations is a real nullable FK (migration 029) that
          // points OUTSIDE this capture. Situations are soft-deleted today (active
          // flag, never DROPped), so it can't dangle in practice — but a captured link
          // to a situation that IS later hard-deleted would abort the undo the same
          // way, so reconcile it defensively (the #598 reflection guard would flag an
          // unhandled captured FK). Profile-owned, so probed WITH the profile_id scope.
          {
            column: "situation_id",
            table: "situations",
            onMissing: "null",
          },
          // Visit link (#1050): a medication "prescribed at" a visit whose encounter
          // was deleted since capture restores with the link NULLed.
          {
            column: "encounter_id",
            table: "encounters",
            onMissing: "null",
          },
          // Provenance link (#1051): the source prescription medical_records row a
          // medication was projected from. If that record was deleted since capture,
          // restore with source_record_id NULLed. Profile-owned, so probed WITH scope.
          {
            column: "source_record_id",
            table: "medical_records",
            onMissing: "null",
          },
          // Indication link (#1052): the condition a medication treats. If that
          // condition was deleted since capture, restore with the link NULLed.
          // Profile-owned, so probed WITH the profile_id scope.
          {
            column: "indication_condition_id",
            table: "conditions",
            onMissing: "null",
          },
        ],
      },
      {
        entity: "doses",
        table: "intake_item_doses",
        fks: [{ column: "item_id", ref: "item" }],
        childWhere: "item_id = ?",
        childBinds: 1,
      },
      {
        entity: "pairs",
        table: "intake_item_pairs",
        // Both endpoints reference intake_items; only the deleted item is in the
        // capture, so its endpoint remaps and the still-existing far endpoint is
        // left as-is by remapRow.
        fks: [
          { column: "a_id", ref: "item" },
          { column: "b_id", ref: "item" },
        ],
        // A pair needs BOTH items alive. The near endpoint is remapped to the
        // just-restored item (so it exists), but the far endpoint may have been
        // deleted after the near item was — its live cascade would have removed the
        // pair. Probe both endpoints and DROP the row if either is gone, rather than
        // re-inserting a pair that references a missing item (#202). (Checking both
        // is safe: the remapped near endpoint always exists post-insert.)
        externalRefs: [
          { column: "a_id", table: "intake_items", onMissing: "drop" },
          { column: "b_id", table: "intake_items", onMissing: "drop" },
        ],
        // Remapping the near endpoint to the restored item's new id can make a_id >
        // b_id; re-canonicalize so the CHECK (a_id < b_id) holds (issue #97).
        orderedPair: ["a_id", "b_id"],
        childWhere: "a_id = ? OR b_id = ?",
        childBinds: 2,
      },
      {
        entity: "courses",
        table: "medication_courses",
        fks: [{ column: "item_id", ref: "item" }],
        // Per-course prescriber link (#1204): provider_id → providers is a REAL
        // enforced FK pointing OUTSIDE this capture. Merging/deleting the prescriber
        // AFTER the med was captured leaves the captured course holding a dead id, so
        // null the now-dangling link on restore (the same #375/#598 treatment the
        // item's own provider_id gets). `providers` is GLOBAL, probed by id alone.
        externalRefs: [
          {
            column: "provider_id",
            table: "providers",
            onMissing: "null",
            global: true,
          },
        ],
        childWhere: "item_id = ?",
        childBinds: 1,
      },
      {
        entity: "logs",
        table: "intake_item_logs",
        // Re-inserted after `doses` (its dose_id target) and `item`.
        fks: [
          { column: "dose_id", ref: "doses" },
          { column: "item_id", ref: "item" },
        ],
        childWhere: "item_id = ?",
        childBinds: 1,
      },
      {
        entity: "side_effects",
        table: "intake_item_side_effects",
        // Re-inserted after `courses` (its nullable course_id target) and `item`.
        fks: [
          { column: "item_id", ref: "item" },
          { column: "course_id", ref: "courses" },
        ],
        childWhere: "item_id = ?",
        childBinds: 1,
      },
    ],
  },
};

export function getKindSpec(kind: string): KindSpec {
  const spec = UNDO_KINDS[kind];
  if (!spec) throw new Error(`unknown undo kind: ${kind}`);
  return spec;
}

// Build the serialized payload from captured rows-by-entity. Pure. `merge` is the
// optional merge-undo context (#199/#200) — omitted for a plain delete.
export function serializePayload(
  kind: string,
  rows: Record<string, Row[]>,
  merge?: MergeUndoContext
): string {
  const payload: Payload = { v: 1, kind, rows };
  if (merge) payload.merge = merge;
  return JSON.stringify(payload);
}

// Parse + validate a stored payload. Pure. Throws on a shape/kind mismatch.
export function parsePayload(json: string): Payload {
  const parsed = JSON.parse(json) as Payload;
  if (!parsed || parsed.v !== 1 || typeof parsed.kind !== "string")
    throw new Error("invalid undo payload");
  getKindSpec(parsed.kind); // validates the kind is known
  if (!parsed.rows || typeof parsed.rows !== "object")
    throw new Error("invalid undo payload: rows");
  return parsed;
}

// Map of entity key → (old id → new id), accumulated as restore inserts each row.
export type IdMaps = Record<string, Map<number, number>>;

// Produce the row to INSERT: drop the autoincrement id and remap every FK column
// whose old value was itself re-inserted in this restore (present in the ref
// entity's id map). A null FK stays null; a value pointing OUTSIDE this capture
// (a still-existing far endpoint) is left untouched. Pure.
export function remapRow(row: Row, idMaps: IdMaps, fks: FkSpec[]): Row {
  const out: Row = { ...row };
  delete out.id;
  for (const { column, ref } of fks) {
    const v = out[column];
    if (v == null) continue;
    const map = idMaps[ref];
    if (map && typeof v === "number" && map.has(v)) out[column] = map.get(v);
  }
  return out;
}

// ── Purge-time file cleanup (issue #1290) ──────────────────────────────────────
// A captured delete's on-disk clip FILES (activity_videos / symptom_videos
// stored_path + poster_path) deliberately survive the delete+undo window untouched
// so a restore re-points at the same file (#1224). But when the holding row
// EXPIRES and is purged WITHOUT a restore, that file loses its last justification —
// its row is gone (unservable) yet it lingers on disk, which matters for the
// strictest-privacy tier these clips sit in. The purge sweep must therefore unlink
// the captured files (the row-ops "undo inverts the side effect" rule, #199/#200,
// applied at the purge — the point the side effect can no longer be inverted).
//
// This pure half maps a payload's captured video-table rows to their (domain, file
// path) pairs; the impure sweep (lib/undo-delete-db.ts) applies the content-hash
// dedup guard — skip a path a LIVE row still references — and the path-contained
// unlink. Video-file tables are named here (not imported from the impure
// lib/video/store) so this module stays free of fs.

// entity.table → the video domain its files live under (lib/video/store's DOMAIN_DIRS).
export const VIDEO_FILE_TABLES: Record<string, "activity" | "symptom"> = {
  activity_videos: "activity",
  symptom_videos: "symptom",
};

export interface CapturedVideoFile {
  domain: "activity" | "symptom";
  storedPath: string | null;
  posterPath: string | null;
}

// The clip/poster files captured in a payload (empty for a kind with no video child).
// Pure — walks the kind spec to map each video entity's rows to their stored paths.
export function capturedVideoFiles(payload: Payload): CapturedVideoFile[] {
  const spec = getKindSpec(payload.kind);
  const out: CapturedVideoFile[] = [];
  for (const entity of spec.entities) {
    const domain = VIDEO_FILE_TABLES[entity.table];
    if (!domain) continue;
    for (const row of payload.rows[entity.entity] ?? []) {
      out.push({
        domain,
        storedPath:
          typeof row.stored_path === "string" ? row.stored_path : null,
        posterPath:
          typeof row.poster_path === "string" ? row.poster_path : null,
      });
    }
  }
  return out;
}
