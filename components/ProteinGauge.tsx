import { proteinBasisPhrase, type ProteinToday } from "@/lib/protein";

// The protein band gauge (issue #974): one horizontal scale showing THREE numbers at a
// glance — today so far (the primary filled bar), this week's daily average (a thin
// marker line), and the goal band (a shaded zone). A pure formatter over the ONE
// getProteinToday model (#221), so the bar, the marker, and the band can never disagree
// with the adequacy card or the food-nudge status line.
//
// Honest in-progress rendering (issue §3): today is IN PROGRESS, so the today bar is NEVER
// a shortfall color mid-day (a 40 g reading at 11am is normal, not "below") — it's the
// neutral primary tint at every value. Floor semantics carry through the legend copy
// ("at least" when the basis includes the estimate floor).

function g(n: number): string {
  return String(Math.round(n));
}

export default function ProteinGauge({ today }: { today: ProteinToday }) {
  const { todayGrams, target, weeklyAverageGrams } = today;

  // Scale 0 → ~1.2× the band ceiling, widened so a big today/weekly value never overflows.
  const scaleMax = Math.max(
    target.gramsHigh * 1.2,
    todayGrams,
    weeklyAverageGrams ?? 0
  );
  const pct = (v: number) =>
    scaleMax > 0 ? Math.min(100, Math.max(0, (v / scaleMax) * 100)) : 0;

  const bandLeft = pct(target.gramsLow);
  const bandWidth = Math.max(0, pct(target.gramsHigh) - bandLeft);
  const todayWidth = pct(todayGrams);
  const weeklyLeft = weeklyAverageGrams != null ? pct(weeklyAverageGrams) : null;

  // Floor copy: today's bar reads "at least N g" unless it's a measured tracked reading.
  const isFloor = today.todayIntake
    ? today.todayIntake.basis !== "tracked"
    : true;
  const todayValueLabel = `${isFloor ? "at least " : ""}${g(todayGrams)} g`;

  return (
    <div data-testid="protein-gauge" className="mt-1">
      {/* The scale: a track with the shaded goal band, the today bar, and the weekly
          marker line. Fixed height, full width, legible at mobile width. */}
      <div
        className="relative h-8 w-full overflow-hidden rounded-md bg-slate-100 dark:bg-ink-800"
        role="img"
        aria-label={`Protein today ${todayValueLabel}, goal ${g(target.gramsLow)} to ${g(target.gramsHigh)} grams${
          weeklyAverageGrams != null
            ? `, usual ${g(weeklyAverageGrams)} grams a day`
            : ""
        }`}
      >
        {/* Goal band — the shaded target zone. */}
        <div
          data-testid="protein-gauge-band"
          className="absolute inset-y-0 bg-emerald-200/60 dark:bg-emerald-800/40"
          style={{ left: `${bandLeft}%`, width: `${bandWidth}%` }}
        />
        {/* Today so far — the primary filled bar. Neutral tint at every value (in
            progress; never a shortfall color mid-day). */}
        <div
          data-testid="protein-gauge-today"
          data-grams={Math.round(todayGrams)}
          className="absolute inset-y-0 left-0 rounded-r-sm bg-sky-500/70 dark:bg-sky-500/60"
          style={{ width: `${todayWidth}%` }}
        />
        {/* This week's daily average — a thin marker line. */}
        {weeklyLeft != null && (
          <div
            data-testid="protein-gauge-weekly"
            data-grams={Math.round(weeklyAverageGrams ?? 0)}
            className="absolute inset-y-0 w-0.5 bg-slate-600 dark:bg-slate-200"
            style={{ left: `${weeklyLeft}%` }}
          />
        )}
      </div>

      {/* Legend (#945 colloquial-first): the three values named. */}
      <dl className="mt-2 flex flex-wrap gap-x-4 gap-y-1 text-xs text-slate-500 dark:text-slate-400">
        <div className="flex items-center gap-1.5">
          <span className="inline-block h-2.5 w-2.5 rounded-sm bg-sky-500/70" />
          <dt>Today so far</dt>
          <dd className="font-medium tabular-nums text-slate-700 dark:text-slate-200">
            · {todayValueLabel}
          </dd>
        </div>
        {weeklyAverageGrams != null && (
          <div className="flex items-center gap-1.5">
            <span className="inline-block h-2.5 w-0.5 bg-slate-600 dark:bg-slate-200" />
            <dt>Usual</dt>
            <dd className="font-medium tabular-nums text-slate-700 dark:text-slate-200">
              · ~{g(weeklyAverageGrams)} g/day
            </dd>
          </div>
        )}
        <div className="flex items-center gap-1.5">
          <span className="inline-block h-2.5 w-2.5 rounded-sm bg-emerald-200/80 dark:bg-emerald-800/60" />
          <dt>Goal</dt>
          <dd className="font-medium tabular-nums text-slate-700 dark:text-slate-200">
            · {g(target.gramsLow)}–{g(target.gramsHigh)} g
          </dd>
        </div>
      </dl>
      {today.todayIntake && today.todayIntake.basis !== "tracked" && (
        <p className="mt-1 text-xs text-slate-400 dark:text-slate-500">
          Today so far is a floor from your {proteinBasisPhrase(today.todayIntake.basis)}.
        </p>
      )}
    </div>
  );
}
