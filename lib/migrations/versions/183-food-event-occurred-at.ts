import type Database from "better-sqlite3";
import type { Migration } from "../runner";

// Migration 183 (issues #2370 and #2205 phase 2, the food wave): the food event
// ledger's two instants take the declared vocabulary's names — `logged_at` becomes
// `recorded_at`, `eaten_at` becomes `occurred_at` — and both are normalized onto the
// canonical stored-instant shape 'YYYY-MM-DDTHH:MM:SSZ' on the way across.
//
// ── WHY THE NORMALIZATION RIDES WITH THE RENAME (#2370) ──────────────────────
//
// lib/time-columns.ts has declared both columns `convention: "canonical"` since the
// #2205 phase 3 census, but the table was ABSENT from CANONICAL_INSTANT_COLUMNS — the
// writer ratchet in lib/__tests__/instant-writer-scan.test.ts — so nothing bound its
// writers, and one of them drifted. The offline replay's `resolveCapturedInstant`
// (lib/offline/queue.ts) returned `new Date().toISOString()`: millisecond precision
// plus `Z`, a THIRD serialization. It is exactly the notify_lifecycle failure from
// #2233 one table over, and structurally invisible for the same reason — the module
// that builds the string writes no SQL of its own, so rule C never saw a literal to
// object to. The column therefore holds two serializations at once (the issue reports
// 159 of 186 rows on the millisecond shape for one real profile).
//
// A mixed column is a LEXICAL hazard, not a cosmetic one: '…31.865Z' sorts BEFORE
// '…31Z' because '.' (0x2E) precedes 'Z' (0x5A). So a millisecond-bearing instant
// orders ahead of the bare-second instant of the same second, and `idx_food_log_events_pop`
// — the (profile, date, group, tap DESC) ordering the ranking, the burst grouping and
// the "pop the newest event" undo all read — answers wrong while every query still
// looks right. Renaming a column whose writers are unbound would just rename the
// problem, which is why the two halves are one change.
//
// VALUE-PRESERVING, up to sub-second precision. The rewrite is a TRUNCATION of the
// fractional part (`substr(v, 1, 19) || 'Z'`, GLOB-guarded to exactly that shape, the
// migration-167 treatment) and never a reparse, so the stored second is unchanged and
// a value already on the convention is copied byte-for-byte.
//
// ── THE RENAME (#2205 phase 2) ───────────────────────────────────────────────
//
//   `logged_at`  → `recorded_at`  — when the serving entered the app. Migration 056
//     wrote the rule this obeys: it is TAP time, NEVER backfilled, because the ranking
//     predicts the next TAP. That has always been the `recorded_at` semantic; only the
//     spelling was the table's own.
//   `eaten_at`   → `occurred_at`  — when the food was actually eaten. NULLABLE, and
//     NULL IS A REAL ANSWER: "nobody stated a time, and the app refuses to infer one"
//     (#2019/#2053). There is deliberately NO backfill from `recorded_at` — inventing an
//     eating time from a tap stamp is the reinterpretation 056 forbade and 154 exists to
//     avoid, and it is what turns a distribution of eating times into one of tapping
//     times. Food diverges from intake here ON PURPOSE (#2205's own inventory notes the
//     two solved this oppositely), and the divergence survives the rename.
//
// `time_source` IS KEPT, untouched — owner ruling on #2205, 2026-08-08. The amendment
// had left it open ("kept as the tap/stated refinement, or dropped in favour of
// `occurred_at IS NULL`"); the call is keep. The clock-skew findings (#2244/#2287)
// showed it distinguishes "nobody stated a time" from "someone stated one and the write
// path refused it" — different facts with different fixes, which `occurred_at IS NULL`
// collapses into one. Redundant in the failure mode, load-bearing in diagnosing it.
//
// `date` semantics are untouched (#2205 constraint 4): the profile-local food day, which
// the backfill toggle and the cross-midnight re-stamp both own, is a different question
// and no day attribution moves here. `created_at` stays the bare-shaped bookkeeping
// stamp and is NOT claimed as canonical.
//
// Readers move in the SAME change — no compatibility alias, no dual-read period (#2205
// constraint 3).
//
// ── THE VESTIGIAL `eaten_at` COLUMN (the migration-124/169/173 pattern) ──────
//
// The rebuilt table keeps an inert `eaten_at`, always NULL. Not a hedge: `migrate()`
// (lib/db.ts) replays EVERY migration unconditionally for the DB-test harness, and
// migration 154 — shipped and immutable — guards on `PRAGMA table_info` and would
// `ALTER TABLE … ADD COLUMN eaten_at TEXT` on a database that has already been through
// this one, growing a dead column under a wrapper whose contract is that a replay
// changes nothing (lib/__db_tests__/migrate.test.ts pins it). The shell makes 154's
// guard find what it is looking for. lib/time-columns.ts declares it `bookkeeping`
// rather than `event` on purpose, so a dead column can never join the chain
// lib/row-instants.ts walks.
//
// `logged_at` needs NO shell: the only frozen statements naming it are migration 056's
// `CREATE TABLE IF NOT EXISTS` (the table exists, so the whole statement is skipped)
// and its two `CREATE INDEX IF NOT EXISTS` — and THE INDEXES KEEP THEIR NAMES, pointed
// at the renamed column, so 056's guards match and never build a second, dead index.
// That is 173's reasoning for `idx_intake_log_item_given`, one table over.
//
// ── STORED UNDO PAYLOADS ARE REWRITTEN TOO ───────────────────────────────────
//
// `deleted_rows.payload` holds `SELECT *` snapshots, and restore builds its INSERT from
// the captured row's OWN KEYS (lib/undo-delete-db.ts). Two undo kinds capture this table
// — `food-serving` (one tap) and `substance-alcohol-history` (a day's alcohol taps) —
// so a row deleted before this migration and undone after it would insert a column name
// that no longer exists. The trash retention window is 30 days by default, i.e. entirely
// live at deploy time. So the snapshots are rewritten in the same one-shot move: the two
// keys renamed and the same fractional truncation applied, inside the two affected kinds
// only. Idempotent by construction (a payload already rewritten has no old key left).
//
// ── SHAPE ────────────────────────────────────────────────────────────────────
//
// A rebuild, not `ALTER TABLE … RENAME COLUMN`: the house pattern (124/163/169/173) is
// CREATE __new → INSERT…SELECT → DROP → RENAME → re-create indexes, which is what lets
// the normalization, the two renames and the vestigial shell land as one statement
// sequence. The runner (and migrate()) apply migrations with foreign_keys DISABLED, so
// dropping this table — an FK CHILD of profiles and notify_messages, and a parent of
// nothing — neither cascades nor loses its links: the copy carries every FK value
// verbatim and the recreated table re-declares the same references. No link is newly
// enforced, so there is nothing to null beforehand.
//
// THE `recorded_at` DEFAULT IS KEPT VERBATIM. Migration 056 spelled it
// `strftime('%Y-%m-%dT%H:%M:%SZ', 'now')`, which already writes the CANONICAL shape —
// unlike a bare `datetime('now')`, it is not a second convention leaking in through the
// schema, and it is what keeps the NOT NULL honest for a statement that omits the column.
// Every app writer binds instantNow()/utcInstant() explicitly, as the ratchet now requires.
//
// THE SCRATCH TABLE IS SPELLED `food_log_events__new`, the house convention for a
// profile-OWNED rebuild (activities, illness_episodes, goals, frequency_targets all
// use it): lib/__tests__/profile-scoping.test.ts derives OWNED_TABLES from every
// `CREATE TABLE … profile_id` in migration source and skips names ending `_new`, so a
// scratch table with a version suffix would be read as a real, unregistered
// profile-owned table.
//
// AUTOINCREMENT high-water mark: event ids are external identity (the ⋯ row menu's
// delete/undo token, the correction burst's anchors, the Telegram callback's captured
// row), so they must never recycle — and a DROP discards the sqlite_sequence entry. The
// old `seq` is captured first and restored after the rename when the copy's own max id
// came in lower (e.g. the newest tap had been deleted).
//
// REPLAY-SAFE. Guarded on the stored table SQL: once the table carries `recorded_at` the
// rebuild is a pure no-op, and the payload sweep matches nothing on a second run.
// Determinism (spec): reads only the DB and its own constants. Self-contained — imports
// nothing from lib/, per the manifest freeze.

