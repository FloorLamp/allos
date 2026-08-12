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
import {
  openEpisodeIdForDate,
  episodeExistsForProfile,
} from "./illness-episode-store";
import { captureDelete } from "./undo-delete-db";

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
    // #1093: a symptom logged while an illness episode is OPEN default-associates to it,
    // so the episode gathers its own evidence. Set only on INSERT — the ON CONFLICT path
    // leaves an existing row's episode_id untouched, so a prior detach (episode_id NULL)
    // survives a re-tap and this never clobbers a hand-set link.
    const episodeId = openEpisodeIdForDate(profileId, date);
    db.prepare(
      `INSERT INTO symptom_logs (profile_id, date, symptom, severity, note, episode_id)
       VALUES (?, ?, ?, ?, ?, ?)
       ON CONFLICT (profile_id, date, symptom)
       DO UPDATE SET severity = MAX(symptom_logs.severity, excluded.severity),
                     note = COALESCE(excluded.note, symptom_logs.note)`
    ).run(profileId, date, symptom, severity, noteVal, episodeId);
    return {
      kind: "logged" as const,
      symptom,
      severity: severityOf(profileId, date, symptom) ?? severity,
    };
  });
}

// Typed result of an attach/detach — the symptom-day link to an episode (#1093).
export type SymptomEpisodeOutcome =
  | { kind: "ok"; episodeId: number | null }
  | { kind: "no-row" } // no logged symptom-day to (de)associate
  | { kind: "bad-episode" } // the target episode isn't this profile's
  | { kind: "invalid" };

