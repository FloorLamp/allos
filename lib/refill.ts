// Refill math — pure, no DB/network, so it's unit-tested in
// lib/__tests__. Given a supplement/medication's on-hand quantity, how many units
// one dose consumes, and how many doses land per day, it derives "≈N days of
// supply left" and whether that's low enough to nudge a refill. The DB decrement
// (on a confirmed dose) and the low-supply notification live in the query/notify
// layers; the arithmetic is here so it can be tested without a database.

// Default low-supply threshold: nudge when roughly a week and a half of supply
// remains, leaving time to reorder a prescription before running out.
export const DEFAULT_LOW_SUPPLY_DAYS = 10;

// Consumption-rate estimation (issue #38). Doses/day was historically approximated
// as the COUNT of scheduled dose rows, which treats a workout-only / situational
// supplement as if it were taken daily and makes "≈N days left" run out (and the
// refill nudge fire) far too early. Instead we prefer the ACTUAL taken-log rate:
// confirmed doses over a trailing window ÷ the window length. We fall back to the
// schedule count only when history is too thin to trust.
export const RATE_WINDOW_DAYS = 30; // trailing window for the actual-rate average
export const MIN_HISTORY_DAYS = 14; // need at least this much history to trust it

// How a doses/day rate was derived: from the trailing taken-log window
// ('history') or from the scheduled-dose-count fallback ('schedule').
export type RateBasis = "history" | "schedule";

export interface DoseRate {
  dosesPerDay: number;
  basis: RateBasis;
}

// Derive a consumption rate (doses/day) for one item from its actual intake
// history, falling back to the scheduled-dose-count estimate when history is thin.
// Pure — the caller gathers the DB inputs:
//   - confirmedInWindow: confirmed (taken) doses logged in the trailing window
//   - daysSinceFirstLog: whole days since the item's FIRST-ever log (null = none)
//   - scheduleDosesPerDay: fallback rate ≈ number of scheduled dose rows
// Fallback (basis 'schedule') when history is too thin to average meaningfully:
// the item has logged for fewer than `minHistoryDays`, or has zero confirmations
// in the window (e.g. paused, or all logs older than the window). Otherwise the
// rate is confirmedInWindow over the EFFECTIVE window (basis 'history'): the
// window capped at how long the item has actually been logged, so an item first
// logged 15 days ago divides by 15, not 30. Dividing a young item's count by the
// full window would halve its rate and overstate days-left, making the low-supply
// nudge fire late (running out unwarned) — worse than the old too-early bias.
export function consumptionRate(
  confirmedInWindow: number,
  daysSinceFirstLog: number | null,
  scheduleDosesPerDay: number,
  windowDays: number = RATE_WINDOW_DAYS,
  minHistoryDays: number = MIN_HISTORY_DAYS
): DoseRate {
  const thinHistory =
    daysSinceFirstLog == null ||
    daysSinceFirstLog < minHistoryDays ||
    confirmedInWindow <= 0 ||
    !(windowDays > 0);
  if (thinHistory) {
    return { dosesPerDay: scheduleDosesPerDay, basis: "schedule" };
  }
  // +1: a first log `n` days ago spans n+1 calendar days of tracking.
  const effectiveDays = Math.min(windowDays, daysSinceFirstLog + 1);
  return { dosesPerDay: confirmedInWindow / effectiveDays, basis: "history" };
}

// Short, human-facing note explaining which basis a days-left estimate used, for
// the "≈N days left" tooltip/label on the supplements page.
export function refillBasisLabel(basis: RateBasis): string {
  return basis === "history"
    ? "based on your last 30 days"
    : "based on schedule";
}

// Units consumed per day = doses/day × units/dose. Guards against nonsense inputs
// (a non-positive rate means "can't estimate", surfaced as null upstream).
export function unitsPerDay(dosesPerDay: number, qtyPerDose: number): number {
  return dosesPerDay * qtyPerDose;
}

// Whole days of supply remaining, or null when it can't be estimated: quantity
// isn't tracked (null), or the consumption rate is non-positive. Floored to whole
// days so "≈N days left" is the conservative "you have at least N full days".
export function daysOfSupplyLeft(
  quantityOnHand: number | null,
  qtyPerDose: number,
  dosesPerDay: number
): number | null {
  if (quantityOnHand == null) return null;
  const perDay = unitsPerDay(dosesPerDay, qtyPerDose);
  if (!(perDay > 0)) return null; // nothing consumed → no finite runway
  if (quantityOnHand <= 0) return 0;
  return Math.floor(quantityOnHand / perDay);
}

// Whether the remaining supply is at or below the refill threshold. A null
// days-left (untracked / unestimable) is never "low" — there's nothing to nudge.
export function isLowSupply(
  daysLeft: number | null,
  thresholdDays: number = DEFAULT_LOW_SUPPLY_DAYS
): boolean {
  return daysLeft != null && daysLeft <= thresholdDays;
}

// One item's "≈N days of supply left", as EVERY refill surface computes it
// (issue #301). The doses/day comes from the SHARED getRefillRates DoseRate —
// its history-aware taken-log rate, or the schedule-count fallback baked into
// getRefillRates — dropping to `fallbackDosesPerDay` only when the item has no
// rate at all (e.g. quantity tracked but no doses and no history). The /medicine
// row badge and the dashboard Low-supply widget both format over this, so they
// can never disagree about how long an item lasts ("one question, one
// computation": lib/refill is the engine, surfaces are formatters).
export function daysOfSupplyForItem(
  quantityOnHand: number | null,
  qtyPerDose: number,
  rate: DoseRate | null,
  fallbackDosesPerDay = 0
): number | null {
  return daysOfSupplyLeft(
    quantityOnHand,
    qtyPerDose,
    rate?.dosesPerDay ?? fallbackDosesPerDay
  );
}

// Minimal shape the low-supply selection needs off an intake item.
export interface RefillTrackedItem {
  id: number;
  name: string;
  kind: "supplement" | "medication";
  quantity_on_hand: number | null;
  qty_per_dose: number;
}

// One item flagged as running low, for the dashboard widget.
export interface LowSupplyItem {
  id: number;
  name: string;
  kind: "supplement" | "medication";
  daysLeft: number;
}

// The dashboard Low-supply widget's list — a PURE formatter over the shared
// getRefillRates rates (issue #301), so it agrees with the /medicine badge,
// Upcoming, and the Telegram nudge instead of hand-rolling a schedule-count
// rate from the raw dose-row count (the deprecated method the header warns
// against). Keeps only items whose estimated days-left is at/below the
// threshold, most-urgent first. Each item's days-left is `daysOfSupplyForItem`,
// the SAME computation the /medicine row uses.
export function selectLowSupplyItems(
  items: RefillTrackedItem[],
  rates: Map<number, DoseRate>,
  thresholdDays: number = DEFAULT_LOW_SUPPLY_DAYS
): LowSupplyItem[] {
  return items
    .map((s) => ({
      s,
      days: daysOfSupplyForItem(
        s.quantity_on_hand,
        s.qty_per_dose,
        rates.get(s.id) ?? null
      ),
    }))
    .filter((x) => isLowSupply(x.days, thresholdDays))
    .map((x) => ({
      id: x.s.id,
      name: x.s.name,
      kind: x.s.kind,
      daysLeft: x.days as number,
    }))
    .sort((a, b) => a.daysLeft - b.daysLeft);
}
