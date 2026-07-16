// Auth-blind write cores for the symptom log (issue #799). Takes profileId first and
// never imports lib/auth — the profileId-first + lib-write-core convention. The Server
// Actions own the auth gate + validation + revalidation; this module owns the SQL and the
// worst-severity / #203 re-key semantics, so a future surface (Telegram, etc.) reuses one
// computation.
//
// A symptom-day is ONE row (UNIQUE(profile_id, date, symptom)). DECIDED (#799): a re-tap
// keeps the day's WORST (highest) severity — `logSymptomCore` can only RAISE. Lowering is
// an explicit edit (`setSymptomSeverityCore`), never a tap. Custom (free-text) symptom
// names carry the #203 name-keyed hygiene: rename re-keys their rows (merging worst
// severity on a per-day collision), delete cleans them; curated slugs are stable and are
// never renamed/deleted through here.

import { db, writeTx } from "./db";
import {
  resolveSymptomKey,
  isValidSeverity,
  isCustomSymptomKey,
  normalizeSymptomName,
} from "./symptoms";

// Typed result so a caller answers from what ACTUALLY happened (the markDoseTaken
// contract, #232) rather than unconditionally confirming.
//   logged  — the row was written; `severity` is the day's resulting (worst, or set) value.
//   invalid — empty symptom or an out-of-range severity; nothing written.
export type SymptomLogOutcome =
  { kind: "logged"; symptom: string; severity: number } | { kind: "invalid" };

function normalizeNote(note: string | null | undefined): string | null {
  const v = (note ?? "").trim();
  return v ? v.slice(0, 500) : null;
}

// Read back the stored severity for a symptom-day (after an upsert).
function severityOf(
  profileId: number,
  date: string,
  symptom: string
): number | null {
  const row = db
    .prepare(
      `SELECT severity FROM symptom_logs
        WHERE profile_id = ? AND date = ? AND symptom = ?`
    )
    .get(profileId, date, symptom) as { severity: number } | undefined;
  return row?.severity ?? null;
}

// Log (tap) a symptom for a day at a severity. Upserts the day's row keeping the WORST
// (highest) severity — a tap can only raise it. A note, when given, fills/updates the
// row's note (a blank note never clears an existing one — that's an explicit edit).
// Single IMMEDIATE transaction (#468).
export function logSymptomCore(
  profileId: number,
  symptomInput: string,
  severity: number,
  date: string,
  note?: string | null
): SymptomLogOutcome {
  const symptom = resolveSymptomKey(symptomInput);
  if (!symptom || !isValidSeverity(severity)) return { kind: "invalid" };
  const noteVal = normalizeNote(note);
  return writeTx(() => {
    db.prepare(
      `INSERT INTO symptom_logs (profile_id, date, symptom, severity, note)
       VALUES (?, ?, ?, ?, ?)
       ON CONFLICT (profile_id, date, symptom)
       DO UPDATE SET severity = MAX(symptom_logs.severity, excluded.severity),
                     note = COALESCE(excluded.note, symptom_logs.note)`
    ).run(profileId, date, symptom, severity, noteVal);
    return {
      kind: "logged" as const,
      symptom,
      severity: severityOf(profileId, date, symptom) ?? severity,
    };
  });
}

// Explicit edit: SET the severity exactly (may LOWER it) and set the note exactly (a
// blank note CLEARS it). Upserts so an edit can also create the row. Single IMMEDIATE
// transaction (#468).
export function setSymptomSeverityCore(
  profileId: number,
  symptomInput: string,
  severity: number,
  date: string,
  note?: string | null
): SymptomLogOutcome {
  const symptom = resolveSymptomKey(symptomInput);
  if (!symptom || !isValidSeverity(severity)) return { kind: "invalid" };
  const noteVal = normalizeNote(note);
  return writeTx(() => {
    db.prepare(
      `INSERT INTO symptom_logs (profile_id, date, symptom, severity, note)
       VALUES (?, ?, ?, ?, ?)
       ON CONFLICT (profile_id, date, symptom)
       DO UPDATE SET severity = excluded.severity, note = excluded.note`
    ).run(profileId, date, symptom, severity, noteVal);
    return { kind: "logged" as const, symptom, severity };
  });
}

