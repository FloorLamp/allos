import type Database from "better-sqlite3";
import type { Migration } from "../runner";

// Migration 113 (issue #1456): the unified save store. ONE `saved_items` table
// behind the star gesture, folding the two stores that answered the same user
// intent — "this one matters to me":
//
//   • `starred_biomarkers` (own table, name-keyed, #482 family-re-keyed) — the star
//     toggle on a biomarker page; drove the Results status card and the profile
//     passport summary.
//   • `trend_pins` (a `profile_settings` KV holding a JSON array of "metric:weight" /
//     "bio:LDL Cholesterol" keys) — the pin toggle on Trends Overview tiles; decided
//     which tiles rendered first, and was the ONLY way a biomarker earned a chart
//     tile there at all.
//
// Two gestures for one intent meant a biomarker you cared about had to be starred
// AND pinned, and the two sets silently diverged. Unlike the #860 observation stores
// (different column shapes — merge rejected), save-records are shape-identical across
// domains, so a true merge is the natural fit: `kind` namespaces the key space, and
// per-domain key semantics stay in domain code (lib/saved-items.ts).
//
// COLUMN NOTES
//   • `kind` CHECK is deliberately narrow — the two kinds that exist at launch. A new
//     savable kind (provider, document, exercise) grows the CHECK by an appended
//     rebuild migration; nothing else about the store changes.
//   • `key` is `COLLATE NOCASE`. The folded star store was PRIMARY KEY (profile_id,
//     canonical_name COLLATE NOCASE) and every writer/reader matched COLLATE NOCASE,
//     so a case-sensitive UNIQUE here would REGRESS biomarker identity ("apob" and
//     "ApoB" would become two saves of one analyte). The collation makes
//     UNIQUE(profile_id, kind, key) case-insensitive, which is what both kinds want
//     (metric ids are lowercase slugs).
//   • `position` orders the saved set on Trends Overview (NULL = unpositioned, sorted
//     after positioned rows by created_at — see orderSavedRefs in lib/saved-items.ts).
//     It is presentation only: a biomarker's save membership, not its position, is
//     what drives the status card / chart tile / passport inclusion.
//
// THE FOLD
//   1. Every `starred_biomarkers` row → (kind='biomarker', key=canonical_name),
//      carrying its `created_at` so "newest star first" ordering survives.
//   2. Each profile's `trend_pins` list, IN ORDER: a "bio:" pin → a biomarker row
//      (the NOCASE UNIQUE dedupes it against the star fold above — a starred AND
//      pinned biomarker becomes ONE row, and that row inherits the pin's position so
//      the user's Trends ordering survives); a "metric:" pin → a `trend-metric` row
//      keyed by the bare metric id (the prefix was only ever a namespace, and `kind`
//      is the namespace now). Unrecognized prefixes are dropped.
//   3. `starred_biomarkers` is DROPPED and the `trend_pins` settings rows DELETED —
//      not left behind. Both are keyed by REUSABLE strings, so a leftover row silently
//      re-attaches to a later subject that reuses the key (the #203 rule); and a
//      readable second copy of the save state is exactly the divergence this fixes.
//
// Self-contained (manifest freeze — never imports lib/): the pin-key parsing is
// inlined rather than importing lib/saved-items.ts, so a later refactor of that module
// can't change what this shipped migration does.
//
// Replay-safe (the non-version-gated migrate() wrapper the DB test tier replays):
// the table is CREATE ... IF NOT EXISTS, the folds are INSERT OR IGNORE guarded by a
// table-exists probe (baseline 001 recreates an EMPTY starred_biomarkers on each
// replay, which folds to nothing), the settings delete is idempotent, and the DROP is
// IF EXISTS.

function tableExists(db: Database.Database, table: string): boolean {
  return (
    db
      .prepare(`SELECT 1 FROM sqlite_master WHERE type = 'table' AND name = ?`)
      .get(table) != null
  );
}

