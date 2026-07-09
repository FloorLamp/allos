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

export interface EntitySpec {
  // Logical key within a kind (used to key the payload + the id maps).
  entity: string;
  // The physical table name (a constant, never user input).
  table: string;
  // FK columns to remap on restore. Empty for the root.
  fks: FkSpec[];
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
}

// ── The kind registry ─────────────────────────────────────────────────────────
// Adding a new undoable kind = one entry here + wiring its delete action to
// captureDelete(kind, ...). The root table MUST be in OWNED_TABLES.
export const UNDO_KINDS: Record<string, KindSpec> = {
  activity: {
    kind: "activity",
    ownedTable: "activities",
    entities: [
      { entity: "activity", table: "activities", fks: [] },
      {
        entity: "sets",
        table: "exercise_sets",
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
    entities: [{ entity: "record", table: "medical_records", fks: [] }],
  },

  // Supplement OR medication (both live in intake_items). Captures the full
  // cascade: scheduled doses, "take together / apart" pairs, adherence logs (which
  // reference a dose), medication courses, and side effects (which reference a
  // course). Restore re-inserts them in this order so every FK target exists first.
  "intake-item": {
    kind: "intake-item",
    ownedTable: "intake_items",
    entities: [
      { entity: "item", table: "intake_items", fks: [] },
      {
        entity: "doses",
        table: "intake_item_doses",
        fks: [{ column: "supplement_id", ref: "item" }],
        childWhere: "supplement_id = ?",
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
        childWhere: "a_id = ? OR b_id = ?",
        childBinds: 2,
      },
      {
        entity: "courses",
        table: "medication_courses",
        fks: [{ column: "item_id", ref: "item" }],
        childWhere: "item_id = ?",
        childBinds: 1,
      },
      {
        entity: "logs",
        table: "intake_item_logs",
        // Re-inserted after `doses` (its dose_id target) and `item`.
        fks: [
          { column: "dose_id", ref: "doses" },
          { column: "supplement_id", ref: "item" },
        ],
        childWhere: "supplement_id = ?",
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

// Build the serialized payload from captured rows-by-entity. Pure.
export function serializePayload(
  kind: string,
  rows: Record<string, Row[]>
): string {
  const payload: Payload = { v: 1, kind, rows };
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
