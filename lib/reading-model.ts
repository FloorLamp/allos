// ONE READING SHAPE OVER THE THREE READING STORES (#1997 phase 1).
//
// The app stores dated numeric readings in three places and, until this module,
// every consumer knew which one it was reading:
//
//   • `body_metrics`   — WIDE, one row per day, up to three measures on it
//                        (weight / body fat / resting HR), source-tagged, no
//                        clinical context.
//   • `metric_samples` — TALL, `metric`/`value` keyed, an absolute start/end
//                        instant per row, source-tagged, no clinical context.
//   • `medical_records`— OBSERVATIONS: a canonical name, the reporting lab's own
//                        range, a flag, and links to the document / encounter /
//                        provider the reading came from.
//
// That coupling is the root of a family of bugs (#1909's two period models,
// #1932's wrong renderer, #1933/#1934's three editability contracts, #1996's
// stranded clinical knowledge, #1931's per-store side-state), because a surface
// that names a TABLE cannot ask a question about a QUANTITY.
//
// So this module declares the quantity-level shape. A `Reading` is keyed by
// #482 IDENTITY — the same `biomarkerFamily()` every biomarker surface already
// partitions on, and the same one `biomarker_family()` reaches from SQL — so the
// clinical knowledge that is keyed by identity (canonical ranges, age bands,
// direction) resolves for a reading NATIVELY, whatever store the row sits in.
//
// PHASE 1 IS A READ MODEL AND NOTHING ELSE. No schema change, no migration, no
// write path: `lib/queries/readings.ts` PRESENTS the existing rows in this shape,
// the stores keep their own writers, and every store-specific reader keeps
// working unchanged. Write consolidation (phase 2) and any physical merge
// (phase 3) are separate, later, and explicitly not started here.
//
// THE GRAIN BOUNDARY IS EXPLICIT. This model covers dated readings ABOVE MINUTE
// GRAIN. `hr_minutes` is deliberately outside it — it is already excluded from
// provenance for volume reasons, and a per-minute stream is not the thing a
// judgement, a period average, or a readings table is asking about.
//
// PURE: no DB, no queries import, so the mapping and the identity resolution are
// unit-testable and can be reused by any layer.

import { biomarkerFamily } from "./canonical-name";
import {
  STREAM_READING_SOURCES,
  type StreamReadingSource,
} from "./reading-identity-map";

// The three physical stores a Reading can be presented from. `medical_records` is
// the OBSERVATION store (provenance-carrying); the other two are STREAMS.
export type ReadingStore =
  "body_metrics" | "metric_samples" | "medical_records";

// How a reading came to exist. Deliberately coarse and about PROVENANCE, not about
// which table it landed in — the whole point of the model is that those are
// different questions:
//
//   • "lab"      — an observation carrying clinical provenance: a document, an
//                  encounter, or a performing provider. A clinic-measured value.
//   • "import"   — a row a bulk/document import produced without any of those
//                  links (a `document:<id>` source stamp on a stream row).
//   • "wearable" — a device/integration sync (the row's `source` is an
//                  integration id).
//   • "manual"   — the user typed it (no source, or the literal 'manual').
export type ReadingSource = "wearable" | "manual" | "import" | "lab";

// The observation-only half. ABSENT (not null) on a stream reading: a wearable
// reading has no document, no encounter, no reporting lab and no lab-stated range,
// and giving it empty ones is exactly the provenance apparatus #1996 argues a
// stream must never grow.
export interface ReadingProvenance {
  documentId?: number;
  encounterId?: number;
  providerId?: number;
  /** The name the source actually printed, when it differs from the canonical. */
  reportedName?: string;
  /** The reporting lab's OWN stated range, verbatim. */
  reportedRange?: string;
  /** The stored out-of-range flag the ingest derived. */
  flag?: string;
}

