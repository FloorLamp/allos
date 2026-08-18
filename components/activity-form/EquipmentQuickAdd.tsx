"use client";

import { useState } from "react";
import type { Equipment } from "@/lib/types";
import { EQUIPMENT_CATEGORIES, kindOf } from "@/lib/types";
import type { WeightUnit } from "@/lib/settings";
import { toKg, stripNegative } from "@/lib/units";
import { createEquipmentAction } from "@/app/(app)/equipment/actions";

// The minimal in-form equipment creation surface (#1611) — the travel-gym path.
//
// It exists because leaving the activity editor to visit /equipment risks the
// in-progress workout, and the editor's server-supplied equipment list would stay
// stale until it refreshed. Reuses the EXISTING write path verbatim
// (createEquipmentAction → lib/equipment's createEquipment core, with its own
// duplicate-name check and revalidation); there is deliberately NO parallel create
// action, validation, or SQL here. Full edit/retire/delete stays on /equipment.
//
// This is the same shape PlateBuilderModal.createBar already used inline: call the
// action, hand the returned Equipment back through `onCreated` so editor-local state
// gains the row immediately, and let the caller select it on the current part. The
// plate builder keeps its own bar-specific fields because the weight typed there
// drives a live plate-total preview; both paths share the one Server Action.

// Only strength implements are offerable from a strength part — a Bike or a Sauna is
// not something a set is performed on. Same kindOf grouping the registry uses.
const STRENGTH_CATEGORIES = EQUIPMENT_CATEGORIES.filter(
  (c) => kindOf(c) === "strength"
);

/**
 * The unambiguous category for a lift's built-in variant, or "" when the lift
 * doesn't imply one (#1611 acceptance 4): "Machine Chest Press" → `Machine`, a
 * barbell variant → `Barbell`. Anything else leaves the field empty and required,
 * rather than guessing a category onto the user's registry.
 */
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
  // Preselected category (from the part's built-in variant) — "" requires a choice.
  defaultCategory: string;
  unit: WeightUnit;
  // The created row: the caller appends it to editor-local state AND selects it on
  // the part being edited, so no set values are re-entered and no reopen is needed.
  onCreated: (equipment: Equipment) => void;
  onCancel: () => void;
}) {
  const [name, setName] = useState("");
  const [category, setCategory] = useState(defaultCategory);
  const [weight, setWeight] = useState("");
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const weightNum = Number(weight);
  const weightInvalid =
    weight.trim() !== "" && (!Number.isFinite(weightNum) || weightNum < 0);

  async function submit() {
    if (!name.trim()) {
      setError("Name the equipment.");
      return;
    }
    if (!category) {
      setError("Pick a category.");
      return;
    }
    if (weightInvalid) {
      setError("Enter a valid weight (0 or more), or leave it blank.");
      return;
    }
    setSaving(true);
    setError(null);
    try {
      const res = await createEquipmentAction({
        name: name.trim(),
        // Implement weight stays OPTIONAL here (only the plate builder's bar needs
        // one) — blank means "not tracked", exactly as the registry stores it.
        weight_kg: weight.trim() === "" ? null : toKg(weightNum, unit),
        category,
      });
      if (!res.ok) {
        // Duplicate-name and validation errors render INLINE; the form stays open
        // and the activity underneath is untouched.
        setError(res.error);
        return;
      }
      onCreated(res.equipment);
    } finally {
      setSaving(false);
    }
  }

  return (
    <div
      data-testid="strength-equipment-quickadd"
      className="mt-2 w-full rounded-md border border-black/10 bg-surface px-2.5 py-2 dark:border-white/10"
    >
      <div className="section-label">New equipment</div>
      <div className="mt-1.5 flex flex-wrap items-center gap-1.5">
        <input
          type="text"
          value={name}
          autoFocus
          onChange={(e) => setName(e.target.value)}
          placeholder="Name (e.g. Hotel chest press)"
          aria-label="Equipment name"
          data-testid="strength-equipment-new-name"
          className="input min-w-0 flex-1"
        />
        <select
          value={category}
          onChange={(e) => setCategory(e.target.value)}
          aria-label="Equipment category"
          data-testid="strength-equipment-new-category"
          className="input w-auto"
        >
          <option value="">Category…</option>
          {STRENGTH_CATEGORIES.map((c) => (
            <option key={c} value={c}>
              {c}
            </option>
          ))}
        </select>
        <input
          type="number"
          min="0"
          step="any"
          value={weight}
          onChange={(e) => setWeight(stripNegative(e.target.value))}
          placeholder={`Weight (${unit}, optional)`}
          aria-label="Equipment weight"
          data-testid="strength-equipment-new-weight"
          className="input w-32"
        />
      </div>
      {error && (
        <p
          data-testid="strength-equipment-new-error"
          className="mt-1.5 text-xs text-rose-600 dark:text-rose-400"
        >
          {error}
        </p>
      )}
      <div className="mt-1.5 flex items-center gap-1.5">
        <button
          type="button"
          onClick={submit}
          disabled={saving}
          data-testid="strength-equipment-new-save"
          className="btn shrink-0"
        >
          {saving ? "Saving…" : "Add"}
        </button>
        <button
          type="button"
          onClick={onCancel}
          className="text-xs font-medium text-slate-500 hover:text-slate-600 dark:text-slate-400 dark:hover:text-slate-300"
        >
          Cancel
        </button>
      </div>
    </div>
  );
}
