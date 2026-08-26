"use client";

import type { Dispatch, SetStateAction } from "react";
import { IconPlus, IconX } from "@tabler/icons-react";
import type { IntakeItemIngredient } from "@/lib/intake-ingredients";

// One editable ingredient row's client state (issue #2856). `amount` is the label's
// own text ("11 mg", "1000 IU", "2 g"); the canonical numeric reading is derived at
// the write boundary, never typed.
export interface IngredientState {
  name: string;
  amount: string;
}

export const emptyIngredient = (): IngredientState => ({
  name: "",
  amount: "",
});

export function ingredientStates(
  rows: readonly IntakeItemIngredient[]
): IngredientState[] {
  return rows.map((r) => ({ name: r.name, amount: r.amount_text ?? "" }));
}

// Whether the repeater holds nothing a person has typed — the test for "safe to seed
// from the catalog". A pick never overwrites entered composition.
export function ingredientsAreEmpty(rows: readonly IngredientState[]): boolean {
  return rows.every((r) => !r.name.trim() && !r.amount.trim());
}

// The "What's in this" repeater (issue #2856). A blend is one item, and until the
// person writes down what is in it every engine can only read the item's NAME: the
// upper-limit totals, the interaction and allergen checks, and the with-fat default
// all match name tokens. These rows are how a "Mood Support" capsule gets to say it
// contains St. John's Wort, and how an eye-health blend's zinc joins the zinc total.
//
// Hand-editable throughout. Picking a catalogued blend SEEDS these rows (`seedNote`
// says where they came from) but never saves them — the Save button is the write.
export default function IngredientsEditor({
  rows,
  setRows,
  seedNote = null,
}: {
  rows: IngredientState[];
  setRows: Dispatch<SetStateAction<IngredientState[]>>;
  // Set when the rows were prefilled from the catalog, so the person knows the
  // numbers came from us and are theirs to correct against the bottle in hand.
  seedNote?: string | null;
}) {
  function setRow(i: number, patch: Partial<IngredientState>) {
    setRows((rs) => rs.map((r, j) => (j === i ? { ...r, ...patch } : r)));
  }

  return (
    <div className="sm:col-span-2" data-testid="ingredients-editor">
      <div className="mb-1 section-label">What&apos;s in this (optional)</div>
      <p className="mb-2 text-xs text-slate-500 dark:text-slate-400">
        One row per ingredient on the label, as it&apos;s written there, per
        capsule or scoop. Blends only — a bottle named after the one thing in it
        needs nothing here. Used for upper-limit totals and interaction checks.
      </p>
      {seedNote && (
        <p
          data-testid="ingredients-seed-note"
          className="mb-2 text-xs text-amber-600 dark:text-amber-400"
        >
          {seedNote}
        </p>
      )}
      <div className="space-y-2">
        {rows.map((r, i) => (
          <div
            key={i}
            className="grid gap-2 sm:grid-cols-[minmax(0,2fr)_minmax(0,1fr)_2.5rem] sm:items-center"
          >
            <input
              className="input"
              aria-label={`Ingredient ${i + 1} name`}
              data-testid={`ingredient-name-${i}`}
              value={r.name}
              onChange={(e) => setRow(i, { name: e.target.value })}
              placeholder="e.g. Zinc"
            />
            <input
              className="input"
              aria-label={`Ingredient ${i + 1} amount`}
              data-testid={`ingredient-amount-${i}`}
              value={r.amount}
              onChange={(e) => setRow(i, { amount: e.target.value })}
              placeholder="e.g. 11 mg"
            />
            <button
              type="button"
              onClick={() => setRows((rs) => rs.filter((_, j) => j !== i))}
              className="tap-target flex h-10 w-10 items-center justify-center justify-self-end rounded-lg text-slate-500 transition hover:bg-rose-50 hover:text-rose-600 dark:text-slate-400 dark:hover:bg-rose-950 dark:hover:text-rose-400"
              aria-label={`Remove ingredient ${i + 1}`}
            >
              <IconX className="h-4 w-4" />
            </button>
          </div>
        ))}
      </div>
      <button
        type="button"
        onClick={() => setRows((rs) => [...rs, emptyIngredient()])}
        data-testid="add-ingredient"
        className="btn-ghost btn-sm mt-2"
      >
        <IconPlus className="h-4 w-4" stroke={2} aria-hidden="true" />
        Add ingredient
      </button>
    </div>
  );
}