// ONE dated reading of ONE quantity.
//
// `rowId`/`store`/`sourceKey` are not decoration: a reading surface must still be
// able to reach the physical row a value came from (to edit it, to explain it, to
// say which device reported it), and a model that erases that would force every
// consumer straight back to naming a table.
export interface Reading {
  /** The #482 canonical family — the key clinical knowledge resolves through. */
  identity: string;
  value: number;
  /** The reading's own unit ("bpm", "%"). "" when the row states none. */
  unit: string;
  /** The profile-local day. */
  date: string;
  /**
   * The absolute instant, where the row records one: `metric_samples.start_time`,
   * or the stated `occurred_at` on `body_metrics` (#2235) and `medical_records`
   * (#2154). Null means the reading is day-grain — honest absence, one meaning
   * across all three stores.
   */
  measuredAt: string | null;
  source: ReadingSource;
  /** The physical row this reading is presented from. */
  store: ReadingStore;
  rowId: number;
  /** The row's raw `source` column — an integration id, 'manual', or null. */
  sourceKey: string | null;
  /** The #133 edit lock: the user hand-corrected this row. */
  edited: boolean;
  notes: string | null;
  provenance?: ReadingProvenance;
}

// The stream ↔ canonical half of the identity map (#1996) — DERIVED, since #2086, from
// the one declaration in lib/reading-identity-map.ts that also carries the other half
// (`CONTINUOUS_READING_METRIC`, re-exported by lib/reading-cadence.ts). Re-exported here
// because this module is where every reader of it already looks, and because the shape
// belongs to the reading model; what moved is the LITERAL, so an entry cannot be added
// to one half and forgotten in the other.
//
// DISCIPLINE, same as the family table's: only register a stream key that measures
// the SAME quantity as the canonical entry. Weight, height, HRV, steps and the rest
// are absent because the canonical vocabulary has no entry for them — an invented
// mapping would grant a reading a band that was never curated for it.
export { STREAM_READING_SOURCES, type StreamReadingSource };

/** The #482 identity a canonical biomarker name resolves to. */
export function readingIdentity(name: string | null | undefined): string {
  return biomarkerFamily(name);
}

/**
 * The stream stores whose rows are readings of `identity`. Empty for an identity
 * that only ever lands in `medical_records` (every episodic marker, and the vitals
 * that store as observations).
 *
 * The argument is RESOLVED through `readingIdentity` rather than compared raw, so a
 * canonical NAME and the identity it belongs to answer the same. `biomarkerFamily`
 * is idempotent, so resolving an identity is free — and the asymmetry it removes was
 * a silent half-answer waiting to happen: the observation half already normalizes
 * (`getBiomarkerSeries` families its argument), so the moment one of these canonical
 * names joins a #482 family, a caller passing the NAME would have been handed every
 * observation and NOT ONE stream row, with nothing to notice. A series that quietly
 * omits a store is precisely the failure this model exists to make impossible.
 */
export function streamSourcesForIdentity(
  identity: string
): StreamReadingSource[] {
  const key = readingIdentity(identity).toLowerCase();
  if (!key) return [];
  return STREAM_READING_SOURCES.filter(
    (s) => readingIdentity(s.canonical).toLowerCase() === key
  );
}

/**
 * The identity a stream store's key measures, or null when that key carries no
 * canonical knowledge (weight, steps, sleep — most of the stream vocabulary).
 */
export function identityForStreamKey(
  store: "body_metrics" | "metric_samples",
  key: string
): string | null {
  const src = STREAM_READING_SOURCES.find(
    (s) => s.store === store && s.key === key
  );
  return src ? readingIdentity(src.canonical) : null;
}

// ---- Source classification -------------------------------------------------

/**
 * Classify a row's provenance. Uniform across the stores ON PURPOSE: the Health
 * Connect parser writes SpO2 into `medical_records` and resting HR into
 * `body_metrics`, so "which table" says nothing about where a reading came from —
 * only the row's own links and source stamp do.
 */
export function readingSourceFor(input: {
  sourceKey: string | null | undefined;
  documentId?: number | null;
  encounterId?: number | null;
  providerId?: number | null;
}): ReadingSource {
  if (
    input.documentId != null ||
    input.encounterId != null ||
    input.providerId != null
  ) {
    return "lab";
  }
  const key = (input.sourceKey ?? "").trim();
  if (!key || key.toLowerCase() === "manual") return "manual";
  // A document-derived stream row carries the document in its source stamp rather
  // than in an FK (the stream stores have none).
  if (key.toLowerCase().startsWith("document:")) return "import";
  return "wearable";
}

