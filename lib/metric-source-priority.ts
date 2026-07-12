// Per-metric source priority (issue #14) — pure (no DB), unit-tested in
// lib/__tests__/metric-source-priority.test.ts.
//
// With more than one real metric source (Health Connect push + Oura pull +
// Strava), the same metric can arrive from several providers. The profile picks
// ONE authoritative ("primary") source per metric; single-value surfaces and the
// additive daily rollups read that source, while point metrics keep every
// source's rows stored for comparison. The choice is stored per profile as ONE
// JSON object in profile_settings (key `metric_source_priority`, e.g.
// {"resting_hr":"oura","sleep_min":"health-connect"}) — this module owns the
// (de)serialization and the preference-list math; lib/settings.ts owns the tier
// read/write.

import { assignHashedColors } from "./trend-colors";

export const METRIC_SOURCE_PRIORITY_KEY = "metric_source_priority";

// A document-provenance source is 'document:<id>' (mirrors
// body-metric-extract.DOCUMENT_SOURCE_PREFIX — kept literal here so this pure module
// doesn't pull in the extraction/AI module graph, the same way the e2e specs mirror
// the wire format). Returns the numeric doc id, or null for a non-document source.
const DOCUMENT_SOURCE_PREFIX = "document:";

export function documentSourceId(source: string): number | null {
  if (!source.startsWith(DOCUMENT_SOURCE_PREFIX)) return null;
  const n = Number(source.slice(DOCUMENT_SOURCE_PREFIX.length));
  return Number.isInteger(n) && n > 0 ? n : null;
}

export interface DocumentMeta {
  filename?: string | null;
  document_date?: string | null;
}

// Human label for a 'document:<id>' series (#533): the document's OWN identity —
// its filename, else its document date, else "Document #<id>" — so two documents no
// longer both collapse to a single "Document" in the legend and primary-source
// picker. `docs` is a per-profile id→meta lookup the caller joins from
// medical_documents. A non-document source returns the bare "Document" fallback
// (callers only pass document sources here). Pure + unit-tested.
export function documentSourceLabel(
  source: string,
  docs: Record<number, DocumentMeta>
): string {
  const id = documentSourceId(source);
  if (id == null) return "Document";
  const meta = docs[id];
  const name = meta?.filename?.trim();
  if (name) return name;
  const date = meta?.document_date?.trim();
  if (date) return `Document (${date})`;
  return `Document #${id}`;
}

// metric key → primary source id. Metric keys are the metric_samples `metric`
// strings ('steps', 'sleep_min', …) plus the body_metrics kinds ('weight',
// 'body_fat', 'resting_hr') and 'heart_rate' for the hr_minutes stream.
export type MetricSourcePriority = Record<string, string>;

// A source id as used in priority matching: an integration id ('health-connect',
// 'oura', 'strava'), 'manual' (which for body_metrics also covers source NULL),
// or a 'document:<id>' provenance string. Bounded + shape-checked so a forged
// form post can't stuff arbitrary blobs into profile_settings.
const SOURCE_ID_RE = /^[a-z0-9][a-z0-9:_-]{0,63}$/;

export function isValidSourceId(source: string): boolean {
  return SOURCE_ID_RE.test(source);
}

// body_metrics stores manual rows with source NULL (or 'manual' from the
// journal); map both onto the one 'manual' key so preference matching and
// display grouping agree.
export function sourceKey(source: string | null | undefined): string {
  return source == null || source === "" || source === "manual"
    ? "manual"
    : source;
}

// Defensive parse of the stored JSON blob: anything malformed yields {}.
export function parseMetricSourcePriority(
  raw: string | null | undefined
): MetricSourcePriority {
  if (!raw) return {};
  try {
    const parsed = JSON.parse(raw);
    if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) {
      return {};
    }
    const out: MetricSourcePriority = {};
    for (const [metric, source] of Object.entries(parsed)) {
      if (typeof source === "string" && isValidSourceId(source)) {
        out[metric] = source;
      }
    }
    return out;
  } catch {
    return {};
  }
}

export function serializeMetricSourcePriority(
  priority: MetricSourcePriority
): string {
  return JSON.stringify(priority);
}

// Set (source) or clear (null) one metric's primary source, returning the new map.
export function withMetricSource(
  priority: MetricSourcePriority,
  metric: string,
  source: string | null
): MetricSourcePriority {
  const next = { ...priority };
  if (source == null || source === "") delete next[metric];
  else next[metric] = source;
  return next;
}

