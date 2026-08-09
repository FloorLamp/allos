// Wellness-practice read layer (#1622). It owns the finite-preimage spelling map,
// session readers, and the page-level practice aggregate. Write cores remain in
// lib/practice-log.ts and lib/practice-store.ts.

import { db, today as profileToday } from "../db";
import { cache } from "../request-cache";
import { tickCached } from "../tick-cache";
import { buildPracticeHeatmap } from "../practice-heatmap";
import {
  inferPracticeRhythm,
  predictedOnDay,
  type WeeklyRhythm,
} from "../weekly-rhythm";
import type { ProtocolHeatmap } from "../protocol-heatmap";
import {
  groupPracticeSpellings,
  MAX_PRACTICE_SPELLINGS_PER_IDENTITY,
  practiceDisplayName,
  practiceIdentity,
  practiceSpellingsFor,
  practiceDurationPrefill,
  samePractice,
} from "../practice";
import type { FrequencyTarget, PracticeLog } from "../types";
import type { FrequencyPace } from "../goals";
import {
  getFrequencyTargetProgress,
  getFrequencyTargets,
  getFrequencyTargetWeeklyHistory,
} from "./frequency-targets";
import {
  practiceWeekVerdict,
  summarizePracticeWeeks,
  type PracticeConsistency,
  type PracticeWeekVerdict,
} from "../trends-practices";

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
  // Whether `asOf` is one of this practice's inferred rhythm days (#2188). False
  // whenever the inference has no pattern (#558: unknown renders NOTHING — the
  // card's rhythm note simply doesn't exist). Predicted ≠ due (#1505): this
  // never feeds pace or adherence, only the calm "usually a session day" note.
  usuallyToday: boolean;
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
        previousDurationMin: practiceDurationPrefill(item.sessions),
        // The rhythm over the identity's own sessions — already gathered above, so
        // the aggregate infers in memory over the SAME rows the per-practice query
        // wrapper (inferPracticeSchedule) scans; the pure core is the one
        // computation either way (#2188).
        usuallyToday:
          predictedOnDay(
            inferPracticeRhythm(
              item.sessions.map((s) => ({ date: s.date, time: s.time })),
              asOf
            ),
            asOf
          ) === true,
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
  // The quick sheet's inline duration stepper starts here (#2204) — `practiceDurationPrefill`
  // over the identity's LAST LOGGED session, the same pure resolution the Wellness card's
  // expanded form uses. Null means blank, and blank is a real answer: the sheet does not
  // invent a duration for a practice with no history, or for one whose last session
  // deliberately carried none.
  previousDurationMin: number | null;
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

  // The inline duration prefill's ingredient (#2204): ONE row per stored spelling —
  // that spelling's newest session — folded to one row per identity in JS, exactly as
  // the today-count fold above does (SQL cannot call practiceIdentity). Bounded by the
  // number of distinct spellings, not by history, so the sheet still opens on two
  // small reads. The ordering is byte-for-byte getPracticeSessions' own, COALESCE
  // sentinel included, so "the last logged session" means the same row on every
  // surface that asks.
  const latestRows = db
    .prepare(
      `SELECT practice, date, time, id, duration_min FROM (
         SELECT practice, date, time, id, duration_min,
                ROW_NUMBER() OVER (
                  PARTITION BY practice
                  ORDER BY date DESC, COALESCE(time, '99:99') DESC, id DESC
                ) AS rn
           FROM practice_logs
          WHERE profile_id = ?
       ) WHERE rn = 1`
    )
    .all(profileId) as {
    practice: string;
    date: string;
    time: string | null;
    id: number;
    duration_min: number | null;
  }[];
  const latestByIdentity = new Map<string, (typeof latestRows)[number]>();
  // The recency key, in getPracticeSessions' own order: date, then time with its
  // null-sorts-last sentinel, then the row id as the tiebreak.
  const recency = (r: (typeof latestRows)[number]) =>
    `${r.date} ${r.time ?? "99:99"} ${String(r.id).padStart(20, "0")}`;
  for (const row of latestRows) {
    const identity = practiceIdentity(row.practice);
    if (!identity) continue;
    const held = latestByIdentity.get(identity);
    if (!held || recency(row) > recency(held))
      latestByIdentity.set(identity, row);
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
      // The SAME pure resolution the Wellness card's expanded form reads — one
      // question, one computation. A practice with no logs at all resolves through
      // the empty list rather than being special-cased here.
      previousDurationMin: practiceDurationPrefill(
        latestByIdentity.has(identity) ? [latestByIdentity.get(identity)!] : []
      ),
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

// ---- Per-practice weekly rhythm (#2188) ------------------------------------

// The practice sibling of inferWorkoutSchedule (#558): the SAME shared inference
// core (lib/weekly-rhythm.ts owns the window, the habitual-weekday gate, and the
// fallback-hour ladder) over this one practice's log history, folded across the
// identity's stored spellings. Inference reads LOGS ONLY and is recomputed per
// evaluation — no stored state (#2188 item 5). Rows are ordered so the modal
// hour's first-max tie-break is deterministic (earliest logged occurrence wins).
//
// cache(): the wellness/protocol pages may ask for several practices per request.
// tickCached beside it (the lib/tick-cache.ts discipline): the notify tick's
// nudge builder re-gathers per behind practice on EVERY waking tick until the
// day's send lands, and nothing inside a tick writes practice_logs (session logs
// arrive via Server Actions and the Telegram tap paths, never tick()).
export const inferPracticeSchedule = cache(
  tickCached(
    "inferPracticeSchedule",
    (profileId: number, practice: string) =>
      `${profileId}:${practiceIdentity(practice)}`,
    inferPracticeScheduleUncached
  )
);

function inferPracticeScheduleUncached(
  profileId: number,
  practice: string
): WeeklyRhythm {
  const asOf = profileToday(profileId);
  const values = getPracticeSpellings(profileId, practice);
  const rows =
    values.length === 0
      ? []
      : (db
          .prepare(
            `SELECT date, time FROM practice_logs
              WHERE profile_id = ? AND practice IN (${inClause(values)})
              ORDER BY date ASC, id ASC`
          )
          .all(profileId, ...values) as {
          date: string;
          time: string | null;
        }[]);
  return inferPracticeRhythm(rows, asOf);
}

// Tri-state "is `date` a predicted session day for this practice?" — the
// isPredictedWorkoutDay shape. Null when no rhythm can be inferred (#558), so no
// consumer can mistake the every-day fallback for "yes".
export function isPredictedPracticeDay(
  profileId: number,
  practice: string,
  date: string
): boolean | null {
  return predictedOnDay(inferPracticeSchedule(profileId, practice), date);
}

// ---- The Trends wellness lens (#1632) --------------------------------------

// One COMPLETED week of a tracked practice: the window's inclusive start, the
// distinct days it was logged, and the range verdict those two produce.
export interface PracticeTrendWeek {
  start: string;
  count: number;
  verdict: PracticeWeekVerdict;
}

// A tracked practice as the Trends lens renders it: its completed-week ledger,
// the consistency that ledger rolls up to, and the per-day duration series for
// the modalities that record one.
export interface PracticeTrend {
  targetId: number;
  identity: string;
  name: string;
  perWeek: number;
  perWeekMax: number | null;
  /** Completed weeks, OLDEST FIRST — the render order of the strip and chart. */
  weeks: PracticeTrendWeek[];
  consistency: PracticeConsistency;
  /** Sessions logged anywhere in the window, including the in-progress week. */
  sessions: number;
  /**
   * Mean minutes per logged DAY, oldest first, for practices that record a
   * duration. Empty for the ones that don't (a one-tap meditation log carries no
   * minutes, and a zero-filled line would invent them).
   */
  duration: { date: string; value: number }[];
  /** Whether the target itself existed for the whole window (see #1670). */
  existedWholeWindow: boolean;
}

// The wellness lens's read (#1632): every TRACKED practice's completed-week
// ledger over the hub's window.
//
// It is a FORMATTER over two existing gathers, not a third engine:
//
//   • The weeks come from `getFrequencyTargetWeeklyHistory` — the completed-weeks
//     read #1670 built for the right-sizing detector. It already walks the
//     profile's OWN weekly windows (calendar or rolling, in the profile's stored
//     timezone), already folds practice spellings through `practiceIdentity`, and
//     already excludes the in-progress week, which is under its floor by
//     construction on every day but the last. Those are exactly this lens's
//     requirements, so re-deriving them would have been a second answer to a
//     question the app had already answered.
//   • The verdict per week is `practiceWeekVerdict`, which is
//     `frequencyRangeState` with the week fully elapsed — the same computation the
//     /wellness card, the Goals-and-habits widget, Upcoming and the Telegram nudge
//     key on. Trends formats those decisions; it never makes its own.
//
// TRACKED only: a practice with no weekly cadence has no floor and no ceiling, so
// "weeks in range" is not a question that can be asked about it. It keeps its
// /wellness card and its full session history.
//
// One extra query beyond the shared history read, regardless of how many
// practices exist: a per-practice-per-day tally that carries both the session
// count and the mean duration.
export function getPracticeTrends(
  profileId: number,
  weeks: number,
  asOf = profileToday(profileId)
): PracticeTrend[] {
  const history = getFrequencyTargetWeeklyHistory(
    profileId,
    weeks,
    asOf
  ).filter((item) => item.target.scope_kind === "practice");
  if (history.length === 0) return [];

  // The window the session/duration series covers: the first completed week's
  // start through the anchor day. Deliberately WIDER at the end than the weekly
  // ledger — a duration series is a per-session trend, not a weekly verdict, so
  // sessions logged in the in-progress week belong on it.
  const windowStart = history[0].weeks[0]?.start ?? asOf;
  const rows = db
    .prepare(
      `SELECT practice, date,
              COUNT(*) AS sessions,
              COUNT(duration_min) AS timed,
              COALESCE(SUM(duration_min), 0) AS minutes
         FROM practice_logs
        WHERE profile_id = ? AND date >= ? AND date <= ?
        GROUP BY practice, date
        ORDER BY date ASC`
    )
    .all(profileId, windowStart, asOf) as {
    practice: string;
    date: string;
    sessions: number;
    timed: number;
    minutes: number;
  }[];

  // Fold the stored spellings onto the one identity (SQL cannot call the
  // normalizer), summing sessions and averaging durations per day.
  const byIdentity = new Map<
    string,
    Map<string, { sessions: number; minutes: number; withMinutes: number }>
  >();
  for (const row of rows) {
    const identity = practiceIdentity(row.practice);
    if (!identity) continue;
    let days = byIdentity.get(identity);
    if (!days) byIdentity.set(identity, (days = new Map()));
    const day = days.get(row.date) ?? {
      sessions: 0,
      minutes: 0,
      withMinutes: 0,
    };
    day.sessions += row.sessions;
    // SUM/COUNT rather than AVG, so a day that merges two spellings — or mixes
    // timed and untimed sessions — averages over the sessions that actually
    // carried minutes, never over the ones that didn't.
    day.minutes += row.minutes;
    day.withMinutes += row.timed;
    days.set(row.date, day);
  }

  return history
    .map((item): PracticeTrend => {
      const identity = practiceIdentity(item.target.scope_value);
      const days = byIdentity.get(identity);
      const weekRows = item.weeks.map((week) => ({
        start: week.start,
        count: week.count,
        verdict: practiceWeekVerdict(
          week.count,
          item.target.per_week,
          item.target.per_week_max
        ),
      }));
      const duration: { date: string; value: number }[] = [];
      let sessions = 0;
      for (const [date, day] of days ?? []) {
        sessions += day.sessions;
        if (day.withMinutes > 0) {
          duration.push({ date, value: day.minutes / day.withMinutes });
        }
      }
      duration.sort((left, right) => left.date.localeCompare(right.date));
      return {
        targetId: item.target.id,
        identity,
        name: practiceDisplayName({
          targetSpelling: item.target.scope_value,
          identity,
        }),
        perWeek: item.target.per_week,
        perWeekMax: item.target.per_week_max,
        weeks: weekRows,
        consistency: summarizePracticeWeeks(weekRows),
        sessions,
        duration,
        existedWholeWindow: item.existedWholeWindow,
      };
    })
    .sort((left, right) =>
      left.name.localeCompare(right.name, undefined, { sensitivity: "base" })
    );
}

// Sessions + minutes per profile-local day AND practice, in [since, until] —
// the gather behind the /wellness cross-practice day-history (the group×day
// matrix over every practice, above the per-practice cards). Identity is
// `practiceIdentity` — the canonical practice key every wellness surface binds
// user-owned spellings through — with the first-seen raw spelling as the
// display label. Rows whose name yields no identity (blank) are skipped.
export interface PracticeDay {
  date: string; // YYYY-MM-DD, profile-local
  key: string; // practiceIdentity of the logged name
  label: string; // display name (first-seen spelling)
  count: number; // sessions of this practice that day
  minutes: number; // total minutes (0 when durations are null)
}

export function getPracticeDays(
  profileId: number,
  since: string,
  until: string
): PracticeDay[] {
  const rows = db
    .prepare(
      `SELECT date, practice, COALESCE(duration_min, 0) AS minutes
         FROM practice_logs
        WHERE profile_id = ? AND date >= ? AND date <= ?
        ORDER BY date ASC, id ASC`
    )
    .all(profileId, since, until) as {
    date: string;
    practice: string;
    minutes: number;
  }[];

  const labelByKey = new Map<string, string>();
  const byDayKey = new Map<string, PracticeDay>();
  for (const r of rows) {
    const key = practiceIdentity(r.practice);
    if (!key) continue;
    if (!labelByKey.has(key)) labelByKey.set(key, r.practice.trim());
    const mapKey = `${r.date}|${key}`;
    const entry = byDayKey.get(mapKey);
    if (entry) {
      entry.count += 1;
      entry.minutes += r.minutes;
    } else {
      byDayKey.set(mapKey, {
        date: r.date,
        key,
        label: labelByKey.get(key)!,
        count: 1,
        minutes: r.minutes,
      });
    }
  }
  return [...byDayKey.values()];
}
