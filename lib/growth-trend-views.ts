import {
  buildGrowthProfile,
  displayWeightGrowth,
  type DatedValue,
  type TrajectoryPoint,
} from "./growth-series";
import {
  chartForAge,
  MAX_AGE_MONTHS,
  type BandCurve,
  type GrowthMetric,
  type GrowthSex,
} from "./growth";
import type { WeightUnit } from "./settings";
import { TREND_METRIC_META } from "./trend-metrics";

export interface GrowthTrendView {
  metric: GrowthMetric;
  label: string;
  percentileTitle: string;
  referenceSource: "WHO" | "CDC";
  referenceAvailable: boolean;
  unit: string;
  valueRound: number;
  bands: BandCurve[];
  points: TrajectoryPoint[];
  latestPercentile: number | null;
  minMonths: number;
  maxMonths: number;
}

export interface GrowthTrendPresentation {
  currentAgeMonths: number;
  source: "WHO" | "CDC";
  views: GrowthTrendView[];
}

// One display-boundary assembler for every growth-percentile surface. Percentiles
// are always computed from canonical kg/cm inputs; only the plotted weight bands
// and trajectory are converted together for an lb-preferring login.
export function buildGrowthTrendPresentation(input: {
  sex: GrowthSex | null;
  birthdate: string | null;
  today: string;
  heights: DatedValue[];
  weights: DatedValue[];
  headCircs: DatedValue[];
  weightUnit: WeightUnit;
  range?: { from?: string; to?: string };
}): GrowthTrendPresentation | null {
  const growth = buildGrowthProfile(input);
  if (!growth) return null;
  const inRange = (date: string) =>
    (!input.range?.from || date >= input.range.from) &&
    (!input.range?.to || date <= input.range.to);

  const meta: Record<
    GrowthMetric,
    { label: string; unit: string; valueRound: number }
  > = {
    height: {
      label: TREND_METRIC_META.height.title,
      unit: " cm",
      valueRound: 1,
    },
    weight: {
      label: TREND_METRIC_META.weight.title,
      unit: ` ${input.weightUnit}`,
      valueRound: 1,
    },
    bmi: {
      label: TREND_METRIC_META.bmi.title,
      unit: "",
      valueRound: 1,
    },
    head_circumference: {
      label: TREND_METRIC_META["head-circ"].title,
      unit: " cm",
      valueRound: 1,
    },
  };

  const views = growth.metrics.map((metric) => {
    const selectedPoints = metric.points.filter((point) => inRange(point.date));
    const selectedAges = selectedPoints.map((point) => point.ageMonthsExact);
    const minMonths =
      selectedAges.length > 0
        ? Math.max(0, Math.min(...selectedAges) - 3)
        : metric.minMonths;
    const maxMonths =
      selectedAges.length > 0
        ? Math.min(MAX_AGE_MONTHS, Math.max(...selectedAges) + 3)
        : metric.maxMonths;
    const selectedBands =
      selectedAges.length > 0
        ? metric.bands.map((band) => ({
            ...band,
            points: band.points.filter(
              (point) =>
                point.ageMonths >= minMonths && point.ageMonths <= maxMonths
            ),
          }))
        : [];
    const plot =
      metric.metric === "weight"
        ? displayWeightGrowth(
            { bands: selectedBands, points: selectedPoints },
            input.weightUnit
          )
        : { bands: selectedBands, points: selectedPoints };
    const latestPercentile =
      selectedPoints
        .slice()
        .reverse()
        .find((point) => point.percentile != null)?.percentile ?? null;
    // WHICH REFERENCE THIS CARD IS ABOUT, and whether one exists (#2803).
    //
    // The age is the NEWEST measurement in view — its percentile is the one the card
    // headlines — falling back to the profile's age today when the window holds no
    // measurement at all. Not today's age in both cases: a reading taken at 20 months
    // is scored against WHO even for a child who is 25 months now.
    //
    // `referenceAvailable` then means what the empty-state copy claims. It used to be
    // `bands.length > 0`, which is a different question: bandCurves clamps a requested
    // window to the table's own age range, so a 22-month-old's BMI card still got nine
    // one-or-two-point CDC curves starting at month 24 and the card looked like it had
    // a reference. It has none — there is no WHO BMI-for-age table under 24 months —
    // so it said "No body mass index measurement is available in this date range"
    // while the same page charted that very BMI. The measurement is there; the
    // REFERENCE is not, and that is what the reader needs told.
    const chart = chartForAge(
      growth.sex,
      selectedPoints.length > 0
        ? selectedPoints[selectedPoints.length - 1].ageMonths
        : growth.ageMonths,
      metric.metric
    );
    return {
      metric: metric.metric,
      ...meta[metric.metric],
      percentileTitle: `${meta[metric.metric].label} Percentile`,
      // With no table at that age, name the metric's only table so the description
      // line still says which reference the chart would draw: head circumference is
      // WHO-only (0–24 mo), every other metric's out-of-WHO-range table is CDC.
      referenceSource: chart
        ? chart.source === "who"
          ? ("WHO" as const)
          : ("CDC" as const)
        : metric.metric === "head_circumference"
          ? ("WHO" as const)
          : ("CDC" as const),
      referenceAvailable: chart != null,
      bands: plot.bands,
      points: plot.points,
      latestPercentile,
      minMonths,
      maxMonths,
    };
  });

  // Once one growth measure can be scored, expose all four chart identities. A
  // missing or age-inapplicable measure renders as an empty card/tile at the end,
  // rather than silently making the four-chart set look like one to three metrics.
  if (!growth.metrics.some((metric) => metric.latest?.percentile != null))
    return null;
  return {
    currentAgeMonths: growth.ageMonths,
    source: growth.ageMonths < 24 ? "WHO" : "CDC",
    views,
  };
}
