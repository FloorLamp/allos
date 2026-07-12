// Part of the lib/queries/intake barrel (#319 — same #126 treatment training
// got). The profile-scoping guard walks all of lib/, so these split modules stay
// covered; every read is profile-scoped directly or through the parent
// intake_items JOIN.
// Refill tracking: effective consumption-rate math and the on-hand supply
// increment/decrement kept in lock-step with the dose logs.
import { db, today } from "../../db";
import { shiftDateStr } from "../../date";
import { consumptionRate, RATE_WINDOW_DAYS, type DoseRate } from "../../refill";
import { getSupplementDoses } from "./schedule";

// Effective consumption rate (doses/day) + its basis for every item that has
// either scheduled doses or logged history, for refill "≈N days left" math
// (issue #38). Prefers the ACTUAL taken-log rate — confirmed doses in the last
// RATE_WINDOW_DAYS ÷ the window — over the scheduled-dose-count estimate, falling
// back to the count when history is thin (see lib/refill's consumptionRate). The
// gather is profile-scoped: the history read JOINs intake_items and filters
// s.profile_id (logs/doses are child tables reached through the parent), and the
// schedule count reuses the profile-scoped getSupplementDoses. Callers (the
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

  // Fallback rate ≈ number of scheduled dose rows per item.
  const scheduleCount = new Map<number, number>();
  for (const d of getSupplementDoses(profileId)) {
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
        scheduleCount.get(id) ?? 0,
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
export function decrementSupply(profileId: number, supplementId: number): void {
  db.prepare(
    `UPDATE intake_items
        SET quantity_on_hand = quantity_on_hand - qty_per_dose
      WHERE id = ? AND profile_id = ? AND quantity_on_hand IS NOT NULL`
  ).run(supplementId, profileId);
}

export function incrementSupply(profileId: number, supplementId: number): void {
  db.prepare(
    `UPDATE intake_items
        SET quantity_on_hand = quantity_on_hand + qty_per_dose
      WHERE id = ? AND profile_id = ? AND quantity_on_hand IS NOT NULL`
  ).run(supplementId, profileId);
}