// 'YYYY-MM-DDTHH:MM:SS.<fraction>Z' — the shape `new Date().toISOString()` writes. GLOB
// is case-sensitive and '.' is literal in it, so a value already on the canonical
// second-resolution shape has no '.' at position 20 and never matches.
const ISO_MS_GLOB =
  "[0-9][0-9][0-9][0-9]-[0-9][0-9]-[0-9][0-9]T[0-9][0-9]:[0-9][0-9]:[0-9][0-9].*Z";

// The same truncation as migration 167, as a SQL expression over one column.
const canonicalize = (col: string) =>
  `CASE WHEN ${col} GLOB '${ISO_MS_GLOB}' THEN substr(${col}, 1, 19) || 'Z' ELSE ${col} END`;

// The undo kinds whose payloads carry food_log_events snapshots, and the entity key
// each files them under (lib/undo-delete.ts KIND_SPECS).
const PAYLOAD_ENTITIES: Record<string, string> = {
  "food-serving": "event",
  "substance-alcohol-history": "events",
};

const RENAMES: [from: string, to: string][] = [
  ["logged_at", "recorded_at"],
  ["eaten_at", "occurred_at"],
];

const MS_RE = /^(\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2})\.\d+Z$/;

function tableSql(db: Database.Database, name: string): string {
  return (
    (
      db
        .prepare(
          "SELECT sql FROM sqlite_master WHERE type = 'table' AND name = ?"
        )
        .get(name) as { sql: string } | undefined
    )?.sql ?? ""
  );
}

