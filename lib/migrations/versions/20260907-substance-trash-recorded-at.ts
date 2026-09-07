import type Database from "better-sqlite3";
import type { Migration } from "../runner";

// Issue #5406: the 20260815 column rename missed `substance-history` snapshots.
// Restore builds its INSERT from each captured row's keys, so move the obsolete key
// inside those holding rows only; live totals and events are already canonical.
const KIND = "substance-history";
const ENTITY = "entry";

function isRecord(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === "object" && !Array.isArray(value);
}

function rewritePayload(json: string): string | null {
  let parsed: unknown;
  try {
    parsed = JSON.parse(json);
  } catch {
    return null;
  }
  if (!isRecord(parsed) || parsed.v !== 1 || parsed.kind !== KIND) return null;
  if (!isRecord(parsed.rows)) return null;
  const entries = parsed.rows[ENTITY];
  if (!Array.isArray(entries) || !entries.every(isRecord)) return null;

  let changed = false;
  for (const entry of entries) {
    if (!Object.hasOwn(entry, "logged_at")) continue;
    // A partially repaired payload may carry both keys. Keep its canonical value and
    // only remove the obsolete key; otherwise move the original value byte-for-byte.
    if (!Object.hasOwn(entry, "recorded_at")) {
      entry.recorded_at = entry.logged_at;
    }
    delete entry.logged_at;
    changed = true;
  }
  return changed ? JSON.stringify(parsed) : null;
}

export function up(db: Database.Database): void {
  const hasTrash = db
    .prepare(
      `SELECT 1 FROM sqlite_master WHERE type = 'table' AND name = 'deleted_rows'`
    )
    .get();
  if (!hasTrash) return;

  const update = db.prepare(`UPDATE deleted_rows SET payload = ? WHERE id = ?`);
  const rows = db
    .prepare(`SELECT id, payload FROM deleted_rows WHERE kind = ?`)
    .all(KIND) as { id: number; payload: unknown }[];
  for (const row of rows) {
    if (typeof row.payload !== "string") continue;
    const next = rewritePayload(row.payload);
    if (next !== null) update.run(next, row.id);
  }
}

export const migration: Migration = {
  name: "20260907-substance-trash-recorded-at",
  up,
};
