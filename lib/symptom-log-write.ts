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
//
// CASE FOLDS FOR MATCHING, NEVER FOR STORAGE (#3325). `logSymptomCore` — the only core
// here that MINTS a key — resolves through `resolveProfileVocabularyKey()`, so a typed
// "kratom" lands on this profile's existing "Kratom" rows. Every other core takes a key
// a surface just rendered and resolves BARE; the reasoning for that split, and for
// leaving rows that already differ only by case alone, is in lib/vocabulary-store.ts.

import { db, today, writeTx } from "./db";
import { SYMPTOM_DAY_WRITE, isPastWriteAccepted } from "./log-manifest";
import type { LoggedVia } from "./logged-via";
import {
  resolveSymptomKey,
  isValidSeverity,
  isCustomSymptomKey,
  normalizeSymptomName,
} from "./symptoms";
import {
  openEpisodeIdForDate,
  openEpisodeContainsDateForProfile,
  episodeExistsForProfile,
} from "./illness-episode-store";
import { captureDelete } from "./undo-delete-db";
import { resolveProfileVocabularyKey } from "./vocabulary-store";

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
  symptom: string,
  episodeId?: number
): number | null {
  const row = db
    .prepare(
      `SELECT severity FROM symptom_logs
        WHERE profile_id = ? AND date = ? AND symptom = ?
          ${episodeId == null ? "" : "AND episode_id = ?"}`
    )
    .get(
      profileId,
      date,
      symptom,
      ...(episodeId == null ? [] : [episodeId])
    ) as { severity: number } | undefined;
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
  // Which surface logged this symptom (#3087) — required, no default, ahead of the
  // optional tail. It rides the INSERT arm of the upsert and is deliberately ABSENT
  // from both DO UPDATE SET clauses below: a re-tap that raises the day's severity is
  // a mutation of a row that already exists, and the row keeps the provenance it was
  // created with.
  loggedVia: LoggedVia,
  note?: string | null,
  explicitEpisodeId?: number
): SymptomLogOutcome {
  // #3325 — the one place a custom symptom key is MINTED, so the one place the
  // case-fold belongs. Resolving against the profile's own spellings makes a typed
  // "kratom" join the existing "Kratom" rows instead of opening a second ledger beside
  // them; the stored spelling is whatever was seen FIRST, so nothing is ever re-titled
  // and "MDMA" never becomes "Mdma". The outcome carries the key that was actually
  // written, so a caller names what landed rather than what was typed.
  //
  // The other cores in this file resolve BARE on purpose: their key comes from a row the
  // app just rendered, and folding it could redirect an edit or a delete onto a
  // case-variant neighbour that predates this fix. See lib/vocabulary-store.ts.
  const symptom = resolveProfileVocabularyKey(
    "symptom",
    profileId,
    symptomInput
  );
  // THE SHARED DATE INVARIANT (#4425): any real past day, never the future. This core
  // and `setSymptomSeverityCore` below are the two here that can MINT a row, and until
  // this line neither asked anything at all — the action's shape check let
  // `2026-13-45` through as a literal string, and `2026-02-30` is worse, because
  // `Date.parse` rolls it silently to March 2 and it never reads as garbage
  // downstream. The PAST is deliberately open (owner ruling 2026-08-31): the symptom
  // bar is mounted on `/history`'s day view against the day being read, so its taps
  // are dated writes. Every other core in this file only updates or deletes a row the
  // app just rendered, so an unreal day finds nothing and answers `invalid` on its own.
  if (
    !symptom ||
    !isPastWriteAccepted(today(profileId), date) ||
    !isValidSeverity(severity)
  )
    return { kind: "invalid" };
  const noteVal = normalizeNote(note);
  return writeTx(() => {
    // #1093: a symptom logged while an illness episode is OPEN default-associates to it.
    // The default path sets only on INSERT, preserving prior detach/hand-set links on a
    // re-tap. A named dashboard cockpit is different: its validated explicit episode is
    // the user's selected write target, so that path also binds an existing day row.
    if (
      explicitEpisodeId != null &&
      !openEpisodeContainsDateForProfile(profileId, explicitEpisodeId, date)
    )
      return { kind: "invalid" as const };
    const episodeId =
      explicitEpisodeId ?? openEpisodeIdForDate(profileId, date);
    if (explicitEpisodeId == null) {
      db.prepare(
        `INSERT INTO symptom_logs
           (profile_id, date, symptom, severity, note, episode_id, logged_via)
         VALUES (?, ?, ?, ?, ?, ?, ?)
         ON CONFLICT (profile_id, date, symptom)
         DO UPDATE SET severity = MAX(symptom_logs.severity, excluded.severity),
                       note = COALESCE(excluded.note, symptom_logs.note)`
      ).run(profileId, date, symptom, severity, noteVal, episodeId, loggedVia);
    } else {
      db.prepare(
        `INSERT INTO symptom_logs
           (profile_id, date, symptom, severity, note, episode_id, logged_via)
         VALUES (?, ?, ?, ?, ?, ?, ?)
         ON CONFLICT (profile_id, date, symptom)
         DO UPDATE SET severity = MAX(symptom_logs.severity, excluded.severity),
                       note = COALESCE(excluded.note, symptom_logs.note),
                       episode_id = excluded.episode_id`
      ).run(profileId, date, symptom, severity, noteVal, episodeId, loggedVia);
    }
    return {
      kind: "logged" as const,
      symptom,
      severity: severityOf(profileId, date, symptom) ?? severity,
    };
  });
}
// #4614: each core declares its own domain; `LOG_MANIFEST`'s cores column derives.
export const logSymptomCoreDeclares = SYMPTOM_DAY_WRITE;

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
  // The surface stating this severity (#3087). This core CAN create a day row (the
  // bar's severity picker on a symptom not yet logged today), so it needs an origin
  // for the INSERT arm; the DO UPDATE SET leaves an existing row's provenance alone.
  loggedVia: LoggedVia,
  note?: string | null
): SymptomLogOutcome {
  const symptom = resolveSymptomKey(symptomInput);
  // Mints a row too — the same invariant, see the note in `logSymptomCore`.
  if (
    !symptom ||
    !isPastWriteAccepted(today(profileId), date) ||
    !isValidSeverity(severity)
  )
    return { kind: "invalid" };
  const noteVal = normalizeNote(note);
  return writeTx(() => {
    db.prepare(
      `INSERT INTO symptom_logs
         (profile_id, date, symptom, severity, note, logged_via)
       VALUES (?, ?, ?, ?, ?, ?)
       ON CONFLICT (profile_id, date, symptom)
       DO UPDATE SET severity = excluded.severity, note = excluded.note`
    ).run(profileId, date, symptom, severity, noteVal, loggedVia);
    return { kind: "logged" as const, symptom, severity };
  });
}
export const setSymptomSeverityCoreDeclares = SYMPTOM_DAY_WRITE;

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
  date: string,
  explicitEpisodeId?: number
): SymptomLogOutcome {
  const symptom = resolveSymptomKey(symptomInput);
  if (!symptom || !isValidSeverity(severity)) return { kind: "invalid" };
  return writeTx(() => {
    if (
      explicitEpisodeId != null &&
      !openEpisodeContainsDateForProfile(profileId, explicitEpisodeId, date)
    )
      return { kind: "invalid" as const };
    const current = severityOf(profileId, date, symptom, explicitEpisodeId);
    // Only an existing row can be lowered, and only to a strictly lower value.
    if (current == null || severity >= current) return { kind: "invalid" };
    db.prepare(
      `UPDATE symptom_logs SET severity = ?
        WHERE profile_id = ? AND date = ? AND symptom = ?
          ${explicitEpisodeId == null ? "" : "AND episode_id = ?"}`
    ).run(
      severity,
      profileId,
      date,
      symptom,
      ...(explicitEpisodeId == null ? [] : [explicitEpisodeId])
    );
    return { kind: "logged" as const, symptom, severity };
  });
}
export const lowerSymptomSeverityCoreDeclares = SYMPTOM_DAY_WRITE;

