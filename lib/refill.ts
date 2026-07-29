// Refill math — pure, no DB/network, so it's unit-tested in
// lib/__tests__. Given a supplement/medication's on-hand quantity, how many units
// one dose consumes, and how many doses land per day, it derives "≈N days of
// supply left" and whether that's low enough to nudge a refill. The DB decrement
// (on a confirmed dose) and the low-supply notification live in the query/notify
// layers; the arithmetic is here so it can be tested without a database.

import { shiftDateStr } from "./date";

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

// ── Shared supply pools (issue #1374) ────────────────────────────────────────
// One linked item's contribution to a shared bottle's consumption: its own doses/day
// (the #38 basis rate — actual taken-log where history is thick enough, scheduled
// estimate otherwise) times its own units-per-dose. `qtyPerDose` deliberately stays
// PER ITEM: an adult takes 2 tablets from the same bottle a child takes 1 from, so the
// pool has no units-per-dose of its own.
export interface PoolConsumer {
  dosesPerDay: number;
  qtyPerDose: number;
}

// Units/day drawn from a shared bottle = the SUM of its linked items' rates. This is
// the pooled analogue of unitsPerDay and the whole point of the pool: today, two
// members' items each project against their own private count and both read high.
// Non-finite / negative contributions are dropped rather than poisoning the sum.
export function pooledUnitsPerDay(consumers: readonly PoolConsumer[]): number {
  let total = 0;
  for (const c of consumers) {
    const units = unitsPerDay(c.dosesPerDay, c.qtyPerDose);
    if (Number.isFinite(units) && units > 0) total += units;
  }
  return total;
}

// "≈N days of supply left" for a shared bottle — the SAME daysOfSupplyLeft engine the
// per-item path uses ("one question, one computation"), fed the summed pooled rate as
// a units/day figure (so qtyPerDose is 1 here: the per-item units are already folded
// into pooledUnitsPerDay). Null when the pool tracks no quantity or nothing consumes it.
export function daysOfSupplyForPool(
  quantityOnHand: number | null,
  consumers: readonly PoolConsumer[]
): number | null {
  return daysOfSupplyLeft(quantityOnHand, 1, pooledUnitsPerDay(consumers));
}

// What the linked items get back when a pool is DELETED (the row-ops side-state rule).
// A pool's quantity is a physical fact about ONE bottle, so:
//   - exactly ONE linked item  → it takes the whole remaining quantity back. There is
//     no other claimant, so restoring it invents nothing and a one-member pool can be
//     unshared losslessly.
//   - two or more linked items → EVERY item returns to `quantity_on_hand = NULL`
//     (untracked, the pre-opt-in state). Copying the count onto each item would
//     recreate the exact phantom-double-supply bug pools exist to fix, and picking a
//     winner among equals would be arbitrary and silent. The delete confirmation shows
//     the remaining count so the user can re-enter it on whichever item actually holds
//     the bottle.
//   - a pool that tracked nothing (quantity NULL) restores NULL either way.
// Returns the quantity to write onto each unlinked item (null = untracked).
export function resolvePoolUnlinkRestore(
  remaining: number | null,
  linkedItemCount: number
): number | null {
  return linkedItemCount === 1 ? remaining : null;
}

// Which bottles a caller may SEE in the medicine cabinet — ONE rule, shared by the
// /supplies page itself and the "N shared bottles" doors its consumer surfaces now
// carry (#1522, the nav row's replacement). A pool is visible when any ACCESSIBLE
// profile draws from it, or when NOTHING links it at all: an orphaned bottle names
// nobody, so nothing is disclosed, and somebody has to be able to clear it. Pure, so
// the page's list and the header count can never disagree about what "in the cabinet"
// means. `memberProfileIds` is a pool's raw membership (cross-profile by
// construction); the caller supplies its already-authorized accessible set.
export function isPoolVisibleTo(
  memberProfileIds: readonly number[],
  accessible: ReadonlySet<number>
): boolean {
  return (
    memberProfileIds.length === 0 ||
    memberProfileIds.some((id) => accessible.has(id))
  );
}

