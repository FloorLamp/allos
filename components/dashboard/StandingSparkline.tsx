import {
  gapBridgesNulls,
  gapFillValue,
  loneReading,
  seriesGapForSeriesKey,
} from "@/lib/trend-sparkline";
import { fillDailySeries } from "@/lib/day-fill";
import { glanceSeriesToneClass } from "@/lib/glance-age";
import SingleReadingMark from "@/components/SingleReadingMark";
import VisualizationDetails from "@/components/VisualizationDetails";

// THE STANDING SPARKLINE COLUMN (#3252) — one aligned column, desktop only.
//
// A reading line answers "what is it now". The column beside it answers "and what has
// it been doing", which is the question the desktop's spare width is worth spending on
// (owner ruling, #3077: "desktop spends its extra room on an inline sparkline, not a
// second column"). Below 720px the column is ABSENT and the same facts stand alone —
// mobile and desktop expose identical facts in identical order, so the plot may never
// be the only carrier of anything.
//
// THAT SEAM IS SPELLED IN rem, NEVER IN px, and the spelling is load-bearing
// (#3459): Tailwind orders an arbitrary px breakpoint BEFORE its named rem ones, so
// a px-spelled variant loses the cascade to any `sm:` rule setting the same
// property. 45rem is the same 720px at the root default. See the note on the row
// template in DashboardStandingCluster.
//
// (Spelled in prose rather than as a literal class on purpose: the px-vs-rem census
// greps for arbitrary-breakpoint utilities, and a warning that names the forbidden
// token would show up in its own sweep as a hit — #3477.)
//
// NO NEW HEALTH COMPUTATION. The series handed in are the reads the row's own domain
// already derives for the page it links to; a row whose domain has no trend read gets
// no sparkline at all rather than a new query. Everything below is drawing.
//
// INLINE SVG, no chart library. The page adds none, and the marks here are the issue's
// own spec: a 2px stroke, a ~12% area fill under it, an emphasized endpoint dot, and
// a nearest-point SVG title naming the exact value and date. The shared disclosure
// below exposes the same history to touch and keyboard users without a custom scrub.
//
// The GAP is not decided here either: `seriesGapForSeriesKey` already declares, per
// series, whether a missing day is a hole a level may cross or an absence the stroke
// must break across, and this consumes that. Steps and weight disagree about that on
// purpose, and drawing them the same way would assert a step count on a day nobody
// measured one.
//
// n = 1 is a MARK, not a plot (docs/internals/charts.md, #1485 G / #2615): one reading
// renders the shared captioned `SingleReadingMark`, never a bare dot in an empty band.
// The same rule #3235 enforces on EquipmentTrend, through the same `loneReading`
// predicate, so a tile and a Standing row cannot draw the identical situation two ways.

/** The plot box, in CSS pixels — 11rem × 2rem, so the viewBox renders ~1:1. */
const WIDTH = 176;
const HEIGHT = 32;
/** Room for the 2px stroke and the endpoint dot to sit fully inside the box. */
const PAD = 4;
/** The n = 1 state's box: the same width, plus a line for the caption it carries. */
const LONE_HEIGHT = 44;

export interface StandingSparklineSeries {
  /**
   * The row's existing trend read, oldest first. Values already in DISPLAY units —
   * unit conversion is the page's boundary, not the plot's.
   */
  points: readonly { date: string; value: number | null }[];
  /**
   * The shared `metric:` / `result:` key (lib/saved-items.ts vocabulary). Its gap
   * policy and its mark are read from it rather than passed alongside it.
   */
  seriesKey: string;
  /** Past the row's own glance floor — the tone, inherited, never re-derived. */
  stale: boolean;
  /** What the column is a picture of, for a reader who never sees it. */
  name: string;
  /** Renders one point as the hover sentence: "82.4 kg · 20 Aug". */
  pointLabel: (point: { date: string; value: number }) => string;
  /** The n = 1 caption, composed by the caller (the words stay per surface). */
  loneCaption: string;
}

interface Plotted {
  x: number;
  y: number;
  date: string;
  value: number;
}

