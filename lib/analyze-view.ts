// Pure presentation logic for the Training → Analyze section. No React state,
// no DB — every export is a plain constant, a query-param coercion, a derived
// display value, or a chart/table cell formatter, so it is unit-testable in
// isolation (see lib/__tests__/analyze-view.test.ts) and shared by the server
// component AnalyzeSection, which keeps only the data reads + JSX. Query result
// types are imported type-only (erased at compile), so this stays runtime-pure.

import type { ReactNode } from "react";
import type {
  CardioStat,
  ExerciseCompareMetric,
  ExerciseCompareSession,
  ExerciseStat,
  SportStat,
} from "@/lib/queries";
import { dispWeight, fmtWeight, kmTo, round } from "@/lib/units";
import { STANDARD_LEVELS, levelFor, type Standard } from "@/lib/strength";

export type AnalyzeKind = "strength" | "cardio" | "sport";

export const RANGES = [
  { id: "12w", label: "12w", days: 84 },
  { id: "6m", label: "6m", days: 183 },
  { id: "1y", label: "1y", days: 365 },
  { id: "all", label: "All", days: null },
] as const;

export type RangeId = (typeof RANGES)[number]["id"];

export const STRENGTH_METRICS: {
  id: ExerciseCompareMetric;
  label: string;
  chartLabel: string;
}[] = [
  { id: "volume", label: "Volume", chartLabel: "Volume" },
  { id: "e1rm", label: "Est. 1RM", chartLabel: "Est. 1RM" },
  { id: "top", label: "Top set", chartLabel: "Top weight" },
  { id: "reps", label: "Reps", chartLabel: "Reps" },
];

export const CARDIO_METRICS = [
  { id: "distance", label: "Distance", chartLabel: "Distance" },
  { id: "duration", label: "Duration", chartLabel: "Duration" },
  { id: "speed", label: "Speed", chartLabel: "Avg speed" },
] as const;

export type CardioMetric = (typeof CARDIO_METRICS)[number]["id"];

// The label/href-per-option list backing the analyze picker (defined here so
// buildAnalyzeOptions can move to lib; AnalyzePicker re-exports it).
export interface AnalyzeOption {
  kind: AnalyzeKind;
  item: string;
  label: string;
  href: string;
}

export interface AnalyzeView {
  name: string;
  metric: string;
  metrics: { id: string; label: string; chartLabel: string }[];
  chartLabel: string;
  chartUnit: string;
  color: string;
  latestActivityId: number;
  chart: { date: string; value: number | null }[];
  columns: string[];
  sessions: { activityId: number; date: string; cells: string[] }[];
  detail: ReactNode;
}

export function formatRatio(ratio: number) {
  return Number.isInteger(ratio) ? String(ratio) : ratio.toFixed(2);
}

export function coerceKind(
  value: string | undefined,
  available: Record<AnalyzeKind, boolean>
): AnalyzeKind {
  if (value === "strength" && available.strength) return "strength";
  if (value === "cardio" && available.cardio) return "cardio";
  if (value === "sport" && available.sport) return "sport";
  if (available.strength) return "strength";
  if (available.cardio) return "cardio";
  return "sport";
}

export function coerceRange(value: string | undefined): RangeId {
  return RANGES.some((r) => r.id === value) ? (value as RangeId) : "12w";
}

export function coerceStrengthMetric(
  value: string | undefined
): ExerciseCompareMetric {
  return STRENGTH_METRICS.some((m) => m.id === value)
    ? (value as ExerciseCompareMetric)
    : "volume";
}

export function coerceCardioMetric(
  value: string | undefined,
  stat: CardioStat | undefined
): CardioMetric {
  if (value === "distance" && stat?.hasDistance) return "distance";
  if (value === "speed" && stat?.hasDistance) return "speed";
  if (value === "duration") return "duration";
  return stat?.hasDistance ? "distance" : "duration";
}

export function defaultMetric(
  kind: AnalyzeKind,
  currentMetric: string | undefined,
  cardioStat?: CardioStat
): string {
  if (kind === "cardio") return coerceCardioMetric(currentMetric, cardioStat);
  if (kind === "sport") return "duration";
  return coerceStrengthMetric(currentMetric);
}

export function firstName(
  kind: AnalyzeKind,
  strength: ExerciseStat[],
  cardio: CardioStat[],
  sports: SportStat[]
): string | null {
  if (kind === "strength") return strength[0]?.exercise ?? null;
  if (kind === "cardio") return cardio[0]?.activity ?? null;
  return sports[0]?.sport ?? null;
}

