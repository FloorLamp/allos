// Wellness-practice read layer (#1622). It owns the finite-preimage spelling map,
// session readers, and the page-level practice aggregate. Write cores remain in
// lib/practice-log.ts and lib/practice-store.ts.

import { db, today as profileToday } from "../db";
import { buildPracticeHeatmap } from "../practice-heatmap";
import type { ProtocolHeatmap } from "../protocol-heatmap";
import {
  groupPracticeSpellings,
  MAX_PRACTICE_SPELLINGS_PER_IDENTITY,
  practiceDisplayName,
  practiceIdentity,
  practiceSpellingsFor,
  previousPracticeDuration,
  samePractice,
} from "../practice";
import type { FrequencyTarget, PracticeLog } from "../types";
import type { FrequencyPace } from "../goals";
import {
  getFrequencyTargetProgress,
  getFrequencyTargets,
} from "./frequency-targets";

const WELLNESS_CARD_SESSION_LIMIT = 200;

export {
  groupPracticeSpellings,
  MAX_PRACTICE_SPELLINGS_PER_IDENTITY,
  practiceSpellingsFor,
} from "../practice";

export interface WellnessPractice {
  identity: string;
  name: string;
  targetId: number | null;
  perWeek: number | null;
  perWeekMax: number | null;
  countThisWeek: number;
  met: boolean;
  atCeiling: boolean;
  pace: FrequencyPace;
  sessionCount: number;
  lastUsed: string | null;
  previousDurationMin: number | null;
  sessions: PracticeLog[];
  heatmap: ProtocolHeatmap;
}

export function getPracticeSpellingsMap(
  profileId: number
): Map<string, string[]> {
  const rows = db
    .prepare(
      `SELECT value FROM (
         SELECT DISTINCT practice AS value FROM practice_logs
          WHERE profile_id = ?
         UNION
         SELECT DISTINCT scope_value AS value FROM frequency_targets
          WHERE profile_id = ? AND scope_kind = 'practice'
       )
       ORDER BY value COLLATE NOCASE, value`
    )
    .all(profileId, profileId) as { value: string }[];
  return groupPracticeSpellings(rows.map((row) => row.value));
}

// Compatibility reader for callers that need only one family. Page/detail gathers
// should resolve getPracticeSpellingsMap() once and pass practiceSpellingsFor() into
// the per-practice readers below.
export function getPracticeSpellings(
  profileId: number,
  practice: string
): string[] {
  return practiceSpellingsFor(getPracticeSpellingsMap(profileId), practice);
}

function inClause(values: readonly string[]): string {
  return values.map(() => "?").join(", ");
}

function resolvedSpellings(
  profileId: number,
  practice: string,
  spellings?: readonly string[]
): readonly string[] {
  return spellings ?? getPracticeSpellings(profileId, practice);
}

export function getPracticeDayCount(
  profileId: number,
  practice: string,
  date: string,
  spellings?: readonly string[]
): number {
  const values = resolvedSpellings(profileId, practice, spellings);
  if (values.length === 0) return 0;
  const row = db
    .prepare(
      `SELECT COUNT(*) AS n FROM practice_logs
        WHERE profile_id = ? AND practice IN (${inClause(values)}) AND date = ?`
    )
    .get(profileId, ...values, date) as { n: number };
  return row.n;
}

export function getPracticeSessions(
  profileId: number,
  practice: string,
  limit = 50,
  window?: { start: string; end: string },
  spellings?: readonly string[]
): PracticeLog[] {
  const values = resolvedSpellings(profileId, practice, spellings);
  if (values.length === 0) return [];
  const boundedLimit = Math.max(1, Math.min(Math.floor(limit), 500));
  const windowSql = window ? "AND date >= ? AND date <= ?" : "";
  const args: Array<string | number> = [profileId, ...values];
  if (window) args.push(window.start, window.end);
  args.push(boundedLimit);
  return db
    .prepare(
      `SELECT id, practice, date, time, duration_min, notes,
              source, external_id, edited, created_at
         FROM practice_logs
        WHERE profile_id = ? AND practice IN (${inClause(values)})
          ${windowSql}
        ORDER BY date DESC, COALESCE(time, '99:99') DESC, id DESC
        LIMIT ?`
    )
    .all(...args) as PracticeLog[];
}

export function getPracticeUsageInWindow(
  profileId: number,
  practice: string,
  start: string,
  end: string,
  spellings?: readonly string[]
): { sessions: number; lastUsed: string | null } {
  const values = resolvedSpellings(profileId, practice, spellings);
  if (values.length === 0) return { sessions: 0, lastUsed: null };
  return db
    .prepare(
      `SELECT COUNT(*) AS sessions, MAX(date) AS lastUsed
         FROM practice_logs
        WHERE profile_id = ? AND practice IN (${inClause(values)})
          AND date >= ? AND date <= ?`
    )
    .get(profileId, ...values, start, end) as {
    sessions: number;
    lastUsed: string | null;
  };
}

