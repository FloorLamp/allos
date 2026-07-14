import type { DistanceUnit } from "./settings";
import { kmTo, round } from "./units";

// Provider-owned measurements stored on an activity. They are displayed in the
// editor but deliberately stay outside its editable/save payload.
export interface ImportedActivityMetrics {
  avg_hr: number | null;
  max_hr: number | null;
  elevation_m: number | null;
  avg_speed_kmh: number | null;
  max_speed_kmh: number | null;
  relative_effort: number | null;
  avg_power_w: number | null;
  max_power_w: number | null;
  weighted_avg_power_w: number | null;
  avg_cadence: number | null;
  avg_temp_c: number | null;
  kilojoules: number | null;
  workout_type: string | null;
  active_kcal?: number | null;
}

export interface ImportedActivityStat {
  key: ImportedActivityDetailKey | "active_kcal";
  label: string;
  value: string;
  detail?: string;
}

export type ImportedActivityDetailKey =
  | "workout_type"
  | "heart_rate"
  | "elevation"
  | "speed"
  | "relative_effort"
  | "power"
  | "cadence"
  | "kilojoules"
  | "temperature";

export interface ImportedActivityDetail {
  key: ImportedActivityDetailKey;
  label: string;
  value: string;
}

export function pickImportedActivityMetrics(
  activity: ImportedActivityMetrics,
  activeKcal: number | null = null
): ImportedActivityMetrics {
  return {
    avg_hr: activity.avg_hr,
    max_hr: activity.max_hr,
    elevation_m: activity.elevation_m,
    avg_speed_kmh: activity.avg_speed_kmh,
    max_speed_kmh: activity.max_speed_kmh,
    relative_effort: activity.relative_effort,
    avg_power_w: activity.avg_power_w,
    max_power_w: activity.max_power_w,
    weighted_avg_power_w: activity.weighted_avg_power_w,
    avg_cadence: activity.avg_cadence,
    avg_temp_c: activity.avg_temp_c,
    kilojoules: activity.kilojoules,
    workout_type: activity.workout_type,
    active_kcal: activeKcal,
  };
}

export function importedActivityStats(
  metrics: ImportedActivityMetrics,
  distanceUnit: DistanceUnit
): {
  primary: ImportedActivityStat[];
  secondary: ImportedActivityStat[];
} {
  const primary: ImportedActivityStat[] = [];
  const secondary: ImportedActivityStat[] = [];
  if (metrics.avg_hr != null || metrics.max_hr != null) {
    primary.push({
      key: "heart_rate",
      label: "Heart rate",
      value: metrics.avg_hr != null ? `${metrics.avg_hr} bpm` : "—",
      detail: metrics.max_hr != null ? `${metrics.max_hr} max` : undefined,
    });
  }
  if (
    metrics.avg_power_w != null ||
    metrics.max_power_w != null ||
    metrics.weighted_avg_power_w != null
  ) {
    primary.push({
      key: "power",
      label: "Power",
      value: metrics.avg_power_w != null ? `${metrics.avg_power_w} W` : "—",
      detail: [
        metrics.weighted_avg_power_w != null
          ? `${metrics.weighted_avg_power_w} weighted`
          : null,
        metrics.max_power_w != null ? `${metrics.max_power_w} max` : null,
      ]
        .filter(Boolean)
        .join(" · "),
    });
  }
  if (metrics.avg_speed_kmh != null || metrics.max_speed_kmh != null) {
    const unit = `${distanceUnit}/h`;
    primary.push({
      key: "speed",
      label: "Speed",
      value:
        metrics.avg_speed_kmh != null
          ? `${round(kmTo(metrics.avg_speed_kmh, distanceUnit), 1)} ${unit}`
          : "—",
      detail:
        metrics.max_speed_kmh != null
          ? `${round(kmTo(metrics.max_speed_kmh, distanceUnit), 1)} max`
          : undefined,
    });
  }
  if (metrics.elevation_m != null) {
    primary.push({
      key: "elevation",
      label: "Elevation gain",
      value:
        distanceUnit === "mi"
          ? `${Math.round(metrics.elevation_m * 3.28084)} ft`
          : `${Math.round(metrics.elevation_m)} m`,
    });
  }

  if (metrics.workout_type) {
    secondary.push({
      key: "workout_type",
      label: "Workout type",
      value: metrics.workout_type.replace(/\b\w/, (c) => c.toUpperCase()),
    });
  }
  if (metrics.relative_effort != null) {
    secondary.push({
      key: "relative_effort",
      label: "Relative effort",
      value: String(metrics.relative_effort),
    });
  }
  if (metrics.avg_cadence != null) {
    secondary.push({
      key: "cadence",
      label: "Cadence",
      value: `${metrics.avg_cadence} rpm`,
    });
  }
  if (metrics.kilojoules != null) {
    secondary.push({
      key: "kilojoules",
      label: "Mechanical work",
      value: `${metrics.kilojoules} kJ`,
    });
  }
  if (metrics.active_kcal != null) {
    secondary.push({
      key: "active_kcal",
      label: "Active energy",
      value: `${Math.round(metrics.active_kcal)} kcal`,
    });
  }
  if (metrics.avg_temp_c != null) {
    secondary.push({
      key: "temperature",
      label: "Temperature",
      value: `${Math.round(metrics.avg_temp_c)}°C`,
    });
  }
  return { primary, secondary };
}

