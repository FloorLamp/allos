import type Database from "better-sqlite3";
import type { Migration } from "../runner";
import { utcInstant, zonedWallTimeToUtc } from "../../date";
import { resolveTimezone } from "../../timezone";

// A STOOL IS AN EVENT WITH AN OPTIONAL TYPE (issue #5872, owner-ruled 2026-09-11).
//
// The Bristol reading lived in `metric_samples`, whose `value` is REAL NOT NULL, so a
// movement nobody saw the form of could not be recorded at all. It moves to its own
// ledger carrying the substance ledger's columns and nothing else: the occurrence is
// the row, and the type is a nullable fact about it.
//
// ── WHY EVERY MOVED ROW BECOMES `time_source = 'stated'` ─────────────────────
//
// This is the part of the migration that looks like it could be smarter and must not
// be. `metric_samples.started_at` carries the Bristol instant in ONE column written by
// TWO paths that the column cannot tell apart: a stated wall time lands as
// `<date>T<HH:MM>:00`, and an unstated tap lands as `sampleTime`'s reading of the wall
// clock, in the same zoneless local shape. There is no flag, no second column, and no
// source key that separates them — the seconds field is suggestive and nothing more
// (a tap on an exact minute boundary writes `:00` too, and a legacy row's seconds are
// not a contract).
//
// So the honest move is the UNIFORM one. Every row already DISPLAYS its `started_at`
// minute as the movement's own clock: `getBristolRows` reads `substr(started_at, 12, 5)`
// and the record renders it with the `stated` grammar, for a tap and a typed time
// alike. Migrating every row as `stated` at that same minute therefore preserves
// exactly what each row already showed, and nothing on any screen changes.
//
// Choosing per row — "this one looks like a fallback, so file it unstated" — would
// invent a distinction the source data does not carry, and it would pay for that
// invention in the worst currency available: rows that silently stop showing the time
// they have always shown, in somebody's own medical history, with no way to tell which
// rows were re-labelled or to get the old reading back. A wrong uniform answer is
// legible and reversible. A plausible per-row guess is neither.
//
// From this migration forward the two ARE distinguishable, because the write core
// stops inventing: an unstated instant is `occurred_at` NULL with `time_source` NULL,
// and only a person's statement writes 'stated'. The move settles the past on the
// reading the past already gave; it does not claim to recover what the old store never
// recorded.
//
// ── THE INSTANT'S ENCODING ───────────────────────────────────────────────────
//
// `started_at` is a ZONELESS LOCAL datetime for this metric (both writers build it from
// profile-local parts). `occurred_at` on the event ledgers is a CANONICAL UTC instant
// (lib/time-columns.ts), so the move converts through the profile's own zone. That is a
// re-encoding of an instant already in hand, not a judgement about it: the rendered
// wall clock comes back identical, which is what the round-trip test pins.
//
// ── A MOVE, NOT A DUAL WRITE ─────────────────────────────────────────────────
//
// The rows are INSERTed into `stool_events` and DELETEd from `metric_samples` in the
// one migration body, inside the runner's transaction. After it there is exactly one
// store: no `bristol_stool_type` row survives, no reader consults both, and no writer
// appends to the old table. There is no window in which a stool exists in two places.

interface SampleRow {
  id: number;
  profile_id: number;
  date: string;
  started_at: string;
  value: number;
}

const LOCAL_DATETIME = /^(\d{4}-\d{2}-\d{2})T(\d{2}:\d{2})/;

