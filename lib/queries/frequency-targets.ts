import { db, today } from "../db";
import type { FrequencyPace } from "../goals";
import { frequencyRangeState, practiceIdentity } from "../practice";
import { daysBetweenDateStr, shiftDateStr } from "../date";
import type { BodyGroup, MuscleRegion } from "../lifts";
import { regionForExercise, regionsForGroup } from "../lifts";
import type { FrequencyTarget } from "../types";
import { parseComponents } from "../types";
import {
  mobilityRegionDays,
  type MobilitySessionInput,
} from "../mobility-coverage";
import { weekWindowStart, weekWindowStartOn } from "./profile-week";

// Weekly frequency targets — the scope-kind-GENERIC `frequency_targets` read
// machinery. It lived under lib/queries/training/goals.ts until #1637, which was
// misleading in both directions: training goals are only ONE of five consumers
// (training goals, nutrition food groups, substance use, protocols, and wellness
// practices), and non-training work kept importing domain-neutral machinery from
// `training/`. Genuinely training-specific goal reads stayed behind in
// training/goals.ts. Pure relocation: no SQL, semantics, or scoping changed.
//
// Every read here is profile-scoped, and the module is reached through the
// lib/queries.ts barrel, so existing `@/lib/queries` import sites are unaffected.
// It imports nothing from `training/`: the shared weekly window it needs moved to
// lib/queries/profile-week.ts, which is where its other non-training consumers
// (nutrition, substance use) now read it from too.

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

export interface FrequencyTargetProgress {
  target: FrequencyTarget;
  count: number;
  per_week: number;
  // The optional weekly ceiling (#1259): a range target ("3–5×/week") is DONE for the
  // week once count reaches it — a calm "that's plenty", never a red state. NULL for a
  // single-floor target. Copied through so every surface reads the SAME range.
  per_week_max: number | null;
  met: boolean;
  // At/above the ceiling (per_week_max != null && count >= per_week_max). Silences the
  // nudge and flips the surfaces to the calm plenty state (#1259).
  atCeiling: boolean;
  // Paced status (#748 item 3): "met" once complete, "on-pace" while keeping up with the
  // share of the week elapsed, else "behind". Computed once here so every surface agrees.
  pace: FrequencyPace;
  // On-days remaining in the profile's week window AFTER today (0..6) — the same window
  // `pace` is computed against, carried so a surface can ask "is this still reachable
  // without training today?" without re-deriving the window (#221). Rolling mode's
  // window is always the trailing 7 days, so this is 0 there: every day is the last day.
  daysLeftInWindow: number;
}

