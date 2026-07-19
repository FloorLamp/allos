// Substance-use reads (issue #998): the alcohol reduction target + this-week
// consumption state and the trailing weekly trend. Consumption itself lives in the
// EXISTING food_log / food_log_events observation store (#860/#944 — a standard
// drink IS one serving of the curated `alcohol` food group), and the target lives
// on the EXISTING frequency_targets table (scope_kind 'substance', migration 072);
// this module only derives. Substance targets carry CAP semantics (a ceiling), the
// inverse of every other frequency scope's floor, which is why they are EXCLUDED
// from getFrequencyTargetProgress and read here instead — same table, dedicated
// (inverted) computation, one place.

import { db, today } from "../db";
import { getWeekMode, getWeekStart } from "../settings";
import { trailingWeeks } from "../week-window";
import { weekWindowStart } from "./training/common";
import { getWeeklyServingsForGroup } from "./nutrition";
import {
  ALCOHOL_FOOD_GROUP,
  substanceCapStatus,
  type Substance,
  type SubstanceCapStatus,
} from "../substance-use";

// A stored substance reduction target: per_week is the weekly CAP (≥ 0; 0 = an
// alcohol-free week target).
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

// This week's alcohol state: standard drinks logged (the SAME weekly food_log
// rollup the food-habit progress reads — one computation, #221) plus the target's
// cap status when a target is set. The week window follows the profile's
// configured week (mode + start) — no second "week" definition (#223).
export interface SubstanceWeekState {
  substance: Substance;
  weekStart: string;
  count: number; // standard drinks logged this week
  target: SubstanceTarget | null;
  status: SubstanceCapStatus | null; // null when no target is set
}

export function getSubstanceWeekState(profileId: number): SubstanceWeekState {
  const weekStart = weekWindowStart(profileId);
  const count = getWeeklyServingsForGroup(
    profileId,
    ALCOHOL_FOOD_GROUP,
    weekStart
  );
  const target = getSubstanceTarget(profileId, "alcohol");
  return {
    substance: "alcohol",
    weekStart,
    count,
    target,
    status: target ? substanceCapStatus(count, target.cap) : null,
  };
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

export function getAlcoholWeeklyTrend(
  profileId: number,
  weeks: number = SUBSTANCE_TREND_WEEKS
): SubstanceTrendWeek[] {
  const wins = trailingWeeks(
    today(profileId),
    getWeekMode(profileId),
    getWeekStart(profileId),
    weeks
  );
  const oldest = wins[0].start;
  const rows = db
    .prepare(
      `SELECT date, servings FROM food_log
        WHERE profile_id = ? AND group_key = ? AND date >= ?`
    )
    .all(profileId, ALCOHOL_FOOD_GROUP, oldest) as {
    date: string;
    servings: number;
  }[];
  return wins.map((w) => ({
    start: w.start,
    end: w.end,
    isCurrent: w.isCurrent,
    count: rows
      .filter((r) => r.date >= w.start && r.date <= w.end)
      .reduce((sum, r) => sum + r.servings, 0),
  }));
}
