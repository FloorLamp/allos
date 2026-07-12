"use client";

import { IconAlertTriangle, IconX } from "@tabler/icons-react";
import {
  matchFoodInteractions,
  foodGuidanceLine,
  foodTimingSignalKey,
} from "@/lib/food-drug-interactions";
import { parseRxcuiIngredients } from "@/lib/rxnorm";
import { dismissMedicineFinding } from "./actions";

// Food–drug guidance line(s) for one intake item (issue #154). Rendered on the
// /medicine medication + supplement rows: a per-item food note like "Grapefruit:
// Avoid grapefruit juice — it raises statin blood levels". A formatter over the
// pure matchFoodInteractions — the SAME computation the create/edit item-form
// notice and the dose-reminder Telegram copy use, so they can't disagree. Shared
// by MedicationCard and EditableSupplementRow so every row renders it identically.
// Informational, never prescriptive.
//
// Suppressible via the shared findings-bus (issue #435): each line carries a
// `food-timing:<itemId>:<ruleId>` dedupeKey, so a line the profile has dismissed is
// filtered out here (via `suppressedFoodKeys`, resolved on the server) and can be
// dismissed inline — the same "calm observations must be suppressible" contract the
// adherence/interaction findings follow. The dose-reminder tail stays un-gated (it
// rides the safety-tier reminder, see lib/notifications/supplement-format.ts).
export default function FoodGuidance({
  itemId,
  name,
  rxcui,
  rxcuiIngredients = null,
  suppressedFoodKeys = [],
}: {
  // The parent intake item's id — the first segment of each line's dedupeKey.
  itemId: number;
  name: string;
  rxcui: string | null;
  // The raw intake_items.rxcui_ingredients column (a JSON array of ingredient
  // RxCUIs, issue #279) — decoded here so a combination product matches each
  // ingredient's guidance entry.
  rxcuiIngredients?: string | null;
  // This profile's currently-active food-timing dismissals (#435), resolved on the
  // server from the findings-suppression store; a hit whose key is here is hidden.
  suppressedFoodKeys?: string[];
}) {
  const suppressed = new Set(suppressedFoodKeys);
  const hits = matchFoodInteractions({
    name,
    rxcui,
    rxcuiIngredients: parseRxcuiIngredients(rxcuiIngredients),
  }).filter((hit) => !suppressed.has(foodTimingSignalKey(itemId, hit.key)));
  if (hits.length === 0) return null;
  return (
    <div data-testid="food-guidance" className="mt-1 space-y-0.5">
      {hits.map((hit) => (
        <p
          key={hit.key}
          className="flex items-start gap-1 text-xs text-amber-700 dark:text-amber-300"
        >
          <IconAlertTriangle className="mt-0.5 h-3.5 w-3.5 shrink-0" />
          <span className="min-w-0 flex-1">
            <span className="font-medium">{hit.food}:</span>{" "}
            {foodGuidanceLine(hit)}
          </span>
          {/* Dismiss through the shared findings-bus suppression store (#435). */}
          <form action={dismissMedicineFinding}>
            <input
              type="hidden"
              name="dedupe_key"
              value={foodTimingSignalKey(itemId, hit.key)}
            />
            <button
              type="submit"
              data-testid="food-guidance-dismiss"
              aria-label={`Dismiss ${hit.food} guidance for ${name}`}
              title="Dismiss"
              className="flex h-4 w-4 shrink-0 items-center justify-center rounded-full text-amber-500 transition hover:bg-amber-100 hover:text-amber-700 dark:text-amber-400 dark:hover:bg-amber-900/40"
            >
              <IconX className="h-3 w-3" stroke={2} />
            </button>
          </form>
        </p>
      ))}
    </div>
  );
}
