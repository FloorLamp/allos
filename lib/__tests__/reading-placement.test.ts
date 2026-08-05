// PURE TIER — the placement policy (#2032, phase 2 of #1997) as a DECISION TABLE, and
// the target codec that carries an existing row's identity to the write core.
//
// The table below is the policy written out in full, pinned in BOTH directions: every
// identity the app registers a reading destination for appears, and the table invents
// nothing the registry does not know about — so a new judged metric is a red test here
// rather than a placement decided by whichever writer reached it first.
//
// `METRIC_READING_STORE` is the registry the write path used to resolve a store from,
// and the cross-check against it is the load-bearing half of the "nothing moved" proof —
// but it lives in a module that OPENS THE DATABASE, so that half runs in the DB tier
// (lib/__db_tests__/reading-writes.test.ts). What is pinned here is the table's totality
// against the pure metric-knowledge registry: the same completeness guard, no connection.

import { describe, it, expect } from "vitest";
import {
  canonicalForStreamKey,
  parseReadingTarget,
  placeReading,
  readingTarget,
  readingTargetToken,
  streamKeysPlacedIn,
  type ReadingPlacement,
} from "@/lib/reading-placement";
import {
  readingIdentity,
  STREAM_READING_SOURCES,
  type Reading,
} from "@/lib/reading-model";
import { JUDGED_METRIC_SLUGS, METRIC_KNOWLEDGE } from "@/lib/metric-judgment";

// The registered reading identities and where a NEW reading of each one lands.
//
// Two columns, because the rule has two inputs: the identity, and whether the reading
// carries clinical provenance. `withProvenance` is `medical_records` for every row on
// purpose — a document / encounter / provider link, a lab's own stated range or the name
// a lab printed has nowhere to live in a stream store, so routing it there would destroy
// it. That is clause 2, and it is the only clause that can override a registered stream.
const PLACEMENT_TABLE: {
  identity: string;
  plain: ReadingPlacement;
  withProvenance: ReadingPlacement;
}[] = [
  // The four vitals whose readings ARE observations: no stream is registered for them,
  // so clause 4 files them under their canonical name either way.
  {
    identity: "Blood Pressure Systolic",
    plain: {
      table: "medical_records",
      canonical: "Blood Pressure Systolic",
    },
    withProvenance: {
      table: "medical_records",
      canonical: "Blood Pressure Systolic",
    },
  },
  {
    identity: "Blood Pressure Diastolic",
    plain: {
      table: "medical_records",
      canonical: "Blood Pressure Diastolic",
    },
    withProvenance: {
      table: "medical_records",
      canonical: "Blood Pressure Diastolic",
    },
  },
  {
    identity: "Oxygen Saturation",
    plain: { table: "medical_records", canonical: "Oxygen Saturation" },
    withProvenance: {
      table: "medical_records",
      canonical: "Oxygen Saturation",
    },
  },
  {
    identity: "Respiratory Rate",
    plain: { table: "medical_records", canonical: "Respiratory Rate" },
    withProvenance: { table: "medical_records", canonical: "Respiratory Rate" },
  },
  {
    identity: "Body Temperature",
    plain: { table: "medical_records", canonical: "Body Temperature" },
    withProvenance: { table: "medical_records", canonical: "Body Temperature" },
  },
  // The two STREAM identities (#1996's reported instance and its sibling): a device push
  // or a hand-typed value joins the stream its trend already reads, but a clinic-measured
  // one keeps its provenance and becomes an observation.
  {
    identity: "Resting Heart Rate",
    plain: { table: "body_metrics", column: "resting_hr" },
    withProvenance: {
      table: "medical_records",
      canonical: "Resting Heart Rate",
    },
  },
  {
    identity: "Body Fat Percentage",
    plain: { table: "body_metrics", column: "body_fat_pct" },
    withProvenance: {
      table: "medical_records",
      canonical: "Body Fat Percentage",
    },
  },
];

describe("the placement rule — the decision table", () => {
  it.each(PLACEMENT_TABLE)(
    "$identity places plainly by its identity",
    ({ identity, plain }) => {
      const decision = placeReading({ name: identity });
      expect(decision.refused).toBeUndefined();
      expect(decision.placed).toEqual(plain);
      expect(decision.identity).toBe(readingIdentity(identity));
    }
  );

  it.each(PLACEMENT_TABLE)(
    "$identity places as an observation when it carries provenance",
    ({ identity, withProvenance }) => {
      expect(placeReading({ name: identity, provenance: true }).placed).toEqual(
        withProvenance
      );
    }
  );

  it("is TOTAL over the identities the metric registry declares", () => {
    // Both directions. Every metric with a canonical identity is in the table above, and
    // the table invents nothing the registry doesn't know about — so a new judged metric
    // is a red test here rather than a placement decided by whichever writer got there
    // first.
    const registered = JUDGED_METRIC_SLUGS.map((slug) => {
      const knowledge = METRIC_KNOWLEDGE[slug];
      return knowledge.source === "canonical" ? knowledge.canonical : "";
    }).sort();
    expect(PLACEMENT_TABLE.map((r) => r.identity).sort()).toEqual(registered);
  });
});

