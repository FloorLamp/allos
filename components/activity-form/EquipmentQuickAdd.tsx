"use client";

import type { Equipment } from "@/lib/types";
import { kindOf } from "@/lib/types";
import { liftImplementCategory } from "@/lib/equipment-availability";
import type { WeightUnit } from "@/lib/settings";
import EquipmentForm from "../EquipmentForm";

// The category to PREFILL when registering gear from inside a lift's row: the lift's
// own implement, when that implement is one this strength-only form can offer. A
// non-strength or unresolved implement prefills "" — the field is then empty and
// required rather than guessed, which is why this narrows on kind and does not reuse
// `liftRequiredCategory`'s three-implement gate (that one answers a different
// question and would drop the kettlebell this form can register).
export function defaultCategoryForLift(name: string): string {
  const category = liftImplementCategory(name);
  return category && kindOf(category) === "strength" ? category : "";
}

export default function EquipmentQuickAdd({
  defaultCategory,
  unit,
  onCreated,
  onCancel,
}: {
  defaultCategory: string;
  unit: WeightUnit;
  onCreated: (equipment: Equipment) => void;
  onCancel: () => void;
}) {
  return (
    <div
      data-testid="strength-equipment-quickadd"
      className="mt-2 w-full rounded-md border border-black/10 bg-surface px-2.5 py-2 dark:border-white/10"
    >
      <EquipmentForm
        defaultCategory={defaultCategory}
        unit={unit}
        strengthOnly
        onSaved={onCreated}
        onCancel={onCancel}
      />
    </div>
  );
}
