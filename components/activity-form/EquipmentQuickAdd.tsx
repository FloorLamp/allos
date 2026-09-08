"use client";

import type { Equipment } from "@/lib/types";
import { EQUIPMENT_CATEGORIES, kindOf } from "@/lib/types";
import type { WeightUnit } from "@/lib/settings";
import EquipmentForm from "../EquipmentForm";

const STRENGTH_CATEGORIES = EQUIPMENT_CATEGORIES.filter(
  (c) => kindOf(c) === "strength"
);

export function categoryForVariant(
  variantEquipment: string | null | undefined
): string {
  const want = (variantEquipment ?? "").trim().toLowerCase();
  return STRENGTH_CATEGORIES.find((c) => c.toLowerCase() === want) ?? "";
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
