import { proteinGaugeMarker, type ProteinToday } from "@/lib/protein";

// The protein band gauge (issue #974): one horizontal scale showing THREE numbers at a
// glance — today so far (the primary filled bar), an average (a thin marker line), and
// the goal band (a shaded zone). A pure formatter over the ONE getProteinToday model
// (#221), so the bar, the marker, and the band can never disagree with the adequacy
// card or the food-nudge status line.
//
// Honest in-progress rendering (issue §3): today is IN PROGRESS, so the today bar is NEVER
// a shortfall color mid-day (a 40 g reading at 11am is normal, not "below") — it's the
// neutral primary tint at every value. Floor semantics carry through the legend copy
// ("at least" when the basis includes the estimate floor).
//
// WHICH average the marker is, and what it may therefore be called, is decided once in
// `proteinGaugeMarker` (#1917/#2328) — this renders the label it is handed and never
// picks one. Normally that is THIS WEEK's daily average, the very figure the adequacy
// card beside it reaches its weekly verdict on; on a week-start morning, before the
// week has a figure at all, it is the trailing 7-day average under its own name. Two
// questions, two labels; neither surface has to guess which it is looking at.

function g(n: number): string {
  return String(Math.round(n));
}

export default function ProteinGauge({
  today,
  periodLabel = "Today",
}: {
  today: ProteinToday;
  periodLabel?: string;
}) {
  const { todayGrams, target } = today;
  const marker = proteinGaugeMarker(today);

  // Scale 0 → ~1.2× the band ceiling, widened so a big today/marker value never overflows.
  const scaleMax = Math.max(
    target.gramsHigh * 1.2,
    todayGrams,
    marker?.grams ?? 0
  );
  const pct = (v: number) =>
    scaleMax > 0 ? Math.min(100, Math.max(0, (v / scaleMax) * 100)) : 0;

  const bandLeft = pct(target.gramsLow);
  const bandWidth = Math.max(0, pct(target.gramsHigh) - bandLeft);
  const todayWidth = pct(todayGrams);
  const markerLeft = marker != null ? pct(marker.grams) : null;

  // Floor copy: today's bar reads "at least N g" unless it's a measured tracked reading.
  const isFloor = today.todayIntake
    ? today.todayIntake.basis !== "tracked"
    : true;
  const todayValueLabel = `${isFloor ? "at least " : ""}${g(todayGrams)} g`;
  const compactTodayValue = `${isFloor ? "≥" : ""}${g(todayGrams)}g`;

  return (
    <div data-testid="protein-gauge" className="mt-1">
      {/* The scale: a track with the shaded goal band, the today bar, and the weekly
          marker line. Fixed height, full width, legible at mobile width. */}
      <div
        className="relative h-8 w-full overflow-hidden rounded-md bg-slate-100 dark:bg-ink-800"
        role="img"
        aria-label={`Protein ${periodLabel.toLowerCase()} ${todayValueLabel}, goal ${g(target.gramsLow)} to ${g(target.gramsHigh)} grams${
          marker ? `, ${marker.ariaPhrase}` : ""
        }`}
      >
        {/* Goal band — the shaded target zone. */}
        <div
          data-testid="protein-gauge-band"
          // The band's absolute grams, so a test can assert the goal setting (#1503)
          // actually moved the target rather than only its rendered width.
          data-grams-low={Math.round(target.gramsLow)}
          data-grams-high={Math.round(target.gramsHigh)}
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
        {/* The average marker — a thin line, named by the model (#2328). The test id
            stays `protein-gauge-weekly` (the element is the gauge's one marker, and
            renaming it would silently drop every existing assertion); `data-kind`
            is what says WHICH average is standing there. */}
        {markerLeft != null && marker != null && (
          <div
            data-testid="protein-gauge-weekly"
            data-kind={marker.kind}
            data-grams={Math.round(marker.grams)}
            className="absolute inset-y-0 w-0.5 bg-slate-600 dark:bg-slate-200"
            style={{ left: `${markerLeft}%` }}
          />
        )}
      </div>

      {/* Compact legend: the full phrasing remains in the gauge's aria-label. */}
      <dl className="mt-2 flex flex-wrap gap-x-3 gap-y-1 text-xs text-slate-500 dark:text-slate-400">
        <div className="flex items-center gap-1.5">
          <span className="inline-block h-2.5 w-2.5 rounded-xs bg-sky-500/70" />
          <dt>{periodLabel}</dt>
          <dd className="font-medium tabular-nums text-slate-700 dark:text-slate-200">
            {compactTodayValue}
          </dd>
        </div>
        {marker != null && (
          <div className="flex items-center gap-1.5">
            <span className="inline-block h-2.5 w-0.5 bg-slate-600 dark:bg-slate-200" />
            <dt data-testid="protein-gauge-marker-label">{marker.label}</dt>
            <dd className="font-medium tabular-nums text-slate-700 dark:text-slate-200">
              ~{g(marker.grams)}g
            </dd>
          </div>
        )}
        <div className="flex items-center gap-1.5">
          <span className="inline-block h-2.5 w-2.5 rounded-xs bg-emerald-200/80 dark:bg-emerald-800/60" />
          <dt>Goal</dt>
          <dd className="font-medium tabular-nums text-slate-700 dark:text-slate-200">
            {g(target.gramsLow)}–{g(target.gramsHigh)}g
          </dd>
        </div>
      </dl>
    </div>
  );
}
