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

import { db, today, writeTx } from "./db";
import { isPastWriteAccepted } from "./log-manifest";
import type { LoggedVia } from "./logged-via";
import { round } from "./units";
import { utcInstant } from "./date";
import { addCanonicalNames, reconcileFlags } from "./queries";
import { getTimezone } from "./settings";
import { statedInstantOnDate, type StatedTimeRefusal } from "./stated-time";
import {
  resolveStatedOccurredAt,
  type StatedOccurredAt,
} from "./reading-writes";
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
//   logged  — ... and `statedTimeRefused` when a stated minute did NOT survive the
//             acceptance gate (#4568). A NOTICE, never a failure: the reading landed on
//             its own day, exactly as `insertBodyMetric`/`insertVitals` answer.
export type TemperatureLogOutcome =
  | {
      kind: "logged";
      id: number;
      degF: number;
      flag: MedicalFlag | null;
      statedTimeRefused?: StatedTimeRefusal;
    }
  | { kind: "invalid"; error: string };

// `updated` carries the same NOTICE its log sibling does, and for the same reason.
export type TemperatureUpdateOutcome =
  | {
      kind: "updated";
      degF: number;
      flag: MedicalFlag | null;
      statedTimeRefused?: StatedTimeRefusal;
    }
  | { kind: "missing" }
  | { kind: "invalid"; error: string };

const TEMP = VITAL_CANONICAL.temperature;

// The stated instant a profile-local "HH:MM" on `date` denotes — THROUGH THE DOMAIN'S
// ONE ACCEPTANCE GATE (#4568). `LOG_MANIFEST.body` declares `statedTime: judged`, and
// this resolver used to run `normalizeClockTime` alone: a SHAPE check, so a temperature
// stated at 14:00 while it was 09:00 was stored as a fact about the future while its
// five sibling body cores refused the same statement through `resolveStatedOccurredAt`.
// The domain had two spellings of one question and the manifest asserted the answer
// only one of them gave.
//
// `resolveStatedOccurredAt` is that one spelling (lib/reading-writes.ts) and it takes an
// INSTANT, so the wall clock is anchored on its own day first — `statedInstantOnDate`,
// which is DST-honest and returns null for a wall time that does not exist on that day.
// A null anchor reaches the gate as an explicit "no time", which is what this resolver
// has always answered for it.
//
// `refused` is present only when a statement was made and the gate discarded it; the
// callers below decide what that COSTS, and they decide it differently on purpose
// (lib/stated-time.ts's own rule: a log path keeps the row and drops the minute, a
// correction path — where the statement is the submission — surfaces it).
function statedOccurredAt(
  profileId: number,
  date: string,
  time: string | null | undefined
): StatedOccurredAt {
  const hhmm = normalizeClockTime(time);
  if (!hhmm) return { value: null };
  const inst = statedInstantOnDate(date, hhmm, getTimezone(profileId));
  return resolveStatedOccurredAt(
    profileId,
    date,
    inst ? utcInstant(inst) : null
  );
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
  // Which surface took this reading (#3087) — required, no default, ahead of the
  // optional stated time. The temperature ledger IS `medical_records` (one series
  // with the ingested vitals, #482), so the stamp lands there beside `source`.
  loggedVia: LoggedVia,
  time?: string | null
): TemperatureLogOutcome {
  // The shared date invariant (#4425): any real past day, never the future. A reading
  // dated forward is a typo or a forgery, and `occurred_at`'s own gate never saw the
  // row's `date`.
  if (!isPastWriteAccepted(today(profileId), date))
    return { kind: "invalid", error: "Enter a valid date." };
  if (rawValue == null || !Number.isFinite(rawValue)) {
    return { kind: "invalid", error: "Enter a valid temperature." };
  }
  const resolvedUnit = resolveTemperatureUnit(rawValue, unit);
  const degF = round(toCanonicalTempF(rawValue, resolvedUnit), 1);
  const rangeErr = temperatureRangeError(degF);
  if (rangeErr) return { kind: "invalid", error: rangeErr };
  // The stated reading time → the row's own event column (#2154). `notes` stays
  // NULL: a note is a note now, never a smuggled clock. A refused statement costs
  // the minute and never the reading — the log-path half of the rule above.
  const stated = statedOccurredAt(profileId, date, time);
  const occurredAt = stated.value ?? null;

  return writeTx(() => {
    const info = db
      .prepare(
        `INSERT INTO medical_records
           (profile_id, date, occurred_at, category, name, value, value_num, unit,
            canonical_name, source, external_id, notes, logged_via)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, 'manual', NULL, NULL, ?)`
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
        TEMP.canonical,
        loggedVia
      );
    const id = Number(info.lastInsertRowid);
    addCanonicalNames([TEMP.canonical]);
    reconcileFlags(profileId, [id]);
    const row = db
      .prepare(
        "SELECT flag FROM medical_records WHERE id = ? AND profile_id = ?"
      )
      .get(id, profileId) as { flag: MedicalFlag | null } | undefined;
    return {
      kind: "logged" as const,
      id,
      degF,
      flag: row?.flag ?? null,
      ...(stated.refused ? { statedTimeRefused: stated.refused } : {}),
    };
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
  // THE SAME DAY BOUND ITS LOG SIBLING HOLDS (#4568). `logTemperatureCore` gained
  // `isPastWriteAccepted` in #4425 and this correction door did not, so a shipped
  // reading could still be edited ONTO a day that has not happened — the same
  // log-versus-correction asymmetry #4463 closed for food. `isRealIsoDate` is folded
  // into the shared predicate, which checks it first.
  if (!isPastWriteAccepted(today(profileId), date))
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
  //
  // A REFUSED MINUTE COSTS THE MINUTE, NOT THE CORRECTION — the LOG branch of
  // lib/stated-time.ts's rule, because that rule's correction branch has a
  // precondition this door does not meet. It reads "a correction path — WHERE THE
  // STATEMENT IS THE WHOLE SUBMISSION — surfaces it as an error", and the submission
  // here is a value AND a day AND a minute. Refusing all three over a stray clock is
  // losing the serving to save the cosmetic half, which is the very trade the rule's
  // first branch exists to prevent. The bad DAY above still refuses outright: that
  // file's next paragraph calls an instant outside its own row's day corruption, and a
  // wrong day is a different question from a wrong minute.
  const stated = statedOccurredAt(profileId, date, time);
  const occurredAt = stated.value ?? null;

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
              -- The #133 lock, armed unconditionally (#2364): a human just stated
              -- this reading's value. Conditioning it on external_id asked which
              -- import path produced the row, and a document-extracted temperature
              -- carries none — so the correction was unlockable, and the document's
              -- own reprocess would take it back.
              edited = 1
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
    return {
      kind: "updated",
      degF,
      flag: row?.flag ?? null,
      ...(stated.refused ? { statedTimeRefused: stated.refused } : {}),
    };
  });
}