// ---- Row → Reading ---------------------------------------------------------

/** The `body_metrics` fields a reading is presented from. */
export interface BodyMetricReadingRow {
  id: number;
  date: string;
  value: number;
  source: string | null;
  edited?: number | null;
  notes?: string | null;
  /** The stated event instant (migration 165, #2235), or NULL = not stated. */
  occurred_at?: string | null;
}

/** The `metric_samples` fields a reading is presented from. */
export interface MetricSampleReadingRow {
  id: number;
  date: string;
  value: number;
  source: string | null;
  start_time?: string | null;
  edited?: number | null;
}

/** The `medical_records` fields a reading is presented from. */
export interface ObservationReadingRow {
  id: number;
  date: string;
  /** The stated event instant (migration 165, #2154), or NULL = not stated. */
  occurred_at?: string | null;
  value_num: number | null;
  unit?: string | null;
  name?: string | null;
  canonical_name?: string | null;
  source?: string | null;
  edited?: number | null;
  notes?: string | null;
  flag?: string | null;
  reference_range?: string | null;
  document_id?: number | null;
  encounter_id?: number | null;
  provider_id?: number | null;
}

export function readingFromBodyMetric(
  row: BodyMetricReadingRow,
  src: StreamReadingSource
): Reading {
  return {
    identity: readingIdentity(src.canonical),
    value: row.value,
    unit: src.unit,
    date: row.date,
    // The row's stated `occurred_at` (#2235): the instant the reading was taken,
    // when somebody said so — NULL stays NULL, honest absence, never a midnight
    // anchor. Descriptive only: `date` remains the day attribution and the
    // dedupe key does not read it.
    measuredAt: row.occurred_at ?? null,
    source: readingSourceFor({ sourceKey: row.source }),
    store: "body_metrics",
    rowId: row.id,
    sourceKey: row.source,
    edited: row.edited === 1,
    notes: row.notes ?? null,
  };
}

export function readingFromMetricSample(
  row: MetricSampleReadingRow,
  src: StreamReadingSource
): Reading {
  return {
    identity: readingIdentity(src.canonical),
    value: row.value,
    unit: src.unit,
    date: row.date,
    measuredAt: row.start_time ?? null,
    source: readingSourceFor({ sourceKey: row.source }),
    store: "metric_samples",
    rowId: row.id,
    sourceKey: row.source ?? null,
    edited: row.edited === 1,
    notes: null,
  };
}

/**
 * Present one observation row, or null when it carries no numeric value (a
 * qualitative result is a reading of a different question and has no place in a
 * numeric series).
 *
 * Provenance is attached only when the row actually has some — see
 * ReadingProvenance on why an empty apparatus would be a lie.
 */
export function readingFromObservation(
  row: ObservationReadingRow
): Reading | null {
  if (row.value_num == null) return null;
  const displayName = row.canonical_name?.trim() || row.name?.trim() || "";
  const provenance: ReadingProvenance = {};
  if (row.document_id != null) provenance.documentId = row.document_id;
  if (row.encounter_id != null) provenance.encounterId = row.encounter_id;
  if (row.provider_id != null) provenance.providerId = row.provider_id;
  const reportedName = row.name?.trim();
  if (reportedName && reportedName !== displayName)
    provenance.reportedName = reportedName;
  const reportedRange = row.reference_range?.trim();
  if (reportedRange) provenance.reportedRange = reportedRange;
  const flag = row.flag?.trim();
  if (flag) provenance.flag = flag;
  return {
    identity: readingIdentity(displayName),
    value: row.value_num,
    unit: row.unit?.trim() ?? "",
    date: row.date,
    // The row's stated `occurred_at` (#2154): the instant the reading was
    // taken, when somebody — the user, or the source document/device — said
    // so. NULL stays NULL: honest day-grain absence, exactly as the two stream
    // stores answer it.
    measuredAt: row.occurred_at ?? null,
    source: readingSourceFor({
      sourceKey: row.source,
      documentId: row.document_id,
      encounterId: row.encounter_id,
      providerId: row.provider_id,
    }),
    store: "medical_records",
    rowId: row.id,
    sourceKey: row.source ?? null,
    edited: row.edited === 1,
    notes: row.notes ?? null,
    ...(Object.keys(provenance).length > 0 ? { provenance } : {}),
  };
}

