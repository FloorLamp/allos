import { chartBand, chartNeutral, chartSeries } from "@/lib/chart-colors";
import type {
  EpisodeMedication,
  TemperaturePoint,
} from "@/lib/illness-episode-format";
import type { TemperatureUnit } from "@/lib/settings";
import { fmtTemp } from "@/lib/units";
import {
  formatClockValue,
  formatDateShape,
  type DisplayFormatPrefs,
} from "@/lib/format-date";
import { formatMedicationDoseProduct } from "@/lib/medication-dose-format";
import {
  MOBILE_CHART_CONTENT_PX,
  viewBoxFontSize,
  type ViewBoxScale,
} from "@/lib/chart-svg";

// Compact episode chart with readable axes: temperature values, date ticks, a labeled
// normal-range band, and dose markers share the same time scale. Colors stay on the
// app chart palette; storage and geometry remain canonical °F.
const W = 320;
const H = 148;
const PLOT_LEFT = 38;
const PLOT_RIGHT = 8;
const PLOT_TOP = 12;
const PLOT_BOTTOM = 84;
const DOSE_Y = 108;
const DATE_Y = 141;
const NORMAL_LOW = 97.0;
const NORMAL_HIGH = 99.0;

// The scale contract this panel renders under, and the type size that follows from
// it (issue #1518). A fixed viewBox scaled to `width: 100%` paints `fontSize` USER
// UNITS at `fontSize × (container ÷ viewBox)` CSS px, so the size is computed from
// the narrowest container rather than typed in — the hand-picked 6.5 and 7 here
// rendered ~7.3px and ~7.8px on a phone, under the legibility floor the guard now
// enforces for this whole family.
const SCALE: ViewBoxScale = {
  viewBoxWidth: W,
  minContainerPx: MOBILE_CHART_CONTENT_PX,
};
const LABEL = viewBoxFontSize(SCALE);

function shortDate(date: string, prefs: DisplayFormatPrefs): string {
  const parsed = /^(\d{4})-(\d{2})-(\d{2})$/.exec(date);
  if (!parsed) return date;
  return formatDateShape(prefs.dateFormat, +parsed[1], +parsed[2], +parsed[3], {
    monthStyle: "short",
  });
}

function sampledDates(dates: string[], max = 4): string[] {
  const unique = [...new Set(dates)].sort();
  if (unique.length <= max) return unique;
  return [
    ...new Set(
      Array.from({ length: max }, (_, index) => {
        const at = Math.round((index * (unique.length - 1)) / (max - 1));
        return unique[at];
      })
    ),
  ];
}

