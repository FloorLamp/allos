// Auth-blind write core for a single manual body-temperature reading (issue #800).
// Takes profileId first and never imports lib/auth — the profileId-first + lib-write-
// core convention (#319). The Server Action owns the auth gate + revalidation; this
// module owns the SQL and the canonical-shape / flag-derivation, so a future surface
// (Telegram fever nudge, an episode-view quick log) reuses ONE computation.
//
// ONE SERIES WITH INGESTED VITALS (#482): a manual reading is written with the EXACT
// canonical name / category / °F canonical unit the Health Connect ingest writes
// (lib/integrations/health-connect.ts body_temperature → VITAL_CANONICAL.temperature),
// so manual + synced readings form one Body Temperature series (same dedup partition,
// is_latest chain, reference-range flags). external_id is NULL and source is 'manual':
// a same-window Health Connect push keys its upsert on external_id and so can NEVER
// match/overwrite a manual row (the structural half of the #133 edit lock).
//
// TIME-OF-DAY FOR THE FEVER CURVE: medical_records.date stays day-granular by
// contract (every GROUP BY date / dedup / timeline query relies on it), and the
// reading's clock time lands on the row's OWN event column, `occurred_at`
// (migration 165; #2154 retired the "HH:MM"-in-notes hack this module minted for
// #800/#843, and migration 171 moved the stored ones). The caller still states a
// profile-local "HH:MM"; it is the user's own wall clock on the row's own day, so
// resolving it against the profile's timezone is exactly what the shared
// WhenControl would do (`statedInstantOnDate`), and the acceptance stays honest —
// a wall time that does not exist on that day (a DST gap) costs the statement,
// never the reading. Multiple same-day readings are just multiple rows on the
// same date; with distinct values they coexist in the series (the dedup partition
// keys on value+unit), giving the fever curve — keyed by real instants now.

import { db, writeTx } from "./db";
import { round } from "./units";
import { isRealIsoDate, utcInstant } from "./date";
import { addCanonicalNames, reconcileFlags } from "./queries";
import { getTimezone } from "./settings";
import { statedInstantOnDate } from "./stated-time";
import {
  VITAL_CANONICAL,
  resolveTemperatureUnit,
  toCanonicalTempF,
  temperatureRangeError,
  normalizeClockTime,
  type TempUnit,
} from "./vitals-input";
import type { MedicalFlag } from "./types";

// Typed outcome so a caller answers from what ACTUALLY happened (the markDoseTaken /
// symptom-log contract) rather than unconditionally confirming.
//   logged  — the row was written; `degF` is the canonical value, `flag` its derived
//             reference-range flag ("high" for a fever).
//   invalid — a malformed date, a non-numeric value, or an out-of-range temperature;
//             nothing written. `error` is user-facing.
export type TemperatureLogOutcome =
  | { kind: "logged"; id: number; degF: number; flag: MedicalFlag | null }
  | { kind: "invalid"; error: string };

export type TemperatureUpdateOutcome =
  | { kind: "updated"; degF: number; flag: MedicalFlag | null }
  | { kind: "missing" }
  | { kind: "invalid"; error: string };

const TEMP = VITAL_CANONICAL.temperature;

// The stated instant a profile-local "HH:MM" on `date` denotes, in the canonical
// utcInstant shape — or null when no plausible time was stated (absence, never a
// midnight anchor) or the wall time does not exist on that day (a DST gap).
function statedOccurredAt(
  profileId: number,
  date: string,
  time: string | null | undefined
): string | null {
  const hhmm = normalizeClockTime(time);
  if (!hhmm) return null;
  const inst = statedInstantOnDate(date, hhmm, getTimezone(profileId));
  return inst ? utcInstant(inst) : null;
}

