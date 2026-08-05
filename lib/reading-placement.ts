// WHERE A READING PHYSICALLY LIVES (#2032, phase 2 of #1997) — the WRITE-side
// sibling of `STREAM_READING_SOURCES`.
//
// Phase 1 gave the app one `Reading` shape keyed by #482 identity, so a surface could
// finally ask a question about a QUANTITY instead of about a table. The write half
// stayed behind: every writer resolved a store from its OWN key — a metric slug
// (`METRIC_READING_STORE`), a fitness test definition (`FitnessStore`), a vitals
// constant (`VITAL_CANONICAL`), a parser's routing table. Four registries spelling one
// decision is how "a folded observation is read-only on a stream metric's surface"
// happened: the row was charted by identity and written by slug, and the two
// disagreed.
//
// This module states the decision ONCE, in two directions:
//
//   • PLACEMENT — `placeReading()`: given an identity (and whether the reading carries
//     clinical provenance), which physical store does a NEW row land in?
//   • TARGETING — `ReadingTarget` and its codec: given an EXISTING row, which physical
//     row does an edit or delete name? This is the #1933/#1934 editability contract
//     generalized from "which table am I" to "which identity am I".
//
// PURE — no DB, no queries import. `lib/reading-writes.ts` is the write core that
// executes these decisions; the Server Actions keep authorization, validation and unit
// conversion at the boundary, exactly as the house write rules require.
//
// NO SCHEMA CHANGE. This is placement policy over the existing three stores, not the
// physical merge — phase 3 is a later, separate decision, and `medical_records` remains
// the clinical record: the policy may ROUTE into it, nothing here restructures it.
//
// THE GRAIN BOUNDARY HOLDS ON THE WRITE SIDE TOO. `hr_minutes` has no reading identity
// and therefore no placement; a per-minute stream is not a dated reading.

import {
  readingIdentity,
  streamSourcesForIdentity,
  STREAM_READING_SOURCES,
  type Reading,
  type ReadingStore,
} from "./reading-model";
import { MOOD_CHART_SERIES, type MoodChartSeries } from "./mood";
import type { BodyMetricColumn } from "./metric-readings";

// ---- Placement ------------------------------------------------------------

/**
 * A physical destination for a reading. Deliberately the SAME shape
 * `METRIC_READING_STORE` uses (minus its store-private `mood` case, which is a
 * check-in rather than a measured reading), so the two registries can be compared
 * directly — and are, in the tests.
 */
export type ReadingPlacement =
  | { table: "body_metrics"; column: BodyMetricColumn }
  | { table: "metric_samples"; metric: string }
  | { table: "medical_records"; canonical: string };

/** Why a reading has no placement. One reason, stated, never a guessed table. */
export type PlacementRefusal = "no-identity";

export type ReadingPlacementDecision =
  | { placed: ReadingPlacement; identity: string; refused?: never }
  | { placed?: never; identity?: never; refused: PlacementRefusal };

/**
 * THE PLACEMENT RULE. Four clauses, in order, over the identity a reading is OF:
 *
 *  1. **No identity, no placement.** An empty or blank name is refused rather than
 *     defaulted into a table. Everything outside the reading vocabulary — sleep
 *     minutes, steps, HRV, per-minute heart rate — reaches here as "no identity" and
 *     keeps its own writer; inventing a placement for it is exactly the mapping the
 *     #482 exclusion discipline forbids.
 *
 *  2. **Clinical provenance forces the observation store.** A reading that carries a
 *     document, an encounter, a performing provider, the reporting lab's own range or
 *     the name that lab printed is an OBSERVATION, whatever else its identity streams
 *     into. The stream stores have no columns for any of that, so routing a
 *     provenance-carrying reading to one would DESTROY the provenance — the single
 *     placement error that cannot be undone by a later correction.
 *
 *  3. **Otherwise, the identity's registered stream.** Resting heart rate and body fat
 *     have `STREAM_READING_SOURCES` entries, so a device push or a hand-typed value of
 *     either joins the stream its daily fold, period stats and goal projection already
 *     read. This is the clause that keeps one quantity in one place instead of
 *     scattering it by which surface happened to submit it.
 *
 *  4. **Otherwise, `medical_records` under the identity's canonical name.** The
 *     default, and the right one: a reading with a curated identity and no stream is
 *     an observation — every lab analyte, and the four vitals (blood pressure, SpO2,
 *     respiratory rate, body temperature) whose readings already ARE observations.
 *
 * The rule is TOTAL over the registered identities and is pinned as a decision table
 * in `lib/__tests__/reading-placement.test.ts`, including the cross-check that it
 * reproduces `METRIC_READING_STORE` for every metric that declares a canonical
 * identity — the proof that consolidating the write path changed no destination.
 */
