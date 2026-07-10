// Undo / soft-delete for destructive row deletes (issue #30) — the IMPURE half.
//
// Wires the pure kind registry (lib/undo-delete.ts) to SQLite: capture-on-delete,
// restore-on-undo, and the 24h purge sweep. Server-only (uses the sync `db`).
//
// PHI note: the serialized payload holds the deleted row's content (PHI-adjacent),
// but it never leaves this same SQLite file — the same trust boundary as the row it
// came from. The label column is a generic, non-PHI kind descriptor only.

import { db } from "./db";
import {
  getKindSpec,
  parsePayload,
  remapRow,
  serializePayload,
  type IdMaps,
  type MergeUndoContext,
  type Row,
} from "./undo-delete";
import { revertActivityMerge } from "./merge-activity";

// Human-readable, NON-PHI descriptors stored in deleted_rows.label (for a possible
// future trash view). Never the user's title/name — that stays in `payload`.
const KIND_LABELS: Record<string, string> = {
  activity: "activity",
  "body-metric": "body metric",
  "biomarker-record": "biomarker record",
  "intake-item": "intake item",
};

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

  const tx = db.transaction((): number | null => {
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

    // Delete the root; children cascade. Profile-scoped for defense in depth.
    db.prepare(`DELETE FROM ${root.table} WHERE id = ? AND profile_id = ?`).run(
      rootId,
      profileId
    );

    return Number(info.lastInsertRowid);
  });

  return tx();
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

  const payload = parsePayload(spec0.payload);
  const spec = getKindSpec(payload.kind);

  const tx = db.transaction(() => {
    const idMaps: IdMaps = {};
    for (const entity of spec.entities) {
      const map = new Map<number, number>();
      idMaps[entity.entity] = map;
      const captured = payload.rows[entity.entity] ?? [];
      for (const row of captured) {
        const oldId = row.id;
        const toInsert = remapRow(row, idMaps, entity.fks);
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

    db.prepare(`DELETE FROM deleted_rows WHERE id = ? AND profile_id = ?`).run(
      undoId,
      profileId
    );
  });

  tx();
  return true;
}

// Purge holding rows older than `maxAgeHours` (default 24h). GLOBAL by design — one
// call per hourly notify tick clears every profile's expired undo records (purged
// means purged), so it is intentionally NOT profile-scoped (allowlisted in the
// profile-scoping test). Returns the number of rows removed. Never throws.
export function sweepDeletedRows(maxAgeHours = 24): number {
  try {
    return db
      .prepare(`DELETE FROM deleted_rows WHERE deleted_at < datetime('now', ?)`)
      .run(`-${maxAgeHours} hours`).changes;
  } catch {
    return 0;
  }
}