export function getPracticeDayUsageInWindow(
  profileId: number,
  practice: string,
  start: string,
  end: string,
  spellings?: readonly string[]
): { date: string; count: number }[] {
  const values = resolvedSpellings(profileId, practice, spellings);
  if (values.length === 0) return [];
  return db
    .prepare(
      `SELECT date, COUNT(*) AS count
         FROM practice_logs
        WHERE profile_id = ? AND practice IN (${inClause(values)})
          AND date >= ? AND date <= ?
        GROUP BY date
        ORDER BY date ASC`
    )
    .all(profileId, ...values, start, end) as {
    date: string;
    count: number;
  }[];
}

export function getPracticeSession(
  profileId: number,
  id: number
): PracticeLog | null {
  return (
    (db
      .prepare(
        `SELECT id, practice, date, time, duration_min, notes,
                source, external_id, edited, created_at
           FROM practice_logs WHERE id = ? AND profile_id = ?`
      )
      .get(id, profileId) as PracticeLog | undefined) ?? null
  );
}

export function getPracticeTargets(profileId: number): FrequencyTarget[] {
  return getFrequencyTargets(profileId)
    .filter((target) => target.scope_kind === "practice")
    .sort(
      (left, right) =>
        left.scope_value.localeCompare(right.scope_value, undefined, {
          sensitivity: "base",
        }) || left.id - right.id
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

export function getWellnessPractices(
  profileId: number,
  asOf = profileToday(profileId),
  weekStart = 0
): WellnessPractice[] {
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
    if (!byIdentity.has(identity)) {
      byIdentity.set(identity, { target, sessions: [] });
    }
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
      const targetProgress = item.target ? progress.get(item.target.id) : null;
      const latest = item.sessions[0] ?? null;
      const countByDate = new Map<string, number>();
      for (const session of item.sessions) {
        countByDate.set(session.date, (countByDate.get(session.date) ?? 0) + 1);
      }
      return {
        identity,
        name: practiceDisplayName({
          targetSpelling: item.target?.scope_value ?? null,
          latestSpelling: latest?.practice ?? null,
          identity,
        }),
        targetId: item.target?.id ?? null,
        perWeek: item.target?.per_week ?? null,
        perWeekMax: item.target?.per_week_max ?? null,
        countThisWeek: targetProgress?.count ?? 0,
        met: targetProgress?.met ?? false,
        atCeiling: targetProgress?.atCeiling ?? false,
        pace: targetProgress?.pace ?? "on-pace",
        sessionCount: item.sessions.length,
        lastUsed: latest?.date ?? null,
        previousDurationMin: previousPracticeDuration(item.sessions),
        sessions: item.sessions.slice(0, WELLNESS_CARD_SESSION_LIMIT),
        heatmap: buildPracticeHeatmap(
          [...countByDate].map(([date, count]) => ({ date, count })),
          asOf,
          weekStart
        ),
      };
    })
    .sort((left, right) =>
      left.name.localeCompare(right.name, undefined, { sensitivity: "base" })
    );
}

// One TRACKED practice as the quick surfaces need it (#1633): the practices the user
// has declared a weekly cadence for, with this week's standing and today's running
// count. Deliberately narrower than WellnessPractice — no heatmap, no session list —
// because the overlay row and the palette's finite preimage render neither, and this
// gathers on every sheet open / palette open.
export interface TrackedPractice {
  targetId: number;
  identity: string;
  name: string;
  perWeek: number;
  perWeekMax: number | null;
  countThisWeek: number;
  atCeiling: boolean;
  pace: FrequencyPace;
  // Sessions logged TODAY, folded across the identity's spellings — what the shared
  // LogPracticeButton shows beside its tap so a second tap is informed, not accidental.
  todayCount: number;
}

// The quick surfaces' practice list: one row per practice-scope frequency target.
//
// TRACKED, not "every practice with history": a weekly cadence is the user's own
// declaration that this is something they mean to keep doing, which is exactly what a
// one-tap logger should offer. An untracked practice keeps its history and its page card
// (getWellnessPractices still folds it in); it just doesn't claim a row in a surface that
// has to stay scannable — and an untracked practice reappearing here would quietly
// undo the untrack. It is also the finite preimage the palette matches typed input
// against (the #394 posture), so both quick surfaces offer exactly the same set.
//
// Two bounded reads regardless of how many practices exist: the shared weekly progress
// computation (the same getFrequencyTargetProgress every cadence surface reads, so the
// overlay can never disagree with the Wellness card) plus one grouped tally of today's
// logs, folded by practiceIdentity in JS — SQL cannot call that normalizer, and today's
// rows are a bounded set.
export function getTrackedPractices(
  profileId: number,
  asOf = profileToday(profileId)
): TrackedPractice[] {
  const targets = getPracticeTargets(profileId);
  if (targets.length === 0) return [];
  const progress = new Map(
    getFrequencyTargetProgress(profileId)
      .filter((item) => item.target.scope_kind === "practice")
      .map((item) => [item.target.id, item])
  );
  const todayRows = db
    .prepare(
      `SELECT practice, COUNT(*) AS n FROM practice_logs
        WHERE profile_id = ? AND date = ?
        GROUP BY practice`
    )
    .all(profileId, asOf) as { practice: string; n: number }[];
  const todayByIdentity = new Map<string, number>();
  for (const row of todayRows) {
    const identity = practiceIdentity(row.practice);
    if (!identity) continue;
    todayByIdentity.set(identity, (todayByIdentity.get(identity) ?? 0) + row.n);
  }

  const seen = new Set<string>();
  const out: TrackedPractice[] = [];
  for (const target of targets) {
    const identity = practiceIdentity(target.scope_value);
    // The schema already forbids two practice targets on one identity per profile
    // (the unique (profile_id, scope_identity) index), so this is belt-and-braces: if
    // one ever slipped in, the first — getPracticeTargets is already ordered — wins,
    // exactly as it does in getWellnessPractices and getPracticeSearchRows, rather
    // than the sheet offering the same write twice.
    if (!identity || seen.has(identity)) continue;
    seen.add(identity);
    const targetProgress = progress.get(target.id);
    out.push({
      targetId: target.id,
      identity,
      name: practiceDisplayName({
        targetSpelling: target.scope_value,
        identity,
      }),
      perWeek: target.per_week,
      perWeekMax: target.per_week_max,
      countThisWeek: targetProgress?.count ?? 0,
      atCeiling: targetProgress?.atCeiling ?? false,
      pace: targetProgress?.pace ?? "on-pace",
      todayCount: todayByIdentity.get(identity) ?? 0,
    });
  }
  return out.sort((left, right) =>
    left.name.localeCompare(right.name, undefined, { sensitivity: "base" })
  );
}