// Attach a logged symptom-day to an episode, or detach it (episodeId null). The explicit
// "easy detach" the #1093 default-association implies: a caregiver who logged a symptom
// during an episode it doesn't belong to can unlink it. Refuses to touch a symptom-day
// that isn't logged, and refuses an episode id that isn't this profile's (belt-and-
// suspenders to the action's write-access gate). Single IMMEDIATE transaction (#468).
export function setSymptomEpisodeCore(
  profileId: number,
  symptomInput: string,
  date: string,
  episodeId: number | null
): SymptomEpisodeOutcome {
  const symptom = resolveSymptomKey(symptomInput);
  if (!symptom) return { kind: "invalid" };
  if (episodeId != null && !episodeExistsForProfile(profileId, episodeId))
    return { kind: "bad-episode" };
  return writeTx(() => {
    const info = db
      .prepare(
        `UPDATE symptom_logs SET episode_id = ?
          WHERE profile_id = ? AND date = ? AND symptom = ?`
      )
      .run(episodeId, profileId, date, symptom);
    if (info.changes === 0) return { kind: "no-row" };
    return { kind: "ok" as const, episodeId };
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

// Explicit LOWER (#857): drop an existing symptom-day's severity to a strictly lower
// value, PRESERVING its note (unlike setSymptomSeverityCore, which rewrites the note).
// This is the write behind the bar's inline "Lower to mild?" confirm — it exists as a
// narrow, direction-checked action so a plain tap can never lower and this affordance can
// never raise. Refuses when there's no row yet or the target isn't below the current
// worst (the tap path owns raises). Single IMMEDIATE transaction (#468).
export function lowerSymptomSeverityCore(
  profileId: number,
  symptomInput: string,
  severity: number,
  date: string
): SymptomLogOutcome {
  const symptom = resolveSymptomKey(symptomInput);
  if (!symptom || !isValidSeverity(severity)) return { kind: "invalid" };
  return writeTx(() => {
    const current = severityOf(profileId, date, symptom);
    // Only an existing row can be lowered, and only to a strictly lower value.
    if (current == null || severity >= current) return { kind: "invalid" };
    db.prepare(
      `UPDATE symptom_logs SET severity = ?
        WHERE profile_id = ? AND date = ? AND symptom = ?`
    ).run(severity, profileId, date, symptom);
    return { kind: "logged" as const, symptom, severity };
  });
}

// Set (or clear) a logged symptom-day's NOTE without touching its severity (#857 per-
// symptom note affordance). A blank note clears the row's note; a non-blank one replaces
// it. Refuses when there's no logged row to annotate (the note rides an existing
// symptom-day, never creates one). Single IMMEDIATE transaction (#468).
export function setSymptomNoteCore(
  profileId: number,
  symptomInput: string,
  date: string,
  note: string | null | undefined
): SymptomLogOutcome {
  const symptom = resolveSymptomKey(symptomInput);
  if (!symptom) return { kind: "invalid" };
  const noteVal = normalizeNote(note);
  return writeTx(() => {
    const info = db
      .prepare(
        `UPDATE symptom_logs SET note = ?
          WHERE profile_id = ? AND date = ? AND symptom = ?`
      )
      .run(noteVal, profileId, date, symptom);
    if (info.changes === 0) return { kind: "invalid" };
    return {
      kind: "logged" as const,
      symptom,
      severity: severityOf(profileId, date, symptom) ?? 0,
    };
  });
}

// Remove a symptom-day row. Idempotent — removing a symptom with nothing logged is a
// no-op. Returns whether a row existed, and the UNDO TOKEN when one was captured (#2124).
// `undoId` is null exactly when nothing was deleted, so a caller renders the plain
// confirmation rather than an Undo that would restore nothing.
export type SymptomRemoveOutcome =
  | { kind: "removed"; symptom: string; existed: boolean; undoId: number | null }
  | { kind: "invalid" };

export function removeSymptomCore(
  profileId: number,
  symptomInput: string,
  date: string
): SymptomRemoveOutcome {
  const symptom = resolveSymptomKey(symptomInput);
  if (!symptom) return { kind: "invalid" };
  const row = db
    .prepare(
      `SELECT id FROM symptom_logs
        WHERE profile_id = ? AND date = ? AND symptom = ?`
    )
    .get(profileId, date, symptom) as { id: number } | undefined;
  if (!row) return { kind: "removed", symptom, existed: false, undoId: null };
  // #2124: the one-tap × CAPTURES now. The `symptom-day` kind owns what this used to do
  // by hand — it takes the row's photos with it (deleteExplicitly children, because
  // symptom_photos.symptom_log_id carries no ON DELETE and foreign_keys=ON would reject
  // dropping a log a photo still references) and restores them re-pointed at the row's
  // new id, inside the same transaction as the capture.
  //
  // WHAT CHANGED ABOUT THE FILES: `deletePhotosForSymptomLog` used to unlink every bound
  // photo and its thumbnail right here, which is what made a mis-tap unrecoverable
  // off-DB. The files are content-named, so they now survive the trash window untouched
  // (a restored row re-points at the same bytes) and the undo PURGE reclaims them — the
  // skin-lesion / activity-clip posture, and the first thing to make the long-declared
  // `symptom_photos` entry in PHOTO_FILE_TABLES reachable.
  const undoId = captureDelete("symptom-day", profileId, row.id);
  return { kind: "removed", symptom, existed: undoId != null, undoId };
}

// Typed result of a custom-symptom management op (#203 hygiene). `undoIds` is the #202
// token batch a DELETE captured (one per removed day); a rename captures nothing and
// carries none.
export type CustomSymptomOutcome =
  | { kind: "ok"; undoIds?: number[] }
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
    // #1093 row-side-state: the colliding old rows are about to be DROPPED — re-parent
    // their photos onto the surviving same-date new-key row first (foreign_keys=ON would
    // reject dropping a log a photo still references, and #203 says re-parent, never
    // cascade-drop). The non-colliding old rows keep their id through the re-key below, so
    // their photos survive untouched.
    db.prepare(
      `UPDATE symptom_photos
          SET symptom_log_id = (
                SELECT n.id FROM symptom_logs n
                 WHERE n.profile_id = ? AND n.symptom = ?
                   AND n.date = (SELECT o.date FROM symptom_logs o
                                  WHERE o.id = symptom_photos.symptom_log_id)
              )
        WHERE profile_id = ?
          AND symptom_log_id IN (
                SELECT o.id FROM symptom_logs o
                 WHERE o.profile_id = ? AND o.symptom = ?
                   AND o.date IN (SELECT date FROM symptom_logs
                                   WHERE profile_id = ? AND symptom = ?)
              )`
    ).run(profileId, newKey, profileId, profileId, oldKey, profileId, newKey);
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
    // #203 name-keyed hygiene: re-key the photos' denormalized `symptom` label too, so a
    // renamed custom symptom's photos don't keep pointing display copy at the dead name.
    db.prepare(
      `UPDATE symptom_photos SET symptom = ?
        WHERE profile_id = ? AND symptom = ?`
    ).run(newKey, profileId, oldKey);
    return { kind: "ok" as const };
  });
}

// Delete a CUSTOM symptom entirely — removes every log row under its key (#203: cleaned,
// not left as orphaned name-keyed state). Refuses a curated slug.
//
// Every day is captured (#2124), so the outcome carries a BATCH of tokens — the #202
// shape `useUndoableDelete` already normalizes — and one Undo brings the whole custom
// symptom's history back, photos and files included. Each day is its own capture rather
// than one payload, because that is what makes the batch restorable a row at a time by
// the same executor every other kind uses.
export function deleteCustomSymptomCore(
  profileId: number,
  name: string
): CustomSymptomOutcome {
  const key = resolveSymptomKey(name);
  if (!key) return { kind: "invalid" };
  if (!isCustomSymptomKey(key)) return { kind: "not-custom" };
  const rows = db
    .prepare(`SELECT id FROM symptom_logs WHERE profile_id = ? AND symptom = ?`)
    .all(profileId, key) as { id: number }[];
  const undoIds: number[] = [];
  for (const r of rows) {
    // Per-day capture: each one takes that day's photo ROWS (leaving the files for the
    // purge) and deletes the log row, in its own transaction. A row that vanished
    // between the select and the capture returns null and is simply skipped.
    const token = captureDelete("symptom-day", profileId, r.id);
    if (token != null) undoIds.push(token);
  }
  return { kind: "ok", undoIds };
}

// Re-export so an action can normalize a custom label the same way the store does.
export { normalizeSymptomName };