export default function StandingSparkline({
  series,
}: {
  series: StandingSparklineSeries;
}) {
  const gap = seriesGapForSeriesKey(series.seriesKey);
  const fill = gapFillValue(gap);
  const dense = fill
    ? fillDailySeries(
        series.points,
        {
          from: series.points[0]?.date ?? null,
          to: series.points.at(-1)?.date ?? null,
        },
        fill
      )
    : series.points;

  const lone = loneReading(dense);
  const tone = glanceSeriesToneClass(series.stale);

  if (lone) {
    return (
      <div
        data-testid="standing-sparkline"
        data-sparkline-state="single-reading"
        className={`hidden min-[45rem]:col-start-3 min-[45rem]:row-start-1 min-[45rem]:block min-[45rem]:justify-self-end ${tone}`}
        // Taller than the plot band, because this mark is a drawing AND a caption
        // while the plot is only a drawing. The shared component keeps its own type
        // size — a one-off smaller one here would be the micro-text the #794 guard
        // exists to stop, and the caption is the whole point of this state.
        style={{ width: WIDTH, height: LONE_HEIGHT }}
      >
        <SingleReadingMark
          fill
          caption={series.loneCaption}
          dotClassName="bg-current"
        />
      </div>
    );
  }

  const values = dense
    .map((p) => p.value)
    .filter((v): v is number => v != null);
  if (values.length < 2) return null;

  const min = Math.min(...values);
  const max = Math.max(...values);
  const span = max - min || 1;
  const step = dense.length > 1 ? (WIDTH - PAD * 2) / (dense.length - 1) : 0;
  const plot = (value: number, index: number): Plotted => ({
    x: PAD + index * step,
    // A flat series sits on the middle of the band rather than on its floor: a
    // straight line along the bottom edge reads as zero, which is a different claim.
    y:
      max === min
        ? HEIGHT / 2
        : HEIGHT - PAD - ((value - min) / span) * (HEIGHT - PAD * 2),
    date: dense[index].date,
    value,
  });

  // Contiguous runs of real readings. `gapBridgesNulls` says whether a level's stroke
  // may cross the holes between them (weight: yes, the analyte existed) or whether the
  // absence is real and must show (steps: a day nobody measured is not a zero).
  const segments: Plotted[][] = [];
  let current: Plotted[] = [];
  dense.forEach((point, index) => {
    if (point.value == null) {
      if (current.length > 0) segments.push(current);
      current = [];
      return;
    }
    current.push(plot(point.value, index));
  });
  if (current.length > 0) segments.push(current);

  // A level's stroke may cross its holes, so its runs collapse into one.
  const strokes = gapBridgesNulls(gap) ? [segments.flat()] : segments;
  const last = strokes.at(-1)?.at(-1);
  const band =
    dense.length > 1 ? (WIDTH - PAD * 2) / (dense.length - 1) : WIDTH;

  return (
    // ONE GRID ITEM, THE TREND CELL (#3896). The disclosure used to be a SECOND grid
    // item at `col-start-2 col-span-2`, so it landed on a grid line of its own beneath
    // the row and indented to the FACTS column: a plotted family stood a full line
    // taller than an unplotted one, at an x nothing else in the card uses. It belongs
    // under the plot it describes — where every other consumer of the shared
    // disclosure already puts it — rather than under the facts it does not.
    <div
      className={`hidden min-[45rem]:col-start-3 min-[45rem]:row-start-1 min-[45rem]:block min-[45rem]:justify-self-end ${tone}`}
      style={{ width: WIDTH }}
    >
      <svg
        data-testid="standing-sparkline"
        data-sparkline-state="series"
        data-sparkline-points={values.length}
        viewBox={`0 0 ${WIDTH} ${HEIGHT}`}
        width={WIDTH}
        height={HEIGHT}
        className="hidden min-[45rem]:block"
        role="img"
        aria-label={series.name}
        preserveAspectRatio="xMidYMid meet"
      >
        {strokes.map((run) => {
          const key = `${run[0].date}-${run.at(-1)!.date}`;
          const line = run.map((p) => `${p.x},${p.y}`).join(" ");
          return (
            <g key={key}>
              {run.length > 1 && (
                // The area, at ~12% of the line's own colour. `currentColor` carries the
                // glance tone down from the wrapper, so the fill can never drift from
                // the stroke it sits under.
                <polygon
                  points={`${run[0].x},${HEIGHT} ${line} ${run.at(-1)!.x},${HEIGHT}`}
                  fill="currentColor"
                  fillOpacity={0.12}
                />
              )}
              <polyline
                points={line}
                fill="none"
                stroke="currentColor"
                strokeWidth={2}
                strokeLinecap="round"
                strokeLinejoin="round"
              />
            </g>
          );
        })}
        {last && (
          // The endpoint is ALWAYS drawn: on a row whose whole point is the latest
          // reading, the newest mark is the one the eye is looking for.
          <circle
            data-testid="standing-sparkline-endpoint"
            cx={last.x}
            cy={last.y}
            r={2.5}
            fill="currentColor"
          />
        )}
        {strokes.flat().map((point) => (
          // One transparent band per reading carries semantic SVG naming; the
          // disclosure below carries the same values for sighted touch and keyboard.
          <rect
            key={point.date}
            data-testid="standing-sparkline-point"
            x={Math.max(0, point.x - band / 2)}
            y={0}
            width={band}
            height={HEIGHT}
            fill="transparent"
          >
            <title>{series.pointLabel(point)}</title>
          </rect>
        ))}
      </svg>
      {/* `z-10` clears the row link's stretched hit surface, which reaches across this
          column; the shared disclosure keeps the link clickable through everything but
          its own summary and list. The visible word is for the eye — the series name is
          written for a reader who never sees the plot, so it is the accessible name. */}
      <div className="relative z-10 flex justify-end">
        <VisualizationDetails
          label="History"
          aria-label={`${series.name} history details`}
          items={strokes.flat().map((point) => series.pointLabel(point))}
          data-testid="standing-sparkline-details"
        />
      </div>
    </div>
  );
}
