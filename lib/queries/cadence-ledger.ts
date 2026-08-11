import { db, today } from "../db";
import {
  CADENCE_SCOPES,
  cadenceDirection,
  cadenceVerdict,
  type CadenceDirection,
  type CadenceSource,
  type CadenceVerdict,
} from "../cadence";
import { daysBetweenDateStr, shiftDateStr } from "../date";
import type { FrequencyScopeKind } from "../frequency-targets";
import type { BodyGroup, MuscleRegion } from "../lifts";
import { regionForExercise, regionsForGroup } from "../lifts";
import {
  mobilityRegionDays,
  type MobilitySessionInput,
} from "../mobility-coverage";
import { practiceIdentity } from "../practice";
import {
  ALCOHOL_FOOD_GROUP,
  substanceDef,
  type Substance,
} from "../substance-use";
import type { FrequencyTarget } from "../types";
import { parseComponents } from "../types";
import { weekWindowStartOn } from "./profile-week";

// THE CADENCE LEDGER (#2034) — the one read model over `frequency_targets`.
//
// Before this module there were four: the current-week rollup, the completed-week
// history, the substance week state and the substance weekly trend. Two of them
// inlined the SAME six-branch scope dispatch and the same gather-and-bucket code
// (~250 structurally identical lines that had to be edited in lockstep); the other
// two read the same table into their own shapes because the first two filtered
// their scope out. One physical table, one identity (`target.id`), four answers.
//
// This is one reader parameterized on the axes `lib/cadence.ts` declares — the
// scope's source and grain, the DIRECTION (floor vs cap), and whether the
// in-progress week is included. Every former reader is now a thin adapter:
//
//   getFrequencyTargetProgress       → weeks 1, includeCurrent, direction floor
//   getFrequencyTargetWeeklyHistory  → weeks N, completed only, direction floor
//   getSubstanceWeekState            → weeks 1, includeCurrent, direction cap
//   getSubstanceWeeklyTrend          → weeks N, includeCurrent, direction cap
//
// Load-bearing properties carried over unchanged from those readers:
//
//   • The weeks are the PROFILE'S OWN weekly windows (calendar mode resetting on
//     the configured week-start day, or rolling trailing-7-day blocks), walked
//     backwards from the anchor day's window. Nothing here re-derives the week.
//   • One gather per event SOURCE over the whole span, bucketed in JS — never one
//     query per week, and never a second query for a source two scopes share.
//   • A source is only read when a target actually needs it.
//   • Everything is profile-scoped; per-profile timezone and week mode are
//     resolved per profile, as everywhere.

// Targets created and owned by a protocol are active only while at least one
// protocol using them is ongoing. Ended protocol rows keep their target reference
// as a historical cadence snapshot, but that snapshot must not keep producing
// dashboard progress, Upcoming items, or notifications forever. Standalone targets
// (no protocol owner) remain active until the user explicitly untracks them.
export function getFrequencyTargets(profileId: number): FrequencyTarget[] {
  return db
    .prepare(
      `SELECT ft.* FROM frequency_targets ft
        WHERE ft.profile_id = ?
          AND (
            NOT EXISTS (
              SELECT 1 FROM protocols owner
               WHERE owner.profile_id = ft.profile_id
                 AND owner.frequency_target_id = ft.id
                 AND owner.owns_frequency_target = 1
            )
            OR EXISTS (
              SELECT 1 FROM protocols live
               WHERE live.profile_id = ft.profile_id
                 AND live.frequency_target_id = ft.id
                 AND live.end_date IS NULL
            )
          )
        ORDER BY ft.created_at, ft.id`
    )
    .all(profileId) as FrequencyTarget[];
}

// One week of a ledger: its inclusive window, whether it is the in-progress one,
// how much of it has elapsed, and what the target's count that week says.
export interface CadenceWeek {
  start: string;
  end: string;
  isCurrent: boolean;
  /** Days of this window elapsed through `end`, 1..7. Always 7 for a completed week. */
  elapsedDays: number;
  count: number;
  verdict: CadenceVerdict;
}

export interface CadenceLedgerEntry {
  target: FrequencyTarget;
  direction: CadenceDirection;
  /** Oldest first — the render order of every weekly strip. */
  weeks: CadenceWeek[];
  /** Whether the target itself existed for the whole of the oldest window (#1670). */
  existedWholeWindow: boolean;
}

