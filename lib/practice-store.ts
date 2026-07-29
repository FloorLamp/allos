// The auth-blind wellness-practice store (#1591). A practice's stable definition is
// its `frequency_targets` row with scope_kind='practice'; its event ledger remains
// `practice_logs`. The pure practiceIdentity() binds their user-owned names, while
// renamePracticeSessions() re-keys the ledger when a definition is renamed.

import { db, writeTx } from "./db";
import {
  normalizePracticeName,
  practiceIdentity,
  previousPracticeDuration,
} from "./practice";
import { getPracticeSessions, renamePracticeSessions } from "./practice-log";
import type { FrequencyTarget, PracticeLog } from "./types";
import {
  getFrequencyTargetProgress,
  getFrequencyTargets,
} from "./queries/frequency-targets";

export interface WellnessPractice {
  identity: string;
  name: string;
  targetId: number | null;
  perWeek: number | null;
  perWeekMax: number | null;
  countThisWeek: number;
  met: boolean;
  atCeiling: boolean;
  sessionCount: number;
  lastUsed: string | null;
  previousDurationMin: number | null;
}

export type SavePracticeOutcome =
  | { kind: "saved"; targetId: number }
  | { kind: "invalid" }
  | { kind: "not-found" }
  | { kind: "duplicate" };
export type UntrackPracticeOutcome =
  { kind: "untracked"; targetId: number } | { kind: "not-found" };

function parseCadence(
  floorRaw: number,
  ceilingRaw: number | null
): { floor: number; ceiling: number | null } | null {
  if (!Number.isFinite(floorRaw) || floorRaw < 1) return null;
  const floor = Math.min(14, Math.floor(floorRaw));
  const ceiling =
    ceilingRaw != null &&
    Number.isFinite(ceilingRaw) &&
    Math.floor(ceilingRaw) > floor
      ? Math.min(14, Math.floor(ceilingRaw))
      : null;
  return { floor, ceiling };
}

export function getPracticeTargets(profileId: number): FrequencyTarget[] {
  return getFrequencyTargets(profileId)
    .filter((target) => target.scope_kind === "practice")
    .sort(
      (a, b) =>
        a.scope_value.localeCompare(b.scope_value, undefined, {
          sensitivity: "base",
        }) || a.id - b.id
    )
    .map((target) => ({ ...target }));
}

export function findPracticeTarget(
  profileId: number,
  name: string
): FrequencyTarget | null {
  const identity = practiceIdentity(name);
  if (!identity) return null;
  return (
    getPracticeTargets(profileId).find(
      (target) => practiceIdentity(target.scope_value) === identity
    ) ?? null
  );
}

export function getWellnessPractices(profileId: number): WellnessPractice[] {
  const targets = getPracticeTargets(profileId);
  const progress = new Map(
    getFrequencyTargetProgress(profileId)
      .filter((item) => item.target.scope_kind === "practice")
      .map((item) => [item.target.id, item])
  );
  const logs = db
    .prepare(
      `SELECT id, practice, date, time, duration_min, notes,
              source, external_id, edited, created_at
         FROM practice_logs
        WHERE profile_id = ?
        ORDER BY date DESC, COALESCE(time, '99:99') DESC, id DESC`
    )
    .all(profileId) as PracticeLog[];

  const byIdentity = new Map<
    string,
    { target: FrequencyTarget | null; sessions: PracticeLog[] }
  >();
  for (const target of targets) {
    const identity = practiceIdentity(target.scope_value);
    if (!identity) continue;
    const current = byIdentity.get(identity);
    if (!current) byIdentity.set(identity, { target, sessions: [] });
  }
  for (const session of logs) {
    const identity = practiceIdentity(session.practice);
    if (!identity) continue;
    const current = byIdentity.get(identity);
    if (current) current.sessions.push(session);
    else byIdentity.set(identity, { target: null, sessions: [session] });
  }

  return [...byIdentity.entries()]
    .map(([identity, item]): WellnessPractice => {
      const p = item.target ? progress.get(item.target.id) : null;
      const latest = item.sessions[0] ?? null;
      return {
        identity,
        name: item.target?.scope_value ?? latest?.practice ?? identity,
        targetId: item.target?.id ?? null,
        perWeek: item.target?.per_week ?? null,
        perWeekMax: item.target?.per_week_max ?? null,
        countThisWeek: p?.count ?? 0,
        met: p?.met ?? false,
        atCeiling: p?.atCeiling ?? false,
        sessionCount: item.sessions.length,
        lastUsed: latest?.date ?? null,
        previousDurationMin: previousPracticeDuration(item.sessions),
      };
    })
    .sort((a, b) =>
      a.name.localeCompare(b.name, undefined, { sensitivity: "base" })
    );
}