// The source-preference list for a metric: the profile's explicit primary source
// first (when set), then the instance defaults. Consumers hand this to
// pickOneProviderPerDay / pickRowsOneSourcePerDay (lib/metric-providers), whose
// fallback for a day none of these sources covers is single-source passthrough —
// so an unset priority degrades to today's behavior.
export function sourcePreference(
  metric: string,
  priority: MetricSourcePriority,
  defaults: readonly string[]
): string[] {
  const chosen = priority[metric];
  const out = chosen ? [chosen, ...defaults] : [...defaults];
  return [...new Set(out)];
}

// The metrics the comparison UI (Trends → Body → "Compare sources") surfaces and
// the settings picker accepts. `kind` routes the read: 'sample' → metric_samples
// by its metric string; 'body' → the body_metrics column of that kind;
// 'hr-minutes' → the per-minute HR stream. This is a UI/write allowlist — storage
// accepts any metric key, but only these are settable from the app.
export interface ComparableMetric {
  key: string;
  kind: "sample" | "body" | "hr-minutes";
  title: string;
  unit: string; // display unit suffix (weight is converted at the boundary)
  decimals: number;
}

export const COMPARABLE_METRICS: readonly ComparableMetric[] = [
  { key: "weight", kind: "body", title: "Weight", unit: " kg", decimals: 1 },
  { key: "body_fat", kind: "body", title: "Body fat", unit: "%", decimals: 1 },
  {
    key: "resting_hr",
    kind: "body",
    title: "Resting heart rate",
    unit: " bpm",
    decimals: 0,
  },
  { key: "steps", kind: "sample", title: "Steps", unit: "", decimals: 0 },
  {
    key: "sleep_min",
    kind: "sample",
    title: "Sleep per night",
    unit: " h",
    decimals: 1,
  },
  {
    key: "active_kcal",
    kind: "sample",
    title: "Active calories",
    unit: " kcal",
    decimals: 0,
  },
  { key: "hrv_ms", kind: "sample", title: "HRV", unit: " ms", decimals: 0 },
  {
    key: "heart_rate",
    kind: "hr-minutes",
    title: "Heart rate (daily avg)",
    unit: " bpm",
    decimals: 0,
  },
] as const;

export function isComparableMetricKey(key: string): boolean {
  return COMPARABLE_METRICS.some((m) => m.key === key);
}

// Fixed categorical colors for the per-source comparison overlay: color follows
// the SOURCE (the entity), never its position in the current chart, so Oura is
// the same violet on every metric and a filtered chart never repaints the
// survivors. Any unknown source (e.g. a document provenance) shares the one
// fallback. Palette validated for light AND dark surfaces (lightness band,
// chroma floor, CVD separation, ≥3:1 contrast) with the dataviz validator.
export const SOURCE_COLORS: Record<string, string> = {
  manual: "#16a34a",
  "health-connect": "#0284c7",
  oura: "#7c3aed",
  strava: "#ea580c",
  withings: "#db2777",
};

export const SOURCE_FALLBACK_COLOR = "#0d9488";

export function sourceColor(source: string | null | undefined): string {
  return SOURCE_COLORS[sourceKey(source)] ?? SOURCE_FALLBACK_COLOR;
}

// Palette for document series (#533) — distinct hues from the fixed
// integration/manual SOURCE_COLORS so a document line never masquerades as an
// integration's color. Validated for light AND dark surfaces with the dataviz
// validator (lightness band, chroma floor, CVD separation).
export const DOCUMENT_SERIES_COLORS = [
  "#4f46e5", // indigo
  "#d97706", // amber
  "#0891b2", // cyan
  "#c026d3", // fuchsia
  "#65a30d", // lime
  "#e11d48", // rose
] as const;

// Per-KEY color map for a comparison overlay's series (#533). A known source
// (manual + the integrations) keeps its FIXED brand color, so Oura is the same
// violet on every metric; every OTHER key — a distinct 'document:<id>' provenance —
// gets its own stable, de-collided color from DOCUMENT_SERIES_COLORS
// (assignHashedColors, the #406 util) instead of every document sharing the single
// fallback teal. So two documents draw as two different lines with two different
// legend dots, and the primary-source picker's two "Document" options become
// visually and textually distinct. Pure + unit-tested.
export function sourceSeriesColorMap(keys: string[]): Map<string, string> {
  const out = new Map<string, string>();
  const unknown: string[] = [];
  for (const key of keys) {
    const fixed = SOURCE_COLORS[sourceKey(key)];
    if (fixed) out.set(key, fixed);
    else unknown.push(key);
  }
  for (const [key, color] of assignHashedColors(
    unknown,
    DOCUMENT_SERIES_COLORS
  )) {
    out.set(key, color);
  }
  return out;
}
