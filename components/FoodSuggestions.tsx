import {
  IconSalad,
  IconAlertTriangle,
  IconInfoCircle,
} from "@tabler/icons-react";
import FoodGroupIcon from "@/components/FoodGroupIcon";
import type { FoodSuggestion, FoodSafetyNoteKind } from "@/lib/food-suggest";

// Presentational renderer for the DETERMINISTIC food suggestions (issue #577). A pure
// formatter over the FoodSuggestion[] the ONE computation (getFoodSuggestions) yields —
// shared by the biomarker detail page and the nutrition/coaching surface so they can't
// disagree ("one question, one computation"). Informational, food-first, never
// prescriptive; each suggestion cites the flagged biomarker as its reason and every
// safety note stays visible.

function noteIcon(kind: FoodSafetyNoteKind) {
  return kind === "condition" || kind === "medication" ? (
    <IconAlertTriangle className="mt-0.5 h-3.5 w-3.5 shrink-0" />
  ) : (
    <IconInfoCircle className="mt-0.5 h-3.5 w-3.5 shrink-0" />
  );
}

export default function FoodSuggestions({
  suggestions,
  testid = "food-suggestions",
  trackAction,
}: {
  suggestions: FoodSuggestion[];
  testid?: string;
  // When provided (#580), each suggested food that maps to a loggable food group gets a
  // "Track as weekly habit" button posting its group_key — the suggestion→target
  // affordance. Reversible, user-initiated, never auto-created.
  trackAction?: (formData: FormData) => void | Promise<void>;
}) {
  if (suggestions.length === 0) return null;
  return (
    <div data-testid={testid} className="space-y-3">
      {suggestions.map((s) => (
        <div
          key={s.key}
          data-testid={`food-suggestion-${s.key}`}
          className="rounded-lg border border-emerald-200 bg-emerald-50 px-3 py-2.5 text-sm dark:border-emerald-900 dark:bg-emerald-950/40"
        >
          <div className="flex items-start gap-1.5">
            <IconSalad className="mt-0.5 h-4 w-4 shrink-0 text-emerald-600 dark:text-emerald-400" />
            <div className="min-w-0">
              <p className="font-semibold text-emerald-900 dark:text-emerald-100">
                Food for {s.label}
              </p>
              {s.triggeredBy.length > 0 && (
                <p className="mt-0.5 text-xs text-emerald-700 dark:text-emerald-300">
                  Because your {s.triggeredBy.join(", ")}{" "}
                  {s.triggeredBy.length > 1 ? "are" : "is"} low.
                </p>
              )}
              <ul className="mt-1.5 space-y-1">
                {s.foods.map((f) => (
                  <li
                    key={f.food}
                    className="text-slate-700 dark:text-slate-200"
                  >
                    <span className="font-medium">{f.food}</span>
                    {f.isAlternative && (
                      <span className="ml-1 rounded bg-emerald-100 px-1 py-0.5 text-[10px] font-medium uppercase tracking-wide text-emerald-700 dark:bg-emerald-900 dark:text-emerald-300">
                        alternative
                      </span>
                    )}
                    <span className="block text-xs text-slate-500 dark:text-slate-400">
                      {f.serving}
                    </span>
                    {trackAction && f.foodGroup && (
                      <form action={trackAction} className="mt-1">
                        <input
                          type="hidden"
                          name="group_key"
                          value={f.foodGroup}
                        />
                        <input type="hidden" name="per_week" value={2} />
                        <button
                          type="submit"
                          data-testid={`track-${f.foodGroup}`}
                          className="inline-flex items-center gap-1 rounded-full border border-emerald-300 px-2 py-0.5 text-xs font-medium text-emerald-700 transition hover:bg-emerald-100 dark:border-emerald-700 dark:text-emerald-300 dark:hover:bg-emerald-900"
                        >
                          <FoodGroupIcon
                            slug={f.foodGroup}
                            className="h-3.5 w-3.5 shrink-0"
                          />
                          Track as weekly habit
                        </button>
                      </form>
                    )}
                  </li>
                ))}
              </ul>
              {s.safetyNotes.length > 0 && (
                <ul className="mt-1.5 space-y-0.5">
                  {s.safetyNotes.map((n, i) => (
                    <li
                      key={i}
                      className="flex items-start gap-1 text-xs text-amber-700 dark:text-amber-300"
                    >
                      {noteIcon(n.kind)}
                      <span>{n.text}</span>
                    </li>
                  ))}
                </ul>
              )}
              {s.caveat && (
                <p className="mt-1.5 text-xs italic text-slate-500 dark:text-slate-400">
                  {s.caveat}
                </p>
              )}
              <p className="mt-1.5 text-[11px] text-slate-400 dark:text-slate-500">
                {s.evidence} Source: {s.source}. Informational, not medical
                advice.
              </p>
            </div>
          </div>
        </div>
      ))}
    </div>
  );
}
