// The nutrient band gauge (issues #974, #980, #4485): one horizontal scale showing a
// period's intake as a filled bar, the goal band as a shaded zone, and — when the model
// has one — an average as a thin marker line. Protein and fiber drew this same track,
// band, fill and legend separately; this is the one drawing of it.
//
// A PURE FORMATTER, and deliberately a dumb one. It receives grams and a floor flag; it
// never asks where they came from, never falls back when one is missing, and never
// converts a unit. Which average the marker is, whether the figure is a floor, and what
// period it describes are all decided in the pure tier before they reach here — that is
// what lets the gauge, the adequacy card and the coaching finding be incapable of
// disagreeing. The only arithmetic here is layout: turning grams into percentages of a
// track.

function g(n: number): string {
  return String(Math.round(n));
}

export interface AdequacyGaugeMarker {
  /** Test ids for the marker line and its legend term, named by the nutrient whose
   *  existing assertions already reach for them. */
  testId: string;
  labelTestId: string;
  /** Which average this is, as the model named it. Rendered, never chosen here. */
  kind: string;
  grams: number;
  label: string;
}

export default function AdequacyGauge({
  testId,
  bandTestId,
  fillTestId,
  periodLabel,
  ariaLabel,
  grams,
  isFloor,
  band,
  goalLegend,
  marker = null,
}: {
  testId: string;
  bandTestId: string;
  fillTestId: string;
  /** The legend's word for the period the bar covers ("Today", "Avg", a weekday). */
  periodLabel: string;
  /** The whole spoken sentence, assembled by the nutrient that owns its copy. */
  ariaLabel: string;
  /** The period's intake, and whether it is a floor on the true figure. */
  grams: number;
  isFloor: boolean;
  /** The goal zone: protein's band bottom/top, fiber's adequate intake/soft ceiling. */
  band: { low: number; high: number };
  /** The goal's compact legend value — a band reads "80–105g", a floor "~38g". */
  goalLegend: string;
  marker?: AdequacyGaugeMarker | null;
}) {
  // Scale 0 → ~1.2× the band ceiling, widened so a big bar or marker never overflows.
  const scaleMax = Math.max(band.high * 1.2, grams, marker?.grams ?? 0);
  const pct = (v: number) =>
    scaleMax > 0 ? Math.min(100, Math.max(0, (v / scaleMax) * 100)) : 0;

  const bandLeft = pct(band.low);
  const bandWidth = Math.max(0, pct(band.high) - bandLeft);
  const markerLeft = marker != null ? pct(marker.grams) : null;
  const compactValue = `${isFloor ? "≥" : ""}${g(grams)}g`;

  return (
    <div data-testid={testId} className="mt-1">
      {/* The scale: a track with the shaded goal band, the period's bar, and the
          marker line. Fixed height, full width, legible at mobile width. */}
      <div
        className="relative h-8 w-full overflow-hidden rounded-md bg-slate-100 dark:bg-ink-800"
        role="img"
        aria-label={ariaLabel}
      >
        {/* Goal band — the shaded target zone. Its absolute grams ride along so a test
            can assert the goal setting (#1503) moved the target rather than only its
            rendered width. */}
        <div
          data-testid={bandTestId}
          data-grams-low={Math.round(band.low)}
          data-grams-high={Math.round(band.high)}
          className="absolute inset-y-0 bg-emerald-200/60 dark:bg-emerald-800/40"
          style={{ left: `${bandLeft}%`, width: `${bandWidth}%` }}
        />
        {/* The period's intake — the primary filled bar. Neutral tint at every value:
            today is IN PROGRESS, so this is never a shortfall color mid-day. */}
        <div
          data-testid={fillTestId}
          data-grams={Math.round(grams)}
          className="absolute inset-y-0 left-0 rounded-r-sm bg-sky-500/70 dark:bg-sky-500/60"
          style={{ width: `${pct(grams)}%` }}
        />
        {marker != null && markerLeft != null && (
          <div
            data-testid={marker.testId}
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
            {compactValue}
          </dd>
        </div>
        {marker != null && (
          <div className="flex items-center gap-1.5">
            <span className="inline-block h-2.5 w-0.5 bg-slate-600 dark:bg-slate-200" />
            <dt data-testid={marker.labelTestId}>{marker.label}</dt>
            <dd className="font-medium tabular-nums text-slate-700 dark:text-slate-200">
              ~{g(marker.grams)}g
            </dd>
          </div>
        )}
        <div className="flex items-center gap-1.5">
          <span className="inline-block h-2.5 w-2.5 rounded-xs bg-emerald-200/80 dark:bg-emerald-800/60" />
          <dt>Goal</dt>
          <dd className="font-medium tabular-nums text-slate-700 dark:text-slate-200">
            {goalLegend}
          </dd>
        </div>
      </dl>
    </div>
  );
}
