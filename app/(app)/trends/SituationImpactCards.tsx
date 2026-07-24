import type { Betterness } from "@/lib/protocol-compare";
import {
  impactChipLabel,
  impactWindowSummary,
  type SituationImpact,
} from "@/lib/situation-impact";

// Situation-window impact cards (issue #1297): the aggregate view the Trends transition
// markers only hint at — "Travel (4 windows · 23 days): SRI −12 · weight +0.8 kg". Each
// card pools a declared situation's windows against their surrounding baselines through the
// SAME pooled protocol-compare engine (one metric vocabulary, two window sources, #221).
// Presentational — the server section resolves the impacts and passes them in; only
// situations with enough windowed history reach here (the absent-pillar rule, #489), so an
// empty list renders nothing.

// A chip tint by the good/bad verdict, matching the coaching card's tone dots: better =
// emerald, worse = amber, unchanged/unknown = slate (neutral metrics carry no verdict).
const BETTER_CHIP: Record<Betterness, string> = {
  better:
    "bg-emerald-100 text-emerald-700 dark:bg-emerald-950 dark:text-emerald-300",
  worse: "bg-amber-100 text-amber-700 dark:bg-amber-950 dark:text-amber-300",
  unchanged: "bg-slate-100 text-slate-600 dark:bg-ink-800 dark:text-slate-300",
  unknown: "bg-slate-100 text-slate-600 dark:bg-ink-800 dark:text-slate-300",
};

// Anchor slug for a situation card so a future deep-link (situation chips → Trends) lands
// on the right card. Kept ASCII-safe.
function anchorId(name: string): string {
  return `situation-impact-${name
    .trim()
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "-")}`;
}

export default function SituationImpactCards({
  impacts,
}: {
  impacts: SituationImpact[];
}) {
  if (impacts.length === 0) return null;
  return (
    <section className="space-y-4" data-testid="situation-impacts">
      <div>
        <h2 className="text-sm font-semibold text-slate-800 dark:text-slate-100">
          Situation impact
        </h2>
        <p className="max-w-md text-xs text-slate-500 dark:text-slate-400">
          What each ongoing situation actually did to your metrics — the during
          days pooled across every window versus the surrounding baseline. Means
          and shifts with day counts, not a score.
        </p>
      </div>
      {impacts.map((impact) => (
        <div
          key={impact.situation}
          id={anchorId(impact.situation)}
          data-testid={`situation-impact-${impact.situation}`}
          className="card scroll-mt-44"
        >
          <div className="mb-2 flex items-center justify-between gap-2">
            <h3 className="font-semibold text-slate-800 dark:text-slate-100">
              {impact.situation}
            </h3>
            <span className="badge bg-slate-100 text-slate-500 dark:bg-ink-800 dark:text-slate-400">
              {impactWindowSummary(impact)}
            </span>
          </div>
          <div className="flex flex-wrap gap-1.5">
            {impact.outcomes.map((o) => (
              <span
                key={o.key}
                data-testid={`situation-impact-${impact.situation}-${o.key}`}
                className={`badge ${BETTER_CHIP[o.betterness]}`}
              >
                {impactChipLabel(o)}
              </span>
            ))}
          </div>
          <ul className="mt-3 space-y-1">
            {impact.outcomes.map((o) => (
              <li
                key={o.key}
                className="text-xs text-slate-500 dark:text-slate-400"
              >
                {o.framing}
              </li>
            ))}
          </ul>
        </div>
      ))}
    </section>
  );
}