// One practice as the global search needs it (#1595) — identity, display name, its
// weekly cadence, and its session tally. Deliberately NOT getWellnessPractices():
// that aggregate builds a heatmap and week-pace state per practice, which is right
// for the page but far too much work per keystroke (and the palette renders none of
// it). Same identity folding, same display-name decision, same cadence fields — just
// the fields a hit shows.
export interface PracticeSearchRow {
  identity: string;
  name: string;
  perWeek: number | null;
  perWeekMax: number | null;
  sessionCount: number;
  lastUsed: string | null;
}

// Every practice the profile has (a weekly target, logged sessions, or both), folded
// to one row per identity. Two bounded queries regardless of how many practices exist:
// the practice-scope targets and one grouped tally over practice_logs.
export function getPracticeSearchRows(profileId: number): PracticeSearchRow[] {
  const tallies = db
    .prepare(
      `SELECT practice, COUNT(*) AS sessions, MAX(date) AS last_used
         FROM practice_logs
        WHERE profile_id = ?
        GROUP BY practice
        ORDER BY last_used DESC`
    )
    .all(profileId) as {
    practice: string;
    sessions: number;
    last_used: string | null;
  }[];

  const byIdentity = new Map<
    string,
    {
      targetSpelling: string | null;
      latestSpelling: string | null;
      latestDate: string | null;
      perWeek: number | null;
      perWeekMax: number | null;
      sessionCount: number;
      lastUsed: string | null;
    }
  >();

  const slot = (identity: string) => {
    let row = byIdentity.get(identity);
    if (!row) {
      row = {
        targetSpelling: null,
        latestSpelling: null,
        latestDate: null,
        perWeek: null,
        perWeekMax: null,
        sessionCount: 0,
        lastUsed: null,
      };
      byIdentity.set(identity, row);
    }
    return row;
  };

  for (const target of getPracticeTargets(profileId)) {
    const identity = practiceIdentity(target.scope_value);
    if (!identity) continue;
    const row = slot(identity);
    // getPracticeTargets is already ordered, so the first target for an identity
    // wins the spelling and cadence (matching getWellnessPractices).
    if (row.targetSpelling == null) {
      row.targetSpelling = target.scope_value;
      row.perWeek = target.per_week;
      row.perWeekMax = target.per_week_max;
    }
  }

  for (const tally of tallies) {
    const identity = practiceIdentity(tally.practice);
    if (!identity) continue;
    const row = slot(identity);
    row.sessionCount += tally.sessions;
    if (
      tally.last_used != null &&
      (row.lastUsed == null || tally.last_used > row.lastUsed)
    ) {
      row.lastUsed = tally.last_used;
    }
    // The newest session's spelling is the display fallback when no target names it.
    if (
      row.latestDate == null ||
      (tally.last_used != null && tally.last_used > row.latestDate)
    ) {
      row.latestDate = tally.last_used;
      row.latestSpelling = tally.practice;
    }
  }

  return [...byIdentity.entries()].map(([identity, row]) => ({
    identity,
    name: practiceDisplayName({
      targetSpelling: row.targetSpelling,
      latestSpelling: row.latestSpelling,
      identity,
    }),
    perWeek: row.perWeek,
    perWeekMax: row.perWeekMax,
    sessionCount: row.sessionCount,
    lastUsed: row.lastUsed,
  }));
}

export function getAllPracticeSessions(
  profileId: number,
  name: string,
  limit = WELLNESS_CARD_SESSION_LIMIT
): PracticeLog[] {
  return getPracticeSessions(profileId, name, limit);
}

export function practiceNameMatches(a: string, b: string): boolean {
  return samePractice(a, b);
}
