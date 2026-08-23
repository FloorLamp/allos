import {
  IconSalad,
  IconCircleMinus,
  IconAlertTriangle,
  IconInfoCircle,
  IconChevronDown,
} from "@tabler/icons-react";
import FoodGroupIcon from "@/components/FoodGroupIcon";
import { NOTICE_TONE } from "@/components/Notice";
import {
  foodSuggestionHeadline,
  type FoodSuggestion,
  type FoodSafetyNoteKind,
} from "@/lib/food-suggest";

// Presentational renderer for the DETERMINISTIC food suggestions (issues #577/#775). A
// pure formatter over the FoodSuggestion[] the ONE computation (getFoodSuggestions)
// yields — shared by the biomarker detail page and the nutrition/coaching surface so
// they can't disagree ("one question, one computation"). Informational, food-first,
// never prescriptive; each suggestion cites the flagged biomarker as its reason and
// every safety note stays visible. Two directions from the ONE engine: ADD (a low
// reading → eat more, emerald) and REDUCE (#775, a high reading → eat less, amber).

function noteIcon(kind: FoodSafetyNoteKind) {
  return kind === "condition" ||
    kind === "medication" ||
    kind === "biomarker" ? (
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
      {suggestions.map((s) => {
        const reduce = s.direction === "reduce";
        return (
          <div
            key={s.dedupeKey}
            data-testid={`food-suggestion-${s.key}`}
            data-direction={s.direction}
            className={`rounded-lg border px-3 py-2.5 text-base ${
              reduce ? NOTICE_TONE.amber : NOTICE_TONE.emerald
            }`}
          >
            <div className="flex items-start gap-1.5">
              {reduce ? (
                <IconCircleMinus className="mt-0.5 h-4 w-4 shrink-0 text-amber-600 dark:text-amber-400" />
              ) : (
                <IconSalad className="mt-0.5 h-4 w-4 shrink-0 text-emerald-600 dark:text-emerald-400" />
              )}
              <div className="min-w-0">
                <p
                  data-testid={`food-suggestion-headline-${s.key}`}
                  className={
                    reduce
                      ? "font-semibold text-amber-900 dark:text-amber-100"
                      : "font-semibold text-emerald-900 dark:text-emerald-100"
                  }
                >
                  {/* One sentence, built once, in lib/food-suggest — including the
                      #2754 rule that the side word comes from the declared trigger
                      and never from the eat-more/eat-less verb. It is a string
                      rather than markup here so the tier that can test it does
                      (#3446), and so the coaching surface cannot phrase it
                      differently from this one. */}
                  {foodSuggestionHeadline(s)}
                </p>
                <ul
                  data-testid={`food-suggestion-foods-${s.key}`}
                  className={`mt-1.5 list-disc space-y-1 pl-5 ${
                    reduce
                      ? "marker:text-amber-500 dark:marker:text-amber-400"
                      : "marker:text-emerald-500 dark:marker:text-emerald-400"
                  }`}
                >
                  {s.foods.map((f) => (
                    <li
                      key={f.food}
                      className="text-slate-700 dark:text-slate-200"
                    >
                      <span className="font-medium">{f.food}</span>
                      {f.isAlternative && (
                        <span className="ml-1 rounded-sm bg-emerald-100 px-1 py-0.5 text-xs font-medium uppercase tracking-wide text-emerald-700 dark:bg-emerald-900 dark:text-emerald-300">
                          alternative
                        </span>
                      )}
                      <span className="block text-sm text-slate-500 dark:text-slate-400">
                        {f.serving}
                      </span>
                      {/* Track-as-habit is an ENCOURAGE affordance — offered only for
                          add suggestions, never for a limit-tier food to reduce. */}
                      {!reduce && trackAction && f.foodGroup && (
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
                            className="inline-flex items-center gap-1 rounded-full border border-emerald-300 px-2 py-0.5 text-sm font-medium text-emerald-700 transition hover:bg-emerald-100 dark:border-emerald-700 dark:text-emerald-300 dark:hover:bg-emerald-900"
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
                        className="flex items-start gap-1 text-sm text-amber-700 dark:text-amber-300"
                      >
                        {noteIcon(n.kind)}
                        <span>{n.text}</span>
                      </li>
                    ))}
                  </ul>
                )}
                {s.caveat && (
                  <p
                    data-testid={`food-suggestion-caveat-${s.key}`}
                    className="mt-1.5 text-sm text-slate-500 dark:text-slate-400"
                  >
                    {s.caveat}
                  </p>
                )}
                {/* WHY THIS WORKS — the mechanism paragraph and its regulatory
                    citation, folded (#3497 item 4). Both cards carried them open,
                    and on a lab page that is two screens of prose between the
                    reader and the next reading. The provenance is trust-building
                    and stays FINDABLE — a native <details>, so in-page find still
                    reaches it and it opens with JS off — but it stops leading.
                    What stays visible is everything that is about the reader:
                    the headline, the foods, every safety note, and the advisory. */}
                <details
                  className="group mt-1.5"
                  data-testid={`food-suggestion-why-${s.key}`}
                >
                  <summary
                    data-testid={`food-suggestion-why-toggle-${s.key}`}
                    className={`flex cursor-pointer list-none items-center gap-1 text-sm font-medium [&::-webkit-details-marker]:hidden ${
                      reduce
                        ? "text-amber-800 dark:text-amber-300"
                        : "text-emerald-800 dark:text-emerald-300"
                    }`}
                  >
                    <span className="group-open:hidden">Why this works</span>
                    <span className="hidden group-open:inline">Hide</span>
                    <IconChevronDown
                      className="h-3.5 w-3.5 shrink-0 transition-transform group-open:rotate-180"
                      stroke={2}
                      aria-hidden="true"
                    />
                  </summary>
                  <p className="mt-1 text-sm text-slate-500 dark:text-slate-400">
                    {s.evidence} Source: {s.source}.
                  </p>
                </details>
              </div>
            </div>
          </div>
        );
      })}
    </div>
  );
}