export interface CadenceLedgerOptions {
  /** How many week windows to read. */
  weeks: number;
  /**
   * Whether the last window is the IN-PROGRESS one. False reads the `weeks`
   * COMPLETED windows before it — the honest ledger for a right-sizing
   * suggestion, since an in-progress week is under its floor by construction on
   * every day but the last.
   */
  includeCurrent: boolean;
  /**
   * Which tenants to read. A DECLARED selection replacing the
   * `scope_kind !== "substance"` subtraction three readers used to carry: a new
   * inverted scope joins the right readers by declaring its direction.
   */
  direction: CadenceDirection;
  /** The day the ledger is anchored on. Defaults to the profile's today. */
  asOf?: string;
}

// A scope to count, independent of whether a target exists for it. Substance week
// state needs a count for a substance with no cap set, so the counting layer is
// addressable without a target row.
export interface CadenceScopeRef {
  kind: FrequencyScopeKind;
  value: string;
}

const scopeKey = (scope: CadenceScopeRef): string =>
  `${scope.kind}:${scope.value}`;

// ---------------------------------------------------------------------------
// The windows
// ---------------------------------------------------------------------------

export interface CadenceWindow {
  start: string;
  end: string;
  isCurrent: boolean;
  elapsedDays: number;
}

// The `weeks` week windows a ledger read covers, OLDEST FIRST and contiguous.
//
// With `includeCurrent` the last window is the in-progress one, [weekStart, asOf] —
// the same window every "this week" surface shows, possibly partial. Without it,
// the last window is the completed week that ended the day before, so the anchor
// day's own week is excluded exactly as the current week always was.
export function cadenceWindows(
  profileId: number,
  options: Pick<CadenceLedgerOptions, "weeks" | "includeCurrent" | "asOf">
): CadenceWindow[] {
  const { weeks, includeCurrent } = options;
  if (weeks < 1) return [];
  const anchor = options.asOf ?? today(profileId);
  const currentStart = weekWindowStartOn(profileId, anchor);
  const completed = includeCurrent ? weeks - 1 : weeks;
  const firstStart = shiftDateStr(currentStart, -7 * completed);

  const windows: CadenceWindow[] = [];
  for (let i = 0; i < completed; i++) {
    const start = shiftDateStr(firstStart, 7 * i);
    windows.push({
      start,
      end: shiftDateStr(start, 6),
      isCurrent: false,
      elapsedDays: 7,
    });
  }
  if (includeCurrent) {
    windows.push({
      start: currentStart,
      end: anchor,
      isCurrent: true,
      // The pacing denominator (#748 item 3): 1..7. A rolling window is always the
      // trailing 7 days, so it is always fully elapsed; a calendar week grows from
      // 1 on its week-start day.
      elapsedDays: (daysBetweenDateStr(currentStart, anchor) ?? 6) + 1,
    });
  }
  return windows;
}

// ---------------------------------------------------------------------------
// The gather
// ---------------------------------------------------------------------------

