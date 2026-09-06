// Substance-use reads (issues #998, #1078): the per-substance reduction target +
// this-week consumption state and the trailing weekly trend. Consumption is a
// SPLIT LEDGER dispatched per substance ("one question, one computation", #221):
// alcohol rides the EXISTING food_daily_totals / food_log_events observation store
// (#860/#944 — a standard drink IS one serving of the curated `alcohol` food
// group), while nicotine/cannabis ride the dedicated `substance_daily_totals` counter
// ledger (migration 096 — not foods, so they never touch the nutrition ledger).
// The target lives on the EXISTING frequency_targets table (scope_kind
// 'substance', migration 072) for every substance; this module only derives.
// Substance targets carry CAP semantics (a ceiling), the inverse of every other
// frequency scope's floor. Since #2034 that is a DECLARED axis rather than a
// separate module: these reads are the `direction: "cap"` tenant of the one
// cadence ledger (lib/queries/cadence-ledger.ts), so they share its week windows,
// its per-source gathers and its verdict vocabulary with the floor readers while
// keeping the anti-nudge guarantee that made them separate in the first place —
// a cap week has no "N to go" state to render. This module is the substance-shaped
// formatting over that tenant.

import { db } from "../db";
import { pageCount, pageOffset } from "../pagination";
import {
  cadenceWindows,
  getCadenceScopeCounts,
  type CadenceWindow,
} from "./cadence-ledger";
import {
  ALCOHOL_FOOD_GROUP,
  SUBSTANCES,
  substanceCapStatus,
  substanceDef,
  type SubstanceCapStatus,
  type SubstanceKey,
} from "../substance-use";

// A stored substance reduction target: per_week is the weekly CAP (≥ 0; 0 = a
// substance-free week target).
export interface SubstanceTarget {
  id: number;
  substance: SubstanceKey;
  cap: number;
  created_at: string;
}

// The unified consumption-history row (#2009). There is deliberately no ledger
// field: each card and every mutation addresses a substance plus this row id,
// while the query layer owns dispatch to food_daily_totals or substance_daily_totals.
// No note: a note is a use's fact and lives on the event (#5304); the day columns
// that used to hold one are left standing, uncollected and unread.
export interface SubstanceDailyTotal {
  id: number;
  substance: SubstanceKey;
  date: string;
  amount: number;
}

export function getSubstanceDailyTotals(
  profileId: number,
  substance: SubstanceKey
): SubstanceDailyTotal[] {
  const rows =
    substanceDef(substance).ledger === "food-log"
      ? (db
          .prepare(
            `SELECT id, date, servings AS amount
             FROM food_daily_totals
             WHERE profile_id = ? AND group_key = ?
             ORDER BY date DESC, id DESC`
          )
          .all(profileId, ALCOHOL_FOOD_GROUP) as {
          id: number;
          date: string;
          amount: number;
        }[])
      : (db
          .prepare(
            `SELECT id, date, units AS amount
             FROM substance_daily_totals
             WHERE profile_id = ? AND substance = ?
             ORDER BY date DESC, id DESC`
          )
          .all(profileId, substance) as {
          id: number;
          date: string;
          amount: number;
        }[]);
  return rows.map((row) => ({ ...row, substance }));
}

// THIS PROFILE'S SUBSTANCE VOCABULARY: the curated catalog (always, in catalog order —
// they are the app's offered defaults whether or not anything is logged), then every
// custom key this profile has a ledger row for, alphabetically. #3279 ruling 2's read
// half: a custom substance is not registered before use, so the LEDGER is the register.
//
// The custom half is deliberately data-presence-only. A key that has been fully undone
// down to zero leaves no row (undoSubstanceUnitCore drops it), so the substance quietly
// stops being part of the profile's vocabulary — the same "it exists because it is used"
// contract custom symptoms have, and the reason no delete/forget affordance is needed.
// A profile that never logs one sees exactly the curated three.
//
// Alcohol's rows live on food_daily_totals and no CUSTOM substance ever does (see
// lib/substance-use.ts), so scanning substance_daily_totals alone finds every custom key
// there can be.
export function getProfileSubstanceKeys(profileId: number): SubstanceKey[] {
  const rows = db
    .prepare(
      `SELECT DISTINCT substance FROM substance_daily_totals
        WHERE profile_id = ?
        ORDER BY substance`
    )
    .all(profileId) as { substance: string }[];
  const custom = rows
    .map((r) => r.substance)
    .filter((s) => !(SUBSTANCES as readonly string[]).includes(s));
  return [...SUBSTANCES, ...custom];
}

