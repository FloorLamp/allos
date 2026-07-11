"use client";

import { IconAlertTriangle } from "@tabler/icons-react";
import {
  matchFoodInteractions,
  foodGuidanceLine,
} from "@/lib/food-drug-interactions";

// Food–drug guidance line(s) for one intake item (issue #154). Rendered on the
// /medicine medication + supplement rows: a per-item food note like "Grapefruit:
// Avoid grapefruit juice — it raises statin blood levels". A formatter over the
// pure matchFoodInteractions — the SAME computation the create/edit item-form
// notice and the dose-reminder Telegram copy use, so they can't disagree. Shared
// by MedicationCard and EditableSupplementRow so every row renders it identically.
// Informational, never prescriptive.
export default function FoodGuidance({
  name,
  rxcui,
}: {
  name: string;
  rxcui: string | null;
}) {
  const hits = matchFoodInteractions({ name, rxcui });
  if (hits.length === 0) return null;
  return (
    <div data-testid="food-guidance" className="mt-1 space-y-0.5">
      {hits.map((hit) => (
        <p
          key={hit.key}
          className="flex items-start gap-1 text-xs text-amber-700 dark:text-amber-300"
        >
          <IconAlertTriangle className="mt-0.5 h-3.5 w-3.5 shrink-0" />
          <span>
            <span className="font-medium">{hit.food}:</span>{" "}
            {foodGuidanceLine(hit)}
          </span>
        </p>
      ))}
    </div>
  );
}