// Distinct training days in the profile's weekly window that satisfy each target.
// The window is either the current calendar week (resetting on the week-start day)
// or a rolling 7-day window, per the profile's week_mode. Region/group targets map
// logged exercises -> region in JS (SQL can't); type targets count activities (and
// multi-part components) of that type.
export function getFrequencyTargetProgress(
  profileId: number
): FrequencyTargetProgress[] {
  // Substance reduction targets (#998) are deliberately EXCLUDED here: their
  // per_week is a weekly CAP (a ceiling), the inverse of every other scope's
  // floor, so a floor-semantics reader (this rollup, the digest's goals-due
  // list, the Upcoming unmet-target generator, the presence recap) would render
  // "2 of 7 — 5 to go", nudging toward MORE consumption. Their progress is the
  // dedicated lib/queries/substance.ts read over the SAME table.
  const targets = getFrequencyTargets(profileId).filter(
    (t) => t.scope_kind !== "substance"
  );
  if (targets.length === 0) return [];

  const since = weekWindowStart(profileId);
  // Days elapsed in this week's window through today, inclusive (1..7) — the pacing
  // denominator (#748 item 3). Rolling mode's window is always the trailing 7 days, so
  // this is 7 there; calendar mode grows it from 1 on the week-start day.
  const elapsedDays = (daysBetweenDateStr(since, today(profileId)) ?? 6) + 1;
  const setRows = db
    .prepare(
      `SELECT DISTINCT a.date AS date, s.exercise AS exercise
       FROM exercise_sets s JOIN activities a ON a.id = s.activity_id
       WHERE a.profile_id = ? AND a.date >= ?`
    )
    .all(profileId, since) as { date: string; exercise: string }[];
  const regionDates = new Map<MuscleRegion, Set<string>>();
  for (const r of setRows) {
    const region = regionForExercise(r.exercise);
    if (!region) continue;
    let set = regionDates.get(region);
    if (!set) regionDates.set(region, (set = new Set()));
    set.add(r.date);
  }

  const actRows = db
    .prepare(
      `SELECT date, type, components FROM activities WHERE profile_id = ? AND date >= ?`
    )
    .all(profileId, since) as {
    date: string;
    type: string;
    components: string | null;
  }[];
  const typeDates = new Map<string, Set<string>>();
  const addType = (type: string, date: string) => {
    let set = typeDates.get(type);
    if (!set) typeDates.set(type, (set = new Set()));
    set.add(date);
  };
  for (const a of actRows) {
    addType(a.type, a.date);
    for (const c of parseComponents(a.components))
      if (c?.type) addType(c.type, a.date);
  }

  // Mobility-region (#840) targets count DISTINCT DAYS a recovery session mobilized the
  // region this week — the move→MuscleId→MuscleRegion rollup, deduped once per day (#223).
  // A SEPARATE view from strength `region` targets (#482: trained ≠ mobilized), gathered
  // from recovery activities' move components (never exercise_sets). One computation:
  // the same mobilityRegionDays the coverage strip uses.
  const mobilityRegionDates = new Map<MuscleRegion, Set<string>>();
  if (targets.some((t) => t.scope_kind === "mobility_region")) {
    const sessions: MobilitySessionInput[] = actRows
      .filter((a) => a.type === "recovery")
      .map((a) => ({
        date: a.date,
        moves: parseComponents(a.components)
          .filter((c) => c?.type === "recovery" && typeof c.name === "string")
          .map((c) => c.name),
      }));
    for (const [region, dates] of mobilityRegionDays(
      sessions,
      today(profileId),
      0
    ))
      mobilityRegionDates.set(region, dates);
  }

  // Food-habit (#580) targets count this week's SERVINGS for the group — the #579
  // weekly rollup's per-group sum, NOT a second count (one question, one computation).
  // Gathered once for all food_group targets. Profile-scoped by the same window.
  const foodServings = new Map<string, number>();
  if (targets.some((t) => t.scope_kind === "food_group")) {
    for (const r of db
      .prepare(
        `SELECT group_key, COALESCE(SUM(servings), 0) AS n FROM food_log
          WHERE profile_id = ? AND date >= ? GROUP BY group_key`
      )
      .all(profileId, since) as { group_key: string; n: number }[])
      foodServings.set(r.group_key, r.n);
  }

  // Wellness-practice (#1259) targets count DISTINCT DAYS a session was logged into
  // practice_logs this week — the dedicated store the reuse-a-store rule (#860/#944)
  // deliberately carved out (a session is not a valued observation). Day-distinct so a
  // second same-day session never double-counts. Gathered once for all practice targets.
  const practiceDates = new Map<string, Set<string>>();
  if (targets.some((t) => t.scope_kind === "practice")) {
    for (const r of db
      .prepare(
        `SELECT practice, date FROM practice_logs
          WHERE profile_id = ? AND date >= ?`
      )
      .all(profileId, since) as { practice: string; date: string }[]) {
      const key = practiceIdentity(r.practice);
      let set = practiceDates.get(key);
      if (!set) practiceDates.set(key, (set = new Set()));
      set.add(r.date);
    }
  }

  return targets.map((t) => {
    let count = 0;
    if (t.scope_kind === "region") {
      count = regionDates.get(t.scope_value as MuscleRegion)?.size ?? 0;
    } else if (t.scope_kind === "group") {
      const union = new Set<string>();
      for (const reg of regionsForGroup(t.scope_value as BodyGroup))
        for (const d of regionDates.get(reg) ?? []) union.add(d);
      count = union.size;
    } else if (t.scope_kind === "food_group") {
      count = foodServings.get(t.scope_value) ?? 0;
    } else if (t.scope_kind === "mobility_region") {
      count = mobilityRegionDates.get(t.scope_value as MuscleRegion)?.size ?? 0;
    } else if (t.scope_kind === "practice") {
      count = practiceDates.get(practiceIdentity(t.scope_value))?.size ?? 0;
    } else {
      count = typeDates.get(t.scope_value)?.size ?? 0;
    }
    // Range semantics (#1259): the FLOOR (per_week) drives met + pace; the optional
    // ceiling (per_week_max) flips atCeiling once reached — a calm "that's plenty", never
    // a red state. One computation (frequencyRangeState) shared by every surface.
    const range = frequencyRangeState(
      count,
      t.per_week,
      t.per_week_max,
      elapsedDays
    );
    return {
      target: t,
      count,
      per_week: t.per_week,
      per_week_max: t.per_week_max,
      met: range.met,
      atCeiling: range.atCeiling,
      pace: range.pace,
      daysLeftInWindow: Math.max(0, 7 - elapsedDays),
    };
  });
}