// Per-week counts for a set of scopes over a set of contiguous week windows.
//
// ONE gather per distinct source, and only for the sources some scope needs. The
// windows are contiguous 7-day blocks (the last possibly short), so which week a
// date belongs to is a division — no per-week query and no per-week scan.
export function cadenceCounts(
  profileId: number,
  scopes: readonly CadenceScopeRef[],
  windows: readonly CadenceWindow[]
): Map<string, number[]> {
  const out = new Map<string, number[]>();
  if (scopes.length === 0 || windows.length === 0) return out;

  const n = windows.length;
  const firstStart = windows[0].start;
  // The span the gathers read. Bounded at BOTH ends: a log dated after the anchor
  // day describes a day that has not happened, and must not fill this week's count.
  const lastEnd = windows[n - 1].end;
  const zeros = (): number[] => Array(n).fill(0) as number[];
  const dayBuckets = (): Set<string>[] =>
    Array.from({ length: n }, () => new Set<string>());

  // Which week a date falls in, or null when it is outside the span.
  const bucketOf = (date: string): number | null => {
    if (date < firstStart || date > lastEnd) return null;
    const delta = daysBetweenDateStr(firstStart, date);
    if (delta == null || delta < 0) return null;
    const idx = Math.floor(delta / 7);
    return idx < n ? idx : null;
  };

  const needs = new Set<CadenceSource>(
    scopes.map((s) => CADENCE_SCOPES[s.kind].source)
  );
  // Alcohol rides the food_log ledger (a standard drink IS one serving of the
  // curated `alcohol` food group, #860/#944), so a substance scope may need the
  // food gather even when no food_group target exists.
  const substanceValues = scopes
    .filter((s) => s.kind === "substance")
    .map((s) => s.value as Substance);
  const foodLedgerSubstances = substanceValues.filter(
    (s) => substanceDef(s).ledger === "food-log"
  );
  const counterLedgerSubstances = substanceValues.filter(
    (s) => substanceDef(s).ledger !== "food-log"
  );

  // ---- exercise_sets → regions -------------------------------------------------
  const regionWeeks = new Map<MuscleRegion, Set<string>[]>();
  if (needs.has("exercise-sets")) {
    const rows = db
      .prepare(
        `SELECT DISTINCT a.date AS date, s.exercise AS exercise
           FROM exercise_sets s JOIN activities a ON a.id = s.activity_id
          WHERE a.profile_id = ? AND a.date >= ? AND a.date <= ?`
      )
      .all(profileId, firstStart, lastEnd) as {
      date: string;
      exercise: string;
    }[];
    for (const r of rows) {
      const region = regionForExercise(r.exercise);
      if (!region) continue;
      const b = bucketOf(r.date);
      if (b == null) continue;
      let arr = regionWeeks.get(region);
      if (!arr) regionWeeks.set(region, (arr = dayBuckets()));
      arr[b].add(r.date);
    }
  }

  // ---- activities → types, and the recovery sessions mobility reads -------------
  const typeWeeks = new Map<string, Set<string>[]>();
  const mobilityWeeks = new Map<MuscleRegion, Set<string>[]>();
  if (needs.has("activity-type") || needs.has("mobility-moves")) {
    const rows = db
      .prepare(
        `SELECT date, type, components FROM activities
          WHERE profile_id = ? AND date >= ? AND date <= ?`
      )
      .all(profileId, firstStart, lastEnd) as {
      date: string;
      type: string;
      components: string | null;
    }[];

    if (needs.has("activity-type")) {
      const addType = (type: string, date: string, bucket: number) => {
        let arr = typeWeeks.get(type);
        if (!arr) typeWeeks.set(type, (arr = dayBuckets()));
        arr[bucket].add(date);
      };
      for (const a of rows) {
        const b = bucketOf(a.date);
        if (b == null) continue;
        addType(a.type, a.date, b);
        for (const c of parseComponents(a.components))
          if (c?.type) addType(c.type, a.date, b);
      }
    }

    if (needs.has("mobility-moves")) {
      // The move→MuscleId→MuscleRegion rollup, deduped once per day (#223) — the
      // SAME mobilityRegionDays the coverage strip uses. The span is already SQL-
      // bounded, so the helper's own window filter is off (0).
      const sessions: MobilitySessionInput[] = rows
        .filter((a) => a.type === "recovery")
        .map((a) => ({
          date: a.date,
          moves: parseComponents(a.components)
            .filter((c) => c?.type === "recovery" && typeof c.name === "string")
            .map((c) => c.name),
        }));
      for (const [region, dates] of mobilityRegionDays(sessions, lastEnd, 0)) {
        const arr = dayBuckets();
        for (const d of dates) {
          const b = bucketOf(d);
          if (b != null) arr[b].add(d);
        }
        mobilityWeeks.set(region, arr);
      }
    }
  }

  // ---- food_log → servings (food groups, and the alcohol substance ledger) ------
  const foodWeeks = new Map<string, number[]>();
  if (needs.has("food-servings") || foodLedgerSubstances.length > 0) {
    for (const r of db
      .prepare(
        `SELECT group_key, date, COALESCE(SUM(servings), 0) AS n FROM food_log
          WHERE profile_id = ? AND date >= ? AND date <= ?
          GROUP BY group_key, date`
      )
      .all(profileId, firstStart, lastEnd) as {
      group_key: string;
      date: string;
      n: number;
    }[]) {
      const b = bucketOf(r.date);
      if (b == null) continue;
      let arr = foodWeeks.get(r.group_key);
      if (!arr) foodWeeks.set(r.group_key, (arr = zeros()));
      arr[b] += r.n;
    }
  }

  // ---- practice_logs → distinct logged days ------------------------------------
  const practiceWeeks = new Map<string, Set<string>[]>();
  if (needs.has("practice-logs")) {
    for (const r of db
      .prepare(
        `SELECT practice, date FROM practice_logs
          WHERE profile_id = ? AND date >= ? AND date <= ?`
      )
      .all(profileId, firstStart, lastEnd) as {
      practice: string;
      date: string;
    }[]) {
      const b = bucketOf(r.date);
      if (b == null) continue;
      const key = practiceIdentity(r.practice);
      let arr = practiceWeeks.get(key);
      if (!arr) practiceWeeks.set(key, (arr = dayBuckets()));
      arr[b].add(r.date);
    }
  }

  // ---- substance_log → units (nicotine / cannabis) -----------------------------
  const substanceWeeks = new Map<string, number[]>();
  if (counterLedgerSubstances.length > 0) {
    const values = [...new Set(counterLedgerSubstances)];
    for (const r of db
      .prepare(
        `SELECT substance, date, COALESCE(SUM(units), 0) AS n FROM substance_log
          WHERE profile_id = ? AND date >= ? AND date <= ?
            AND substance IN (${values.map(() => "?").join(",")})
          GROUP BY substance, date`
      )
      .all(profileId, firstStart, lastEnd, ...values) as {
      substance: string;
      date: string;
      n: number;
    }[]) {
      const b = bucketOf(r.date);
      if (b == null) continue;
      let arr = substanceWeeks.get(r.substance);
      if (!arr) substanceWeeks.set(r.substance, (arr = zeros()));
      arr[b] += r.n;
    }
  }

  // ---- per-scope projection ----------------------------------------------------
  const sizes = (buckets: Set<string>[] | undefined): number[] =>
    buckets ? buckets.map((s) => s.size) : zeros();

  for (const scope of scopes) {
    const { source } = CADENCE_SCOPES[scope.kind];
    let counts: number[];
    switch (source) {
      case "exercise-sets":
        if (scope.kind === "group") {
          // A day counts ONCE for the group however many of its regions it hit.
          const unions = dayBuckets();
          for (const region of regionsForGroup(scope.value as BodyGroup)) {
            const arr = regionWeeks.get(region);
            if (!arr) continue;
            arr.forEach((set, i) => {
              for (const d of set) unions[i].add(d);
            });
          }
          counts = unions.map((s) => s.size);
        } else {
          counts = sizes(regionWeeks.get(scope.value as MuscleRegion));
        }
        break;
      case "activity-type":
        counts = sizes(typeWeeks.get(scope.value));
        break;
      case "mobility-moves":
        counts = sizes(mobilityWeeks.get(scope.value as MuscleRegion));
        break;
      case "food-servings":
        counts = foodWeeks.get(scope.value) ?? zeros();
        break;
      case "practice-logs":
        counts = sizes(practiceWeeks.get(practiceIdentity(scope.value)));
        break;
      case "substance-ledger":
        counts =
          substanceDef(scope.value as Substance).ledger === "food-log"
            ? (foodWeeks.get(ALCOHOL_FOOD_GROUP) ?? zeros())
            : (substanceWeeks.get(scope.value) ?? zeros());
        break;
    }
    out.set(scopeKey(scope), counts);
  }
  return out;
}