// ---- WHAT THIS PROFILE ACTUALLY TRACKS (#3327) ------------------------------
//
// `getProfileSubstanceKeys` above answers "what is this profile's VOCABULARY?", and
// its answer always opens with the curated three, because they are the app's offered
// defaults on the page that offers them. That is the wrong question for a quick
// surface: the sheet must not offer alcohol, nicotine and cannabis to somebody who has
// never logged any of them — an empty offer is worse than no offer (#3327), and
// #3279 ruling 3 admits a substance to the quick surfaces on DATA PRESENCE, not on the
// vocabulary at large.
//
// So this asks the narrower question: which substances does this profile have a ledger
// row for? Every custom key already qualifies by construction — the ledger IS its
// register, so a key only appears in the DISTINCT scan because rows exist — and the
// three curated keys are the only ones that can be present-in-vocabulary and
// absent-in-fact, so only they need the probe. Alcohol's probe reads food_daily_totals
// because that is alcohol's ledger (#860/#944), through the same dispatch every other
// read here uses.
//
// EVER-LOGGED, not recently-logged. A frequency floor was considered and left out: a
// substance named through #3326 this morning would sit below any such floor for weeks,
// so the surface that just took the trouble to create it would refuse to offer it —
// which reads as broken, not as restraint. The cost of the looser rule is one extra row
// for somebody who logged a drink once a year ago; the cost of the tighter one is the
// feature being invisible exactly when it is new. See the open question on #3327 if
// this needs revisiting.
export function getLoggedSubstanceKeys(profileId: number): SubstanceKey[] {
  return getProfileSubstanceKeys(profileId).filter((substance) =>
    substanceDef(substance).ledger === "food-log"
      ? db
          .prepare(
            `SELECT 1 FROM food_daily_totals
              WHERE profile_id = ? AND group_key = ? LIMIT 1`
          )
          .get(profileId, ALCOHOL_FOOD_GROUP) != null
      : db
          .prepare(
            `SELECT 1 FROM substance_daily_totals
              WHERE profile_id = ? AND substance = ? LIMIT 1`
          )
          .get(profileId, substance) != null
  );
}

// Whether the quick-log sheet offers this profile a substance row at all. Its own
// function rather than `getLoggedSubstanceKeys(...).length > 0` because it is read
// once per APP-SHELL RENDER, on every route — the list is gathered later, on open, by
// the overlay's own read action, which is both cheaper and fresher (#1468).
export function hasLoggedSubstance(profileId: number): boolean {
  const anyCustom = db
    .prepare(
      `SELECT 1 FROM substance_daily_totals WHERE profile_id = ? LIMIT 1`
    )
    .get(profileId);
  if (anyCustom != null) return true;
  return (
    db
      .prepare(
        `SELECT 1 FROM food_daily_totals
          WHERE profile_id = ? AND group_key = ? LIMIT 1`
      )
      .get(profileId, ALCOHOL_FOOD_GROUP) != null
  );
}

export function getAllSubstanceDailyTotals(
  profileId: number
): SubstanceDailyTotal[] {
  return getProfileSubstanceKeys(profileId)
    .flatMap((substance) => getSubstanceDailyTotals(profileId, substance))
    .sort((a, b) => b.date.localeCompare(a.date) || b.id - a.id);
}

