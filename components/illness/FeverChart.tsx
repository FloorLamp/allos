import { chartSeries, chartBand } from "@/lib/chart-colors";
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

// Compact episode chart with readable axes: temperature values, date ticks, a labeled
// normal-range band, and dose markers share the same time scale. Colors stay on the
// app chart palette; storage and geometry remain canonical °F.
const W = 320;
const H = 142;
const PLOT_LEFT = 34;
const PLOT_RIGHT = 8;
const PLOT_TOP = 10;
const PLOT_BOTTOM = 82;
const DOSE_Y = 105;
const DATE_Y = 137;
const NORMAL_LOW = 97.0;
const NORMAL_HIGH = 99.0;

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

  return (
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
        y={bandTop + 8}
        fontSize={6.5}
        fill={chartSeries.slate}
      >
        Normal range
      </text>
      <text x={1} y={PLOT_TOP + 4} fontSize={7} fill={chartSeries.slate}>
        {fmtTemp(hi - 0.5, temperatureUnit)}
      </text>
      <text x={1} y={PLOT_BOTTOM} fontSize={7} fill={chartSeries.slate}>
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
              fontSize={7}
              fill={chartSeries.slate}
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
          <text x={1} y={DOSE_Y + 3} fontSize={7} fill={chartSeries.slate}>
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
}