export function up(db: Database.Database): void {
  db.exec(`
    CREATE TABLE IF NOT EXISTS stool_events (
      id          INTEGER PRIMARY KEY AUTOINCREMENT,
      profile_id  INTEGER NOT NULL REFERENCES profiles(id),
      date        TEXT NOT NULL,
      -- The tap instant, canonical by DEFAULT as well as by writer — the shape
      -- food_log_events.recorded_at and substance_log_events.recorded_at carry.
      recorded_at TEXT NOT NULL
        DEFAULT (strftime('%Y-%m-%dT%H:%M:%SZ', 'now')),
      created_at  TEXT NOT NULL DEFAULT (datetime('now')),
      -- The movement's own instant, nullable: NULL means nobody stated one, and the
      -- app never stamps a stool with a time nobody stated. time_source records
      -- where a present value came from — the same closed pair the sibling ledgers use.
      occurred_at TEXT,
      time_source TEXT
        CHECK (time_source IS NULL OR time_source IN ('tap', 'stated')),
      -- The Bristol type, NULLABLE: the occurrence is the row and the type is an
      -- optional fact about it. The RANGE is the schema's (types over guards);
      -- parseBristolType stays the form-boundary parser over the same vocabulary.
      type        INTEGER CHECK (type IS NULL OR type BETWEEN 1 AND 7)
    );
    CREATE INDEX IF NOT EXISTS idx_stool_events_profile
      ON stool_events(profile_id, recorded_at DESC);
    CREATE INDEX IF NOT EXISTS idx_stool_events_day
      ON stool_events(profile_id, date, recorded_at DESC);
  `);

  move(db);
}

// THE DATA MOVE, SEPARATE FROM THE SCHEMA STEP SO IT CAN BE RUN TWICE (the
// 20260905-substance-event-rows seam, and for the same reason): the schema step is
// genuinely not replayable and does not need to be, while the move's idempotence is
// the claim worth proving by executing it. Replaying it is a no-op because the source
// rows are gone — the DELETE is what makes the second run find nothing.
export function move(db: Database.Database): void {
  const samples = db
    .prepare(
      `SELECT id, profile_id, date, started_at, value
         FROM metric_samples
        WHERE metric = 'bristol_stool_type'
        ORDER BY id ASC`
    )
    .all() as SampleRow[];
  if (samples.length === 0) return;

  // One zone lookup per profile, read off this handle rather than through
  // lib/settings (whose reader is request-cached and would import the app's db
  // singleton into a migration body).
  const zones = new Map<number, string>();
  const instanceTz = (
    db.prepare("SELECT value FROM settings WHERE key = 'timezone'").get() as
      | { value?: string }
      | undefined
  )?.value;
  const zoneOf = (profileId: number): string => {
    const known = zones.get(profileId);
    if (known !== undefined) return known;
    const row = db
      .prepare(
        "SELECT value FROM profile_settings WHERE profile_id = ? AND key = 'timezone'"
      )
      .get(profileId) as { value?: string } | undefined;
    const tz = resolveTimezone(row?.value, row?.value == null ? instanceTz : undefined);
    zones.set(profileId, tz);
    return tz;
  };

  const insert = db.prepare(
    `INSERT INTO stool_events
       (profile_id, date, recorded_at, occurred_at, time_source, type)
     VALUES (?, ?, ?, ?, 'stated', ?)`
  );
  for (const sample of samples) {
    const parts = LOCAL_DATETIME.exec(sample.started_at);
    // A shape this metric's two writers cannot produce. Falling back to the DAY keeps
    // the row — losing a recorded movement is the one outcome this move may not have —
    // and the minute it never legibly carried is the only thing that changes.
    const instant = parts
      ? zonedWallTimeToUtc(zoneOf(sample.profile_id), parts[1], parts[2])
      : null;
    const at =
      instant ??
      zonedWallTimeToUtc(zoneOf(sample.profile_id), sample.date, "00:00");
    const canonical = at ? (utcInstant(at) as string) : null;
    // The type is the stored REAL. Anything outside the scale never came from a write
    // path this app has, and the CHECK would refuse it — it moves as an untyped
    // occurrence rather than being dropped, which is the same "keep the row" rule.
    const type =
      Number.isInteger(sample.value) && sample.value >= 1 && sample.value <= 7
        ? sample.value
        : null;
    insert.run(sample.profile_id, sample.date, canonical, canonical, type);
  }

  db.prepare("DELETE FROM metric_samples WHERE metric = 'bristol_stool_type'").run();
}

export const migration: Migration = {
  name: "20260911-stool-events",
  up,
};
