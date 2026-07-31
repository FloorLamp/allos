// The auth-blind wellness-practice store (#1591). A practice's stable definition is
// its `frequency_targets` row with scope_kind='practice'; its event ledger remains
// `practice_logs`. The pure practiceIdentity() binds their user-owned names, while
// renamePracticeSessions() re-keys the ledger when a definition is renamed.

import { db, writeTx } from "./db";
import {
  normalizePracticeName,
  practiceIdentity,
  practiceSignalKey,
  validatePracticeCadence,
  type PracticeCadenceError,
} from "./practice";
import { renamePracticeSessions } from "./practice-log";
import type { Row } from "./undo-delete";
import { captureDelete } from "./undo-delete-db";
import {
  findPracticeTarget,
  getPracticeSpellings,
  getWellnessPractices,
} from "./queries/wellness";

export type SavePracticeOutcome =
  | { kind: "saved"; targetId: number }
  | {
      kind: "invalid";
      reason: "name" | PracticeCadenceError;
    }
  | { kind: "not-found" }
  | { kind: "duplicate" };
export type UntrackPracticeOutcome =
  { kind: "untracked"; targetId: number } | { kind: "not-found" };
export type DeletePracticeOutcome =
  { kind: "deleted"; undoId: number } | { kind: "not-found" };

export function createWellnessPractice(
  profileId: number,
  nameRaw: string,
  floorRaw: number,
  ceilingRaw: number | null
): SavePracticeOutcome {
  const name = normalizePracticeName(nameRaw);
  if (!name) return { kind: "invalid", reason: "name" };
  const cadence = validatePracticeCadence(floorRaw, ceilingRaw);
  if (!cadence.ok) return { kind: "invalid", reason: cadence.reason };

  return writeTx(() => {
    // The duplicate read belongs under the same reserved write lock as the
    // insert. The partial unique index is the final backstop; this read preserves
    // the typed duplicate outcome instead of surfacing SQLITE_CONSTRAINT.
    if (findPracticeTarget(profileId, name)) return { kind: "duplicate" };
    const info = db
      .prepare(
        `INSERT INTO frequency_targets
           (profile_id, scope_kind, scope_value, scope_identity, per_week, per_week_max)
         VALUES (?, 'practice', ?, ?, ?, ?)`
      )
      .run(
        profileId,
        name,
        practiceIdentity(name),
        cadence.floor,
        cadence.ceiling
      );
    // A session-only practice becomes a defined practice without splitting its
    // existing case/whitespace variants into a second history.
    renamePracticeSessions(profileId, name, name);
    return { kind: "saved", targetId: Number(info.lastInsertRowid) };
  });
}

export function updateWellnessPractice(
  profileId: number,
  targetId: number,
  nameRaw: string,
  floorRaw: number,
  ceilingRaw: number | null
): SavePracticeOutcome {
  const name = normalizePracticeName(nameRaw);
  if (!name) return { kind: "invalid", reason: "name" };
  const cadence = validatePracticeCadence(floorRaw, ceilingRaw);
  if (!cadence.ok) return { kind: "invalid", reason: cadence.reason };

  return writeTx(() => {
    // Both reads belong inside the reserved write transaction: another process
    // cannot rename/create a destination target between collision discovery and
    // this update.
    const current = db
      .prepare(
        `SELECT id, scope_value FROM frequency_targets
          WHERE id = ? AND profile_id = ? AND scope_kind = 'practice'`
      )
      .get(targetId, profileId) as
      { id: number; scope_value: string } | undefined;
    if (!current) return { kind: "not-found" };

    const currentIdentity = practiceIdentity(current.scope_value);
    const destinationIdentity = practiceIdentity(name);
    if (
      destinationIdentity !== currentIdentity &&
      getWellnessPractices(profileId).some(
        (practice) => practice.identity === destinationIdentity
      )
    ) {
      return { kind: "duplicate" };
    }

    db.prepare(
      `UPDATE frequency_targets
          SET scope_value = ?, scope_identity = ?, per_week = ?, per_week_max = ?
        WHERE id = ? AND profile_id = ? AND scope_kind = 'practice'`
    ).run(
      name,
      practiceIdentity(name),
      cadence.floor,
      cadence.ceiling,
      targetId,
      profileId
    );
    renamePracticeSessions(profileId, current.scope_value, name);
    return { kind: "saved", targetId };
  });
}

