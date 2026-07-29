import {
  buildGrowthProfile,
  displayWeightGrowth,
  type DatedValue,
  type TrajectoryPoint,
} from "./growth-series";
import {
  MAX_AGE_MONTHS,
  type BandCurve,
  type GrowthMetric,
  type GrowthSex,
} from "./growth";
import type { WeightUnit } from "./settings";
import { BODY_METRIC_META } from "./trends-body-metrics";

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
      label: BODY_METRIC_META.height.title,
      unit: " cm",
      valueRound: 1,
    },
    weight: {
      label: BODY_METRIC_META.weight.title,
      unit: ` ${input.weightUnit}`,
      valueRound: 1,
    },
    bmi: {
      label: BODY_METRIC_META.bmi.title,
      unit: "",
      valueRound: 1,
    },
    head_circumference: {
      label: BODY_METRIC_META["head-circ"].title,
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
    return {
      metric: metric.metric,
      ...meta[metric.metric],
      percentileTitle: `${meta[metric.metric].label} Percentile`,
      referenceSource:
        metric.metric === "head_circumference"
          ? ("WHO" as const)
          : metric.metric === "bmi"
            ? ("CDC" as const)
            : growth.ageMonths < 24
              ? ("WHO" as const)
              : ("CDC" as const),
      referenceAvailable: metric.bands.length > 0,
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
