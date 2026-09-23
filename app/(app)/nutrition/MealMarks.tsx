"use client";

import { useState } from "react";
import Chip from "@/components/Chip";
import type { MealProperty } from "@/lib/food-sensitivities";

// THE `This meal` CHIPS (#5865). Offered only for the meal properties the subject has
// an active sensitivity on, so a profile with none sees no new control. A pressed chip
// marks every tap of this meal, the usual bundle included; another day or another meal
// starts unmarked, the way the eating-time statement drops on a day switch.

/** The marks in force for `meal` (a day + meal-window key), and their setter. */
export function useMealMarks(meal: string) {
  const [marked, setMarked] = useState({ meal, slugs: [] as string[] });
  const pressed = marked.meal === meal ? marked.slugs : [];
  return [pressed, (slugs: string[]) => setMarked({ meal, slugs })] as const;
}

/** ` · Spicy` for a receipt carrying marks, empty for an unmarked one. */
export function mealMarksSuffix(
  properties: readonly MealProperty[],
  pressed: readonly string[]
): string {
  return properties
    .filter((p) => pressed.includes(p.slug))
    .map((p) => ` · ${p.label}`)
    .join("");
}

export default function MealMarks({
  properties,
  pressed,
  onChange,
}: {
  properties: readonly MealProperty[];
  pressed: readonly string[];
  onChange: (slugs: string[]) => void;
}) {
  if (properties.length === 0) return null;
  return (
    <div
      role="group"
      aria-label="This meal"
      data-testid="food-meal-marks"
      className="mb-2.5 flex flex-wrap items-center gap-1.5"
    >
      <span className="text-xs text-slate-500 dark:text-slate-400">
        This meal
      </span>
      {properties.map(({ slug, label }) => {
        const on = pressed.includes(slug);
        return (
          <Chip
            key={slug}
            role="filter"
            pressed={on}
            testId={`food-meal-mark-${slug}`}
            onClick={() =>
              onChange(
                on ? pressed.filter((s) => s !== slug) : [...pressed, slug]
              )
            }
          >
            {label}
          </Chip>
        );
      })}
    </div>
  );
}
