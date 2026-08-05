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

import type { OverrideChoices } from "./import-review/conflicts";

export interface FkSpec {
  // The FK column on this entity's rows.
  column: string;
  // The entity key this column references. During restore, an old value found in
  // that entity's id map is rewritten to the new id; a value NOT in the map (a row
  // outside this capture that still exists) is left untouched.
  ref: string;
}

// A captured string key that embeds another captured entity's id. The wellness
// practice suppression row is the first tenant: `practice:<targetId>` must follow
// the frequency target to its NEW id on restore, just as a numeric FK does.
export interface KeyRefSpec {
  column: string;
  prefix: string;
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

// A denormalized day COUNTER that the kind's ROOT row is one tick of — not a cascade
// child, and not a row that is deleted and re-inserted whole (#2038).
//
// `food_log.servings` is the first and only tenant: one logged serving is a
// `food_log_events` ledger row AND +1 on the (date, group_key) day counter — one fact in
// two shapes (#1963). So deleting ONE serving out of three must DECREMENT the counter,
// never remove it, and undo must increment it back — re-creating the row (from the
// captured snapshot, notes and all) only when the delete emptied the day to zero and
// dropped it. Declared here so the capture half and the restore half read the SAME spec
// instead of each carrying its own arithmetic, which is exactly the split #2039 removed
// one table over.
export interface CounterSpec {
  // The counted column. Moved by exactly one per captured root row.
  column: string;
  // The counter row's natural-key columns BESIDE profile_id, read off the captured
  // snapshot to find (or re-insert) the live row on restore. Constants, never user input.
  key: readonly string[];
}

export interface EntitySpec {
  // Logical key within a kind (used to key the payload + the id maps).
  entity: string;
  // The physical table name (a constant, never user input).
  table: string;
  // FK columns to remap on restore. Empty for the root.
  fks: FkSpec[];
  // String-key references to remap on restore (for example
  // upcoming_dismissals.signal_key = `practice:<targetId>`).
  keyRefs?: KeyRefSpec[];
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
  // Most children disappear through an FK cascade when the root is deleted.
  // Some side-state belongs to the root only by convention rather than an FK
  // (practice sessions + dismissals); captureDelete explicitly removes those
  // captured rows in the same transaction.
  deleteExplicitly?: boolean;
  // This entity is a day COUNTER the root row is one tick of (see CounterSpec), so the
  // delete decrements it and the undo increments it back — it is never deleted and
  // re-inserted whole. Mutually exclusive with deleteExplicitly.
  counter?: CounterSpec;
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
  // set, restore additionally INVERTS this drop's share of the merge that produced the
  // delete: it moves the drop's re-parented exercise_sets back off the keeper, re-folds
  // the keeper from the merge's drops that are STILL folded in (#1884), and clears the
  // recorded pair decision so the pair can be re-detected. A plain delete never carries
  // it, so its restore is unchanged.
  merge?: MergeUndoContext;
}

// The context an activity-merge delete carries so its undo can fully invert the
// merge (issues #199/#200). Captured at merge time from the pre-fold keeper + the
// discarded row; consumed by restoreDeletedRow.
export interface MergeUndoContext {
  // The keeper the discarded row was folded into.
  keeperId: number;
  // Identity of the MERGE this drop belonged to — the same opaque value on every drop
  // of one N-way merge (#1884). Undo uses it to find the merge's OTHER drops that are
  // still folded into the keeper (their holding rows still un-restored) so it can
  // un-fold only THIS drop's contribution instead of resetting the keeper wholesale to
  // `keeperBefore`, which is correct only when every drop leaves at once. Optional:
  // payloads captured before #1884 carry none and keep the old whole-snapshot reset
  // (harmless for the single-drop case, and they age out inside the retention window).
  mergeId?: string;
  // The per-field member choices the fold applied (#1431) — the same map for every
  // drop of one merge. Undo replays the fold over the still-folded drops with these,
  // so a choice naming a drop that HAS come back stops applying (its member is no
  // longer in the merge) while a choice naming a still-folded one keeps applying.
  overrides?: OverrideChoices;
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
  // Profile-owned cycling children moved onto the keeper before the drop's
  // cascade delete. Optional so an undo payload captured by an older build remains
  // restorable during the 24-hour undo window after deployment.
  movedTelemetryIds?: number[];
  movedLapIds?: number[];
  movedSegmentEffortIds?: number[];
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
        entity: "telemetry",
        table: "activity_telemetry",
        fks: [{ column: "activity_id", ref: "activity" }],
        childWhere: "activity_id = ?",
        childBinds: 1,
      },
      {
        entity: "laps",
        table: "activity_laps",
        fks: [{ column: "activity_id", ref: "activity" }],
        childWhere: "activity_id = ?",
        childBinds: 1,
      },
      {
        entity: "segmentEfforts",
        table: "activity_segment_efforts",
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
          // ORDERING provider (#1404) — the same real, enforced, outward-pointing FK
          // as provider_id above (the clinician who ordered the test, not the lab
          // that ran it), and the same treatment when that registry row is gone by
          // restore time: null the link, keep the record.
          {
            column: "ordering_provider_id",
            table: "providers",
            onMissing: "null",
            global: true,
          },
        ],
      },
      {
        // Correction lineage (#1404): the prior values a re-import overwrote. A CHILD
        // of the record (ON DELETE CASCADE), so the live delete takes them with it —
        // which means the undo must bring them back, or "undo" would quietly destroy
        // the correction history the delete was supposed to be reversible about.
        entity: "revisions",
        table: "medical_record_revisions",
        fks: [{ column: "record_id", ref: "record" }],
        childWhere: "record_id = ?",
        childBinds: 1,
      },
      {
        // Screening-instrument item answers (#1396). A PHQ-9/GAD-7/AUDIT-C score IS a
        // medical_records row (category 'instrument'), and its per-item answers live in
        // instrument_responses as a CHILD (ON DELETE CASCADE), so the live delete takes
        // them with it. They are not cosmetic: PHQ-9 item 9 is the SELF-HARM item, and
        // the non-dismissible crisis line reads it — restoring the score without its
        // answers would silently downgrade a restored reading from "item 9 positive" to
        // "total-only", i.e. an undo that loses a safety signal. Captured and restored
        // with the reading.
        entity: "instrumentResponses",
        table: "instrument_responses",
        fks: [{ column: "medical_record_id", ref: "record" }],
        childWhere: "medical_record_id = ?",
        childBinds: 1,
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
          // pause_situation_id → situations is the INVERSE situational link (migration
          // 108, #1296) — the mirror of situation_id, same nullable-FK-to-situations
          // shape and same reconciliation: a captured link to a since-hard-deleted
          // situation restores NULLed. Profile-owned, probed WITH the profile_id scope.
          {
            column: "pause_situation_id",
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
          // Shared supply pool link (#1374, migration 112): the household bottle this
          // item draws from. Deleting the pool nulls only LIVE links, so a captured
          // copy can still hold a since-deleted supply_id — a verbatim re-insert would
          // violate the FK and abort the undo (the #375/#598 class). Restore with the
          // link NULLed: the item comes back untracked rather than pointing at a bottle
          // that no longer exists. `shared_supplies` is GLOBAL (no profile_id, the
          // providers precedent), so it's probed by id alone.
          {
            column: "supply_id",
            table: "shared_supplies",
            onMissing: "null",
            global: true,
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
        entity: "doseVersions",
        table: "intake_dose_schedule_versions",
        // A GRANDCHILD, re-inserted after `doses` so its dose_id remaps to the restored
        // row's new id. Without it a restored item would come back with no schedule
        // history — behaviourally the pre-#1973 "this row, always" reading, so nothing
        // breaks, but every pre-delete schedule change would be silently forgotten and
        // the item's past days re-judged by its current rule.
        fks: [{ column: "dose_id", ref: "doses" }],
        childWhere:
          "dose_id IN (SELECT id FROM intake_item_doses WHERE item_id = ?)",
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

  // A tracked wellness practice: deleting it for good captures the weekly target,
  // every session in its normalized name family, and its id-keyed suppression row.
  // Sessions/dismissals carry no FK to frequency_targets, so the action supplies the
  // exact finite-preimage rows and captureDelete removes them explicitly.
  "wellness-practice": {
    kind: "wellness-practice",
    ownedTable: "frequency_targets",
    entities: [
      {
        entity: "target",
        table: "frequency_targets",
        fks: [],
      },
      {
        entity: "sessions",
        table: "practice_logs",
        fks: [],
        childWhere:
          "profile_id = (SELECT profile_id FROM frequency_targets WHERE id = ?) AND practice = (SELECT scope_value FROM frequency_targets WHERE id = ?)",
        childBinds: 2,
        deleteExplicitly: true,
      },
      {
        entity: "dismissals",
        table: "upcoming_dismissals",
        fks: [],
        keyRefs: [{ column: "signal_key", prefix: "practice:", ref: "target" }],
        childWhere:
          "profile_id = (SELECT profile_id FROM frequency_targets WHERE id = ?) AND signal_key = 'practice:' || ?",
        childBinds: 2,
        deleteExplicitly: true,
      },
    ],
  },

  // A logs-only practice has no target row to root the capture on. One session is
  // the root and the remaining same-practice sessions are explicit siblings; undo
  // restores the same logs-only card, never inventing a weekly target.
  "wellness-practice-history": {
    kind: "wellness-practice-history",
    ownedTable: "practice_logs",
    entities: [
      {
        entity: "session",
        table: "practice_logs",
        fks: [],
      },
      {
        entity: "sessions",
        table: "practice_logs",
        fks: [],
        childWhere:
          "profile_id = (SELECT profile_id FROM practice_logs WHERE id = ?) AND id != ? AND practice = (SELECT practice FROM practice_logs WHERE id = ?)",
        childBinds: 3,
        deleteExplicitly: true,
      },
    ],
  },

  // One alcohol history row is the food_log day counter plus every alcohol tap
  // event on that day. The event ledger has no FK, so capture/delete it explicitly
  // and restore it alongside the counter on Undo.
  "substance-alcohol-history": {
    kind: "substance-alcohol-history",
    ownedTable: "food_log",
    entities: [
      { entity: "entry", table: "food_log", fks: [] },
      {
        entity: "events",
        table: "food_log_events",
        fks: [],
        childWhere:
          "profile_id = (SELECT profile_id FROM food_log WHERE id = ?) AND group_key = 'alcohol' AND date = (SELECT date FROM food_log WHERE id = ?)",
        childBinds: 2,
        deleteExplicitly: true,
      },
    ],
  },

  // Nicotine/cannabis history is already one profile-owned day row.
  "substance-history": {
    kind: "substance-history",
    ownedTable: "substance_log",
    entities: [{ entity: "entry", table: "substance_log", fks: [] }],
  },

  // ONE logged practice session (#2038). Deleting a whole practice has been undoable
  // since the two kinds above it; deleting one of its sessions was permanent, while the
  // structurally identical substance history row was not — an inconsistency that read as
  // accidental rather than decided. A session is a single profile-owned row with no
  // children, so this is the plainest possible kind; the import tombstone the delete
  // writes stays and coexists with undo exactly as it does for the whole-practice kinds
  // (captureDelete writes it, restore removes it).
  "practice-session": {
    kind: "practice-session",
    ownedTable: "practice_logs",
    entities: [{ entity: "session", table: "practice_logs", fks: [] }],
  },

  // ONE logged food serving (#2038/#1963). The root is the LEDGER row the ⋯ row menu
  // named; `food_log` is its day counter, which the delete decremented and the undo has
  // to give back — see CounterSpec. Rooting on the event (not on food_log, the way the
  // alcohol kind does) is what keeps deleting one serving out of three from taking the
  // other two with it: the alcohol history row IS the whole day, this is one tap inside
  // it.
  "food-serving": {
    kind: "food-serving",
    ownedTable: "food_log_events",
    entities: [
      { entity: "event", table: "food_log_events", fks: [] },
      {
        entity: "counter",
        table: "food_log",
        fks: [],
        counter: { column: "servings", key: ["date", "group_key"] },
        childWhere:
          "profile_id = (SELECT profile_id FROM food_log_events WHERE id = ?) AND date = (SELECT date FROM food_log_events WHERE id = ?) AND group_key = (SELECT group_key FROM food_log_events WHERE id = ?)",
        childBinds: 3,
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
export function remapRow(
  row: Row,
  idMaps: IdMaps,
  fks: FkSpec[],
  keyRefs: KeyRefSpec[] = []
): Row {
  const out: Row = { ...row };
  delete out.id;
  for (const { column, ref } of fks) {
    const v = out[column];
    if (v == null) continue;
    const map = idMaps[ref];
    if (map && typeof v === "number" && map.has(v)) out[column] = map.get(v);
  }
  for (const { column, prefix, ref } of keyRefs) {
    const value = out[column];
    if (typeof value !== "string" || !value.startsWith(prefix)) continue;
    const oldId = Number(value.slice(prefix.length));
    const map = idMaps[ref];
    if (Number.isInteger(oldId) && map?.has(oldId))
      out[column] = `${prefix}${map.get(oldId)}`;
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
