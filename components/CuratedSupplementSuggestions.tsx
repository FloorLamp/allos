import {
  IconPill,
  IconAlertTriangle,
  IconInfoCircle,
} from "@tabler/icons-react";
import { NOTICE_TONE } from "@/components/Notice";
import InfoTooltipIcon from "@/components/InfoTooltipIcon";
import { joinNamesForSentence } from "@/lib/summarize-names";
import { FOOD_TIMING_HINTS } from "@/lib/intake-schedule";
import type {
  CuratedSupplementSuggestion,
  SupplementSafetyNoteKind,
} from "@/lib/supplement-suggest-curated";

// Presentational renderer for the DETERMINISTIC supplement suggestions (issue #2378) —
// a pure formatter over the CuratedSupplementSuggestion[] the ONE computation
// (getCuratedSupplementSuggestions) yields, shared by the supplements tab and the
// biomarker detail page so they can't disagree ("one question, one computation").
//
// THE DISTINCTION IS THE POINT: every card here is badged CURATED and carries its
// evidence line and public source. The AI route's drafts (lib/supplement-suggest.ts)
// render in their own panel badged GENERATED, with a rationale rather than a source.
// A curated recommendation and a generated one are different claims; a reader must be
// able to tell which one they are looking at without reading the copy.
//
// Informational, never prescriptive: the curated map contains NO dose, so no card can
// show one.

// The CURATED badge's own look, named once because the list's items and the legend
// that explains them must wear the same badge to read as the same vocabulary.
const ORIGIN_BADGE_CLASS =
  "rounded-sm bg-emerald-100 px-1.5 py-0.5 text-xs font-medium uppercase tracking-wide text-emerald-700 dark:bg-emerald-900 dark:text-emerald-300";

const CURATED_ORIGIN_EXPLAINER =
  "From the curated, human-reviewed biomarker→supplement map — the same suggestion every time, with no AI involved.";

function noteIcon(kind: SupplementSafetyNoteKind) {
  return kind === "allergy" ? (
    <IconInfoCircle className="mt-0.5 h-3.5 w-3.5 shrink-0" />
  ) : (
    <IconAlertTriangle className="mt-0.5 h-3.5 w-3.5 shrink-0" />
  );
}

export default function CuratedSupplementSuggestions({
  suggestions,
  testid = "curated-supplement-suggestions",
}: {
  suggestions: CuratedSupplementSuggestion[];
  testid?: string;
}) {
  if (suggestions.length === 0) return null;
  return (
    <div data-testid={testid} className="space-y-3">
      {/* #3970 rule 1. The origin explainer is CONSTANT — every suggestion in this
          list is curated — so it states itself once here, beside a sample of the
          badge it glosses, instead of mounting an `h-8 w-8` button on every row.
          It stays an InfoTooltipIcon and never a `title=`: this is the #2378
          disclaimer #3375 made touch- and keyboard-reachable, and that binds the
          single mount exactly as it bound the N. */}
      <p className="flex items-center gap-1 text-xs text-slate-500 dark:text-slate-400">
        <span className={ORIGIN_BADGE_CLASS}>Curated</span>
        <InfoTooltipIcon
          label={CURATED_ORIGIN_EXPLAINER}
          data-testid="curated-origin-help"
        />
      </p>
      {suggestions.map((s) => {
        const reasons = s.triggeredBy.length > 0 ? s.triggeredBy : [s.label];
        return (
          <div
            key={s.key}
            data-testid={`curated-supplement-suggestion-${s.key}`}
            data-origin={s.origin}
            className={`rounded-lg border px-3 py-2.5 text-base ${NOTICE_TONE.emerald}`}
          >
            <div className="flex items-start gap-1.5">
              <IconPill className="mt-0.5 h-4 w-4 shrink-0 text-emerald-600 dark:text-emerald-400" />
              <div className="min-w-0">
                <div className="flex flex-wrap items-center gap-2">
                  <p className="font-semibold text-emerald-900 dark:text-emerald-100">
                    {/* The side word follows the entry's declared trigger (#2754):
                        the lipids soluble-fiber entry fires on a HIGH flag. The
                        NAMES take the shared join, never a comma — "Lymphocytes,
                        Relative" is one name (#3496; copy.md §9). */}
                    {joinNamesForSentence(reasons)}{" "}
                    {reasons.length > 1 ? "are" : "is"}{" "}
                    {s.side === "high" ? "HIGH." : "LOW."} Options to consider:
                  </p>
                  <span
                    data-testid="suggestion-origin-badge"
                    className={ORIGIN_BADGE_CLASS}
                  >
                    Curated
                  </span>
                </div>
                <ul
                  data-testid={`curated-supplement-items-${s.key}`}
                  className="mt-1.5 list-disc space-y-1 pl-5 marker:text-emerald-500 dark:marker:text-emerald-400"
                >
                  {s.supplements.map((item) => {
                    const hint = FOOD_TIMING_HINTS[item.foodTiming];
                    return (
                      <li
                        key={item.name}
                        className="text-slate-700 dark:text-slate-200"
                      >
                        <span className="font-medium">{item.name}</span>
                        {item.isAlternative && (
                          <span className="ml-1 rounded-sm bg-emerald-100 px-1 py-0.5 text-xs font-medium uppercase tracking-wide text-emerald-700 dark:bg-emerald-900 dark:text-emerald-300">
                            alternative
                          </span>
                        )}
                        {(hint || item.note) && (
                          <span className="block text-sm text-slate-500 dark:text-slate-400">
                            {[hint, item.note].filter(Boolean).join(". ")}
                          </span>
                        )}
                      </li>
                    );
                  })}
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
                    data-testid={`curated-supplement-caveat-${s.key}`}
                    className="mt-1.5 text-sm text-slate-500 dark:text-slate-400"
                  >
                    {s.caveat}
                  </p>
                )}
                <p className="mt-1.5 text-sm text-slate-500 dark:text-slate-400">
                  {s.evidence} Source: {s.source}.
                </p>
              </div>
            </div>
          </div>
        );
      })}
    </div>
  );
}
