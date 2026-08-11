// Part of the lib/queries/intake barrel (#319 — same #126 treatment training
// got). The profile-scoping guard walks all of lib/, so these split modules stay
// covered; every read is profile-scoped directly or through the parent
// intake_items JOIN.
// Refill tracking: effective consumption-rate math and the on-hand supply
// increment/decrement kept in lock-step with the dose logs.
import { db, today, writeTx } from "../../db";
import { shiftDateStr } from "../../date";
import {
  consumptionRate,
  resolveRefillWrite,
  RATE_WINDOW_DAYS,
  type DoseRate,
} from "../../refill";
import { getIntakeDoses, getIntakeItems } from "./schedule";
import { cadenceDensity } from "../../intake-cadence";

// Effective consumption rate (doses/day) + its basis for every item that has
// either scheduled doses or logged history, for refill "≈N days left" math
// (issue #38). Prefers the ACTUAL taken-log rate — confirmed doses in the last
// RATE_WINDOW_DAYS ÷ the window — over the scheduled-dose-count estimate, falling
// back to the count when history is thin (see lib/refill's consumptionRate). The
// gather is profile-scoped: the history read JOINs intake_items and filters
// s.profile_id (logs/doses are child tables reached through the parent), and the
// schedule count reuses the profile-scoped getIntakeDoses. Callers (the
// supplements page, Upcoming, and the refill notifier) all read the shared rate
// from here rather than re-approximating it.
export function getRefillRates(
  profileId: number,
  windowDays: number = RATE_WINDOW_DAYS
): Map<number, DoseRate> {
  const todayStr = today(profileId);
  // Inclusive trailing window of `windowDays` calendar days ending today.
  const windowStart = shiftDateStr(todayStr, -(windowDays - 1));
  const todayMs = Date.parse(`${todayStr}T00:00:00Z`);

  // Per-item: confirmations inside the window + the first-ever log date. Only a
  // TAKEN log row is consumption — a skipped dose (issue #232) burned no supply,
  // so it must not inflate the consumption rate. Profile-scoped through the
  // parent intake_items JOIN.
  const rows = db
    .prepare(
      `SELECT l.item_id AS sid,
              SUM(CASE WHEN l.date >= ? THEN 1 ELSE 0 END) AS in_window,
              MIN(l.date) AS first_date
         FROM intake_item_logs l
         JOIN intake_items s ON s.id = l.item_id
        WHERE s.profile_id = ? AND l.status = 'taken'
        GROUP BY l.item_id`
    )
    .all(windowStart, profileId) as {
    sid: number;
    in_window: number;
    first_date: string | null;
  }[];
  const history = new Map(rows.map((r) => [r.sid, r]));

  // Fallback rate ≈ scheduled dose rows per item, SCALED BY CADENCE DENSITY (#1602).
  // The count of rows answers "how many doses on a day it lands", not "per day": a
  // weekly med with one dose row consumes 1/7 of a tablet per day, so 12 tablets are
  // ≈12 weeks of supply, not ≈12 days. Without the scaling the low-supply nudge would
  // fire on a weekly med almost immediately and then keep firing — the refill-nagging
  // twin of the daily-reminder problem this issue exists to fix.
  //
  // Only the SCHEDULE fallback needs it. The history-based rate is measured from the
  // taken log, which already contains the real cadence, so scaling it would double-count.
  const cadenceById = new Map(
    getIntakeItems(profileId).map((s) => [s.id, cadenceDensity(s)])
  );
  const scheduleCount = new Map<number, number>();
  for (const d of getIntakeDoses(profileId)) {
    scheduleCount.set(d.item_id, (scheduleCount.get(d.item_id) ?? 0) + 1);
  }

  const out = new Map<number, DoseRate>();
  const ids = new Set<number>([...scheduleCount.keys(), ...history.keys()]);
  for (const id of ids) {
    const h = history.get(id);
    const daysSinceFirstLog =
      h?.first_date != null
        ? Math.round(
            (todayMs - Date.parse(`${h.first_date}T00:00:00Z`)) / 86_400_000
          )
        : null;
    out.set(
      id,
      consumptionRate(
        h?.in_window ?? 0,
        daysSinceFirstLog,
        (scheduleCount.get(id) ?? 0) * (cadenceById.get(id) ?? 1),
        windowDays
      )
    );
  }
  return out;
}

// Refill decrement/increment. Adjust an item's on-hand
// quantity by one dose's worth (qty_per_dose), only when tracking is enabled
// (quantity_on_hand not null). Profile-scoped, so a forged id can't touch another
// profile's row. Callers keep the adjustment in lock-step with the existing
// per-(dose,date) log dedup, so confirming twice never double-counts.
//
// The decrement is NOT floored at 0: an over-logged item is allowed to go
// negative so that incrementSupply (on untoggle) is its exact inverse and can
// never over-credit supply above the original. If we clamped here, untoggling a
// dose taken while already near/at empty would hand back a full qty_per_dose that
// was never removed, inventing supply. A negative on-hand reads as "out" (days-
// of-supply math floors <=0 to 0, and the edit form clamps the shown value), and
// a manual refill overwrites it outright.
// SHARED SUPPLY POOLS (#1374): when the item carries a `supply_id`, the adjustment
// lands on the POOL instead of the item's private counter — one bottle, one count, every
// taker drawing from it. This is the ONE place either adjustment is written, so every
// dose-log path (the page tri-state, the dashboard hero, Upcoming, the household
// cockpit's cross-profile confirm, PRN quick-log, the historical-dose backfill, the
// offline replay, and every Telegram tap) becomes pool-aware without a second decrement
// path. The item's own `qty_per_dose` is what's drawn — an adult and a child share a
// bottle but not a dose size.
//
// The item lookup is profile-scoped, so a forged id can neither touch another profile's
// item nor reach the pool through it.
function poolIdFor(profileId: number, supplementId: number): number | null {
  const row = db
    .prepare(
      `SELECT supply_id FROM intake_items WHERE id = ? AND profile_id = ?`
    )
    .get(supplementId, profileId) as { supply_id: number | null } | undefined;
  return row?.supply_id ?? null;
}