// Remove a symptom-day row. Idempotent — removing a symptom with nothing logged is a
// no-op. Returns whether a row existed.
export type SymptomRemoveOutcome =
  { kind: "removed"; symptom: string; existed: boolean } | { kind: "invalid" };

export function removeSymptomCore(
  profileId: number,
  symptomInput: string,
  date: string
): SymptomRemoveOutcome {
  const symptom = resolveSymptomKey(symptomInput);
  if (!symptom) return { kind: "invalid" };
  return writeTx(() => {
    const info = db
      .prepare(
        `DELETE FROM symptom_logs
          WHERE profile_id = ? AND date = ? AND symptom = ?`
      )
      .run(profileId, date, symptom);
    return { kind: "removed" as const, symptom, existed: info.changes > 0 };
  });
}

// Typed result of a custom-symptom management op (#203 hygiene).
export type CustomSymptomOutcome =
  | { kind: "ok" }
  | { kind: "not-custom" } // the target key is a curated slug — not user-managed
  | { kind: "invalid" };

// Rename a CUSTOM symptom across ALL the profile's log rows (#203: name-keyed state is
// re-keyed when its subject is renamed, never left to drift). Refuses to touch a curated
// slug (those are stable). On a per-day collision with an existing row under the new key,
// the surviving row keeps the WORST severity and the duplicate is dropped. Single
// IMMEDIATE transaction (#468).
export function renameCustomSymptomCore(
  profileId: number,
  oldName: string,
  newName: string
): CustomSymptomOutcome {
  const oldKey = resolveSymptomKey(oldName);
  const newKey = resolveSymptomKey(newName);
  if (!oldKey || !newKey) return { kind: "invalid" };
  // Only a custom source is renameable; a curated slug is fixed vocabulary.
  if (!isCustomSymptomKey(oldKey)) return { kind: "not-custom" };
  if (oldKey === newKey) return { kind: "ok" };
  return writeTx(() => {
    // Merge: for days where BOTH keys exist, raise the new row's severity to the worst of
    // the two, then drop the old duplicate; finally re-key the remaining old rows.
    db.prepare(
      `UPDATE symptom_logs
          SET severity = MAX(
                severity,
                (SELECT o.severity FROM symptom_logs o
                  WHERE o.profile_id = symptom_logs.profile_id
                    AND o.date = symptom_logs.date AND o.symptom = ?)
              )
        WHERE profile_id = ? AND symptom = ?
          AND date IN (SELECT date FROM symptom_logs
                        WHERE profile_id = ? AND symptom = ?)`
    ).run(oldKey, profileId, newKey, profileId, oldKey);
    db.prepare(
      `DELETE FROM symptom_logs
        WHERE profile_id = ? AND symptom = ?
          AND date IN (SELECT date FROM symptom_logs
                        WHERE profile_id = ? AND symptom = ?)`
    ).run(profileId, oldKey, profileId, newKey);
    db.prepare(
      `UPDATE symptom_logs SET symptom = ?
        WHERE profile_id = ? AND symptom = ?`
    ).run(newKey, profileId, oldKey);
    return { kind: "ok" as const };
  });
}

// Delete a CUSTOM symptom entirely — removes every log row under its key (#203: cleaned,
// not left as orphaned name-keyed state). Refuses a curated slug.
export function deleteCustomSymptomCore(
  profileId: number,
  name: string
): CustomSymptomOutcome {
  const key = resolveSymptomKey(name);
  if (!key) return { kind: "invalid" };
  if (!isCustomSymptomKey(key)) return { kind: "not-custom" };
  writeTx(() => {
    db.prepare(
      `DELETE FROM symptom_logs WHERE profile_id = ? AND symptom = ?`
    ).run(profileId, key);
  });
  return { kind: "ok" };
}

// Re-export so an action can normalize a custom label the same way the store does.
export { normalizeSymptomName };
