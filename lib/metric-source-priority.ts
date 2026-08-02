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
import { BODY_METRIC_META } from "./trends-body-metrics";
import { documentSourceId } from "./document-source";

export { documentSourceId };

export const METRIC_SOURCE_PRIORITY_KEY = "metric_source_priority";

// `documentSourceId` is re-exported here for the metric-source API's existing
// callers. Encoding/parsing itself lives in the domain-neutral provenance module.

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

// A source CLASS (issue #1640): one selectable id standing for EVERY source in a
// family, alongside — never replacing — its members. `documents` covers every
// 'document:<id>' provenance, so "my DEXA scans" is one pick and one series
// instead of one per report, and the next scan (a new document id) is covered
// without re-picking. Members keep their own identity everywhere else: the #533
// per-document labels/colors are unaffected.
export const DOCUMENTS_SOURCE_CLASS = "documents";

// Display name for the class — plural on purpose: it is the family, not a report.
export const DOCUMENTS_SOURCE_LABEL = "Documents";

export function isSourceClassId(id: string): boolean {
  return id === DOCUMENTS_SOURCE_CLASS;
}

// Does one selector (a concrete source id OR a class id) match a row's source?
// THE matching primitive — SQL mirrors it in sourceMatchSql (lib/queries/metrics).
export function sourceMatchesSelector(
  selector: string,
  source: string | null | undefined
): boolean {
  const key = sourceKey(source);
  if (selector === DOCUMENTS_SOURCE_CLASS) return documentSourceId(key) != null;
  return selector === key;
}

// metric key → the profile's choice for that metric. Metric keys are the
// metric_samples `metric` strings ('steps', 'sleep_min', …) plus the body_metrics
// kinds ('weight', 'body_fat', 'resting_hr') and 'heart_rate' for the hr_minutes
// stream.
//
// A choice is a source (or class) id plus its MODE (issue #1642):
//   • preference (strict: false) — the chosen source first, then the instance
//     defaults, then single-source passthrough: a day it didn't cover shows
//     whoever did, so a chart never goes blank when a provider lapses.
//   • strict (strict: true) — ONLY that source answers. Uncovered days are real
//     gaps and a latest-value read with no reading is the honest empty state,
//     never another source's number.
export interface MetricSourceChoice {
  source: string;
  strict: boolean;
}

export type MetricSourcePriority = Record<string, MetricSourceChoice>;

// A source id as used in priority matching: an integration id ('health-connect',
// 'oura', 'strava'), 'manual' (which for body_metrics also covers source NULL),
// a 'document:<id>' provenance string, or a class id ('documents', #1640).
// Bounded + shape-checked so a forged form post can't stuff arbitrary blobs into
// profile_settings.
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
//
// TWO value shapes, and the bare string stays canonical for preference mode so
// every already-stored blob keeps parsing unchanged (#1642):
//   "oura"                       → preference
//   { "source": "oura", "strict": true } → strict ("only this source")
// An object without a valid `source`, or with a non-true `strict`, degrades the
// same way anything malformed does — dropped, or read as preference.
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
    for (const [metric, value] of Object.entries(parsed)) {
      if (typeof value === "string") {
        if (isValidSourceId(value))
          out[metric] = { source: value, strict: false };
        continue;
      }
      if (!value || typeof value !== "object" || Array.isArray(value)) continue;
      const { source, strict } = value as {
        source?: unknown;
        strict?: unknown;
      };
      if (typeof source !== "string" || !isValidSourceId(source)) continue;
      out[metric] = { source, strict: strict === true };
    }
    return out;
  } catch {
    return {};
  }
}

// The object form is written ONLY for a strict choice, so a profile that never
// touches strict mode keeps the exact blob shape it has today.
export function serializeMetricSourcePriority(
  priority: MetricSourcePriority
): string {
  const out: Record<string, string | MetricSourceChoice> = {};
  for (const [metric, choice] of Object.entries(priority)) {
    out[metric] = choice.strict
      ? { source: choice.source, strict: true }
      : choice.source;
  }
  return JSON.stringify(out);
}

// Set (source) or clear (null) one metric's primary source, returning the new map.
// `strict` is meaningless without a source and is dropped along with it.
export function withMetricSource(
  priority: MetricSourcePriority,
  metric: string,
  source: string | null,
  strict = false
): MetricSourcePriority {
  const next = { ...priority };
  if (source == null || source === "") delete next[metric];
  else next[metric] = { source, strict };
  return next;
}

// THE resolved answer to "which sources may answer for this metric, in what
// order, and may anything else answer at all" (#14 + #1640 + #1642). ONE
// computation, consumed by the day resolvers, the additive rollups, the
// latest-value reads and the picker alike — no surface re-derives it.
//
// `order` entries are SELECTORS: a concrete source id or a class id (#1640).
// `strict` true means `order` is exhaustive — a day/reading no listed selector
// covers is a genuine gap, not a fallback opportunity.
export interface SourceResolution {
  order: string[];
  strict: boolean;
}

export function resolveMetricSources(
  metric: string,
  priority: MetricSourcePriority,
  defaults: readonly string[]
): SourceResolution {
  const chosen = priority[metric];
  if (chosen?.strict) return { order: [chosen.source], strict: true };
  const out = chosen ? [chosen.source, ...defaults] : [...defaults];
  return { order: [...new Set(out)], strict: false };
}

// The source-preference list alone — the profile's explicit primary source first
// (when set), then the instance defaults. Consumers hand the full resolution to
// pickOneProviderPerDay / pickRowsOneSourcePerDay (lib/metric-providers), whose
// fallback for a day none of these sources covers is single-source passthrough
// (preference mode) or nothing at all (strict) — so an unset priority degrades
// to today's behavior.
export function sourcePreference(
  metric: string,
  priority: MetricSourcePriority,
  defaults: readonly string[]
): string[] {
  return resolveMetricSources(metric, priority, defaults).order;
}

