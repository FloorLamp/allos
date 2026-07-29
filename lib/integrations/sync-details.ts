import type { HealthConnectOriginChoice } from "./health-connect";

// The structured `details` JSON every provider's sync event can carry. Started as
// Health Connect's origin/warning diagnostics and is now the shared event-level
// channel: Fitbit Takeout writes its partial-failure warning here, and a PULL run
// that stopped early marks itself `truncated` (#1614) so Review can render it as a
// partial run rather than a clean success — no schema change, and the marker is as
// durable as the event row itself.
export interface SyncEventDetails {
  warnings: string[];
  origins: HealthConnectOriginChoice[];
  // The provider had MORE data than this run took: a page cap or a 429 stopped it,
  // and the sync cursor was deliberately not advanced so the next run re-covers the
  // remainder. Absent (rather than false) on an ordinary complete run.
  truncated?: boolean;
}

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

export function parseSyncEventDetails(
  raw: string | null
): SyncEventDetails | null {
  if (!raw) return null;
  try {
    const value = JSON.parse(raw) as Partial<SyncEventDetails>;
    const warnings = Array.isArray(value.warnings)
      ? value.warnings.filter(
          (item): item is string => typeof item === "string"
        )
      : [];
    const origins = Array.isArray(value.origins)
      ? value.origins.filter(
          (item): item is HealthConnectOriginChoice =>
            !!item &&
            typeof item === "object" &&
            typeof item.date === "string" &&
            typeof item.metric === "string" &&
            typeof item.chosen === "string" &&
            Array.isArray(item.ignored) &&
            item.ignored.every((origin) => typeof origin === "string")
        )
      : [];
    const truncated = value.truncated === true;
    if (!warnings.length && !origins.length && !truncated) return null;
    return { warnings, origins, ...(truncated ? { truncated: true } : {}) };
  } catch {
    return null;
  }
}

// Did this sync event stop early with more data upstream (#1614)? Reads the durable
// `details` marker, so a truncated pull is distinguishable from a clean success on
// every surface that renders an event. Pure → unit-testable.
export function isTruncatedSyncEvent(ev: {
  details?: string | null;
}): boolean {
  return parseSyncEventDetails(ev.details ?? null)?.truncated === true;
}

// The one Review line for a pull that a provider page cap or rate limit cut short.
// Written into the event's own `details` (never a second event), beside the
// `truncated` marker the UI badges. The cursor is deliberately NOT advanced on such a
// run, so the next sync re-covers the window.
export const TRUNCATED_SYNC_WARNING =
  "Partial sync — a page cap or rate limit stopped this run early. The next sync picks up where it left off.";

// The serialized `details` payload for a truncated pull run. ONE shape for Strava,
// Oura, and Withings so their partial runs can't describe themselves differently.
export function truncatedSyncDetails(): string {
  return JSON.stringify({
    warnings: [TRUNCATED_SYNC_WARNING],
    origins: [],
    truncated: true,
  } satisfies SyncEventDetails);
}

// Bound structured diagnostics while repeatedly serializing the candidate object,
// so the stored value is always complete JSON. Never slice serialized JSON: that
// turns a useful prefix into an unparsable value and hides every detail.
export function serializeSyncEventDetails(
  details: SyncEventDetails,
  maxChars = MAX_SYNC_DETAILS_CHARS
): string | null {
  const bounded: SyncEventDetails = {
    warnings: [],
    origins: [],
    // The truncation marker is a single boolean and must never be the thing the
    // char budget drops — it is what the UI badges the run on.
    ...(details.truncated ? { truncated: true } : {}),
  };
  const fits = (candidate: SyncEventDetails) =>
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
  if (!bounded.warnings.length && !bounded.origins.length && !bounded.truncated)
    return null;
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
  const parsed = parseSyncEventDetails(raw);
  return parsed ? serializeSyncEventDetails(parsed, maxChars) : null;
}

export function originChoiceLabel(choice: HealthConnectOriginChoice): string {
  const ignored = choice.ignored.map(originLabel).join(", ");
  return `${metricLabel(choice.metric)}: ${originLabel(choice.chosen)} used · ${ignored} ignored as duplicate`;
}