// ---------------------------------------------------------------------------
// The ledger
// ---------------------------------------------------------------------------

// Every ACTIVE target read in the given direction, with its per-week counts and
// verdicts over the requested windows.
export function getCadenceLedger(
  profileId: number,
  options: CadenceLedgerOptions
): CadenceLedgerEntry[] {
  const targets = getFrequencyTargets(profileId).filter(
    (t) => cadenceDirection(t.scope_kind) === options.direction
  );
  if (targets.length === 0) return [];
  const windows = cadenceWindows(profileId, options);
  if (windows.length === 0) return [];

  const scopes: CadenceScopeRef[] = targets.map((t) => ({
    kind: t.scope_kind as FrequencyScopeKind,
    value: t.scope_value,
  }));
  const counts = cadenceCounts(profileId, scopes, windows);

  return targets.map((t) => {
    const series =
      counts.get(
        scopeKey({
          kind: t.scope_kind as FrequencyScopeKind,
          value: t.scope_value,
        })
      ) ?? (Array(windows.length).fill(0) as number[]);
    return {
      target: t,
      direction: options.direction,
      weeks: windows.map((w, i) => ({
        start: w.start,
        end: w.end,
        isCurrent: w.isCurrent,
        elapsedDays: w.elapsedDays,
        count: series[i],
        verdict: cadenceVerdict({
          direction: options.direction,
          count: series[i],
          target: t.per_week,
          ceiling: t.per_week_max,
          elapsedDays: w.elapsedDays,
        }),
      })),
      // `created_at` is a UTC `datetime('now')` stamp; its calendar day is what the
      // cold-start exclusion compares. A target created ON the window's first day
      // counts as having existed for it.
      existedWholeWindow: t.created_at.slice(0, 10) <= windows[0].start,
    };
  });
}

// Per-week counts for ONE scope with no target row required — the seam substance
// week state and the substance trend read, since a substance is tracked (and its
// consumption shown) whether or not a cap has been set.
export function getCadenceScopeCounts(
  profileId: number,
  scope: CadenceScopeRef,
  windows: readonly CadenceWindow[]
): number[] {
  return (
    cadenceCounts(profileId, [scope], windows).get(scopeKey(scope)) ??
    (Array(windows.length).fill(0) as number[])
  );
}