export default function FeverChart({
  temperatures,
  medications = [],
  temperatureUnit = "F",
  formatPrefs,
}: {
  temperatures: TemperaturePoint[];
  medications?: EpisodeMedication[];
  temperatureUnit?: TemperatureUnit;
  formatPrefs: DisplayFormatPrefs;
}) {
  const pts = temperatures.filter((point) => Number.isFinite(point.degF));
  const doses = medications.flatMap((medication) =>
    medication.administrations.map((administration) => ({
      ...administration,
      name: medication.name,
      product: administration.product ?? medication.product,
    }))
  );
  if (pts.length === 0 && doses.length === 0) return null;

  const stamp = (date: string, time: string | null) =>
    `${date}T${time ?? "12:00"}`;
  const allStamps = [
    ...pts.map((point) => stamp(point.date, point.time)),
    ...doses.map((dose) => stamp(dose.date, dose.time24 ?? null)),
  ].sort();
  const first = Date.parse(`${allStamps[0]}Z`);
  const last = Date.parse(`${allStamps.at(-1)}Z`);
  const plotWidth = W - PLOT_LEFT - PLOT_RIGHT;
  const xFor = (date: string, time: string | null) => {
    const value = Date.parse(`${stamp(date, time)}Z`);
    return first === last
      ? PLOT_LEFT + plotWidth / 2
      : PLOT_LEFT + ((value - first) / (last - first)) * plotWidth;
  };

  const values = pts.map((point) => point.degF);
  const safeValues = values.length ? values : [NORMAL_LOW, NORMAL_HIGH];
  const lo = Math.min(...safeValues, NORMAL_LOW) - 0.5;
  const hi = Math.max(...safeValues, NORMAL_HIGH) + 0.5;
  const span = hi - lo || 1;
  const y = (value: number) =>
    PLOT_TOP + (1 - (value - lo) / span) * (PLOT_BOTTOM - PLOT_TOP);

  const bandTop = y(NORMAL_HIGH);
  const bandBottom = y(NORMAL_LOW);
  const line = pts
    .map((point) => `${xFor(point.date, point.time)},${y(point.degF)}`)
    .join(" ");
  const dates = sampledDates([
    ...pts.map((point) => point.date),
    ...doses.map((dose) => dose.date),
  ]);

  const chart = (
    <svg
      viewBox={`0 0 ${W} ${H}`}
      width="100%"
      role="img"
      aria-label={`Illness timeline${values.length ? `, peak temperature ${fmtTemp(Math.max(...values), temperatureUnit)}` : ""}, ${doses.length} medication dose${doses.length === 1 ? "" : "s"}`}
      data-testid="episode-fever-chart"
      className="w-full"
    >
      <line
        x1={PLOT_LEFT}
        y1={PLOT_BOTTOM}
        x2={W - PLOT_RIGHT}
        y2={PLOT_BOTTOM}
        stroke={chartBand.reference}
        opacity={0.25}
      />
      <rect
        x={PLOT_LEFT}
        y={bandTop}
        width={plotWidth}
        height={Math.max(0, bandBottom - bandTop)}
        fill={chartBand.reference}
        opacity={0.15}
      />
      <text
        x={PLOT_LEFT + 3}
        y={bandTop + LABEL}
        fontSize={LABEL}
        fill={chartNeutral}
      >
        Normal range
      </text>
      <text
        x={1}
        y={PLOT_TOP + LABEL * 0.5}
        fontSize={LABEL}
        fill={chartNeutral}
      >
        {fmtTemp(hi - 0.5, temperatureUnit)}
      </text>
      <text x={1} y={PLOT_BOTTOM} fontSize={LABEL} fill={chartNeutral}>
        {fmtTemp(lo + 0.5, temperatureUnit)}
      </text>

      {dates.map((date) => {
        const x = xFor(date, null);
        return (
          <g key={date}>
            <line
              x1={x}
              y1={PLOT_TOP}
              x2={x}
              y2={DOSE_Y + 4}
              stroke={chartBand.reference}
              opacity={0.12}
            />
            <text
              x={x}
              y={DATE_Y}
              textAnchor="middle"
              fontSize={LABEL}
              fill={chartNeutral}
            >
              {shortDate(date, formatPrefs)}
            </text>
          </g>
        );
      })}

      {pts.length > 1 && (
        <polyline
          points={line}
          fill="none"
          stroke={chartSeries.rose}
          strokeWidth={2}
          strokeLinejoin="round"
          strokeLinecap="round"
        />
      )}
      {pts.map((point, index) => (
        <circle
          key={point.id || `${point.date}-${point.time ?? index}`}
          cx={xFor(point.date, point.time)}
          cy={y(point.degF)}
          r={2.8}
          fill={point.flag === "high" ? chartSeries.rose : chartBand.reference}
        >
          <title>{`${fmtTemp(point.degF, temperatureUnit)} · ${shortDate(point.date, formatPrefs)}${point.time ? ` · ${formatClockValue(point.time, formatPrefs.timeFormat)}` : ""}`}</title>
        </circle>
      ))}

      {doses.length > 0 && (
        <>
          <line
            x1={PLOT_LEFT}
            y1={DOSE_Y}
            x2={W - PLOT_RIGHT}
            y2={DOSE_Y}
            stroke={chartBand.reference}
            opacity={0.35}
          />
          <text
            x={1}
            y={DOSE_Y + LABEL * 0.35}
            fontSize={LABEL}
            fill={chartNeutral}
          >
            Doses
          </text>
          {doses.map((dose, index) => {
            const x = xFor(dose.date, dose.time24 ?? null);
            return (
              <g key={dose.id ?? `${dose.name}:${dose.date}:${index}`}>
                <title>{`${dose.name}${formatMedicationDoseProduct(dose.amount, dose.product) ? ` · ${formatMedicationDoseProduct(dose.amount, dose.product)}` : ""}${dose.time ? ` · ${formatClockValue(dose.time, formatPrefs.timeFormat)}` : ""}`}</title>
                <path
                  d={`M ${x} ${DOSE_Y - 5} l 5 5 l -5 5 l -5 -5 z`}
                  fill={chartSeries.violet}
                />
              </g>
            );
          })}
        </>
      )}
    </svg>
  );

  if (doses.length === 0) return chart;
  return (
    <>
      {chart}
      {/* The dose detail, in DOM text beneath the chart (#1512 D).
          Each diamond's medication, amount and time lived only in an SVG
          `<title>`, which a touch device never shows — so on a phone the dose
          row was an unreadable line of shapes. Inline labels were the first
          choice and do not fit: an episode spans several days across 274 user
          units and doses cluster within hours of each other, so the labels would
          smear (the #1573 failure). A caption line is the sanctioned fallback:
          complete, legible at any width, and it prints with the chart. */}
      <ul
        data-testid="fever-chart-doses"
        className="mt-1 flex flex-wrap gap-x-3 gap-y-0.5 text-xs text-slate-600 dark:text-slate-300"
      >
        {doses.map((dose, index) => {
          const amount = formatMedicationDoseProduct(dose.amount, dose.product);
          return (
            <li
              key={dose.id ?? `${dose.name}:${dose.date}:${index}`}
              data-testid="fever-chart-dose"
              className="flex min-w-0 items-center gap-1.5"
            >
              <span
                aria-hidden="true"
                className="h-2 w-2 shrink-0 rotate-45"
                style={{ background: chartSeries.violet }}
              />
              <span className="truncate">
                {[
                  dose.name,
                  amount || null,
                  dose.time
                    ? formatClockValue(dose.time, formatPrefs.timeFormat)
                    : null,
                  shortDate(dose.date, formatPrefs),
                ]
                  .filter(Boolean)
                  .join(" · ")}
              </span>
            </li>
          );
        })}
      </ul>
    </>
  );
}