// ---- Series assembly -------------------------------------------------------

/**
 * Collapse readings that are the SAME physical measurement presented twice.
 *
 * The GROUP is (identity, date, SOURCE, value), where `source` is the NORMALIZED
 * `ReadingSource` this model classifies with — not the row's raw `source` column
 * (#2005).
 *
 * Keying on the raw column was a double-count waiting for its first caller. The
 * stores spell the same provenance differently: a hand-entered `body_metrics` row
 * carries `source = NULL` while a hand-entered `medical_records` row carries the
 * literal `'manual'`, and `readingSourceFor` — like the rest of the codebase —
 * already treats those as ONE provenance. Two spellings of one fact must not make
 * two readings out of one, so the collapse asks the same question the shape does.
 *
 * The VALUE is in the group because it must be: a same-day fever curve is several
 * genuinely different Body Temperature readings from one source on one date
 * (#800/#843), and a (date, source) key alone would silently drop all but one of
 * them.
 *
 * THE INSTANT SHARPENS THE GROUP — where both sides actually carry one (#2154).
 * Two readings of one value on one day that BOTH state instants, and state
 * DIFFERENT ones, are two real readings (the fever curve's same-value case,
 * finally distinguishable) and both survive. An instant-less reading makes no
 * claim about when, so it still collapses into its group rather than doubling a
 * timed twin of the same value/day — the #2005 rule the instant must not undo: a
 * hand-entered untimed reading beside a timed import of the same measurement is
 * one reading, not two. (When several timed members exist, the untimed one folds
 * into the group's first — caller order decides, exactly as ties always have.)
 * Instants are compared as the strings the stores hand over; the only place two
 * conventions could meet in one group has no real member today (a manual
 * metric_samples stamp vs. a manual observation of the same quantity — placement
 * routes those to one store).
 *
 * The consequence to state out loud: two DEVICES that report the same value on the
 * same day (with no instants, or the same one) still collapse, because both
 * classify as `wearable`. That is the right answer for a SERIES — charting one
 * day's 52 bpm twice skews every average drawn over it — and "which device said
 * what" is a different question with its own reader (`getStreamReadings`, and the
 * source-comparison surfaces), not something a folded series was ever going to
 * answer.
 *
 * The representative is the reading that carries the MOST: an observation with
 * provenance wins over a bare stream row (even over one carrying an instant —
 * folding stores together never costs a document link), then a timed reading wins
 * over an untimed twin. Remaining ties keep the first, so the caller's order
 * decides.
 */
export function dedupeReadings(readings: readonly Reading[]): Reading[] {
  const kept: Reading[] = [];
  // Group key -> indices into `kept` (one entry per surviving instant slot).
  const groups = new Map<string, number[]>();
  const carriesMore = (kept: Reading, r: Reading): boolean => {
    if (!kept.provenance && r.provenance) return true;
    if (kept.provenance && !r.provenance) return false;
    return kept.measuredAt == null && r.measuredAt != null;
  };
  for (const r of readings) {
    const key = `${r.identity.toLowerCase()}|${r.date}|${r.source}|${r.value}`;
    const members = groups.get(key);
    if (!members) {
      groups.set(key, [kept.push(r) - 1]);
      continue;
    }
    let target = -1;
    if (r.measuredAt != null) {
      // A timed reading merges with its exact instant, else with an untimed
      // member (the same measurement presented without its time), else it is a
      // new reading of the group's value at a different moment.
      target =
        members.find((i) => kept[i].measuredAt === r.measuredAt) ??
        members.find((i) => kept[i].measuredAt == null) ??
        -1;
    } else {
      // An untimed reading claims nothing about when: collapse into the group.
      target = members[0];
    }
    if (target === -1) {
      members.push(kept.push(r) - 1);
      continue;
    }
    if (carriesMore(kept[target], r)) kept[target] = r;
  }
  return kept;
}

