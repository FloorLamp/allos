import type Database from "better-sqlite3";
import type { Migration } from "../runner";
import { utcInstant, zonedWallIsoToUtc } from "../../date";
import { DEFAULT_TIMEZONE, isValidTimezone } from "../../timezone";

// Migration 164 (issue #2205 phase 1, and the #94 weakness it revisits):
// `hr_minutes.ts` stops being a profile-local wall clock and becomes a UTC instant.
//
// THIS ONE IS A GENUINE VALUE CHANGE — the only one in phase 1, which is why #2205
// constraint 1 puts it last, behind everything value-preserving.
//
//   before   2026-03-08T09:14        profile-local minute, no zone, computed at ingest
//   after    2026-03-08T14:14:00Z    the absolute instant that minute denoted
//
// WHAT WAS WRONG. The stored minute was `zonedMinuteStr(profileTz, instant)` — the
// local wall clock AT INGEST, carrying no zone of its own, and part of the primary
// key. Two consequences, both documented at #94 and both fixed here:
//
//   1. A profile timezone change RE-MEANT HISTORY. The old rows kept whatever local
//      minute they were written with, so after a move from New York to Tokyo the same
//      raw sample read as a different time of day than it had the day before — a
//      3am reading became an afternoon one, silently, with no row rewritten.
//   2. It re-keyed the ROLLING WINDOW. The next Health Connect push of the same ~48h
//      re-derived different local minutes and INSERTed duplicates alongside the old
//      rows. lib/integrations/ingest-timezone-sweep.ts exists ONLY to paper over that
//      by deleting the window so the re-push can repopulate it. With a UTC key a
//      timezone change re-keys nothing, so that half of the sweep goes in this change.
//
// THE HONEST LIMIT, stated rather than buried. Only the profile's CURRENT timezone is
// knowable — no row records the zone it was written under, which is the whole defect.
// So the conversion reads every row under the profile's timezone today. For a profile
// that never moved (the overwhelming case) that is exact. For one that did, its older
// rows were ALREADY mislabelled by the old model, and this makes them mislabelled
// ONCE, STATICALLY, instead of silently re-meaning on every future timezone change.
// That is strictly better and it is the most any migration can honestly claim; it is
// not a claim that the old data is now perfect.
//
// DST IS HANDLED. `zonedWallIsoToUtc` settles each wall clock against the offset in
// force AT that instant (two passes, so a stamp near a transition lands on the right
// side), which is exactly what the old ingest-time derivation could not do after the
// fact. A fixed-offset conversion would have shifted half the year by an hour.
//
// THE KEY. PRIMARY KEY (profile_id, ts, source) keeps its SHAPE; what changes is what
// `ts` means, so the whole table is rebuilt to rewrite the key values. Idempotent
// ingest is preserved BY CONSTRUCTION and improved: the same raw sample now derives
// the same UTC minute forever, where before it derived whatever the current zone said.
//
// THE INDEX. `idx_hr_minutes_day ON (profile_id, substr(ts,1,10))` is dropped and NOT
// replaced. A substring of a UTC instant is a UTC day, which is not the profile-local
// day any reader asks for — keeping it would be keeping a fast wrong answer. Day
// attribution moves to read time (lib/local-day-window.ts), which asks for RANGES of
// `ts`, and the primary key's own implicit index is already a covering index on
// (profile_id, ts, source) for exactly that. A second index would be redundant.
//
// VERIFICATION IS PART OF THE MIGRATION, not a thing to remember to do afterwards:
// row count in and out must match, and a mismatch throws rather than half-converting.
// The runner applies each migration in its own IMMEDIATE transaction, so a throw rolls
// the whole rebuild back and the boot fails loudly with the table untouched.
//
// REPLAY-SAFE: guarded on the stored table SQL, so the non-version-gated migrate()
// replay is a no-op once converted.

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

// The profile's timezone, read straight off the handle. Migrations must not import
// lib/settings (it pulls in lib/db and its own boot path), so this mirrors
// getTimezone's resolution order: per-profile setting, else the instance default,
// else UTC — validated, because an unusable zone here would corrupt every row it
// touched rather than fail loudly.
function timezoneFor(db: Database.Database, profileId: number): string {
  const prof = (
    db
      .prepare(
        "SELECT value FROM profile_settings WHERE profile_id = ? AND key = 'timezone'"
      )
      .get(profileId) as { value?: string } | undefined
  )?.value;
  const instance = (
    db.prepare("SELECT value FROM settings WHERE key = 'timezone'").get() as
      { value?: string } | undefined
  )?.value;
  const chosen = prof ?? instance;
  return chosen && isValidTimezone(chosen) ? chosen : DEFAULT_TIMEZONE;
}