// The stored pin blob → an ordered, de-duped key list. Mirrors the retired
// parsePins(): any malformed/legacy shape yields an empty list rather than throwing,
// so one corrupt profile setting can't fail the whole boot.
function parsePinBlob(raw: string | null | undefined): string[] {
  if (!raw) return [];
  let parsed: unknown;
  try {
    parsed = JSON.parse(raw);
  } catch {
    return [];
  }
  if (!Array.isArray(parsed)) return [];
  const seen = new Set<string>();
  const out: string[] = [];
  for (const entry of parsed) {
    if (typeof entry !== "string") continue;
    const key = entry.trim();
    if (!key) continue;
    const dedupe = key.toLowerCase();
    if (seen.has(dedupe)) continue;
    seen.add(dedupe);
    out.push(key);
  }
  return out;
}

export function up(db: Database.Database): void {
  db.exec(`
    CREATE TABLE IF NOT EXISTS saved_items (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      profile_id INTEGER NOT NULL REFERENCES profiles(id),
      kind TEXT NOT NULL CHECK (kind IN ('biomarker','trend-metric')),
      key TEXT NOT NULL COLLATE NOCASE,
      position INTEGER,
      created_at TEXT NOT NULL DEFAULT (datetime('now')),
      UNIQUE(profile_id, kind, key)
    );
    CREATE INDEX IF NOT EXISTS idx_saved_items_profile_kind
      ON saved_items(profile_id, kind);
  `);

  // 1. The star store. A whole-table fold across every profile: each row carries its
  // own profile_id into the new table, so no profile's saves can land under another's.
  if (tableExists(db, "starred_biomarkers")) {
    db.exec(`
      INSERT OR IGNORE INTO saved_items (profile_id, kind, key, created_at)
        SELECT profile_id, 'biomarker', canonical_name, created_at
          FROM starred_biomarkers;
    `);
  }

  // 2. The pin KV, per profile, in list order.
  const pinRows = db
    .prepare(`SELECT profile_id, value FROM profile_settings WHERE key = ?`)
    .all("trend_pins") as { profile_id: number; value: string }[];
  const findBio = db.prepare(
    `SELECT id, position FROM saved_items
      WHERE profile_id = ? AND kind = 'biomarker' AND key = ?`
  );
  const setPosition = db.prepare(
    `UPDATE saved_items SET position = ? WHERE id = ? AND profile_id = ?`
  );
  const insertSaved = db.prepare(
    `INSERT OR IGNORE INTO saved_items (profile_id, kind, key, position)
       VALUES (?, ?, ?, ?)`
  );
  const fold = db.transaction(() => {
    for (const row of pinRows) {
      let position = 0;
      for (const pin of parsePinBlob(row.value)) {
        if (pin.startsWith("bio:")) {
          const name = pin.slice("bio:".length).trim();
          if (!name) continue;
          // The star fold may already hold this analyte (NOCASE). Keep that row —
          // its created_at is the real save date — and give it the pin's position so
          // the user's Trends ordering survives the merge.
          const existing = findBio.get(row.profile_id, name) as
            { id: number; position: number | null } | undefined;
          if (existing) {
            if (existing.position == null)
              setPosition.run(position, existing.id, row.profile_id);
          } else {
            insertSaved.run(row.profile_id, "biomarker", name, position);
          }
        } else if (pin.startsWith("metric:")) {
          const id = pin.slice("metric:".length).trim();
          if (!id) continue;
          insertSaved.run(row.profile_id, "trend-metric", id, position);
        } else {
          continue; // unknown namespace — not a save of anything we can resolve
        }
        position++;
      }
    }
  });
  fold();

  // 3. Both old stores go. See the #203 note in the header.
  db.prepare(`DELETE FROM profile_settings WHERE key = ?`).run("trend_pins");
  db.exec(`DROP TABLE IF EXISTS starred_biomarkers;`);
}

export const migration: Migration = {
  id: 113,
  name: "113-saved-items",
  up,
};