export function buildAnalyzeOptions({
  strength,
  cardio,
  sports,
  activeRange,
  metric,
}: {
  strength: ExerciseStat[];
  cardio: CardioStat[];
  sports: SportStat[];
  activeRange: RangeId;
  metric?: string;
}): AnalyzeOption[] {
  const raw = [
    ...strength.map((s) => ({
      kind: "strength" as const,
      item: s.exercise,
      metric: coerceStrengthMetric(metric),
    })),
    ...cardio.map((c) => ({
      kind: "cardio" as const,
      item: c.activity,
      metric: coerceCardioMetric(metric, c),
    })),
    ...sports.map((s) => ({
      kind: "sport" as const,
      item: s.sport,
      metric: "duration",
    })),
  ];
  const counts = new Map<string, number>();
  for (const option of raw) {
    const key = option.item.trim().toLowerCase();
    counts.set(key, (counts.get(key) ?? 0) + 1);
  }
  return raw.map((option) => {
    const duplicate = (counts.get(option.item.trim().toLowerCase()) ?? 0) > 1;
    const label = duplicate
      ? `${option.item} (${kindLabel(option.kind)})`
      : option.item;
    const params = new URLSearchParams();
    params.set("tab", "analyze");
    params.set("kind", option.kind);
    params.set("item", option.item);
    params.set("metric", option.metric);
    params.set("range", activeRange);
    return {
      kind: option.kind,
      item: option.item,
      label,
      href: `/training?${params.toString()}`,
    };
  });
}

export function kindLabel(kind: AnalyzeKind): string {
  if (kind === "strength") return "Strength";
  if (kind === "cardio") return "Cardio";
  return "Sport";
}

export function rangeFilter<T extends { date: string }>(
  rows: T[],
  fromDate: string | null
): T[] {
  return fromDate ? rows.filter((r) => r.date >= fromDate) : rows;
}

export function newestFirst(
  a: { date: string; activityId: number },
  b: { date: string; activityId: number }
) {
  return a.date < b.date
    ? 1
    : a.date > b.date
      ? -1
      : b.activityId - a.activityId;
}

export function strengthMetricValue(
  session: ExerciseCompareSession,
  metric: ExerciseCompareMetric,
  unit: "kg" | "lb"
): number | null {
  switch (metric) {
    case "volume":
      return dispWeight(session.volumeKg, unit, 0);
    case "e1rm":
      return session.e1rmKg == null
        ? null
        : dispWeight(session.e1rmKg, unit, 0);
    case "top":
      return session.topWeightKg == null
        ? null
        : dispWeight(session.topWeightKg, unit, 0);
    case "reps":
      return session.totalReps;
  }
}

export function cardioMetricValue(
  session: CardioStat["trend"][number],
  metric: CardioMetric,
  distanceUnit: "km" | "mi"
): number | null {
  return metric === "distance"
    ? round(kmTo(session.distanceKm, distanceUnit), 2)
    : metric === "speed"
      ? session.speedKmh == null
        ? null
        : round(kmTo(session.speedKmh, distanceUnit), 1)
      : Math.round(session.durationMin);
}

export function bestText(session: ExerciseCompareSession, unit: "kg" | "lb") {
  if (session.topWeightKg == null || session.topReps == null) return "—";
  return `${fmtWeight(session.topWeightKg, unit)} × ${session.topReps}`;
}

export function e1rmText(session: ExerciseCompareSession, unit: "kg" | "lb") {
  return session.e1rmKg == null ? "—" : fmtWeight(session.e1rmKg, unit);
}

export function formatIntensity(value: string | null) {
  const normalized = value?.trim();
  if (!normalized) return "—";
  return normalized.charAt(0).toUpperCase() + normalized.slice(1);
}

// ---- Strength benchmark card ----

export interface BenchmarkRow {
  type: "level" | "current";
  label: string;
  ratio: number;
  color: string;
}

// The pure state behind BenchmarkCard: the athlete's current bodyweight ratio +
// ranked level, whether they're below the beginner cut (unranked, so the actual
// ratio joins the ladder), the label to bold on the ladder, and the sorted rows
// (each standard level, plus the "Current" marker when unranked). Rendering-only
// concerns (JSX, timeline dots) stay in the component.
export function benchmarkState(
  standard: Standard,
  currentE1rmKg: number,
  bodyweightKg: number | null
) {
  const currentRatio =
    bodyweightKg && currentE1rmKg > 0 ? currentE1rmKg / bodyweightKg : null;
  const currentLevel =
    currentRatio == null ? null : levelFor(currentRatio, standard);
  const isUnranked = currentRatio != null && currentRatio < standard.beginner;
  const rankedLevelLabel = !isUnranked ? currentLevel?.label : null;
  const rows: BenchmarkRow[] = [
    ...STANDARD_LEVELS.map((level) => ({
      type: "level" as const,
      label: level.label,
      ratio: standard[level.key],
      color: level.color,
    })),
    ...(!isUnranked || currentRatio == null
      ? []
      : [
          {
            type: "current" as const,
            label: "Current",
            ratio: currentRatio,
            color: "text-brand-700 dark:text-brand-300",
          },
        ]),
  ].sort((a, b) => b.ratio - a.ratio);
  return { currentRatio, currentLevel, isUnranked, rankedLevelLabel, rows };
}
