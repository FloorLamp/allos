"use client";

import { useMemo } from "react";
import { IconAlertTriangle } from "@tabler/icons-react";
import { NOTICE_TONE } from "@/components/Notice";
import {
  interactionsForCandidate,
  interactionTitle,
  SEVERITY_LABEL,
  type InteractionItem,
} from "@/lib/drug-interactions";
import {
  pgxForCandidate,
  pgxStatusLabel,
  PGX_SEVERITY_LABEL,
  type PgxVariantInput,
} from "@/lib/pgx";
import {
  matchFoodInteractions,
  foodGuidanceLine,
  foodGuidanceDetail,
} from "@/lib/food-drug-interactions";

// The inline interaction / PGx / food-guidance notices for the item being
// entered/edited (#846, extracted from IntakeItemForm). DELIBERATELY CROSS-KIND: a
// supplement×drug interaction (#144) and a drug×drug interaction render identically
// in BOTH forms because this is the ONE client-side computation over the bundled
// datasets — the inline notice can never disagree with the Supplements/Medications
// page section or the Upcoming finding. Informational, never prescriptive.
export default function IntakeInteractionNotices({
  name,
  rxcui,
  rxcuiIngredients,
  stackItems,
  pgxVariants,
  excludeId,
  age = null,
  showFood = true,
}: {
  name: string;
  rxcui: string | null;
  rxcuiIngredients: string[] | null;
  stackItems: InteractionItem[];
  pgxVariants: PgxVariantInput[];
  excludeId?: number;
  // The profile's age in whole years (issue #851 item 4): an age-gated food note
  // (alcohol → adult) is hidden for a child on the form notice too. Null = unknown.
  age?: number | null;
  // Existing-item detail pages already render the dismissible FoodGuidance line.
  // They disable this duplicate form formatter while keeping drug and PGx notices.
  showFood?: boolean;
}) {
  const candidateInteractions = useMemo(() => {
    if (!name.trim()) return [];
    const others = stackItems.filter((x) => x.id !== excludeId);
    return interactionsForCandidate({ name, rxcui, rxcuiIngredients }, others);
  }, [name, rxcui, rxcuiIngredients, stackItems, excludeId]);

  const candidatePgx = useMemo(() => {
    if (!name.trim()) return [];
    return pgxForCandidate({ name, rxcui, rxcuiIngredients }, pgxVariants);
  }, [name, rxcui, rxcuiIngredients, pgxVariants]);

  const candidateFoodInteractions = useMemo(() => {
    if (!showFood || !name.trim()) return [];
    return matchFoodInteractions({ name, rxcui, rxcuiIngredients }, age);
  }, [showFood, name, rxcui, rxcuiIngredients, age]);

  return (
    <>
      {candidateInteractions.length > 0 && (
        <div
          data-testid="interaction-notice"
          className={`sm:col-span-2 rounded-lg border px-3 py-2.5 text-sm ${NOTICE_TONE.amber}`}
        >
          <div className="flex items-start gap-1.5">
            <IconAlertTriangle className="mt-0.5 h-4 w-4 shrink-0" />
            <p className="font-semibold">
              Possible interaction
              {candidateInteractions.length > 1 ? "s" : ""} with your current
              stack
            </p>
          </div>
          <div className="mt-1 space-y-1">
            {candidateInteractions.map((hit) => (
              <p
                key={hit.dedupeKey}
                className="text-amber-700 dark:text-amber-300"
              >
                <span className="font-medium">
                  {SEVERITY_LABEL[hit.severity]}:
                </span>{" "}
                {interactionTitle(hit)} — {hit.mechanism}
              </p>
            ))}
            <p className="text-xs text-amber-700 dark:text-amber-400">
              Informational only — discuss with your prescriber or pharmacist.
              You can still save this item.
            </p>
          </div>
        </div>
      )}

      {candidatePgx.length > 0 && (
        <div
          data-testid="pgx-notice"
          className={`sm:col-span-2 rounded-lg border px-3 py-2.5 text-sm ${NOTICE_TONE.violet}`}
        >
          <div className="flex items-start gap-1.5">
            <IconAlertTriangle className="mt-0.5 h-4 w-4 shrink-0" />
            <p className="font-semibold">
              Pharmacogenomic note{candidatePgx.length > 1 ? "s" : ""} for this
              medication
            </p>
          </div>
          <div className="mt-1 space-y-1">
            {candidatePgx.map((hit) => (
              <p
                key={hit.dedupeKey}
                className="text-violet-700 dark:text-violet-300"
              >
                <span className="font-medium">
                  {PGX_SEVERITY_LABEL[hit.severity]}:
                </span>{" "}
                {hit.gene} {pgxStatusLabel(hit)} on file — {hit.guidance}
              </p>
            ))}
            <p className="text-xs text-violet-700 dark:text-violet-400">
              Informational — discuss with your prescriber before any change; do
              not stop or switch a medication based on this alone. You can still
              save this item.
            </p>
          </div>
        </div>
      )}

      {candidateFoodInteractions.length > 0 && (
        <div
          data-testid="food-notice"
          className={`sm:col-span-2 rounded-lg border px-3 py-2.5 text-sm ${NOTICE_TONE.amber}`}
        >
          <div className="flex items-start gap-1.5">
            <IconAlertTriangle className="mt-0.5 h-4 w-4 shrink-0" />
            <p className="font-semibold">Food guidance for this item</p>
          </div>
          <div className="mt-1 space-y-1">
            {candidateFoodInteractions.map((hit) => (
              <div key={hit.key} className="text-amber-700 dark:text-amber-300">
                <p>
                  <span className="font-medium">{hit.food}:</span>{" "}
                  {foodGuidanceLine(hit)}
                </p>
                <p className="text-xs text-amber-700 dark:text-amber-400">
                  {foodGuidanceDetail(hit)}
                </p>
              </div>
            ))}
          </div>
        </div>
      )}
    </>
  );
}