// Set (or clear) a logged symptom-day's NOTE without touching its severity (#857 per-
// symptom note affordance). A blank note clears the row's note; a non-blank one replaces
// it. Refuses when there's no logged row to annotate (the note rides an existing
// symptom-day, never creates one). Single IMMEDIATE transaction (#468).
export function setSymptomNoteCore(
  profileId: number,
  symptomInput: string,
  date: string,
  note: string | null | undefined,
  explicitEpisodeId?: number
): SymptomLogOutcome {
  const symptom = resolveSymptomKey(symptomInput);
  if (!symptom) return { kind: "invalid" };
  const noteVal = normalizeNote(note);
  return writeTx(() => {
    if (
      explicitEpisodeId != null &&
      !openEpisodeContainsDateForProfile(profileId, explicitEpisodeId, date)
    )
      return { kind: "invalid" as const };
    const info = db
      .prepare(
        `UPDATE symptom_logs SET note = ?
          WHERE profile_id = ? AND date = ? AND symptom = ?
            ${explicitEpisodeId == null ? "" : "AND episode_id = ?"}`
      )
      .run(
        noteVal,
        profileId,
        date,
        symptom,
        ...(explicitEpisodeId == null ? [] : [explicitEpisodeId])
      );
    if (info.changes === 0) return { kind: "invalid" };
    return {
      kind: "logged" as const,
      symptom,
      severity: severityOf(profileId, date, symptom, explicitEpisodeId) ?? 0,
    };
  });
}

// Remove a symptom-day row. Idempotent — removing a symptom with nothing logged is a
// no-op. Returns whether a row existed, and the UNDO TOKEN when one was captured (#2124).
// `undoId` is null exactly when nothing was deleted, so a caller renders the plain
// confirmation rather than an Undo that would restore nothing.
export type SymptomRemoveOutcome =
  | {
      kind: "removed";
      symptom: string;
      existed: boolean;
      undoId: number | null;
    }
  | { kind: "invalid" };

export function removeSymptomCore(
  profileId: number,
  symptomInput: string,
  date: string,
  explicitEpisodeId?: number
): SymptomRemoveOutcome {
  const symptom = resolveSymptomKey(symptomInput);
  if (!symptom) return { kind: "invalid" };
  if (
    explicitEpisodeId != null &&
    !openEpisodeContainsDateForProfile(profileId, explicitEpisodeId, date)
  )
    return { kind: "invalid" };
  const row = db
    .prepare(
      `SELECT id FROM symptom_logs
        WHERE profile_id = ? AND date = ? AND symptom = ?
          ${explicitEpisodeId == null ? "" : "AND episode_id = ?"}`
    )
    .get(
      profileId,
      date,
      symptom,
      ...(explicitEpisodeId == null ? [] : [explicitEpisodeId])
    ) as { id: number } | undefined;
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
//
// BOTH ENDS RESOLVE BARE, and #3325 kept it that way deliberately. Renaming is the one
// operation whose PURPOSE can be to change case: folding the target would turn
// "kratom" -> "Kratom" into a silent no-op, and folding the source would aim a rename at
// the wrong card where a profile already carries both spellings. It is also the
// user-facing MERGE for such a pair — the per-day collision rule right below is exactly
// the merge semantics, applied because a person asked for it rather than by a migration
// that could not ask.
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