export function placeReading(input: {
  /**
   * The CANONICAL NAME of the quantity. The placement decision resolves it to a #482
   * identity, so an aliased spelling places with its family — but the name given is
   * what an observation is stored under, so callers pass the name they mean to keep,
   * exactly as they do today.
   */
  name: string | null | undefined;
  /** Whether the reading carries clinical provenance. Clause 2. */
  provenance?: boolean;
}): ReadingPlacementDecision {
  const identity = readingIdentity(input.name);
  if (!identity) return { refused: "no-identity" };
  // Clause 4's destination, also clause 2's. A family identity labels itself; a plain
  // canonical name is its own identity, so this is the name as given, trimmed.
  const observation: ReadingPlacement = {
    table: "medical_records",
    canonical: (input.name ?? "").trim(),
  };
  if (input.provenance) return { placed: observation, identity };
  const streams = streamSourcesForIdentity(identity);
  // A second stream for one identity would make placement ambiguous — one quantity in
  // two stream stores is the split this whole model exists to close. The registry is
  // pinned single-valued in the pure test; taking [0] here is that invariant, not a
  // silent preference.
  const stream = streams[0];
  if (!stream) return { placed: observation, identity };
  return {
    placed:
      stream.store === "body_metrics"
        ? { table: "body_metrics", column: stream.key as BodyMetricColumn }
        : { table: "metric_samples", metric: stream.key },
    identity,
  };
}

/**
 * The canonical name a stream store's key measures, or null when that key carries no
 * reading identity (weight, steps, sleep — most of the stream vocabulary).
 *
 * The inverse of clause 3, for the writers that still name a COLUMN: it lets a caller
 * holding `body_fat_pct` ask the placement policy the question in the policy's own
 * vocabulary rather than re-deriving the mapping.
 */
export function canonicalForStreamKey(
  store: "body_metrics" | "metric_samples",
  key: string
): string | null {
  return (
    STREAM_READING_SOURCES.find((s) => s.store === store && s.key === key)
      ?.canonical ?? null
  );
}

/**
 * The stream-store keys that belong to `store` because a registered identity places
 * there. `lib/integrations/normalize.ts` uses the `metric_samples` complement of this
 * to reject a parser mis-routing a body measure into the tall store — a guard that
 * used to be its own hand-kept array beside this policy.
 */
export function streamKeysPlacedIn(
  store: "body_metrics" | "metric_samples"
): string[] {
  return STREAM_READING_SOURCES.filter((s) => s.store === store).map(
    (s) => s.key as string
  );
}

// ---- Targeting: the editability contract ----------------------------------

// The stores an edit or delete can name. `mood` is the one destination that is not a
// `ReadingStore`: a check-in is a self-rating rather than a measured reading, so it has
// no identity and no placement — but the metric detail table lists its rows beside the
// rest, so the CONTRACT has to reach it. Named for the store, not its table, because
// mood is store-private (#992).
export type ReadingTargetStore = ReadingStore | "mood";