describe("the placement rule — clauses 1 and 3", () => {
  it("refuses a reading with no identity rather than defaulting a table", () => {
    for (const name of ["", "   ", null, undefined]) {
      expect(placeReading({ name }).refused).toBe("no-identity");
      expect(placeReading({ name }).placed).toBeUndefined();
    }
  });

  it("files an unregistered analyte as an observation under its own name", () => {
    // Clause 4 is the DEFAULT, not a whitelist: a lab analyte with no stream is an
    // observation, which is what makes the policy total over the whole vocabulary rather
    // than only over the metrics that have a detail page.
    expect(placeReading({ name: "LDL Cholesterol" }).placed).toEqual({
      table: "medical_records",
      canonical: "LDL Cholesterol",
    });
  });

  it("resolves an aliased spelling to its family's stream", () => {
    // The identity is #482's, so a name that families with a registered stream places
    // with it. (`biomarkerFamily` is idempotent, so an identity resolves the same as the
    // name it came from.)
    expect(placeReading({ name: "  resting heart rate  " }).placed).toEqual({
      table: "body_metrics",
      column: "resting_hr",
    });
  });

  it("registers at most ONE stream per identity", () => {
    // The invariant `placeReading` relies on when it takes the first match: one quantity
    // in two stream stores would make placement ambiguous, which is the split the reading
    // model exists to close.
    const byIdentity = new Map<string, number>();
    for (const src of STREAM_READING_SOURCES) {
      const key = readingIdentity(src.canonical).toLowerCase();
      byIdentity.set(key, (byIdentity.get(key) ?? 0) + 1);
    }
    expect([...byIdentity.values()].filter((n) => n > 1)).toEqual([]);
  });

  it("names the stream keys each store owns", () => {
    expect(streamKeysPlacedIn("body_metrics").sort()).toEqual([
      "body_fat_pct",
      "resting_hr",
    ]);
    expect(streamKeysPlacedIn("metric_samples")).toEqual([]);
    expect(canonicalForStreamKey("body_metrics", "resting_hr")).toBe(
      "Resting Heart Rate"
    );
    // Weight streams, but the canonical vocabulary has no entry for it, so it carries no
    // reading identity — the #482 exclusion discipline, applied to the write side.
    expect(canonicalForStreamKey("body_metrics", "weight_kg")).toBeNull();
  });
});

describe("the target codec", () => {
  it("round-trips every store", () => {
    const targets = [
      { store: "body_metrics", id: 7, column: "resting_hr" },
      { store: "metric_samples", id: 8, metric: "hrv_ms" },
      { store: "medical_records", id: 9, identity: "Oxygen Saturation" },
      { store: "mood", id: 10, series: "calm" },
    ] as const;
    for (const target of targets) {
      expect(parseReadingTarget(readingTargetToken(target))).toEqual(target);
    }
  });

  it("carries a #482 family identity, colon and all", () => {
    // The measure is the UNSPLIT tail precisely so this works: a family identity is
    // spelled `family:<key>`, and splitting on every colon would truncate it.
    const target = {
      store: "medical_records",
      id: 3,
      identity: "family:vitamin-d-25-hydroxy",
    } as const;
    expect(readingTargetToken(target)).toBe(
      "medical_records:3:family:vitamin-d-25-hydroxy"
    );
    expect(parseReadingTarget(readingTargetToken(target))).toEqual(target);
  });

  it("rejects a malformed or invented target rather than guessing", () => {
    for (const raw of [
      "",
      "   ",
      null,
      undefined,
      "body_metrics",
      "body_metrics:7",
      "body_metrics:7:",
      "body_metrics:0:resting_hr",
      "body_metrics:-1:resting_hr",
      "body_metrics:1.5:resting_hr",
      "body_metrics:7:heart_rate", // not a column of that table
      "mood:7:sadness", // not a charted series
      "hr_minutes:7:bpm", // outside the model's grain boundary
      "activities:7:distance",
    ]) {
      expect(parseReadingTarget(raw)).toBeNull();
    }
  });

  it("targets a Reading by the row it was presented from", () => {
    const observation: Reading = {
      identity: "Resting Heart Rate",
      value: 61,
      unit: "bpm",
      date: "2026-03-04",
      measuredAt: null,
      source: "lab",
      store: "medical_records",
      rowId: 41,
      sourceKey: null,
      edited: false,
      notes: null,
      provenance: { documentId: 5 },
    };
    // The whole point of phase 2: this reading is LISTED on a page whose own store is
    // body_metrics, and its target still names the clinical record it lives in.
    expect(readingTarget(observation)).toEqual({
      store: "medical_records",
      id: 41,
      identity: "Resting Heart Rate",
    });
    expect(
      readingTarget({ ...observation, store: "body_metrics", rowId: 12 })
    ).toEqual({ store: "body_metrics", id: 12, column: "resting_hr" });
  });

  it("refuses a stream reading whose identity has no registered stream", () => {
    // Unreachable from the query layer (it presents stream rows only THROUGH the
    // registry), and a refusal rather than a guess if it ever happens.
    expect(
      readingTarget({
        identity: "LDL Cholesterol",
        value: 100,
        unit: "mg/dL",
        date: "2026-03-04",
        measuredAt: null,
        source: "manual",
        store: "body_metrics",
        rowId: 3,
        sourceKey: null,
        edited: false,
        notes: null,
      })
    ).toBeNull();
  });
});