// Compact preview for the activity form's collapsed details disclosure. Reuse
// the recorded-measurement formatter so its HR/elevation units cannot drift
// from the expanded content.
export function activityDisclosureSummary({
  metrics,
  distanceUnit,
  calorieKcal,
  calorieEstimated,
}: {
  metrics: ImportedActivityMetrics | null | undefined;
  distanceUnit: DistanceUnit;
  calorieKcal: number | null;
  calorieEstimated: boolean;
}): string[] {
  const summary: string[] = [];
  const calories = calorieKcal ?? metrics?.active_kcal ?? null;
  if (calories != null && Number.isFinite(calories) && calories >= 0) {
    summary.push(
      `${calorieEstimated && calorieKcal != null ? "≈ " : ""}${Math.round(calories)} kcal`
    );
  }
  if (!metrics) return summary;

  const { primary } = importedActivityStats(metrics, distanceUnit);
  const heartRate = primary.find((stat) => stat.key === "heart_rate");
  if (heartRate) {
    summary.push(
      heartRate.value === "—" && heartRate.detail
        ? `${heartRate.detail} bpm`
        : heartRate.value
    );
  }
  const elevation = primary.find((stat) => stat.key === "elevation");
  if (elevation) summary.push(elevation.value);
  return summary;
}

// One formatter feeds every surface that presents provider measurements. The
// editor uses the labeled rows; the Journal selects the same formatted values
// for its compact metric strip.
export function importedActivityDetails(
  metrics: ImportedActivityMetrics,
  distanceUnit: DistanceUnit
): ImportedActivityDetail[] {
  const details: ImportedActivityDetail[] = [];
  if (metrics.workout_type) {
    details.push({
      key: "workout_type",
      label: "Workout type",
      value: metrics.workout_type.replace(/\b\w/, (c) => c.toUpperCase()),
    });
  }
  if (metrics.avg_hr != null || metrics.max_hr != null) {
    details.push({
      key: "heart_rate",
      label: "Heart rate",
      value:
        [
          metrics.avg_hr != null ? `${metrics.avg_hr} avg` : null,
          metrics.max_hr != null ? `${metrics.max_hr} max` : null,
        ]
          .filter(Boolean)
          .join(" · ") + " bpm",
    });
  }
  if (metrics.elevation_m != null) {
    details.push({
      key: "elevation",
      label: "Elevation gain",
      value:
        distanceUnit === "mi"
          ? `${Math.round(metrics.elevation_m * 3.28084)} ft`
          : `${Math.round(metrics.elevation_m)} m`,
    });
  }
  if (metrics.avg_speed_kmh != null || metrics.max_speed_kmh != null) {
    const unit = `${distanceUnit}/h`;
    details.push({
      key: "speed",
      label: "Speed",
      value:
        [
          metrics.avg_speed_kmh != null
            ? `${round(kmTo(metrics.avg_speed_kmh, distanceUnit), 1)} avg`
            : null,
          metrics.max_speed_kmh != null
            ? `${round(kmTo(metrics.max_speed_kmh, distanceUnit), 1)} max`
            : null,
        ]
          .filter(Boolean)
          .join(" · ") + ` ${unit}`,
    });
  }
  if (metrics.relative_effort != null) {
    details.push({
      key: "relative_effort",
      label: "Relative effort",
      value: String(metrics.relative_effort),
    });
  }
  if (
    metrics.avg_power_w != null ||
    metrics.max_power_w != null ||
    metrics.weighted_avg_power_w != null
  ) {
    details.push({
      key: "power",
      label: "Power",
      value:
        [
          metrics.avg_power_w != null ? `${metrics.avg_power_w} avg` : null,
          metrics.max_power_w != null ? `${metrics.max_power_w} max` : null,
          metrics.weighted_avg_power_w != null
            ? `${metrics.weighted_avg_power_w} weighted`
            : null,
        ]
          .filter(Boolean)
          .join(" · ") + " W",
    });
  }
  if (metrics.avg_cadence != null) {
    details.push({
      key: "cadence",
      label: "Average cadence",
      value: `${metrics.avg_cadence} rpm`,
    });
  }
  if (metrics.kilojoules != null) {
    details.push({
      key: "kilojoules",
      label: "Work",
      value: `${metrics.kilojoules} kJ`,
    });
  }
  if (metrics.avg_temp_c != null) {
    details.push({
      key: "temperature",
      label: "Average temperature",
      value: `${Math.round(metrics.avg_temp_c)}°C`,
    });
  }
  return details;
}