// `sign` is +1 (credit, an untoggle/undo) or -1 (consume). The pool UPDATE draws the
// LINKED ITEM's qty_per_dose via a scalar subquery so the two sides stay exact inverses,
// and no-ops when the pool isn't tracking a quantity — mirroring the item branch.
function adjustSupply(
  profileId: number,
  supplementId: number,
  sign: 1 | -1
): void {
  const supplyId = poolIdFor(profileId, supplementId);
  if (supplyId != null) {
    db.prepare(
      `UPDATE shared_supplies
          SET quantity_on_hand = quantity_on_hand + ? * (
                SELECT qty_per_dose FROM intake_items
                 WHERE id = ? AND profile_id = ?
              ),
              updated_at = datetime('now')
        WHERE id = ? AND quantity_on_hand IS NOT NULL`
    ).run(sign, supplementId, profileId, supplyId);
    return;
  }
  db.prepare(
    `UPDATE intake_items
        SET quantity_on_hand = quantity_on_hand + ? * qty_per_dose
      WHERE id = ? AND profile_id = ? AND quantity_on_hand IS NOT NULL`
  ).run(sign, supplementId, profileId);
}

export function decrementSupply(profileId: number, supplementId: number): void {
  adjustSupply(profileId, supplementId, -1);
}

export function incrementSupply(profileId: number, supplementId: number): void {
  adjustSupply(profileId, supplementId, 1);
}

// The typed outcome of a one-tap "Refilled" (issue #852 item 3) — handlers answer from
// it, never unconditionally confirm.
export type RefillOutcome =
  | { kind: "refilled"; newQuantity: number; fillSize: number }
  // No fill size available (first use, nothing remembered) — the UI must ask for one.
  | { kind: "needs-size" }
  // The item doesn't track supply (quantity_on_hand NULL) — nothing to refill into.
  | { kind: "untracked" }
  // Not owned by the profile / removed.
  | { kind: "stale-item" };

// Record a refill: add `fillSize` units to the item's on-hand supply and REMEMBER that
// size (last_fill_size) for next time. When `fillSize` is null, reuse the remembered
// size; if none is remembered, return "needs-size" so the caller asks. The whole read-
// modify-write runs in ONE writeTx (BEGIN IMMEDIATE): the on-hand value is re-read
// under the write lock and the fill is added RELATIVE to it via resolveRefillWrite, so a
// dose confirm that decremented supply between page-load and the tap is preserved, not
// clobbered (the #467 CAS discipline applied to an increment). Profile-scoped: a forged
// id can't touch another profile's row.
export function refillSupply(
  profileId: number,
  itemId: number,
  fillSize: number | null
): RefillOutcome {
  return writeTx(() => {
    const row = db
      .prepare(
        `SELECT quantity_on_hand, qty_per_dose, last_fill_size, supply_id
           FROM intake_items WHERE id = ? AND profile_id = ?`
      )
      .get(itemId, profileId) as
      | {
          quantity_on_hand: number | null;
          qty_per_dose: number;
          last_fill_size: number | null;
          supply_id: number | null;
        }
      | undefined;
    if (!row) return { kind: "stale-item" };
    // A POOLED item (#1374) refills the shared bottle, not its own (always NULL)
    // counter — same lock-read-relative increment, applied to the pool row. The
    // remembered fill size stays on the ITEM: "I buy the 90-count bottle" is a fact
    // about how this person restocks, and the pool has no single restocker.
    if (row.supply_id != null) {
      const pool = db
        .prepare("SELECT quantity_on_hand FROM shared_supplies WHERE id = ?")
        .get(row.supply_id) as { quantity_on_hand: number | null } | undefined;
      if (!pool) return { kind: "stale-item" };
      if (pool.quantity_on_hand == null) return { kind: "untracked" };
      const remembered =
        row.last_fill_size != null && row.last_fill_size > 0
          ? row.last_fill_size
          : null;
      const fill = fillSize != null && fillSize > 0 ? fillSize : remembered;
      if (fill == null) return { kind: "needs-size" };
      const next = resolveRefillWrite(pool.quantity_on_hand, fill) as number;
      db.prepare(
        `UPDATE shared_supplies SET quantity_on_hand = ?, updated_at = datetime('now')
          WHERE id = ?`
      ).run(next, row.supply_id);
      db.prepare(
        "UPDATE intake_items SET last_fill_size = ? WHERE id = ? AND profile_id = ?"
      ).run(fill, itemId, profileId);
      return { kind: "refilled", newQuantity: next, fillSize: fill };
    }
    if (row.quantity_on_hand == null) return { kind: "untracked" };
    const remembered =
      row.last_fill_size != null && row.last_fill_size > 0
        ? row.last_fill_size
        : null;
    const fill = fillSize != null && fillSize > 0 ? fillSize : remembered;
    if (fill == null) return { kind: "needs-size" };
    // Increment relative to the lock-read current value (no clobber of a concurrent
    // decrement); resolveRefillWrite is non-null here (current not null, fill > 0).
    const next = resolveRefillWrite(row.quantity_on_hand, fill) as number;
    db.prepare(
      `UPDATE intake_items
          SET quantity_on_hand = ?, last_fill_size = ?
        WHERE id = ? AND profile_id = ?`
    ).run(next, fill, itemId, profileId);
    return { kind: "refilled", newQuantity: next, fillSize: fill };
  });
}
