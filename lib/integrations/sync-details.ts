import type { HealthConnectSyncDetails } from "./health-connect";

export const MAX_SYNC_DETAILS_CHARS = 4000;

const ORIGIN_LABELS: Record<string, string> = {
  "com.fitbit.FitbitMobile": "Fitbit",
  "com.garmin.android.apps.connectmobile": "Garmin",
};

const METRIC_LABELS: Record<string, string> = {
  steps: "Steps",
  distance_km: "Distance",
  active_kcal: "Active calories",
  total_kcal: "Total calories",
  sleep_min: "Sleep",
  nutrition_kcal: "Nutrition calories",
};

export function originLabel(origin: string): string {
  return ORIGIN_LABELS[origin] ?? origin;
}

export function metricLabel(metric: string): string {
  return (
    METRIC_LABELS[metric] ??
    metric.replaceAll("_", " ").replace(/^./, (c) => c.toUpperCase())
  );
}

export function parseHealthConnectSyncDetails(
  raw: string | null
): HealthConnectSyncDetails | null {
  if (!raw) return null;
  try {
    const value = JSON.parse(raw) as Partial<HealthConnectSyncDetails>;
    const warnings = Array.isArray(value.warnings)
      ? value.warnings.filter(
          (item): item is string => typeof item === "string"
        )
      : [];
    const origins = Array.isArray(value.origins)
      ? value.origins.filter(
          (item): item is HealthConnectSyncDetails["origins"][number] =>
            !!item &&
            typeof item === "object" &&
            typeof item.date === "string" &&
            typeof item.metric === "string" &&
            typeof item.chosen === "string" &&
            Array.isArray(item.ignored) &&
            item.ignored.every((origin) => typeof origin === "string")
        )
      : [];
    return warnings.length || origins.length ? { warnings, origins } : null;
  } catch {
    return null;
  }
}

// Bound structured diagnostics while repeatedly serializing the candidate object,
// so the stored value is always complete JSON. Never slice serialized JSON: that
// turns a useful prefix into an unparsable value and hides every detail.
export function serializeHealthConnectSyncDetails(
  details: HealthConnectSyncDetails,
  maxChars = MAX_SYNC_DETAILS_CHARS
): string | null {
  const bounded: HealthConnectSyncDetails = { warnings: [], origins: [] };
  const fits = (candidate: HealthConnectSyncDetails) =>
    JSON.stringify(candidate).length <= maxChars;

  for (const warning of details.warnings.slice(0, 20)) {
    const value = warning.slice(0, 500);
    const candidate = { ...bounded, warnings: [...bounded.warnings, value] };
    if (fits(candidate)) bounded.warnings.push(value);
  }
  for (const choice of details.origins.slice(0, 100)) {
    const value = {
      date: choice.date.slice(0, 32),
      metric: choice.metric.slice(0, 100),
      chosen: choice.chosen.slice(0, 200),
      ignored: choice.ignored.slice(0, 8).map((origin) => origin.slice(0, 200)),
    };
    const candidate = { ...bounded, origins: [...bounded.origins, value] };
    if (fits(candidate)) bounded.origins.push(value);
  }
  if (!bounded.warnings.length && !bounded.origins.length) return null;
  return JSON.stringify(bounded);
}

// Defensive boundary for direct recordSyncEvent callers. The HC route serializes
// from a structured object; an alternate caller with an oversized string is parsed
// and reserialized through the same safe cap.
export function boundSyncDetailsJson(
  raw: string | null | undefined,
  maxChars = MAX_SYNC_DETAILS_CHARS
): string | null {
  if (!raw) return null;
  if (raw.length <= maxChars) return raw;
  const parsed = parseHealthConnectSyncDetails(raw);
  return parsed ? serializeHealthConnectSyncDetails(parsed, maxChars) : null;
}

export function originChoiceLabel(
  choice: HealthConnectSyncDetails["origins"][number]
): string {
  const ignored = choice.ignored.map(originLabel).join(", ");
  return `${metricLabel(choice.metric)}: ${originLabel(choice.chosen)} used · ${ignored} ignored as duplicate`;
}
