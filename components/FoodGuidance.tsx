"use client";

import { IconX } from "@tabler/icons-react";
import {
  matchFoodInteractions,
  foodGuidanceLine,
  foodTimingSignalKey,
} from "@/lib/food-drug-interactions";
import { parseRxcuiIngredients } from "@/lib/rxnorm";
import { dismissIntakeFinding } from "@/app/(app)/nutrition/supplement-actions";

// Food–drug guidance line(s) for one intake item (issue #154). Rendered on the
// intake surfaces' medication + supplement rows (#746): a per-item food note like "Grapefruit:
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
  age = null,
  heading,
  className,
  canDismiss = true,
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
  // The profile's age in whole years (issue #851 item 4), so an age-gated food note
  // (alcohol → adult) is hidden for a child. Null/unknown shows every rule.
  age?: number | null;
  // Detail cards can name this group; compact row hosts omit the heading.
  heading?: string;
  className?: string;
  // Cross-profile detail views are deliberately read-only until the caregiver
  // explicitly acts as that profile, so they render guidance without mutation controls.
  canDismiss?: boolean;
}) {
  const suppressed = new Set(suppressedFoodKeys);
  const hits = matchFoodInteractions(
    {
      name,
      rxcui,
      rxcuiIngredients: parseRxcuiIngredients(rxcuiIngredients),
    },
    age
  ).filter((hit) => !suppressed.has(foodTimingSignalKey(itemId, hit.key)));
  if (hits.length === 0) return null;
  return (
    <div
      data-testid="food-guidance"
      className={`space-y-0.5 ${className ?? "mt-1"}`}
    >
      {heading ? <div className="mb-1 section-label">{heading}</div> : null}
      {hits.map((hit) => (
        // A <div>, not a <p>: the dismiss <form> may not nest inside a <p> —
        // invalid HTML that React rejects at hydration, crashing the whole
        // intake surface tree (dose cards included).
        <div
          key={hit.key}
          className="flex items-start gap-2 text-xs text-amber-700 dark:text-amber-300"
        >
          <span className="min-w-0 flex-1">
            <span className="font-medium">{hit.food}:</span>{" "}
            {foodGuidanceLine(hit)}
          </span>
          {/* Dismiss through the shared findings-bus suppression store (#435). */}
          {canDismiss ? (
            <form
              action={async (fd) => {
                await dismissIntakeFinding(fd);
              }}
            >
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
          ) : null}
        </div>
      ))}
    </div>
  );
}
