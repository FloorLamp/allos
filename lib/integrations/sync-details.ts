import type {
  HealthConnectOriginChoice,
  SyncTypeTally,
} from "./health-connect";

// The structured `details` JSON every source's sync event can carry. Started as
// Health Connect's origin/warning diagnostics and is now the shared event-level
// channel: Fitbit Takeout writes its partial-failure warning here, and a PULL run
// that stopped early marks itself `truncated` (#1614) so Review can render it as a
// partial run rather than a clean success — no schema change, and the marker is as
// durable as the event row itself.
export interface SyncEventDetails {
  warnings: string[];
  origins: HealthConnectOriginChoice[];
  // The source had MORE data than this run took: a page cap or a 429 stopped it,
  // and the sync cursor was deliberately not advanced so the next run re-covers the
  // remainder. Absent (rather than false) on an ordinary complete run.
  truncated?: boolean;
  // Per-type record accounting for this run (#4956) — what arrived, what landed.
  // Health Connect writes it for every consumed type that carried records; a source
  // that reports no per-type breakdown simply omits it, and `droppedTypes` below then
  // has nothing to say about that run rather than guessing.
  tally?: SyncTypeTally;
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

// Read a stored tally back defensively — `details` is durable JSON written by past
// versions, so an entry whose counts are not finite numbers is dropped rather than
// trusted into an arithmetic comparison. Returns null when nothing usable survives.
function readTally(raw: unknown): SyncTypeTally | null {
  if (!raw || typeof raw !== "object" || Array.isArray(raw)) return null;
  const out: SyncTypeTally = {};
  for (const [key, value] of Object.entries(raw as Record<string, unknown>)) {
    if (!value || typeof value !== "object") continue;
    const { received, landed } = value as Record<string, unknown>;
    if (typeof received !== "number" || !Number.isFinite(received)) continue;
    if (typeof landed !== "number" || !Number.isFinite(landed)) continue;
    out[key.slice(0, 100)] = { received, landed };
  }
  return Object.keys(out).length ? out : null;
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
    const tally = readTally(value.tally);
    if (!warnings.length && !origins.length && !truncated && !tally)
      return null;
    return {
      warnings,
      origins,
      ...(truncated ? { truncated: true } : {}),
      ...(tally ? { tally } : {}),
    };
  } catch {
    return null;
  }
}

// Did this sync event stop early with more data upstream (#1614)? Reads the durable
// `details` marker, so a truncated pull is distinguishable from a clean success on
// every surface that renders an event. Pure → unit-testable.
export function isTruncatedSyncEvent(ev: { details?: string | null }): boolean {
  return parseSyncEventDetails(ev.details ?? null)?.truncated === true;
}

// The one Review line for a pull that a source page cap or rate limit cut short.
// Written into the event's own `details` (never a second event), beside the
// `truncated` marker the UI badges. The cursor is deliberately NOT advanced on such a
// run, so the next sync re-covers the window.
export const TRUNCATED_SYNC_WARNING =
  "Partial sync — a page cap or rate limit stopped this run early. The next sync picks up where it left off.";

// The serialized `details` payload for a PARTIAL run. ONE shape for Strava, Oura,
// Withings and — since #2567 — Weather, so their partial runs can't describe
// themselves differently.
//
// `warning` overrides the human Review LINE only, never the durable marker: every
// caller writes the same `truncated: true` that `isTruncatedSyncEvent` reads and
// `scheduledStanding` turns into `"partial"`. Weather passes its own line because the
// default names a cause it does not have — no page cap and no rate limit stopped it,
// its air-quality half simply failed — and a marker whose sentence is false is worse
// than no sentence at all. Bounded here rather than trusted: a partial reason can be
// an arbitrary upstream error string.
export function truncatedSyncDetails(
  warning: string = TRUNCATED_SYNC_WARNING
): string {
  return JSON.stringify({
    warnings: [warning.slice(0, 500)],
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
    // Neither may the tally: it is the durable evidence `droppedTypes` reads, and a
    // budget that silently drops it would restore exactly the silence #4956 is about.
    // Its size is bounded by the consumed-key set, not by anything a payload controls.
    ...(details.tally && Object.keys(details.tally).length
      ? { tally: details.tally }
      : {}),
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
  if (
    !bounded.warnings.length &&
    !bounded.origins.length &&
    !bounded.truncated &&
    !bounded.tally
  )
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

// THE TYPES A LIVE SOURCE IS SWALLOWING (#4956), over a window of its events.
//
// A source can be perfectly healthy — every run `ok`, rows landing — and still be
// dropping one record type entirely, because the exporter renamed a field the parser
// reads. That is what happened for six days across 405 `ok` pushes, and nothing in the
// failing/stale vocabulary can describe it: nothing failed and data did arrive.
//
// A type qualifies when the window contains at least one successful run that RECEIVED
// it and NOT ONE successful run that landed any of it. So a single landed record
// clears the type on the next read — the signal ends the moment the drop does, with no
// separate resolution step — and a type simply absent from a push says nothing either
// way, which is what makes a nightly type (skin temperature) safe to judge over a
// window that contains daytime pushes.
//
// FAILED runs are ignored: a run that threw has no honest tally, and a source whose
// runs are failing is already described by `failing`.
export function droppedTypes(
  events: readonly { ok: number; details?: string | null }[]
): string[] {
  const received = new Set<string>();
  const landed = new Set<string>();
  for (const ev of events) {
    if (!ev.ok) continue;
    const tally = parseSyncEventDetails(ev.details ?? null)?.tally;
    if (!tally) continue;
    for (const [key, counts] of Object.entries(tally)) {
      if (counts.received > 0) received.add(key);
      if (counts.landed > 0) landed.add(key);
    }
  }
  return [...received].filter((key) => !landed.has(key)).sort();
}

export function originChoiceLabel(choice: HealthConnectOriginChoice): string {
  const ignored = choice.ignored.map(originLabel).join(", ");
  return `${metricLabel(choice.metric)}: ${originLabel(choice.chosen)} used · ${ignored} ignored as duplicate`;
}
