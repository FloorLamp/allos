// Refill math (issue #103 Phase B) — pure, no DB/network, so it's unit-tested in
// lib/__tests__. Given a supplement/medication's on-hand quantity, how many units
// one dose consumes, and how many doses land per day, it derives "≈N days of
// supply left" and whether that's low enough to nudge a refill. The DB decrement
// (on a confirmed dose) and the low-supply notification live in the query/notify
// layers; the arithmetic is here so it can be tested without a database.

// Default low-supply threshold: nudge when roughly a week and a half of supply
// remains, leaving time to reorder a prescription before running out.
export const DEFAULT_LOW_SUPPLY_DAYS = 10;

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