/** Oldest → newest, the order every series surface reads in. */
export function sortReadings(readings: readonly Reading[]): Reading[] {
  return [...readings].sort(
    (a, b) =>
      a.date.localeCompare(b.date) ||
      (a.measuredAt ?? "").localeCompare(b.measuredAt ?? "") ||
      a.rowId - b.rowId
  );
}

/** The chart/period-stat shape: one point per reading, oldest first. */
export function readingPoints(
  readings: readonly Reading[]
): { date: string; value: number }[] {
  return sortReadings(readings).map((r) => ({ date: r.date, value: r.value }));
}

// A charted point that knows whether it came from the STREAM or from a folded
// same-identity OBSERVATION. `observed` is what lets a surface say "a clinic
// reading is not a wearable reading" instead of quietly averaging the two ideas.
export interface FoldedPoint {
  date: string;
  value: number;
  observed?: boolean;
}

// The coverage key a stream series and an observation are compared on: the day and
// the value, and nothing else.
//
// It is deliberately SOURCE-BLIND, which is the one place `dedupeReadings`' key
// cannot be applied verbatim: a stream series point is a DAILY FOLD of that day's
// rows (source-priority resolved upstream), so it has no single provenance to
// compare — asking it for one would invent an answer. INSTANT-BLIND for the same
// reason (#2154): the folded point lost its rows' instants on the way to becoming
// a chart point, so a timed observation of the same (date, value) still reads as
// covered rather than doubling the day. Every comparison where both sides really
// are `Reading`s goes through `dedupeReadings`; this is that same key projected
// onto the one side that lost its source on the way to becoming a chart point.
function streamCoverageKey(p: { date: string; value: number }): string {
  return `${p.date}|${p.value}`;
}

/**
 * THE fold decision (#2029): which same-identity observations a stream series does
 * not already carry, oldest first.
 *
 * An observation whose (date, value) already appears in the stream is the SAME
 * reading presented twice — the stream series is a daily fold of rows that may
 * include a manual entry an import also produced — so it is dropped rather than
 * shown beside itself. Everything else survives: a clinic-measured reading is a
 * real reading of this quantity, and leaving it out is exactly the incompleteness
 * #1996 reports.
 *
 * ONE DECISION, TWO CONSUMERS. The metric page's chart and the readings table under
 * it are two views of the same day, and until this function existed they answered
 * "how many readings are there" differently — the chart folded, the table
 * concatenated, and the surface contradicted itself one scroll apart (#2029). Both
 * now read this, so the disagreement has nowhere to live.
 *
 * The observation side is collapsed by `dedupeReadings` first, so two spellings of
 * one clinical reading (#2005) cannot survive as two either.
 *
 * The stream stays authoritative for its own days: nothing here rewrites a
 * streamed value.
 */
export function foldObservations(
  stream: readonly { date: string; value: number }[],
  observations: readonly Reading[]
): Reading[] {
  const streamed = new Set(stream.map(streamCoverageKey));
  return dedupeReadings(sortReadings(observations)).filter(
    (r) => !streamed.has(streamCoverageKey(r))
  );
}

/**
 * The chart projection of `foldObservations`: the stream's points plus the
 * surviving observations, each MARKED so a surface can say "a clinic reading is not
 * a wearable reading" instead of quietly averaging the two ideas.
 */
export function foldObservationPoints(
  stream: readonly { date: string; value: number }[],
  observations: readonly Reading[]
): FoldedPoint[] {
  const folded: FoldedPoint[] = [
    ...stream.map((p) => ({ date: p.date, value: p.value })),
    ...foldObservations(stream, observations).map((r) => ({
      date: r.date,
      value: r.value,
      observed: true,
    })),
  ];
  // Stable by day, stream point first on a day that carries both.
  return folded.sort(
    (a, b) =>
      a.date.localeCompare(b.date) ||
      Number(a.observed ?? false) - Number(b.observed ?? false)
  );
}
