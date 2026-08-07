import type Database from "better-sqlite3";
import type { Migration } from "../runner";
import { utcInstant, zonedDateParts, zonedWallTimeToUtc } from "../../date";
import { DEFAULT_TIMEZONE, isValidTimezone } from "../../timezone";

// Migration 170 (issue #2154): the temperature notes-hack data move.
//
// Before #2154, a manual Body Temperature reading smuggled its clock time through
// the row's free-text `notes` as a bare "HH:MM" (#800/#843 — medical_records had no
// time column, and the fever curve needed one). Migration 165 gave the table a real
// event column (`occurred_at`) and #2154's write paths fill it; this migration moves
// the EXISTING smuggled times into that column and clears the note where it was
// purely the time, so one convention serves history and future alike.
//
// A LOSSY FREE-TEXT PARSE, handled accordingly:
//   • GLOB-guarded in SQL and re-validated in JS — only a note that is EXACTLY a
//     zero-padded 24h "HH:MM" (the shape normalizeClockTime always stored) counts.
//     A note carrying anything else — prose, a "7:30", a "25:99" — is left
//     untouched: malformed values are not this migration's to guess at.
//   • Scoped to canonical_name = 'Body Temperature': the only rows any writer ever
//     minted the convention for. A coincidental "HH:MM" note on some other analyte
//     is somebody's note, not a smuggled clock.
//   • The wall clock resolves against the profile's CURRENT timezone — the same
//     honest limit migration 164 states: the note recorded the user's own wall
//     clock with no zone of its own, the profile's timezone is the best statement
//     of the zone it was read in, and unlike a zoneless CLINICAL clock (which stays
//     NULL by #2243 decision 3) this clock was typed into the app by the user the
//     WhenControl rule would resolve identically today.
//   • A wall time that does not exist on its day in that zone (a spring-forward
//     gap) is left untouched rather than settled onto a different clock reading.
//   • `occurred_at` is never clobbered: a row that already carries a stated
//     instant (an edit made between deploy and boot) keeps it — but its
//     purely-time note is still cleared, since the convention it rode is retired.
//
// ROW ACCOUNTING is part of the migration: every candidate note is counted as
// moved, cleared-only, or skipped (malformed / DST-gap), and the arithmetic must
// balance or the migration throws — the runner's per-migration IMMEDIATE
// transaction then rolls the whole move back rather than half-applying it.
//
// REPLAY-SAFE by construction: a moved note is cleared, so a replay finds no
// matching rows and is a no-op. NO SCHEMA CHANGE — notes content and occurred_at
// values only — so the #2091/#1999 column-set pins are untouched.
//
// The #800/#843 fever-curve behavior is preserved, upgraded: same-day multiple
// readings are now keyed by real instants instead of display strings.

// Zero-padded 24h "HH:MM", the exact shape normalizeClockTime stored.
const HHMM = /^([01]\d|2[0-3]):[0-5]\d$/;

// The profile's timezone, read straight off the handle (migrations must not import
// lib/settings — it pulls in lib/db and its own boot path). Mirrors getTimezone's
// resolution order: per-profile setting, else the instance default, else UTC.
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
      | { value?: string }
      | undefined
  )?.value;
  const chosen = prof ?? instance;
  return chosen && isValidTimezone(chosen) ? chosen : DEFAULT_TIMEZONE;
}

export function up(db: Database.Database): void {
  // The candidate set: every Body Temperature row whose note is, in its entirety,
  // a plausible "HH:MM". The GLOB narrows in SQL (cheap, index-free but tiny);
  // the JS regex re-validates (GLOB's [0-2][0-9] admits a 29:xx).
  const rows = db
    .prepare(
      `SELECT id, profile_id, date, notes, occurred_at FROM medical_records
        WHERE canonical_name = 'Body Temperature'
          AND notes IS NOT NULL
          AND length(notes) = 5
          AND notes GLOB '[0-2][0-9]:[0-5][0-9]'
        ORDER BY profile_id, id`
    )
    .all() as {
    id: number;
    profile_id: number;
    date: string;
    notes: string;
    occurred_at: string | null;
  }[];

  const setBoth = db.prepare(
    `UPDATE medical_records SET occurred_at = ?, notes = NULL WHERE id = ?`
  );
  const clearNote = db.prepare(
    `UPDATE medical_records SET notes = NULL WHERE id = ?`
  );

  const tzByProfile = new Map<number, string>();
  let moved = 0;
  let clearedOnly = 0;
  let skipped = 0;
  for (const row of rows) {
    if (!HHMM.test(row.notes)) {
      skipped++; // a 29:xx the GLOB admitted — malformed, left untouched
      continue;
    }
    if (row.occurred_at != null) {
      // A stated instant already stands; the note was still purely the retired
      // convention, so it goes — the instant is not second-guessed.
      clearNote.run(row.id);
      clearedOnly++;
      continue;
    }
    let tz = tzByProfile.get(row.profile_id);
    if (!tz) {
      tz = timezoneFor(db, row.profile_id);
      tzByProfile.set(row.profile_id, tz);
    }
    const inst = zonedWallTimeToUtc(tz, row.date, row.notes);
    // Settled-back check (the statedInstantOnDate rule): a wall time inside a
    // spring-forward gap settles onto a different clock reading, which would
    // silently change what the user stated — leave that row on the old shape.
    if (!inst || zonedDateParts(tz, inst).hhmm !== row.notes) {
      skipped++;
      continue;
    }
    setBoth.run(utcInstant(inst), row.id);
    moved++;
  }

  if (moved + clearedOnly + skipped !== rows.length) {
    throw new Error(
      `migration 170: temperature note-time accounting does not balance ` +
        `(candidates ${rows.length}, moved ${moved}, cleared ${clearedOnly}, ` +
        `skipped ${skipped}). Refusing to half-apply the data move.`
    );
  }
  if (rows.length > 0) {
    console.log(
      `[migration 170] temperature note-times: ${moved} moved into occurred_at, ` +
        `${clearedOnly} notes cleared beside an existing instant, ${skipped} ` +
        `malformed/DST-gap value(s) left untouched.`
    );
  }
}

export const migration: Migration = {
  id: 170,
  name: "170-temperature-note-times",
  up,
};