// ---- Completed-week history (#1670) ---------------------------------------

// One completed target week for a target: the window's inclusive start date and the
// count that week produced under the SAME per-scope counting rules
// getFrequencyTargetProgress applies to the current week.
export interface FrequencyTargetWeek {
  start: string;
  count: number;
}

// A target's trailing history: its COMPLETED weeks (oldest first — the current,
// in-progress week is deliberately absent, see below) plus whether the target itself
// existed for the whole of that window.
export interface FrequencyTargetHistory {
  target: FrequencyTarget;
  weeks: FrequencyTargetWeek[];
  existedWholeWindow: boolean;
}

// Per-target weekly counts over the `weeks` COMPLETED target weeks before the current
// one — the revealed-preference ledger the #1670 right-sizing detector reads.
//
// Three properties are load-bearing:
//
//   • The weeks are the profile's OWN weekly windows, walked backwards from
//     weekWindowStart, so calendar mode (resetting on the configured week-start day)
//     and rolling mode (trailing 7-day blocks) both get the answer their surfaces
//     already show. Nothing here re-derives the week.
//   • The CURRENT week is excluded. It is under its floor by construction on every
//     day but the last, so including it would make almost every target look chronic.
//   • Counting is the same per-scope rule as the current-week rollup — distinct
//     training days by region/group/type, distinct mobilized days via the shared
//     mobilityRegionDays gather, summed servings for a food group, distinct logged
//     days for a practice — so a suggestion can never disagree with the card beside
//     it. Substance CAPS are excluded here exactly as they are there: a cap is not a
//     floor, and "chronically under it" is that scope's success state.
//
// One gather per event source over the WHOLE window, bucketed in JS — never one query
// per week.
//
// `asOf` moves the anchor (#1632). It defaults to today — the detector's whole
// point is the weeks leading up to now — but a WINDOWED analytics surface may end
// its range in the past, and the honest ledger for such a window is the completed
// weeks before ITS end, not before today's. The week containing `asOf` is excluded
// exactly as the current week is: it is the in-progress one from that day's point
// of view. Nothing else changes, so the default call site is byte-for-byte the
// behaviour #1670 shipped.
export function getFrequencyTargetWeeklyHistory(
  profileId: number,
  weeks: number,
  asOf?: string
): FrequencyTargetHistory[] {
  const targets = getFrequencyTargets(profileId).filter(
    (t) => t.scope_kind !== "substance"
  );
  if (targets.length === 0 || weeks < 1) return [];

  const currentStart =
    asOf == null ? weekWindowStart(profileId) : weekWindowStartOn(profileId, asOf);
  const historyStart = shiftDateStr(currentStart, -7 * weeks);
  const weekStarts = Array.from({ length: weeks }, (_, i) =>
    shiftDateStr(historyStart, 7 * i)
  );
  // The window's last completed day — the anchor mobilityRegionDays windows against.
  const lastDay = shiftDateStr(currentStart, -1);

  // Which completed week a date falls in, or null when it is outside the window.
  const bucketOf = (date: string): number | null => {
    const delta = daysBetweenDateStr(historyStart, date);
    if (delta == null || delta < 0) return null;
    const idx = Math.floor(delta / 7);
    return idx < weeks ? idx : null;
  };
  const dayBuckets = () =>
    Array.from({ length: weeks }, () => new Set<string>());

  const setRows = db
    .prepare(
      `SELECT DISTINCT a.date AS date, s.exercise AS exercise
       FROM exercise_sets s JOIN activities a ON a.id = s.activity_id
       WHERE a.profile_id = ? AND a.date >= ? AND a.date < ?`
    )
    .all(profileId, historyStart, currentStart) as {
    date: string;
    exercise: string;
  }[];
  const regionWeeks = new Map<MuscleRegion, Set<string>[]>();
  for (const r of setRows) {
    const region = regionForExercise(r.exercise);
    if (!region) continue;
    const b = bucketOf(r.date);
    if (b == null) continue;
    let arr = regionWeeks.get(region);
    if (!arr) regionWeeks.set(region, (arr = dayBuckets()));
    arr[b].add(r.date);
  }

  const actRows = db
    .prepare(
      `SELECT date, type, components FROM activities
        WHERE profile_id = ? AND date >= ? AND date < ?`
    )
    .all(profileId, historyStart, currentStart) as {
    date: string;
    type: string;
    components: string | null;
  }[];
  const typeWeeks = new Map<string, Set<string>[]>();
  const addType = (type: string, date: string, bucket: number) => {
    let arr = typeWeeks.get(type);
    if (!arr) typeWeeks.set(type, (arr = dayBuckets()));
    arr[bucket].add(date);
  };
  for (const a of actRows) {
    const b = bucketOf(a.date);
    if (b == null) continue;
    addType(a.type, a.date, b);
    for (const c of parseComponents(a.components))
      if (c?.type) addType(c.type, a.date, b);
  }

  const mobilityWeeks = new Map<MuscleRegion, Set<string>[]>();
  if (targets.some((t) => t.scope_kind === "mobility_region")) {
    const sessions: MobilitySessionInput[] = actRows
      .filter((a) => a.type === "recovery")
      .map((a) => ({
        date: a.date,
        moves: parseComponents(a.components)
          .filter((c) => c?.type === "recovery" && typeof c.name === "string")
          .map((c) => c.name),
      }));
    for (const [region, dates] of mobilityRegionDays(
      sessions,
      lastDay,
      7 * weeks
    )) {
      const arr = dayBuckets();
      for (const d of dates) {
        const b = bucketOf(d);
        if (b != null) arr[b].add(d);
      }
      mobilityWeeks.set(region, arr);
    }
  }

  const foodWeeks = new Map<string, number[]>();
  if (targets.some((t) => t.scope_kind === "food_group")) {
    for (const r of db
      .prepare(
        `SELECT group_key, date, COALESCE(SUM(servings), 0) AS n FROM food_log
          WHERE profile_id = ? AND date >= ? AND date < ?
          GROUP BY group_key, date`
      )
      .all(profileId, historyStart, currentStart) as {
      group_key: string;
      date: string;
      n: number;
    }[]) {
      const b = bucketOf(r.date);
      if (b == null) continue;
      let arr = foodWeeks.get(r.group_key);
      if (!arr) foodWeeks.set(r.group_key, (arr = Array(weeks).fill(0)));
      arr[b] += r.n;
    }
  }

  const practiceWeeks = new Map<string, Set<string>[]>();
  if (targets.some((t) => t.scope_kind === "practice")) {
    for (const r of db
      .prepare(
        `SELECT practice, date FROM practice_logs
          WHERE profile_id = ? AND date >= ? AND date < ?`
      )
      .all(profileId, historyStart, currentStart) as {
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

  const zeros = Array(weeks).fill(0) as number[];
  const sizes = (buckets: Set<string>[] | undefined): number[] =>
    buckets ? buckets.map((s) => s.size) : zeros;

  return targets.map((t) => {
    let counts: number[];
    if (t.scope_kind === "region") {
      counts = sizes(regionWeeks.get(t.scope_value as MuscleRegion));
    } else if (t.scope_kind === "group") {
      const unions = dayBuckets();
      for (const reg of regionsForGroup(t.scope_value as BodyGroup)) {
        const arr = regionWeeks.get(reg);
        if (!arr) continue;
        arr.forEach((set, i) => {
          for (const d of set) unions[i].add(d);
        });
      }
      counts = unions.map((s) => s.size);
    } else if (t.scope_kind === "food_group") {
      counts = foodWeeks.get(t.scope_value) ?? zeros;
    } else if (t.scope_kind === "mobility_region") {
      counts = sizes(mobilityWeeks.get(t.scope_value as MuscleRegion));
    } else if (t.scope_kind === "practice") {
      counts = sizes(practiceWeeks.get(practiceIdentity(t.scope_value)));
    } else {
      counts = sizes(typeWeeks.get(t.scope_value));
    }
    return {
      target: t,
      weeks: weekStarts.map((start, i) => ({ start, count: counts[i] })),
      // `created_at` is a UTC `datetime('now')` stamp; its calendar day is what the
      // cold-start exclusion compares. A target created ON the window's first day
      // counts as having existed for it.
      existedWholeWindow: t.created_at.slice(0, 10) <= historyStart,
    };
  });
}
