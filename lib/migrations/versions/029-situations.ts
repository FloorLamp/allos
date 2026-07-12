import type Database from "better-sqlite3";
import type { Migration } from "../runner";

// Migration 029 (issue #560): promote "situations" from free-text, string-keyed
// state to id-keyed first-class rows.
//
// THE DEBT. A `situational` supplement's context was matched by EXACT STRING: the
// supplement carried a free-text `intake_items.situation` (TEXT), and the profile's
// active set lived as a free-text JSON array in `profile_settings.active_situations`,
// compared with `activeSituations.has(supp.situation)`. That's the classic #203
// string-keyed-state fragility — a rename ("Illness" → "Sickness") silently detaches
// every situational supplement, casing/whitespace mismatches ("illness" vs "Illness")
// don't match, and there's no shared vocabulary between the two ad-hoc string sets.
//
// THE REWORK (part 1 — the load-bearing fix):
//   • a small per-profile `situations` table (stable id + NOCASE-unique name +
//     active flag) becomes the ONE vocabulary and the source of the active state;
//   • `intake_items.situation_id` links a situational item to its situation ROW —
//     the durable identity the free-text column lacked, so reads coalesce the row's
//     name (getSupplements) and a future rename re-keys cleanly through the id.
// The free-text `intake_items.situation` column is KEPT as a denormalized fallback
// for rows with no link (legacy/unmatched); getSupplements reads
// COALESCE(situations.name, intake_items.situation), so a linked row always follows
// its situation row.
//
// BACKFILL. For each profile, gather the distinct situation names it used —
// intake_items.situation, intake_item_suggestions.situation, protocols.situation,
// and the active_situations JSON array — NOCASE-dedupe (first-seen casing wins),
// insert a situations row per name (active=1 iff the name was in active_situations),
// and point each intake_items.situation_id at the matching row. Finally the migrated
// active_situations profile_setting is removed (its state now lives on
// situations.active) — the string-keyed source is retired, not left to drift.
//
// FK SHAPE: intake_items.situation_id is a brand-new nullable column with a NULL
// default referencing a NEW table, so a plain additive ADD COLUMN ... REFERENCES
// yields an enforced FK (same reasoning as migration 019); the runner applies this
// with foreign_keys OFF and restores it after. Guards (IF NOT EXISTS + a column
// probe) keep the non-version-gated migrate() replay a no-op. Determinism: reads
// only the DB + its own constants.

function columnNames(db: Database.Database, table: string): Set<string> {
  return new Set(
    (db.prepare(`PRAGMA table_info(${table})`).all() as { name: string }[]).map(
      (r) => r.name
    )
  );
}

// Collapse internal whitespace + trim (the same normalization the runtime layer
// applies), so " Poor  Sleep " and "Poor Sleep" resolve to one row.
function normalize(name: string): string {
  return name.trim().replace(/\s+/g, " ");
}

// Names from a profile's active_situations JSON blob (defensive: a malformed blob
// yields none).
function parseActive(raw: string | null | undefined): string[] {
  if (!raw) return [];
  try {
    const arr = JSON.parse(raw);
    return Array.isArray(arr)
      ? arr.filter((x): x is string => typeof x === "string")
      : [];
  } catch {
    return [];
  }
}

export function up(db: Database.Database): void {
  db.exec(
    `CREATE TABLE IF NOT EXISTS situations (
       id         INTEGER PRIMARY KEY AUTOINCREMENT,
       profile_id INTEGER NOT NULL REFERENCES profiles(id),
       name       TEXT NOT NULL,
       active     INTEGER NOT NULL DEFAULT 0 CHECK (active IN (0, 1)),
       created_at TEXT NOT NULL DEFAULT (datetime('now')),
       UNIQUE (profile_id, name COLLATE NOCASE)
     );`
  );

  if (!columnNames(db, "intake_items").has("situation_id")) {
    db.exec(
      `ALTER TABLE intake_items ADD COLUMN situation_id INTEGER REFERENCES situations(id);`
    );
  }

  // --- Backfill (once; a no-op on a fresh DB with no profiles/data) ---
  const profiles = db.prepare("SELECT id FROM profiles").all() as {
    id: number;
  }[];

  const insertSituation = db.prepare(
    `INSERT OR IGNORE INTO situations (profile_id, name, active) VALUES (?, ?, ?)`
  );
  const setActive = db.prepare(
    `UPDATE situations SET active = 1 WHERE profile_id = ? AND name = ? COLLATE NOCASE`
  );
  const linkItems = db.prepare(
    `UPDATE intake_items
        SET situation_id = (
          SELECT s.id FROM situations s
           WHERE s.profile_id = intake_items.profile_id
             AND s.name = intake_items.situation COLLATE NOCASE
        )
      WHERE profile_id = ? AND situation IS NOT NULL AND TRIM(situation) != ''`
  );

  for (const { id: profileId } of profiles) {
    const activeRaw = (
      db
        .prepare(
          `SELECT value FROM profile_settings WHERE profile_id = ? AND key = 'active_situations'`
        )
        .get(profileId) as { value: string } | undefined
    )?.value;
    const activeNames = parseActive(activeRaw).map(normalize).filter(Boolean);
    const activeLower = new Set(activeNames.map((n) => n.toLowerCase()));

    const rawNames: string[] = [];
    for (const table of [
      "intake_items",
      "intake_item_suggestions",
      "protocols",
    ]) {
      const hasSituation = columnNames(db, table).has("situation");
      if (!hasSituation) continue;
      for (const r of db
        .prepare(
          `SELECT DISTINCT situation FROM ${table}
            WHERE profile_id = ? AND situation IS NOT NULL AND TRIM(situation) != ''`
        )
        .all(profileId) as { situation: string }[]) {
        rawNames.push(r.situation);
      }
    }
    rawNames.push(...activeNames);

    // NOCASE-dedupe, first-seen casing wins.
    const seen = new Set<string>();
    for (const raw of rawNames) {
      const name = normalize(raw);
      if (!name) continue;
      const key = name.toLowerCase();
      if (seen.has(key)) continue;
      seen.add(key);
      insertSituation.run(profileId, name, activeLower.has(key) ? 1 : 0);
    }
    // An active_situations name that never appeared with a stored casing above is
    // still inserted by the loop (rawNames includes activeNames), so mark active.
    for (const name of activeNames) setActive.run(profileId, name);

    linkItems.run(profileId);

    // Retire the migrated string-keyed source — active state now lives on
    // situations.active (row-ops rule: re-key, don't leave the old set to drift).
    db.prepare(
      `DELETE FROM profile_settings WHERE profile_id = ? AND key = 'active_situations'`
    ).run(profileId);
  }
}

export const migration: Migration = {
  id: 29,
  name: "029-situations",
  up,
};