// ── THE USE LEDGER (#5026 phase 2) ───────────────────────────────────────────
//
// One page of USE rows — the event table rather than its day counter, because the
// record names a single use and corrects it there. `getFoodLedgerPage`
// (lib/queries/nutrition.ts) re-instantiated for `substance_log_events`: same window,
// same ordering rule (stated instant first, tap stamp as the fallback), same
// bounded-page contract, so `/history` reads both consumable ledgers through one shape.
export interface SubstanceLedgerRow {
  id: number;
  substance: string;
  date: string;
  recorded_at: string;
  occurred_at: string | null;
  notes: string | null;
}

export function getSubstanceLedgerPage(
  profileId: number,
  from: string,
  options: { untilDate?: string | null; substance?: string },
  page: number,
  pageSize: number
): { rows: SubstanceLedgerRow[]; total: number; page: number } {
  const requestedPage = Math.max(1, Math.floor(page));
  const boundedSize = Math.max(1, Math.floor(pageSize));
  const where = ["date >= ?"];
  const args: Array<string | number> = [profileId, from];
  if (options.untilDate) {
    where.push("date <= ?");
    args.push(options.untilDate);
  }
  if (options.substance) {
    where.push("substance = ?");
    args.push(options.substance);
  }
  const total = (
    db
      .prepare(
        `SELECT COUNT(*) AS n FROM substance_log_events
          WHERE profile_id = ? AND ${where.join(" AND ")}`
      )
      .get(...args) as { n: number }
  ).n;
  const boundedPage = Math.min(requestedPage, pageCount(total, boundedSize));
  const rows = db
    .prepare(
      `SELECT id, substance, date, recorded_at, occurred_at, notes
         FROM substance_log_events
        WHERE profile_id = ? AND ${where.join(" AND ")}
        ORDER BY date DESC, COALESCE(occurred_at, recorded_at) DESC, id DESC
        LIMIT ? OFFSET ?`
    )
    .all(
      ...args,
      boundedSize,
      pageOffset(boundedPage, boundedSize)
    ) as SubstanceLedgerRow[];
  return { rows, total, page: boundedPage };
}

export function getSubstanceTarget(
  profileId: number,
  substance: SubstanceKey
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

// The cadence-ledger scope a substance is counted through. The ledger owns the
// dispatch to the substance's own store (alcohol on food_daily_totals — a standard drink IS
// one serving of the curated `alcohol` food group; nicotine/cannabis on the
// substance_daily_totals counter ledger), so this module never re-decides it.
const substanceScope = (substance: SubstanceKey) =>
  ({ kind: "substance", value: substance }) as const;

// This week's state for ONE substance: units logged (the SAME weekly rollup its
// other surfaces read, #221) plus the target's cap status when a target is set.
export interface SubstanceWeekState {
  substance: SubstanceKey;
  weekStart: string;
  count: number; // units logged this week (standard drinks / uses)
  target: SubstanceTarget | null;
  status: SubstanceCapStatus | null; // null when no target is set
}

export function getSubstanceWeekState(
  profileId: number,
  substance: SubstanceKey
): SubstanceWeekState {
  const [window] = cadenceWindows(profileId, {
    weeks: 1,
    includeCurrent: true,
  });
  const count = getCadenceScopeCounts(profileId, substanceScope(substance), [
    window,
  ])[0];
  const target = getSubstanceTarget(profileId, substance);
  return {
    substance,
    weekStart: window.start,
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
  return getProfileSubstanceKeys(profileId).map((s) =>
    getSubstanceWeekState(profileId, s)
  );
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
  substance: SubstanceKey,
  weeks: number = SUBSTANCE_TREND_WEEKS
): SubstanceTrendWeek[] {
  const windows: CadenceWindow[] = cadenceWindows(profileId, {
    weeks,
    includeCurrent: true,
  });
  const counts = getCadenceScopeCounts(
    profileId,
    substanceScope(substance),
    windows
  );
  return windows.map((w, i) => ({
    start: w.start,
    end: w.end,
    isCurrent: w.isCurrent,
    count: counts[i],
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