// Stop a weekly practice target without erasing its session ledger. Protocol links
// are nullable by design; unlink them first so the target can be removed under the
// FK, while the historical sessions remain visible as a session-only practice that
// can receive a new target later.
export function untrackWellnessPractice(
  profileId: number,
  targetId: number
): UntrackPracticeOutcome {
  return writeTx(() => {
    const target = db
      .prepare(
        `SELECT id FROM frequency_targets
          WHERE id = ? AND profile_id = ? AND scope_kind = 'practice'`
      )
      .get(targetId, profileId) as { id: number } | undefined;
    if (!target) return { kind: "not-found" };

    db.prepare(
      `UPDATE protocols
          SET frequency_target_id = NULL, owns_frequency_target = 0
        WHERE profile_id = ? AND frequency_target_id = ?`
    ).run(profileId, targetId);
    db.prepare(
      `DELETE FROM frequency_targets
        WHERE id = ? AND profile_id = ? AND scope_kind = 'practice'`
    ).run(targetId, profileId);
    db.prepare(
      `DELETE FROM upcoming_dismissals
        WHERE profile_id = ? AND signal_key = ?`
    ).run(profileId, practiceSignalKey(targetId));
    return { kind: "untracked", targetId };
  });
}

function capturedPracticeSessions(profileId: number, practice: string): Row[] {
  const spellings = getPracticeSpellings(profileId, practice);
  if (spellings.length === 0) return [];
  return db
    .prepare(
      `SELECT * FROM practice_logs
        WHERE profile_id = ?
          AND practice IN (${spellings.map(() => "?").join(", ")})
        ORDER BY id`
    )
    .all(profileId, ...spellings) as Row[];
}

// Permanently remove a practice definition AND its whole session family under one
// undo token. A tracked practice roots the capture on frequency_targets so undo
// restores the target and remaps its `practice:<id>` suppression row; a logs-only
// practice roots on one session and restores only its historical card (never
// inventing a target that did not exist).
export function deleteWellnessPractice(
  profileId: number,
  targetId: number | null,
  practice: string
): DeletePracticeOutcome {
  return writeTx((): DeletePracticeOutcome => {
    // A forged/stale logs-only request must not delete sessions while leaving an
    // existing weekly target behind. Resolve the target under the same reserved
    // write transaction as family capture so another process cannot add one
    // between discovery and deletion.
    const resolvedTargetId =
      targetId ?? findPracticeTarget(profileId, practice)?.id ?? null;
    if (resolvedTargetId != null) {
      const target = db
        .prepare(
          `SELECT id, scope_value FROM frequency_targets
          WHERE id = ? AND profile_id = ? AND scope_kind = 'practice'`
        )
        .get(resolvedTargetId, profileId) as
        { id: number; scope_value: string } | undefined;
      if (!target) return { kind: "not-found" };
      const sessions = capturedPracticeSessions(profileId, target.scope_value);
      const dismissals = db
        .prepare(
          `SELECT * FROM upcoming_dismissals
          WHERE profile_id = ? AND signal_key = ?`
        )
        .all(profileId, practiceSignalKey(target.id)) as Row[];
      const undoId = captureDelete(
        "wellness-practice",
        profileId,
        target.id,
        undefined,
        { sessions, dismissals }
      );
      return undoId == null
        ? { kind: "not-found" }
        : { kind: "deleted", undoId };
    }

    const sessions = capturedPracticeSessions(profileId, practice);
    const root = sessions[0];
    if (!root || typeof root.id !== "number") return { kind: "not-found" };
    const undoId = captureDelete(
      "wellness-practice-history",
      profileId,
      root.id,
      undefined,
      { sessions: sessions.slice(1) }
    );
    return undoId == null ? { kind: "not-found" } : { kind: "deleted", undoId };
  });
}