// Normalize a picker argument: a plain preference list (the default provider
// order, and what the pure tests pass) or an already-resolved selection.
export function asSourceResolution(
  selection: readonly string[] | SourceResolution
): SourceResolution {
  return Array.isArray(selection)
    ? { order: [...selection], strict: false }
    : (selection as SourceResolution);
}

// The grouping key a row's source takes under a resolution (#1640): when a CLASS
// selector is in play, every member of that class collapses onto the class id so
// the family resolves as ONE candidate source per day; otherwise the row keeps
// its own sourceKey, so two documents stay two series (#533).
export function sourceGroupKey(
  source: string | null | undefined,
  order: readonly string[]
): string {
  for (const selector of order) {
    if (isSourceClassId(selector) && sourceMatchesSelector(selector, source)) {
      return selector;
    }
  }
  return sourceKey(source);
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
  {
    key: "weight",
    kind: "body",
    title: BODY_METRIC_META.weight.title,
    unit: " kg",
    decimals: BODY_METRIC_META.weight.decimals,
  },
  {
    key: "body_fat",
    kind: "body",
    title: BODY_METRIC_META["body-fat"].title,
    unit: BODY_METRIC_META["body-fat"].unit,
    decimals: BODY_METRIC_META["body-fat"].decimals,
  },
  {
    key: "resting_hr",
    kind: "body",
    title: BODY_METRIC_META["resting-hr"].title,
    unit: BODY_METRIC_META["resting-hr"].unit,
    decimals: BODY_METRIC_META["resting-hr"].decimals,
  },
  {
    key: "steps",
    kind: "sample",
    title: BODY_METRIC_META.steps.title,
    unit: BODY_METRIC_META.steps.unit,
    decimals: BODY_METRIC_META.steps.decimals,
  },
  {
    key: "sleep_min",
    kind: "sample",
    title: "Sleep Per Night",
    unit: " h",
    decimals: 1,
  },
  {
    key: "active_kcal",
    kind: "sample",
    title: BODY_METRIC_META["active-calories"].title,
    unit: BODY_METRIC_META["active-calories"].unit,
    decimals: BODY_METRIC_META["active-calories"].decimals,
  },
  {
    key: "hrv_ms",
    kind: "sample",
    title: BODY_METRIC_META.hrv.title,
    unit: BODY_METRIC_META.hrv.unit,
    decimals: BODY_METRIC_META.hrv.decimals,
  },
  {
    key: "heart_rate",
    kind: "hr-minutes",
    title: BODY_METRIC_META.hr.title,
    unit: BODY_METRIC_META.hr.unit,
    decimals: BODY_METRIC_META.hr.decimals,
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
  // amber-600. A first-class provider needs its OWN color, not the shared unknown
  // fallback (#531/#534: every distinct entity gets a stable color, never one family
  // color) — and this one especially, because the surface it matters on is the
  // compare-sources overlay, where a Takeout series is routinely plotted against the
  // Health Connect series for the very same nights. Sitting in the wide hue gap
  // between strava's burnt orange and manual's green, it stays separable from all
  // five siblings and from the teal fallback.
  "fitbit-takeout": "#ca8a04",
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

// ---- The aggregated Documents series (#1640) ----
// A per-source comparison series, structurally — the query layer's
// MetricSourceSeries, kept structural so this stays a pure module.
export interface SourceSeriesLike {
  source: string;
  data: { date: string; value: number }[];
}

// Does this comparison carry any document-sourced series at all? Gates the
// picker's "Documents" option: ONE scan is already worth electing the class over
// that scan's own id, because the NEXT scan (a new document id) is covered
// without re-picking.
export function hasDocumentSeries(
  series: readonly SourceSeriesLike[]
): boolean {
  return series.some((s) => documentSourceId(s.source) != null);
}

// Insert ONE aggregated 'documents' series covering every document-sourced
// series, positioned just before its members so the aggregate leads the family.
// The per-document series REMAIN — the class is an addition, never a relabeling,
// so the #533 per-document identity is untouched.
//
// Added only when TWO OR MORE documents report the metric: with a single
// document the aggregate would be a pixel-identical second line over the same
// points, which reads as a rendering bug rather than as information. The picker
// still offers the class at one document (hasDocumentSeries) — that is a
// forward-looking choice about future scans, not a claim about this chart.
//
// Same-day readings from two documents AVERAGE, matching how the single-series
// body-metric fold treats two same-day rows of one source.
export function withDocumentsClassSeries<T extends SourceSeriesLike>(
  series: readonly T[]
): (T | SourceSeriesLike)[] {
  const members = series.filter((s) => documentSourceId(s.source) != null);
  if (members.length < 2) return [...series];
  const byDate = new Map<string, { sum: number; n: number }>();
  for (const member of members) {
    for (const point of member.data) {
      const acc = byDate.get(point.date) ?? { sum: 0, n: 0 };
      acc.sum += point.value;
      acc.n += 1;
      byDate.set(point.date, acc);
    }
  }
  const aggregate: SourceSeriesLike = {
    source: DOCUMENTS_SOURCE_CLASS,
    data: [...byDate.entries()]
      .map(([date, { sum, n }]) => ({ date, value: sum / n }))
      .sort((a, b) => (a.date < b.date ? -1 : 1)),
  };
  const firstMember = series.findIndex(
    (s) => documentSourceId(s.source) != null
  );
  const out: (T | SourceSeriesLike)[] = [...series];
  out.splice(firstMember, 0, aggregate);
  return out;
}

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
