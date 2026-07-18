import { fiberBasisIsFloor, type FiberAdequacy } from "@/lib/fiber";

// The fiber band gauge (issue #980 item 2): the fiber row's twin of the protein band gauge
// (#974), so the "Today's nutrients" card's two rows share ONE scale/legend treatment. A
// pure formatter over the ONE getFiberAdequacy model (#221) — no new computation, just the
// weekly intake and the DRI band drawn as a scale. Fiber has no in-progress "today"
// reading (its model is a weekly average), so the primary bar is THIS WEEK's intake, not a
// today-so-far bar; there's no usual-marker line the way protein has. Every non-tracked
// basis is a FLOOR, so the bar reads "at least N g" and the legend says so — the same
// honesty the protein gauge carries.

function g(n: number): string {
  return String(Math.round(n));
}

export default function FiberGauge({ adequacy }: { adequacy: FiberAdequacy }) {
  const { intake, target } = adequacy;

  // Scale 0 → ~1.2× the soft ceiling, widened so a big weekly value never overflows.
  const scaleMax = Math.max(target.gramsHigh * 1.2, intake.grams);
  const pct = (v: number) =>
    scaleMax > 0 ? Math.min(100, Math.max(0, (v / scaleMax) * 100)) : 0;

  // The goal band runs from the DRI adequate intake up to the soft "very high" ceiling.
  const bandLeft = pct(target.grams);
  const bandWidth = Math.max(0, pct(target.gramsHigh) - bandLeft);
  const weekWidth = pct(intake.grams);

  const isFloor = fiberBasisIsFloor(intake.basis);
  const weekValueLabel = `${isFloor ? "at least " : ""}${g(intake.grams)} g`;

  return (
    <div data-testid="fiber-gauge" className="mt-1">
      {/* The scale: a track with the shaded goal band and the this-week bar. */}
      <div
        className="relative h-8 w-full overflow-hidden rounded-md bg-slate-100 dark:bg-ink-800"
        role="img"
        aria-label={`Fiber this week ${weekValueLabel} a day, goal at least ${g(target.grams)} grams a day`}
      >
        {/* Goal band — the DRI adequate-intake zone up to the soft ceiling. */}
        <div
          data-testid="fiber-gauge-band"
          className="absolute inset-y-0 bg-emerald-200/60 dark:bg-emerald-800/40"
          style={{ left: `${bandLeft}%`, width: `${bandWidth}%` }}
        />
        {/* This week's daily average — the primary filled bar. Neutral tint (a floor
            for a non-tracked basis, so never a definite shortfall color). */}
        <div
          data-testid="fiber-gauge-week"
          data-grams={Math.round(intake.grams)}
          className="absolute inset-y-0 left-0 rounded-r-sm bg-sky-500/70 dark:bg-sky-500/60"
          style={{ width: `${weekWidth}%` }}
        />
      </div>

      {/* Legend (#945 colloquial-first): the two values named, matching the protein
          gauge's swatch treatment. */}
      <dl className="mt-2 flex flex-wrap gap-x-4 gap-y-1 text-xs text-slate-500 dark:text-slate-400">
        <div className="flex items-center gap-1.5">
          <span className="inline-block h-2.5 w-2.5 rounded-sm bg-sky-500/70" />
          <dt>This week</dt>
          <dd className="font-medium tabular-nums text-slate-700 dark:text-slate-200">
            · {weekValueLabel}/day
          </dd>
        </div>
        <div className="flex items-center gap-1.5">
          <span className="inline-block h-2.5 w-2.5 rounded-sm bg-emerald-200/80 dark:bg-emerald-800/60" />
          <dt>Goal</dt>
          <dd className="font-medium tabular-nums text-slate-700 dark:text-slate-200">
            · ~{g(target.grams)} g/day
          </dd>
        </div>
      </dl>
    </div>
  );
}
