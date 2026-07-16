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
// TIME-OF-DAY FOR THE FEVER CURVE: medical_records.date is day-granular by contract
// (every GROUP BY date / dedup / timeline query relies on it — the Health Connect path
// keeps the timestamp out of `date` too, in external_id), so a repeat-reading's clock
// time rides `notes` as a plain "HH:MM" string. Multiple same-day readings are just
// multiple rows on the same date; with distinct values they coexist in the series
// (the dedup partition keys on value+unit), giving the fever curve.

import { db, writeTx } from "./db";
import { round } from "./units";
import { isRealIsoDate } from "./date";
import { addCanonicalNames, reconcileFlags } from "./queries";
import {
  VITAL_CANONICAL,
  toCanonicalTempF,
  temperatureRangeError,
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

// Normalize a caller-supplied time note to a bare "HH:MM" (24h) string, or null. Kept
// display-only text in `notes`; never parsed for day attribution (that's `date`).
function normalizeTimeNote(time: string | null | undefined): string | null {
  const v = (time ?? "").trim();
  return /^\d{2}:\d{2}$/.test(v) ? v : null;
}

const TEMP = VITAL_CANONICAL.temperature;

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
  const degF = round(toCanonicalTempF(rawValue, unit), 1);
  const rangeErr = temperatureRangeError(degF);
  if (rangeErr) return { kind: "invalid", error: rangeErr };
  const note = normalizeTimeNote(time);

  return writeTx(() => {
    const info = db
      .prepare(
        `INSERT INTO medical_records
           (profile_id, date, category, name, value, value_num, unit,
            canonical_name, source, external_id, notes)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, 'manual', NULL, ?)`
      )
      .run(
        profileId,
        date,
        TEMP.category,
        TEMP.canonical,
        String(degF),
        degF,
        TEMP.unit,
        TEMP.canonical,
        note
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