export function createWellnessPractice(
  profileId: number,
  nameRaw: string,
  floorRaw: number,
  ceilingRaw: number | null
): SavePracticeOutcome {
  const name = normalizePracticeName(nameRaw);
  const cadence = parseCadence(floorRaw, ceilingRaw);
  if (!name || !cadence) return { kind: "invalid" };
  if (findPracticeTarget(profileId, name)) return { kind: "duplicate" };

  return writeTx(() => {
    const info = db
      .prepare(
        `INSERT INTO frequency_targets
           (profile_id, scope_kind, scope_value, per_week, per_week_max)
         VALUES (?, 'practice', ?, ?, ?)`
      )
      .run(profileId, name, cadence.floor, cadence.ceiling);
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
  const cadence = parseCadence(floorRaw, ceilingRaw);
  if (!name || !cadence) return { kind: "invalid" };
  const current = db
    .prepare(
      `SELECT id, scope_value FROM frequency_targets
        WHERE id = ? AND profile_id = ? AND scope_kind = 'practice'`
    )
    .get(targetId, profileId) as
    { id: number; scope_value: string } | undefined;
  if (!current) return { kind: "not-found" };

  const destination = findPracticeTarget(profileId, name);
  if (
    destination &&
    destination.id !== targetId &&
    practiceIdentity(destination.scope_value) !==
      practiceIdentity(current.scope_value)
  ) {
    return { kind: "duplicate" };
  }

  return writeTx(() => {
    // Update every legacy duplicate target in the old identity family. Protocols keep
    // their stable target ids, while all surfaces now display one canonical name.
    const matchingIds = getPracticeTargets(profileId)
      .filter(
        (target) =>
          practiceIdentity(target.scope_value) ===
          practiceIdentity(current.scope_value)
      )
      .map((target) => target.id);
    for (const id of matchingIds) {
      db.prepare(
        `UPDATE frequency_targets
            SET scope_value = ?, per_week = ?, per_week_max = ?
          WHERE id = ? AND profile_id = ? AND scope_kind = 'practice'`
      ).run(name, cadence.floor, cadence.ceiling, id, profileId);
    }
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
  const target = db
    .prepare(
      `SELECT id FROM frequency_targets
        WHERE id = ? AND profile_id = ? AND scope_kind = 'practice'`
    )
    .get(targetId, profileId) as { id: number } | undefined;
  if (!target) return { kind: "not-found" };

  return writeTx(() => {
    db.prepare(
      `UPDATE protocols
          SET frequency_target_id = NULL, owns_frequency_target = 0
        WHERE profile_id = ? AND frequency_target_id = ?`
    ).run(profileId, targetId);
    db.prepare(
      `DELETE FROM frequency_targets
        WHERE id = ? AND profile_id = ? AND scope_kind = 'practice'`
    ).run(targetId, profileId);
    return { kind: "untracked", targetId };
  });
}

export function getAllPracticeSessions(
  profileId: number,
  name: string,
  limit = 200
): PracticeLog[] {
  return getPracticeSessions(profileId, name, limit);
}
