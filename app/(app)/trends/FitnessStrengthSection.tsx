import Link from "next/link";
import { requireSession } from "@/lib/auth";
import {
  getCardioByActivity,
  getExerciseE1rmSeries,
  getStrengthByExercise,
} from "@/lib/queries";
import {
  getDisplayFormatPrefs,
  getUnitPrefs,
  getWeekStart,
} from "@/lib/settings";
import { recentCardioPRs, recentPRs } from "@/lib/coaching";
import { chartSeries } from "@/lib/chart-colors";
import { startOfWeekStr } from "@/lib/date";
import { dispWeight } from "@/lib/units";
import {
  prWeeks,
  selectWindowPRs,
  strengthMovers,
  weekStartsThrough,
  windowPrDays,
  type FitnessWindow,
} from "@/lib/trends-fitness";
import { EmptyState } from "@/components/ui";
import LineChartCard from "@/components/LineChartCard";
import StackedBarCard from "@/components/StackedBarCard";

// Trends → Fitness → **Strength progression** (#1492): what the window did to the
// lifts, as trends rather than as a full-history explorer table.
//
// Both halves are windowed reads of EXISTING computations (#221):
//   • getExerciseE1rmSeries(profileId, since, until) — the SAME per-session best-
//     e1RM series plateau detection reads, already collapsed onto the canonical
//     `exerciseHistoryKey` (#331/#432/#482), so a lift and its variants are ONE
//     trend line and ONE mover, never two half-series that each look flat.
//   • recentPRs / recentCardioPRs, windowed exactly as the PRs block windows them,
//     rolled up per week by the pure `prWeeks` — a rate over the records already
//     detected, not a second PR detector.
export default async function FitnessStrengthSection({
  window,
  weeks,
}: {
  window: FitnessWindow;
  weeks: number;
}) {
  const { login, profile } = await requireSession();
  const units = getUnitPrefs(login.id);
  const wu = units.weightUnit;
  const since = window.from ?? undefined;

  const series = getExerciseE1rmSeries(profile.id, since, window.to);
  const movers = strengthMovers(series);
  // The charted lift is the window's most-trained one (most sessions, ties to the
  // bigger move) — the trend most likely to answer "did my training work".
  const lead = [...series]
    .filter((s) => s.points.length >= 2)
    .sort((a, b) => b.points.length - a.points.length)[0];

  // PR rate: the same windowed records the PRs block lists, per week.
  const days = windowPrDays(window);
  const records = selectWindowPRs(
    recentPRs(getStrengthByExercise(profile.id), window.to, days),
    recentCardioPRs(
      getCardioByActivity(
        profile.id,
        units.distanceUnit,
        getDisplayFormatPrefs(login.id)
      ),
      window.to,
      days
    ),
    Number.MAX_SAFE_INTEGER
  ).items;
  const weekStart = getWeekStart(profile.id);
  const earliest = records.reduce(
    (min, r) => (r.date < min ? r.date : min),
    window.from ?? window.to
  );
  const prRate = prWeeks(
    records,
    weekStartsThrough(
      startOfWeekStr(window.from ?? earliest, weekStart),
      window.to
    ).slice(-weeks)
  );

  return (
    <section
      id="strength"
      className="scroll-mt-28 space-y-6"
      data-testid="fitness-strength"
    >
      <div className="card" data-testid="fitness-e1rm-trend">
        <h2 className="mb-1 font-semibold text-slate-800 dark:text-slate-100">
          Estimated 1RM {lead ? `— ${lead.exercise}` : ""}
        </h2>
        <p className="mb-3 text-xs text-slate-500 dark:text-slate-400">
          Best estimated one-rep max per session in this window, for your
          most-trained lift. Variants of a lift count as one.
        </p>
        {!lead ? (
          <EmptyState
            message="No lift has two or more sessions in this window yet. Widen the range, or log another session."
            action={{ href: "/training?tab=log", label: "Go to Log" }}
          />
        ) : (
          <>
            <LineChartCard
              data={lead.points.map((p) => ({
                date: p.date,
                value: dispWeight(p.value, wu, 1),
              }))}
              label="Est. 1RM"
              unit={` ${wu}`}
              color={chartSeries.violet}
            />
            {movers.length > 0 && (
              <ul
                className="mt-4 space-y-1 text-sm"
                data-testid="fitness-strength-movers"
              >
                {movers.map((m) => {
                  const delta = dispWeight(m.deltaKg, wu, 1);
                  return (
                    <li
                      key={m.exercise}
                      className="flex items-baseline justify-between gap-3"
                    >
                      <span className="text-slate-700 dark:text-slate-200">
                        {m.exercise}
                      </span>
                      <span
                        className={`tabular-nums font-medium ${
                          m.deltaKg > 0
                            ? "text-emerald-600 dark:text-emerald-400"
                            : m.deltaKg < 0
                              ? "text-rose-600 dark:text-rose-400"
                              : "text-slate-500 dark:text-slate-400"
                        }`}
                      >
                        {m.deltaKg > 0 ? "+" : ""}
                        {delta} {wu}
                      </span>
                    </li>
                  );
                })}
              </ul>
            )}
            <p className="mt-3 text-xs text-slate-500 dark:text-slate-400">
              Per-lift session tables and the full history live on{" "}
              <Link
                href="/training?tab=analyze"
                className="font-medium text-brand-700 hover:underline dark:text-brand-300"
              >
                Training → Analyze
              </Link>
              .
            </p>
          </>
        )}
      </div>

      <div className="card" data-testid="fitness-pr-rate">
        <h2 className="mb-1 font-semibold text-slate-800 dark:text-slate-100">
          PR rate
        </h2>
        <p className="mb-3 text-xs text-slate-500 dark:text-slate-400">
          Personal records set per week in this window, strength and cardio
          together.
        </p>
        {prRate.length === 0 || records.length === 0 ? (
          <EmptyState message="No records set in this window yet." />
        ) : (
          <StackedBarCard
            data={prRate.map((w) => ({ date: w.week, count: w.count }))}
            series={[{ key: "count", label: "PRs", color: chartSeries.amber }]}
            labelPrefix="Week of "
            decimals={0}
          />
        )}
      </div>
    </section>
  );
}
