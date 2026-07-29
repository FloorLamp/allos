import { requireSession } from "@/lib/auth";
import { isTrainingRestricted } from "@/lib/age-gate";
import { getDisplayFormatPrefs, getUnitPrefs } from "@/lib/settings";
import { today } from "@/lib/db";
import {
  getInsights,
  getRecentNarratives,
  getSituationImpacts,
  RECAP_KINDS,
} from "@/lib/queries";
import SituationImpactCards from "./SituationImpactCards";
import CompareSection from "./CompareSection";
import { ALL_ROWS, filterSeriesByRange } from "@/lib/trends";
import { formatLongDate, type DisplayFormatPrefs } from "@/lib/format-date";
import { periodLabel } from "@/lib/recap-narrative";
import type { NarrativePeriod } from "@/lib/recap-narrative";
import type { DateRange } from "@/lib/timeline-format";
import { EmptyState } from "@/components/ui";
import DateField from "@/components/DateField";
import SubmitButton from "@/components/SubmitButton";
import { generateForDate, generateRecap } from "./actions";

// A recap-narrative title from its stored kind + window ("Weekly recap · Jul 3 –
// Jul 9"). Falls back gracefully when a start date is absent.
function recapTitle(
  kind: "week" | "month",
  start: string | null,
  end: string,
  prefs: DisplayFormatPrefs
) {
  const label = periodLabel(kind as NarrativePeriod)
    .replace("This", "")
    .trim();
  const cap = label.charAt(0).toUpperCase() + label.slice(1);
  const window = start
    ? `${formatLongDate(start, prefs)} – ${formatLongDate(end, prefs)}`
    : formatLongDate(end, prefs);
  return `${cap} recap · ${window}`;
}

