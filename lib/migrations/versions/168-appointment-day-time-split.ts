import type Database from "better-sqlite3";
import type { Migration } from "../runner";

// Migration 168 (issue #2234): split `appointments.scheduled_at` by grain — as a
// TABLE REBUILD, because the column is NOT NULL and its replacement (`date`) is too.
//
// `scheduled_at` held THREE shapes, with no marker saying which: a bare day
// (`YYYY-MM-DD`, the form with no time), a space-separated local datetime
// (`YYYY-MM-DD HH:MM`, the app's own form), and a T-separated one
// (`YYYY-MM-DDTHH:MM`, the FHIR importer — occasionally with seconds). One
// user-facing column, two grains, and every reader deciding for itself which it
// was handed. The split replaces it with:
//
//   - date        TEXT NOT NULL — the appointment's calendar day, YYYY-MM-DD.
//   - time_of_day TEXT NULL     — the wall-clock HH:MM, NULL for a day-only
//                                 booking (a real product state: the form labels
//                                 the field "Time (optional)" and the calendar
//                                 feed emits those rows as all-day events).
//
// `time_of_day IS NULL` IS the grain — it cannot disagree with a string shape the
// way a marker column could. NEITHER half is an instant: the appointment is the
// CLINIC's local wall clock, deliberately never resolved against the profile's
// timezone and never stored as UTC (the clinic is frequently not in the profile's
// zone; the zone question is #2243's, out of scope here).
//
// Ordering is preserved exactly: `ORDER BY scheduled_at` put a day-only row before
// same-day timed rows because `'2026-08-07' < '2026-08-07 09:00'` lexically, and
// `ORDER BY date, time_of_day` sorts NULL first ASC / last DESC — identical in
// both directions.
//
// The data move rides inside the rebuild's copy:
//
//   date        = substr(scheduled_at, 1, 10)
//   time_of_day = CASE WHEN length(scheduled_at) > 10
//                      THEN substr(scheduled_at, 12, 5) END
//
// Position 11 is the separator in both timed spellings (space or T), so
// `substr(…, 12, 5)` takes `HH:MM` from either; a value carrying seconds still
// yields the HH:MM prefix.
//
// The CREATE below is the version-167 appointments shape VERBATIM — migration
// 024's rebuilt definition plus 026's trailing `encounter_id` — with the one
// column replaced by the two new ones in its position. The copy preserves ids;
// the profile listing index is recreated over (profile_id, date, time_of_day) so
// it keeps serving the same ORDER BY, plus the external-id dedup index unchanged.
//
// FK/CASCADE SAFETY: the runner (and the migrate() test wrapper) apply every
// migration with foreign_keys DISABLED and restore it afterward (issue #95), so
// the DROP/RENAME swap is safe; appointments has no FK children. DATA SAFETY: per
// the house rule (migration 006), every dangling nullable link is NULLED before
// the FK'd copy — provider_id, document_id, and encounter_id here — so a broken
// pointer becomes "unlinked", never a commit failure.
//
// REPLAY SAFETY: the non-version-gated migrate() test wrapper replays every up()
// unconditionally, so the rebuild is guarded — skipped once the appointments
// table already has a `date` column. Production applies it exactly once behind
// the user_version gate. Determinism: reads only the DB + its own constants.

const CREATE_APPOINTMENTS = `
  CREATE TABLE appointments (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    profile_id INTEGER NOT NULL REFERENCES profiles(id),
    date TEXT NOT NULL,
    time_of_day TEXT,
    provider_id INTEGER REFERENCES providers(id),
    title TEXT,
    location TEXT,
    notes TEXT,
    status TEXT NOT NULL DEFAULT 'scheduled'
      CHECK (status IN ('scheduled','completed','cancelled')),
    created_at TEXT NOT NULL DEFAULT (datetime('now')),
    kind TEXT,
    document_id INTEGER REFERENCES medical_documents(id),
    source TEXT,
    external_id TEXT,
    encounter_id INTEGER REFERENCES encounters(id)
  );`;

const INDEXES = [
  `CREATE INDEX IF NOT EXISTS idx_appointments_profile
     ON appointments(profile_id, date, time_of_day);`,
  `CREATE UNIQUE INDEX IF NOT EXISTS idx_appointments_external
     ON appointments(profile_id, external_id) WHERE external_id IS NOT NULL;`,
];

function columnNames(db: Database.Database, table: string): string[] {
  return (
    db.prepare(`PRAGMA table_info(${table})`).all() as { name: string }[]
  ).map((r) => r.name);
}

export function up(db: Database.Database): void {
  // Replay guard: already rebuilt (or somehow absent) → no-op.
  const oldCols = columnNames(db, "appointments");
  if (oldCols.length === 0 || oldCols.includes("date")) return;

  const run = db.transaction(() => {
    // Null any dangling link before the FK'd copy (mirrors 006's rule).
    db.exec(
      `UPDATE appointments SET provider_id = NULL
         WHERE provider_id IS NOT NULL
           AND provider_id NOT IN (SELECT id FROM providers);`
    );
    db.exec(
      `UPDATE appointments SET document_id = NULL
         WHERE document_id IS NOT NULL
           AND document_id NOT IN (SELECT id FROM medical_documents);`
    );
    db.exec(
      `UPDATE appointments SET encounter_id = NULL
         WHERE encounter_id IS NOT NULL
           AND encounter_id NOT IN (SELECT id FROM encounters);`
    );

    const scratch = "appointments__new168";
    db.exec(
      CREATE_APPOINTMENTS.replace(
        "CREATE TABLE appointments (",
        `CREATE TABLE ${scratch} (`
      )
    );

    // The copy IS the data move: the day prefix becomes `date`, the HH:MM after
    // the position-11 separator (space or T) becomes `time_of_day` (NULL for a
    // bare day; a seconds-bearing value still yields HH:MM).
    db.exec(
      `INSERT INTO ${scratch}
         (id, profile_id, date, time_of_day, provider_id, title, location,
          notes, status, created_at, kind, document_id, source, external_id,
          encounter_id)
       SELECT id, profile_id,
              substr(scheduled_at, 1, 10),
              CASE WHEN length(scheduled_at) > 10
                   THEN substr(scheduled_at, 12, 5) END,
              provider_id, title, location, notes, status, created_at, kind,
              document_id, source, external_id, encounter_id
         FROM appointments;`
    );

    // DROP first (freeing the old index names), then rename the scratch into place.
    db.exec(`DROP TABLE appointments;`);
    db.exec(`ALTER TABLE ${scratch} RENAME TO appointments;`);

    for (const idx of INDEXES) db.exec(idx);
  });
  // One (possibly nested) transaction: the runner already wraps up() in an
  // IMMEDIATE transaction (this nests as a SAVEPOINT); the migrate() test wrapper
  // calls up() in autocommit (this becomes the transaction).
  run.immediate();
}

export const migration: Migration = {
  id: 168,
  name: "168-appointment-day-time-split",
  up,
};