/**
 * The physical row an edit or delete names.
 *
 * A surface produces one of these FROM THE ROW — from a `Reading`'s `store`/`rowId`, or
 * from the metric registry — never from its own key. That is the whole difference
 * between phase 1 and phase 2: a folded clinical observation listed on a stream
 * metric's page carries `store: "medical_records"` and is corrected there, instead of
 * being marked read-only because the page's slug says `body_metrics`.
 *
 * Each variant carries the MEASURE the store needs to isolate one reading:
 *   • `body_metrics` — the column, because one row carries up to three measures and
 *     nulling the wrong one would take that day's weight with it;
 *   • `metric_samples` — the metric key, so a target can only reach rows of the
 *     quantity it names;
 *   • `medical_records` — the #482 IDENTITY, matched through the `biomarker_family()`
 *     SQL function rather than an exact canonical string, so an aliased spelling of
 *     the same analyte is the same target (the generalization the issue asks for);
 *   • `mood` — which of the check-in's three 1–5 ratings (#1408).
 */
export type ReadingTarget =
  | { store: "body_metrics"; id: number; column: BodyMetricColumn }
  | { store: "metric_samples"; id: number; metric: string }
  | { store: "medical_records"; id: number; identity: string }
  | { store: "mood"; id: number; series: MoodChartSeries };

const BODY_METRIC_COLUMNS: readonly BodyMetricColumn[] = [
  "weight_kg",
  "body_fat_pct",
  "resting_hr",
];

/**
 * The wire form of a target: `store:id:measure`.
 *
 * A single opaque field is deliberate. The row already knows where it lives, so the
 * form posts that fact rather than a metric slug the action would have to re-resolve —
 * which is precisely how the write path came to disagree with the read path. The
 * measure is the tail, unsplit, because a #482 family identity contains a colon
 * (`family:vitamin-d-25-hydroxy`).
 */
export function readingTargetToken(target: ReadingTarget): string {
  const measure =
    target.store === "body_metrics"
      ? target.column
      : target.store === "metric_samples"
        ? target.metric
        : target.store === "medical_records"
          ? target.identity
          : target.series;
  return `${target.store}:${target.id}:${measure}`;
}

/**
 * Parse a posted target. Returns null for anything malformed — a rejected no-op, never
 * a write against a guessed row or a guessed store.
 *
 * Note what this does NOT do: it does not authorize. Profile scoping lives in the write
 * core's `WHERE profile_id = ?`, so a crafted token can only ever miss.
 */
export function parseReadingTarget(
  raw: string | null | undefined
): ReadingTarget | null {
  const text = (raw ?? "").trim();
  if (!text) return null;
  const first = text.indexOf(":");
  if (first < 0) return null;
  const second = text.indexOf(":", first + 1);
  if (second < 0) return null;
  const store = text.slice(0, first);
  const id = Number(text.slice(first + 1, second));
  const measure = text.slice(second + 1);
  if (!Number.isInteger(id) || id <= 0 || !measure) return null;
  switch (store) {
    case "body_metrics":
      return BODY_METRIC_COLUMNS.includes(measure as BodyMetricColumn)
        ? { store, id, column: measure as BodyMetricColumn }
        : null;
    case "metric_samples":
      return { store, id, metric: measure };
    case "medical_records":
      return { store, id, identity: measure };
    case "mood":
      return MOOD_CHART_SERIES.includes(measure as MoodChartSeries)
        ? { store, id, series: measure as MoodChartSeries }
        : null;
    default:
      return null;
  }
}

/**
 * The target for a `Reading` — the read model's rows made editable.
 *
 * Null only for a stream reading whose identity has no registered stream source, which
 * cannot happen for a `Reading` the query layer produced (it presents stream rows only
 * THROUGH that registry) and is a refusal rather than a guess if it ever does.
 */
export function readingTarget(reading: Reading): ReadingTarget | null {
  if (reading.store === "medical_records") {
    return {
      store: "medical_records",
      id: reading.rowId,
      identity: reading.identity,
    };
  }
  const src = streamSourcesForIdentity(reading.identity).find(
    (s) => s.store === reading.store
  );
  if (!src) return null;
  return reading.store === "body_metrics"
    ? {
        store: "body_metrics",
        id: reading.rowId,
        column: src.key as BodyMetricColumn,
      }
    : { store: "metric_samples", id: reading.rowId, metric: src.key };
}
