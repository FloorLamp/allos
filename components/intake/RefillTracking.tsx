"use client";

import type { IntakeItem } from "@/lib/types";
import { rememberedFillFor } from "@/lib/refill";
import type { SupplyOption } from "@/lib/supply-product";
import RefillButton from "@/components/medications/RefillButton";
import SharedSupplyPicker from "./SharedSupplyPicker";

// The optional refill-tracking block shared by both intake forms (#846): units on
// hand + units per dose, driving "≈N days left" and the low-supply nudge. Applies to
// both kinds (supplements and medications track supply the same way). The loaded
// on-hand value round-trips as a hidden field so updateIntakeItem can compare-and-set
// the concurrently-decremented counter instead of clobbering it (#467).
export default function RefillTracking({
  fid,
  item,
  bottles,
  supplyId,
  supplyName,
  onPickSupply,
  quantityOnHand,
  setQuantityOnHand,
  onRefilled,
  qtyPerDose,
  setQtyPerDose,
  initialRefill = false,
}: {
  fid: string | number;
  initialRefill?: boolean;
  item?: IntakeItem;
  // Controlled by the form (#3216). The merged form shows one editor at a time, so a
  // count that lived only in this block's DOM would save only when the supply editor
  // happened to be open; every posted value is state.
  quantityOnHand: string;
  setQuantityOnHand: (v: string) => void;
  onRefilled: (newQuantity: number) => void;
  qtyPerDose: string;
  setQtyPerDose: (v: string) => void;
  bottles: SupplyOption[];
  supplyId: string;
  supplyName: string | null;
  onPickSupply?: (supply: SupplyOption | null) => void;
}) {
  const s = item;
  const pooled = supplyId !== "";
  // THE CONTAINER'S OWN REMEMBERED FILL (#5121's owner ruling, #5911). The count field
  // above already shows the BOTTLE's number when this item is pooled; the refill control
  // beneath it now reuses the BOTTLE's remembered size for the same reason, and never
  // the member's. `bottles` carries it on the linked option, so the block reads it from
  // the same list the picker offers rather than minting a second source for it.
  const linkedBottle = pooled
    ? (bottles.find((option) => String(option.id) === supplyId) ?? null)
    : null;
  const rememberedFill = rememberedFillFor({
    supplyId: pooled ? Number(supplyId) || null : null,
    itemLastFillSize: s?.last_fill_size ?? null,
    poolLastFillSize: linkedBottle?.lastFillSize ?? null,
  });
  return (
    <div
      data-testid="refill-tracking"
      className="sm:col-span-2 border-t border-black/5 pt-4 dark:border-white/5"
    >
      <div className="grid grid-cols-1 gap-3 sm:grid-cols-2">
        <div>
          <label className="label" htmlFor={`intake-qty-${fid}`}>
            {pooled ? "Shared bottle count" : "Quantity on hand"}
          </label>
          <input
            id={`intake-qty-${fid}`}
            type="number"
            min={0}
            step="any"
            value={quantityOnHand}
            onChange={(event) => setQuantityOnHand(event.target.value)}
            className="input"
            placeholder="Not tracked"
          />
          <p className="mt-1 text-xs text-slate-500">
            {pooled
              ? "This is the bottle’s count for everyone linked to it."
              : "Leave blank to stop tracking. Zero means none left."}
          </p>
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
            className="input"
            placeholder="1"
          />
        </div>
      </div>
      {s && quantityOnHand !== "" && (
        <div className="mt-3">
          <RefillButton
            itemId={s.id}
            supplyId={Number(supplyId) || null}
            hasLastFill={rememberedFill != null}
            lastFillSize={rememberedFill}
            initialAsk={initialRefill}
            onRefilled={onRefilled}
          />
        </div>
      )}
      <SharedSupplyPicker
        itemId={s?.id}
        itemName={s?.name ?? ""}
        options={bottles}
        supplyId={supplyId}
        supplyName={supplyName}
        onPickSupply={onPickSupply}
      />
    </div>
  );
}
