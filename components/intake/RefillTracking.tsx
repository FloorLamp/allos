"use client";

import { useEffect, useState } from "react";
import type { IntakeItem } from "@/lib/types";
import type { SupplyOption } from "@/lib/supply-product";
import SharedSupplyPicker from "./SharedSupplyPicker";

// The optional refill-tracking block shared by both intake forms (#846): units on
// hand + units per dose, driving "≈N days left" and the low-supply nudge. Applies to
// both kinds (supplements and medications track supply the same way). The loaded
// on-hand value round-trips as a hidden field so updateIntakeItem can compare-and-set
// the concurrently-decremented counter instead of clobbering it (#467).
export default function RefillTracking({
  fid,
  item,
  initialSupply = null,
  onPickSupply,
  quantityOnHand,
  setQuantityOnHand,
  qtyPerDose,
  setQtyPerDose,
}: {
  fid: string | number;
  item?: IntakeItem;
  // Controlled by the form (#3216). The merged form shows one editor at a time, so a
  // count that lived only in this block's DOM would save only when the supply editor
  // happened to be open; every posted value is state.
  quantityOnHand: string;
  setQuantityOnHand: (v: string) => void;
  qtyPerDose: string;
  setQtyPerDose: (v: string) => void;
  // CREATE mode (#1705): the bottle this form was opened from, and the callback that
  // lets the item form prefill its product fields when one is chosen here.
  initialSupply?: SupplyOption | null;
  onPickSupply?: (supply: SupplyOption | null) => void;
}) {
  const s = item;
  // A bottle chosen on a NEW item (#1705) makes it pooled the moment it saves, so the
  // private-count fields must disappear now rather than after the round trip.
  const [chosenSupply, setChosenSupply] = useState<SupplyOption | null>(
    initialSupply
  );
  // A POOLED item (#1374) keeps NO private count — the shared bottle holds it — so the
  // per-item quantity field is hidden entirely and the shared-supply control below is
  // the whole story. Leaving both visible is how a household ends up double-counting.
  const pooled = s?.supply_id != null || chosenSupply != null;
  const [enabled, setEnabled] = useState(s?.quantity_on_hand != null);
  // Untracked and pooled both mean "this item keeps no private count", and the form
  // posts state — so the state has to say so, not just the hidden input that used to.
  useEffect(() => {
    if (!enabled || pooled) setQuantityOnHand("");
  }, [enabled, pooled, setQuantityOnHand]);
  return (
    <div
      data-testid="refill-tracking"
      className="sm:col-span-2 border-t border-black/5 pt-4 dark:border-white/5"
    >
      <label
        className={`${pooled ? "hidden " : ""}flex items-center gap-2 text-sm font-medium text-slate-700 dark:text-slate-200`}
      >
        <input
          type="checkbox"
          checked={enabled}
          onChange={(event) => setEnabled(event.target.checked)}
          className="h-4 w-4 rounded-sm border-slate-300 text-brand-600 dark:border-slate-600"
        />
        Track supply and refills
      </label>
      <p className="mt-1 pl-6 text-xs text-slate-500 dark:text-slate-400">
        Track units on hand to see “≈N days left” and get a refill nudge when
        you’re running low.
      </p>
      <div
        className={`${enabled && !pooled ? "grid" : "hidden"} mt-3 grid-cols-1 gap-3 sm:grid-cols-2`}
        aria-hidden={!enabled || pooled}
      >
        <div>
          <label className="label" htmlFor={`intake-qty-${fid}`}>
            Quantity on hand
          </label>
          <input
            id={`intake-qty-${fid}`}
            type="number"
            min={0}
            step="any"
            value={quantityOnHand}
            onChange={(event) => setQuantityOnHand(event.target.value)}
            disabled={!enabled}
            className="input"
            placeholder="e.g. 90"
          />
        </div>
        <div>
          <label className="label" htmlFor={`intake-qty-per-dose-${fid}`}>
            Units per dose
          </label>
          <input
            id={`intake-qty-per-dose-${fid}`}
            type="number"
            min={0}
            step="any"
            value={qtyPerDose}
            onChange={(event) => setQtyPerDose(event.target.value)}
            disabled={!enabled}
            className="input"
            placeholder="1"
          />
        </div>
      </div>
      <SharedSupplyPicker
        itemId={s?.id}
        itemName={s?.name ?? ""}
        supplyId={s?.supply_id ?? null}
        supplyName={s?.supply_name ?? null}
        initialSupply={initialSupply}
        onPickSupply={(supply) => {
          setChosenSupply(supply);
          onPickSupply?.(supply);
        }}
      />
    </div>
  );
}