// Rewrite the captured food-event snapshots inside one stored payload. Returns the new
// JSON, or null when nothing changed (so an already-converted row is not rewritten).
function rewritePayload(json: string, entity: string): string | null {
  let parsed: unknown;
  try {
    parsed = JSON.parse(json);
  } catch {
    // A payload that does not parse is already unrestorable; leave it exactly as found
    // rather than making this migration the thing that lost it.
    return null;
  }
  if (!parsed || typeof parsed !== "object") return null;
  const rows = (parsed as { rows?: unknown }).rows;
  if (!rows || typeof rows !== "object") return null;
  const captured = (rows as Record<string, unknown>)[entity];
  if (!Array.isArray(captured)) return null;

  let changed = false;
  for (const row of captured) {
    if (!row || typeof row !== "object") continue;
    const r = row as Record<string, unknown>;
    for (const [from, to] of RENAMES) {
      if (!(from in r)) continue;
      let v = r[from];
      if (typeof v === "string") {
        const m = MS_RE.exec(v);
        if (m) v = `${m[1]}Z`;
      }
      delete r[from];
      r[to] = v;
      changed = true;
    }
  }
  return changed ? JSON.stringify(parsed) : null;
}

export function up(db: Database.Database): void {
  const sql = tableSql(db, "food_log_events");
  // Absent (a partial handle), or already converged — either way, nothing to do.
  if (sql !== "" && !sql.includes("recorded_at")) {
    const prior = db
      .prepare(`SELECT seq FROM sqlite_sequence WHERE name = 'food_log_events'`)
      .get() as { seq: number } | undefined;

    db.exec(`
      CREATE TABLE food_log_events__new (
        id          INTEGER PRIMARY KEY AUTOINCREMENT,
        profile_id  INTEGER NOT NULL REFERENCES profiles(id),
        group_key   TEXT NOT NULL,
        date        TEXT NOT NULL,
        -- The tap instant. Canonical by DEFAULT as well as by writer (see the header).
        recorded_at TEXT NOT NULL
          DEFAULT (strftime('%Y-%m-%dT%H:%M:%SZ', 'now')),
        created_at  TEXT NOT NULL DEFAULT (datetime('now')),
        meal_slot   TEXT
          CHECK (meal_slot IS NULL OR meal_slot IN ('Morning', 'Midday', 'Evening')),
        -- The EATING instant, nullable: NULL means nobody stated one (#2019/#2053).
        occurred_at TEXT,
        time_source TEXT
          CHECK (time_source IS NULL OR time_source IN ('tap', 'stated')),
        notify_message_id INTEGER REFERENCES notify_messages(id)
          ON DELETE SET NULL,
        -- VESTIGIAL, always NULL. Nothing reads or writes it; occurred_at above
        -- replaced it. It survives for exactly one reason: migrate() (lib/db.ts)
        -- applies EVERY migration unconditionally, and the frozen migration 154 adds
        -- this column back unless its PRAGMA guard finds it.
        eaten_at    TEXT
      );
      INSERT INTO food_log_events__new
        (id, profile_id, group_key, date, recorded_at, created_at, meal_slot,
         occurred_at, time_source, notify_message_id)
        SELECT id, profile_id, group_key, date,
               ${canonicalize("logged_at")},
               created_at, meal_slot,
               ${canonicalize("eaten_at")},
               time_source, notify_message_id
          FROM food_log_events;
      DROP TABLE food_log_events;
      ALTER TABLE food_log_events__new RENAME TO food_log_events;
      -- Migration 056's two orderings, under their ORIGINAL names on the renamed
      -- column (see the header): a replay of 056 finds them and builds nothing.
      CREATE INDEX IF NOT EXISTS idx_food_log_events_profile
        ON food_log_events(profile_id, recorded_at DESC);
      CREATE INDEX IF NOT EXISTS idx_food_log_events_pop
        ON food_log_events(profile_id, date, group_key, recorded_at DESC);
      -- Migration 170's FK-side index, so pruning notify_messages still resolves its
      -- children without scanning the ledger.
      CREATE INDEX IF NOT EXISTS idx_food_log_events_notify_message
        ON food_log_events(notify_message_id);
    `);

    if (prior != null) {
      // Restore the pre-rebuild high-water mark when it exceeds the copied rows' own
      // max (the INSERT re-seeded sqlite_sequence only up to the surviving max id, and
      // an empty table re-created no entry at all). sqlite_sequence carries no unique
      // constraint, so the upsert is spelled out.
      const now = db
        .prepare(
          `SELECT seq FROM sqlite_sequence WHERE name = 'food_log_events'`
        )
        .get() as { seq: number } | undefined;
      if (now == null) {
        db.prepare(
          `INSERT INTO sqlite_sequence (name, seq) VALUES ('food_log_events', ?)`
        ).run(prior.seq);
      } else if (now.seq < prior.seq) {
        db.prepare(
          `UPDATE sqlite_sequence SET seq = ? WHERE name = 'food_log_events'`
        ).run(prior.seq);
      }
    }
  }

  // The stored undo snapshots (see the header). Guarded on the table existing at all,
  // and a no-op on a database with no trash.
  if (tableSql(db, "deleted_rows") === "") return;
  const update = db.prepare(`UPDATE deleted_rows SET payload = ? WHERE id = ?`);
  for (const [kind, entity] of Object.entries(PAYLOAD_ENTITIES)) {
    const rows = db
      .prepare(`SELECT id, payload FROM deleted_rows WHERE kind = ?`)
      .all(kind) as { id: number; payload: string }[];
    for (const row of rows) {
      if (typeof row.payload !== "string") continue;
      const next = rewritePayload(row.payload, entity);
      if (next !== null) update.run(next, row.id);
    }
  }
}

export const migration: Migration = {
  id: 183,
  name: "183-food-event-occurred-at",
  up,
};
