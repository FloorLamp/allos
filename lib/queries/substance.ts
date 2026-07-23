// Substance-use reads (issues #998, #1078): the per-substance reduction target +
// this-week consumption state and the trailing weekly trend. Consumption is a
// SPLIT LEDGER dispatched per substance ("one question, one computation", #221):
// alcohol rides the EXISTING food_log / food_log_events observation store
// (#860/#944 — a standard drink IS one serving of the curated `alcohol` food
// group), while nicotine/cannabis ride the dedicated `substance_log` counter
// ledger (migration 098 — not foods, so they never touch the nutrition ledger).
// The target lives on the EXISTING frequency_targets table (scope_kind
// 'substance', migration 072) for every substance; this module only derives.
// Substance targets carry CAP semantics (a ceiling), the inverse of every other
// frequency scope's floor, which is why they are EXCLUDED from
// getFrequencyTargetProgress and read here instead — same table, dedicated
// (inverted) computation, one place. Both week readers share the SAME profile
// week window (weekWindowStart / trailingWeeks) — no second "week" definition
// (#223).

import { db, today } from "../db";
import { getWeekMode, getWeekStart } from "../settings";
import { trailingWeeks } from "../week-window";
import { weekWindowStart } from "./training/common";
import { getWeeklyServingsForGroup } from "./nutrition";
import {
  ALCOHOL_FOOD_GROUP,
  SUBSTANCES,
  substanceDef,
  substanceCapStatus,
  type Substance,
  type SubstanceCapStatus,
} from "../substance-use";

// A stored substance reduction target: per_week is the weekly CAP (≥ 0; 0 = a
// substance-free week target).
export interface SubstanceTarget {
  id: number;
  substance: Substance;
  cap: number;
  created_at: string;
}

export function getSubstanceTarget(
  profileId: number,
  substance: Substance
): SubstanceTarget | null {
  const row = db
    .prepare(
      `SELECT id, scope_value, per_week, created_at FROM frequency_targets
        WHERE profile_id = ? AND scope_kind = 'substance' AND scope_value = ?`
    )
    .get(profileId, substance) as
    | { id: number; scope_value: string; per_week: number; created_at: string }
    | undefined;
  if (!row) return null;
  return {
    id: row.id,
    substance,
    cap: row.per_week,
    created_at: row.created_at,
  };
}

// This week's units for a substance_log-ledger substance (nicotine/cannabis) —
// the SUM twin of getWeeklyServingsForGroup over the same week window.
function getWeeklySubstanceUnits(
  profileId: number,
  substance: Substance,
  weekStart: string
): number {
  const row = db
    .prepare(
      `SELECT COALESCE(SUM(units), 0) AS n FROM substance_log
        WHERE profile_id = ? AND date >= ? AND substance = ?`
    )
    .get(profileId, weekStart, substance) as { n: number };
  return row.n;
}

// This week's state for ONE substance: units logged (dispatched to the
// substance's ledger — the SAME weekly rollup its other surfaces read, #221)
// plus the target's cap status when a target is set.
export interface SubstanceWeekState {
  substance: Substance;
  weekStart: string;
  count: number; // units logged this week (standard drinks / uses)
  target: SubstanceTarget | null;
  status: SubstanceCapStatus | null; // null when no target is set
}

export function getSubstanceWeekState(
  profileId: number,
  substance: Substance
): SubstanceWeekState {
  const weekStart = weekWindowStart(profileId);
  const count =
    substanceDef(substance).ledger === "food-log"
      ? getWeeklyServingsForGroup(profileId, ALCOHOL_FOOD_GROUP, weekStart)
      : getWeeklySubstanceUnits(profileId, substance, weekStart);
  const target = getSubstanceTarget(profileId, substance);
  return {
    substance,
    weekStart,
    count,
    target,
    status: target ? substanceCapStatus(count, target.cap) : null,
  };
}

// Every tracked substance's week state, in catalog order — the page's section
// list and the findings builder both iterate this (one computation each way).
export function getAllSubstanceWeekStates(
  profileId: number
): SubstanceWeekState[] {
  return SUBSTANCES.map((s) => getSubstanceWeekState(profileId, s));
}

// One week of the trailing consumption trend (oldest first). The current
// (possibly partial) week's total equals getSubstanceWeekState().count for the
// same fixture — same week identity, same SUM (#221/#223).
export interface SubstanceTrendWeek {
  start: string;
  end: string;
  isCurrent: boolean;
  count: number;
}

export const SUBSTANCE_TREND_WEEKS = 8;

export function getSubstanceWeeklyTrend(
  profileId: number,
  substance: Substance,
  weeks: number = SUBSTANCE_TREND_WEEKS
): SubstanceTrendWeek[] {
  const wins = trailingWeeks(
    today(profileId),
    getWeekMode(profileId),
    getWeekStart(profileId),
    weeks
  );
  const oldest = wins[0].start;
  const rows =
    substanceDef(substance).ledger === "food-log"
      ? (db
          .prepare(
            `SELECT date, servings AS units FROM food_log
              WHERE profile_id = ? AND group_key = ? AND date >= ?`
          )
          .all(profileId, ALCOHOL_FOOD_GROUP, oldest) as {
          date: string;
          units: number;
        }[])
      : (db
          .prepare(
            `SELECT date, units FROM substance_log
              WHERE profile_id = ? AND substance = ? AND date >= ?`
          )
          .all(profileId, substance, oldest) as {
          date: string;
          units: number;
        }[]);
  return wins.map((w) => ({
    start: w.start,
    end: w.end,
    isCurrent: w.isCurrent,
    count: rows
      .filter((r) => r.date >= w.start && r.date <= w.end)
      .reduce((sum, r) => sum + r.units, 0),
  }));
}

// Back-compat alias (#998 callers): the alcohol trend is the generalized trend
// dispatched to the food-log ledger.
export function getAlcoholWeeklyTrend(
  profileId: number,
  weeks: number = SUBSTANCE_TREND_WEEKS
): SubstanceTrendWeek[] {
  return getSubstanceWeeklyTrend(profileId, "alcohol", weeks);
}