// The label on those cabinet doors (#1522 part C). With bottles to count, the count IS
// the useful part ("3 shared bottles →") and doubles as the discoverability cue the
// cabinet never had. With none, the link keeps its NAME — "Medicine cabinet", the name
// deliberately retained once it stopped being a nav sibling of "Medications" — so an
// empty household still learns the surface exists rather than reading "0 shared
// bottles". Pure and shared so every door words it identically.
export function sharedSuppliesLinkLabel(count: number): string {
  if (count <= 0) return "Medicine cabinet";
  return `${count} shared ${count === 1 ? "bottle" : "bottles"}`;
}

// Normalize the raw `quantity_on_hand` form field (opt-in refill tracking): a blank
// or non-finite entry is NULL (untracked); otherwise the value floored at 0. Shared
// by the add/update actions AND the #467 loaded-value compare so both sides of that
// compare normalize identically.
export function parseQuantityOnHand(
  raw: FormDataEntryValue | null | undefined
): number | null {
  const s = String(raw ?? "").trim();
  return s === "" || !Number.isFinite(Number(s))
    ? null
    : Math.max(0, Number(s));
}

// Compare-and-set for the refill counter (issue #467). The supplement edit form
// writes `quantity_on_hand` as an ABSOLUTE value, but a confirmed dose decrements it
// concurrently — including from the poll sidecar (a Telegram ✅ tap → markDoseTaken →
// decrement), a genuinely separate process. A caregiver who opened the edit form when
// it showed 30, then saved an unrelated tweak after the patient logged a dose (30→29),
// would write 30 back and silently undo the decrement — on the safety-adjacent refill
// path, and the edit form IS the refill path (there is no separate "mark refilled"
// action). So the form also submits the value it LOADED with: only honor the submitted
// value when the user actually changed the field (submitted differs from loaded);
// otherwise keep whatever the counter now holds (`current`, re-read under the write
// lock). NULL-safe, so untracked ↔ tracked toggles compare cleanly. Returns the value
// to persist.
export function resolveOnHandWrite(
  submitted: number | null,
  loaded: number | null,
  current: number | null
): number | null {
  return submitted === loaded ? current : submitted;
}

// The one-tap "Refilled" write (issue #852 item 3). A refill ADDS `fillSize` units to
// whatever supply is on hand RIGHT NOW — `current`, the value re-read under the
// IMMEDIATE write lock, NOT the stale value the row was loaded with — so a dose confirm
// that decremented supply between page-load and the tap is preserved, not clobbered.
// That's the #467 CAS discipline applied to an increment rather than an absolute edit:
// the new value is computed RELATIVE to the lock-read current, and it routes through
// resolveOnHandWrite (current + fillSize submitted against `current` as both loaded and
// current) so the same compare-and-set gate governs it. Returns null when the item
// isn't tracking supply (quantity_on_hand NULL — nothing to add to) or the fill size is
// non-positive (no-op). `fillSize` is floored at 0.
export function resolveRefillWrite(
  current: number | null,
  fillSize: number
): number | null {
  if (current == null) return null;
  const fill = Math.max(0, fillSize);
  if (!(fill > 0)) return current;
  // submitted = current + fill, compared against `current` as loaded — a deliberate,
  // relative-to-current write that the CAS gate passes through unchanged.
  return resolveOnHandWrite(current + fill, current, current);
}

// The projected run-out DATE (issue #852 item 3): today shifted forward by the whole
// days of supply left, so a pharmacy hears "runs out ~Aug 3" rather than "≈19 days".
// Pure calendar arithmetic (shiftDateStr is UTC-anchored). Null when days-left can't be
// estimated (untracked / unestimable supply).
export function runOutDateStr(
  todayStr: string,
  daysLeft: number | null
): string | null {
  if (daysLeft == null) return null;
  return shiftDateStr(todayStr, Math.max(0, daysLeft));
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
