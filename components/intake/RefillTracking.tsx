"use client";

import type { Supplement } from "@/lib/types";

// The optional refill-tracking block shared by both intake forms (#846): units on
// hand + units per dose, driving "≈N days left" and the low-supply nudge. Applies to
// both kinds (supplements and medications track supply the same way). The loaded
// on-hand value round-trips as a hidden field so updateSupplement can compare-and-set
// the concurrently-decremented counter instead of clobbering it (#467).
export default function RefillTracking({
  fid,
  supplement,
}: {
  fid: string | number;
  supplement?: Supplement;
}) {
  const s = supplement;
  const loadedQty =
    s?.quantity_on_hand != null ? Math.max(0, s.quantity_on_hand) : "";
  return (
    <div className="sm:col-span-2 border-t border-black/5 pt-4 dark:border-white/5">
      <label className="text-sm font-medium text-slate-700 dark:text-slate-200">
        Refill tracking (optional)
      </label>
      <p className="mt-1 text-xs text-slate-500 dark:text-slate-400">
        Track units on hand to see “≈N days left” and get a refill nudge when
        you’re running low. Leave the quantity blank to skip tracking.
      </p>
      <div className="mt-3 grid grid-cols-1 gap-3 sm:grid-cols-2">
        <div>
          <label className="label" htmlFor={`intake-qty-${fid}`}>
            Quantity on hand
          </label>
          <input
            id={`intake-qty-${fid}`}
            name="quantity_on_hand"
            type="number"
            min={0}
            step="any"
            defaultValue={loadedQty}
            className="input"
            placeholder="e.g. 90 pills"
          />
          {/* The value the form LOADED with, so updateSupplement can compare-and-
              set the concurrently-decremented on-hand counter (#467). */}
          <input
            type="hidden"
            name="quantity_on_hand_loaded"
            value={loadedQty}
          />
        </div>
        <div>
          <label className="label" htmlFor={`intake-qty-per-dose-${fid}`}>
            Units per dose
          </label>
          <input
            id={`intake-qty-per-dose-${fid}`}
            name="qty_per_dose"
            type="number"
            min={0}
            step="any"
            defaultValue={s?.qty_per_dose ?? 1}
            className="input"
            placeholder="1"
          />
        </div>
      </div>
    </div>
  );
}