export function up(db: Database.Database): void {
  if (tableSql(db, "hr_minutes").includes("UTC instant")) return;

  const before = (
    db.prepare("SELECT COUNT(*) AS n FROM hr_minutes").get() as { n: number }
  ).n;

  db.exec(`
    CREATE TABLE hr_minutes__new (
      profile_id INTEGER NOT NULL REFERENCES profiles(id),
      ts TEXT NOT NULL,                                 -- UTC instant, 'YYYY-MM-DDTHH:MM:00Z' (#2205). The profile-local DAY/minute is derived at READ time (lib/local-day-window.ts) — see #94.
      bpm REAL NOT NULL,                                -- count-weighted average
      bpm_min REAL,
      bpm_max REAL,
      n INTEGER NOT NULL,                               -- samples in bucket (for weighted merge)
      source TEXT NOT NULL DEFAULT 'health-connect',
      PRIMARY KEY (profile_id, ts, source)
    );
  `);

  const insert = db.prepare(
    `INSERT OR IGNORE INTO hr_minutes__new
       (profile_id, ts, bpm, bpm_min, bpm_max, n, source)
     VALUES (?, ?, ?, ?, ?, ?, ?)`
  );
  // PAGED BY ROWID, not iterated. better-sqlite3 refuses to run a write while a
  // statement iterator is open on the same connection, and `.all()` on a profile's
  // whole history would materialise millions of rows (hr_minutes grows ~0.5M rows a
  // year for an all-day wearable — the #387 table). Paging keeps the working set flat
  // and is safe because the rows being read are never the rows being written.
  const PAGE = 5_000;
  const read = db.prepare(
    `SELECT rowid AS rid, profile_id, ts, bpm, bpm_min, bpm_max, n, source
       FROM hr_minutes WHERE profile_id = ? AND rowid > ?
      ORDER BY rowid LIMIT ${PAGE}`
  );
  const profiles = (
    db
      .prepare("SELECT DISTINCT profile_id AS id FROM hr_minutes ORDER BY id")
      .all() as { id: number }[]
  ).map((r) => r.id);

  let converted = 0;
  let collided = 0;
  let unparseable = 0;
  for (const profileId of profiles) {
    const tz = timezoneFor(db, profileId);
    let cursor = 0;
    for (;;) {
      const page = read.all(profileId, cursor) as {
        rid: number;
        profile_id: number;
        ts: string;
        bpm: number;
        bpm_min: number | null;
        bpm_max: number | null;
        n: number;
        source: string;
      }[];
      if (page.length === 0) break;
      cursor = page[page.length - 1].rid;
      for (const row of page) {
        const at = zonedWallIsoToUtc(tz, row.ts);
        // An unparseable stamp is carried across UNCHANGED rather than dropped or
        // guessed at. It cannot have come from zonedMinuteStr, so it is either hand-seeded
        // or already absolute; either way losing a reading to a format surprise would be
        // worse than leaving one row on the old shape for a later pass to notice.
        const ts = at ? utcInstant(at) : row.ts;
        if (!at) unparseable++;
        const res = insert.run(
          row.profile_id,
          ts,
          row.bpm,
          row.bpm_min,
          row.bpm_max,
          row.n,
          row.source
        );
        if (res.changes === 0) collided++;
        else converted++;
      }
    }
  }

  // A collision needs a local stamp inside a spring-forward GAP — a wall clock that
  // never existed — which zonedMinuteStr cannot produce from a real instant. Counted
  // rather than assumed away, and folded into the row-count check below so the
  // accounting has to balance exactly.
  if (converted + collided !== before) {
    throw new Error(
      `migration 164: hr_minutes row accounting does not balance ` +
        `(read ${before}, wrote ${converted}, collided ${collided}). ` +
        `Refusing to swap in a partially converted table.`
    );
  }

  db.exec(`
    DROP TABLE hr_minutes;
    ALTER TABLE hr_minutes__new RENAME TO hr_minutes;
    DROP INDEX IF EXISTS idx_hr_minutes_day;
  `);

  const after = (
    db.prepare("SELECT COUNT(*) AS n FROM hr_minutes").get() as { n: number }
  ).n;
  if (after !== converted) {
    throw new Error(
      `migration 164: hr_minutes holds ${after} rows after the swap, expected ${converted}.`
    );
  }
  if (collided > 0 || unparseable > 0) {
    console.warn(
      `[migration 164] hr_minutes converted with ${collided} key collision(s) and ` +
        `${unparseable} unparseable stamp(s) carried across unchanged.`
    );
  }
}

export const migration: Migration = {
  id: 164,
  name: "164-hr-minutes-utc-instants",
  up,
};
