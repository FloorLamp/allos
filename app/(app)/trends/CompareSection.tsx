import { requireSession } from "@/lib/auth";
import { isTrainingRestricted } from "@/lib/age-gate";
import {
  listCompareOptions,
  resolveSeriesByKey,
  buildTrendAnnotations,
  deCollideColor,
  type TrendSeries,
} from "@/lib/trends-series";
import {
  alignSeries,
  normalizeAligned,
  pearson,
  pairedPoints,
  describeCorrelation,
} from "@/lib/trends-compare";
import type { DateRange } from "@/lib/timeline-format";
import CompareControls from "@/components/CompareControls";
import CompareOverlay from "@/components/CompareOverlay";

// The Trends hub's Compare tab: overlay two series on one time axis to eyeball
// correlation. The A/B picks (cmpA/cmpB query params) and the normalize toggle
// (cmpn) round-trip through CompareControls; this server component resolves each
// key to a windowed series, aligns them with the pure lib/trends-compare helpers,
// and renders a dual-axis (or normalized single-axis) overlay plus a Pearson r
// read-out.
export default async function CompareSection({
  range,
  a,
  b,
  normalized,
}: {
  range: DateRange;
  a?: string;
  b?: string;
  normalized: boolean;
}) {
  const { login, profile } = await requireSession();
  const restricted = isTrainingRestricted(profile.id);
  const options = listCompareOptions(profile.id, restricted);

  const seriesA: TrendSeries | null = a
    ? resolveSeriesByKey(profile.id, login.id, range, a, restricted)
    : null;
  const seriesB: TrendSeries | null = b
    ? resolveSeriesByKey(profile.id, login.id, range, b, restricted)
    : null;

  const alignedRaw =
    seriesA && seriesB ? alignSeries(seriesA.points, seriesB.points) : [];
  const r = pearson(alignedRaw);
  const paired = pairedPoints(alignedRaw).length;
  const corr = describeCorrelation(r);
  const chartData = normalized ? normalizeAligned(alignedRaw) : alignedRaw;
  // Event annotations for the overlay, windowed to the shared range (profile-scoped
  // reads only). The client CompareOverlay owns the per-type toggle.
  const annotations = buildTrendAnnotations(profile.id, range);
  // Two biomarkers can hash to the same palette color; nudge B off A so the
  // overlay's two lines (and legend dots) stay distinguishable (issue #400).
  const colorB =
    seriesA && seriesB ? deCollideColor(seriesB.color, seriesA.color) : null;

  return (
    <div className="space-y-6">
      <p className="text-sm text-slate-500 dark:text-slate-400">
        Overlay any two metrics or biomarkers on the shared date window to spot
        relationships (e.g. body weight vs resting heart rate). Different units
        get their own axis; “Normalize” rescales both to 0–100% to compare
        shape.
      </p>

      <CompareControls options={options} a={a} b={b} normalized={normalized} />

      {!seriesA || !seriesB ? (
        <div className="card text-sm text-slate-500 dark:text-slate-400">
          Pick a series for both A and B to see them overlaid.
          {a && !seriesA ? " Series A has no readings in this range." : ""}
          {b && !seriesB ? " Series B has no readings in this range." : ""}
        </div>
      ) : (
        <div className="card space-y-4">
          <div className="flex flex-wrap items-center justify-between gap-3">
            <div className="flex flex-wrap items-center gap-4 text-sm font-medium">
              <span className="flex items-center gap-1.5">
                <span
                  className="inline-block h-2.5 w-2.5 rounded-full"
                  style={{ background: seriesA.color }}
                />
                {seriesA.label}
                {seriesA.unit ? (
                  <span className="text-slate-400">
                    ({seriesA.unit.trim()})
                  </span>
                ) : null}
              </span>
              <span className="flex items-center gap-1.5">
                <span
                  className="inline-block h-2.5 w-2.5 rounded-full"
                  style={{ background: colorB ?? seriesB.color }}
                />
                {seriesB.label}
                {seriesB.unit ? (
                  <span className="text-slate-400">
                    ({seriesB.unit.trim()})
                  </span>
                ) : null}
              </span>
            </div>
            {corr ? (
              <span
                className="rounded-full border border-black/10 bg-white/60 px-3 py-1 text-xs text-slate-600 dark:border-white/10 dark:bg-ink-900/60 dark:text-slate-300"
                title={`Pearson r over ${paired} shared date${paired === 1 ? "" : "s"}`}
              >
                {corr.label} · r = {r!.toFixed(2)} ({paired} shared)
              </span>
            ) : (
              <span className="text-xs text-slate-500 dark:text-slate-400">
                {paired < 2
                  ? "Not enough shared dates to correlate"
                  : "No correlation (a series is flat)"}
              </span>
            )}
          </div>

          <CompareOverlay
            data={chartData}
            labelA={seriesA.label}
            labelB={seriesB.label}
            colorA={seriesA.color}
            colorB={colorB ?? seriesB.color}
            unitA={seriesA.unit}
            unitB={seriesB.unit}
            normalized={normalized}
            annotations={annotations}
          />

          <p className="text-xs text-slate-500 dark:text-slate-400">
            Correlation is not causation — an overlay only shows whether two
            series moved together over the dates they share.
          </p>
        </div>
      )}
    </div>
  );
}