// The Trends hub's Insights section: the hub's DERIVED VIEWS over your own data —
// the AI daily insights (reusing getInsights), the AI weekly/monthly recap
// narratives (issue #20) and their generate forms, the situation-impact analytics
// (#1297), and — since #1489 — the **Compare** overlay, which used to be a tab of
// its own.
//
// THE GATE LIVES HERE, NOT ON THE STRIP (#1489). The AI half is an age-gated
// surface, but compare is age-neutral and training-restricted profiles have always
// had it. So the page offers the Insights section to everyone and this component
// hides the gated half: a restricted profile gets the compare block alone (and
// never a generate form — the write actions re-check the gate independently, since
// hidden UI is not an auth boundary).
//
// #1644: this closes the merged page. It stayed a SECTION rather than earning a
// surface of its own — see lib/trends-sections.ts for the reasoning.
export default async function InsightsSection({
  range,
  cmpA,
  cmpB,
  cmpNormalized,
}: {
  range: DateRange;
  cmpA?: string;
  cmpB?: string;
  cmpNormalized: boolean;
}) {
  const { login, profile } = await requireSession();
  const restricted = isTrainingRestricted(profile.id);
  const formatPrefs = getDisplayFormatPrefs(login.id);
  // Read every insight (ALL_ROWS overrides the default 30-row cap) so an older
  // window isn't silently truncated before filterSeriesByRange windows it. Skipped
  // wholesale for a restricted profile — the gated half doesn't render, so it
  // doesn't run its queries either.
  const insights = restricted
    ? []
    : filterSeriesByRange(getInsights(profile.id, ALL_ROWS), range);
  // Recap narratives are not date-windowed by the shared range — a weekly/monthly
  // recap is a standing summary, so show the most recent few regardless of window.
  const recaps = restricted
    ? []
    : getRecentNarratives(profile.id, RECAP_KINDS, 6);

  // Situation-window impact cards (#1297): pooled protocol-compare over the declared
  // transition log. Standing summaries like the recaps (not range-windowed) — the pooling
  // spans a situation's whole windowed history — so they lead the tab regardless of range.
  const situationImpacts = restricted
    ? []
    : getSituationImpacts(
        profile.id,
        today(profile.id),
        getUnitPrefs(login.id).weightUnit
      );

  return (
    <div className="space-y-6">
      {!restricted && (
        <div className="space-y-6" data-testid="insights-ai">
          <SituationImpactCards impacts={situationImpacts} />

          {/* ---- Weekly / monthly AI recap (issue #20) ---- */}
          <section className="space-y-4">
            <form
              action={generateRecap}
              data-testid="recap-narrative-form"
              className="card flex flex-wrap items-end gap-3"
            >
              <div className="mr-1">
                <div className="label">Period recap</div>
                <p className="max-w-md text-xs text-slate-500 dark:text-slate-400">
                  An AI narrative of your training, adherence, and body-metric
                  trends over the last week or month, grounded in your recap
                  data. Uses Claude when <code>ANTHROPIC_API_KEY</code> is set;
                  otherwise a built-in summary is generated.
                </p>
              </div>
              <SubmitButton
                name="period"
                value="week"
                pendingLabel="Generating…"
              >
                ✦ Weekly recap
              </SubmitButton>
              <SubmitButton
                name="period"
                value="month"
                pendingLabel="Generating…"
              >
                ✦ Monthly recap
              </SubmitButton>
            </form>

            {recaps.length > 0 && (
              <div className="space-y-4">
                {recaps.map((n) => (
                  <div
                    key={n.id}
                    className="card"
                    data-testid="recap-narrative"
                  >
                    <div className="mb-2 flex items-center justify-between gap-2">
                      <h3 className="font-semibold text-slate-800 dark:text-slate-100">
                        {recapTitle(
                          n.kind === "month" ? "month" : "week",
                          n.period_start,
                          n.period_end,
                          formatPrefs
                        )}
                      </h3>
                      <span className="badge bg-slate-100 text-slate-500 dark:bg-ink-800 dark:text-slate-400">
                        {n.model ?? "n/a"}
                      </span>
                    </div>
                    <p className="whitespace-pre-wrap text-sm leading-relaxed text-slate-700 dark:text-slate-200">
                      {n.summary}
                    </p>
                  </div>
                ))}
              </div>
            )}
          </section>

          {/* ---- Daily insight ---- */}
          <section className="space-y-4">
            <form
              action={generateForDate}
              className="card flex flex-wrap items-end gap-4"
            >
              <div>
                <label className="label" htmlFor="insight-date">
                  Date to analyze
                </label>
                <DateField
                  id="insight-date"
                  name="date"
                  defaultValue={today(profile.id)}
                />
              </div>
              <SubmitButton pendingLabel="Generating…">
                ✦ Generate analysis
              </SubmitButton>
              <p className="text-xs text-slate-500 dark:text-slate-400">
                AI-generated daily analysis of your activity, metrics, and
                goals. Uses Claude when <code>ANTHROPIC_API_KEY</code> is set;
                otherwise a built-in summary is generated.
              </p>
            </form>

            {insights.length === 0 ? (
              <EmptyState message="No insights in this range. Generate one above, or widen the date range." />
            ) : (
              <div className="space-y-4">
                {insights.map((i) => (
                  <div key={i.id} className="card">
                    <div className="mb-2 flex items-center justify-between">
                      <h3 className="font-semibold text-slate-800 dark:text-slate-100">
                        {formatLongDate(i.date, formatPrefs)}
                      </h3>
                      <span className="badge bg-slate-100 text-slate-500 dark:bg-ink-800 dark:text-slate-400">
                        {i.model ?? "n/a"}
                      </span>
                    </div>
                    <p className="whitespace-pre-wrap text-sm leading-relaxed text-slate-700 dark:text-slate-200">
                      {i.summary}
                    </p>
                  </div>
                ))}
              </div>
            )}
          </section>
        </div>
      )}

      {/* ---- Compare (#1489: the former Compare tab, now a section) ---- */}
      <section id="compare" className="scroll-mt-28 space-y-4">
        <h2 className="font-semibold text-slate-800 dark:text-slate-100">
          Compare
        </h2>
        <CompareSection
          range={range}
          a={cmpA}
          b={cmpB}
          normalized={cmpNormalized}
        />
      </section>
    </div>
  );
}