// Log one body-temperature reading into medical_records. Converts the entered value
// to canonical °F at the boundary (°C via toCanonicalTempF), range-checks it, writes
// the row, registers the canonical name, and re-derives its reference-range flag in
// ONE IMMEDIATE transaction (#468) so a throw in reconcileFlags can't leave a
// half-written row. Returns the derived flag so the caller can confirm "logged (fever)".
export function logTemperatureCore(
  profileId: number,
  rawValue: number | null | undefined,
  unit: TempUnit | string | null | undefined,
  date: string,
  time?: string | null
): TemperatureLogOutcome {
  if (!isRealIsoDate(date))
    return { kind: "invalid", error: "Enter a valid date." };
  if (rawValue == null || !Number.isFinite(rawValue)) {
    return { kind: "invalid", error: "Enter a valid temperature." };
  }
  const resolvedUnit = resolveTemperatureUnit(rawValue, unit);
  const degF = round(toCanonicalTempF(rawValue, resolvedUnit), 1);
  const rangeErr = temperatureRangeError(degF);
  if (rangeErr) return { kind: "invalid", error: rangeErr };
  // The stated reading time → the row's own event column (#2154). `notes` stays
  // NULL: a note is a note now, never a smuggled clock.
  const occurredAt = statedOccurredAt(profileId, date, time);

  return writeTx(() => {
    const info = db
      .prepare(
        `INSERT INTO medical_records
           (profile_id, date, occurred_at, category, name, value, value_num, unit,
            canonical_name, source, external_id, notes)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, 'manual', NULL, NULL)`
      )
      .run(
        profileId,
        date,
        occurredAt,
        TEMP.category,
        TEMP.canonical,
        String(degF),
        degF,
        TEMP.unit,
        TEMP.canonical
      );
    const id = Number(info.lastInsertRowid);
    addCanonicalNames([TEMP.canonical]);
    reconcileFlags(profileId, [id]);
    const row = db
      .prepare(
        "SELECT flag FROM medical_records WHERE id = ? AND profile_id = ?"
      )
      .get(id, profileId) as { flag: MedicalFlag | null } | undefined;
    return { kind: "logged" as const, id, degF, flag: row?.flag ?? null };
  });
}

// Correct one existing temperature reading without turning the episode UI into a
// general medical-record editor. The canonical identity and profile ownership are
// both checked before the scoped update; imported readings retain their edit lock.
export function updateTemperatureCore(
  profileId: number,
  id: number,
  rawValue: number | null | undefined,
  date: string,
  time?: string | null
): TemperatureUpdateOutcome {
  if (!isRealIsoDate(date))
    return { kind: "invalid", error: "Enter a valid date." };
  if (rawValue == null || !Number.isFinite(rawValue))
    return { kind: "invalid", error: "Enter a valid temperature." };
  const degF = round(rawValue, 1);
  const rangeErr = temperatureRangeError(degF);
  if (rangeErr) return { kind: "invalid", error: rangeErr };
  // The edit sheet's time field IS the statement: a stated "HH:MM" lands on
  // occurred_at (resolved on the possibly-corrected date), an emptied field
  // clears it. `notes` is no longer written — a genuine note survives an edit
  // instead of being clobbered by the retired clock-in-notes convention.
  const occurredAt = statedOccurredAt(profileId, date, time);

  return writeTx((): TemperatureUpdateOutcome => {
    const owned = db
      .prepare(
        `SELECT id FROM medical_records
          WHERE id = ? AND profile_id = ? AND canonical_name = ?`
      )
      .get(id, profileId, TEMP.canonical);
    if (!owned) return { kind: "missing" };
    db.prepare(
      `UPDATE medical_records
          SET date = ?, occurred_at = ?, value = ?, value_num = ?, unit = ?,
              edited = CASE WHEN external_id IS NOT NULL THEN 1 ELSE edited END
        WHERE id = ? AND profile_id = ? AND canonical_name = ?`
    ).run(
      date,
      occurredAt,
      String(degF),
      degF,
      TEMP.unit,
      id,
      profileId,
      TEMP.canonical
    );
    reconcileFlags(profileId, [id]);
    const row = db
      .prepare(
        `SELECT flag FROM medical_records
          WHERE id = ? AND profile_id = ? AND canonical_name = ?`
      )
      .get(id, profileId, TEMP.canonical) as
      { flag: MedicalFlag | null } | undefined;
    return { kind: "updated", degF, flag: row?.flag ?? null };
  });
}
