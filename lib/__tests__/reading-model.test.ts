// PURE TIER — the #1997 phase 1 read model: one Reading shape over the three
// reading stores, keyed by #482 identity.
//
// The load-bearing assertion is the identity one: a `medical_records` "Resting
// Heart Rate" observation and a `body_metrics.resting_hr` row must resolve to the
// SAME identity, because that is what lets clinical knowledge filed under a
// canonical name reach a reading that streams into a different table (#1996).
//
// All fixtures SYNTHETIC.

import { describe, it, expect } from "vitest";
import { biomarkerFamily } from "@/lib/canonical-name";
import {
  STREAM_READING_SOURCES,
  dedupeReadings,
  foldObservationPoints,
  identityForStreamKey,
  readingFromBodyMetric,
  readingFromMetricSample,
  readingFromObservation,
  readingIdentity,
  readingPoints,
  readingSourceFor,
  sortReadings,
  streamSourcesForIdentity,
  type Reading,
  type StreamReadingSource,
} from "@/lib/reading-model";

const RHR: StreamReadingSource = STREAM_READING_SOURCES.find(
  (s) => s.canonical === "Resting Heart Rate"
)!;

const HRV_SAMPLE: StreamReadingSource = {
  store: "metric_samples",
  key: "hrv_ms",
  canonical: "Heart Rate Variability",
  unit: "ms",
};

describe("identity resolution across stores", () => {
  it("gives a streamed resting HR and an imported one the SAME identity", () => {
    const streamed = readingFromBodyMetric(
      { id: 1, date: "2026-07-01", value: 58, source: "oura" },
      RHR
    );
    const observed = readingFromObservation({
      id: 9,
      date: "2026-07-01",
      value_num: 61,
      unit: "bpm",
      name: "Heart rate",
      canonical_name: "Resting Heart Rate",
      document_id: 4,
    });
    expect(observed).not.toBeNull();
    expect(streamed.identity).toBe(observed!.identity);
    // …and it is the canonical #482 identity, not a private key of this module.
    expect(streamed.identity).toBe(biomarkerFamily("Resting Heart Rate"));
  });

  it("resolves the stream sources for that identity, and none for an episodic one", () => {
    const identity = readingIdentity("Resting Heart Rate");
    expect(streamSourcesForIdentity(identity)).toEqual([RHR]);
    expect(streamSourcesForIdentity(readingIdentity("Ferritin"))).toEqual([]);
    // The inverse map: a stream key with curated knowledge resolves; the rest of
    // the stream vocabulary deliberately does not.
    expect(identityForStreamKey("body_metrics", "resting_hr")).toBe(identity);
    expect(identityForStreamKey("body_metrics", "weight_kg")).toBeNull();
  });

  it("registers only stream keys whose canonical name is a real identity", () => {
    for (const s of STREAM_READING_SOURCES) {
      expect(readingIdentity(s.canonical)).toBe(s.canonical);
      expect(s.unit).not.toBe("");
    }
  });

  // The regression pin for the asymmetry that would otherwise appear the day one of
  // these canonical names joins a #482 family: the observation half already resolves
  // its argument through `biomarkerFamily`, so a caller passing the NAME would have
  // got every observation and no stream row at all. Asserted for EVERY registered
  // source, in both spellings, so the invariant survives the registry growing.
  it("answers a canonical NAME and its identity identically", () => {
    for (const s of STREAM_READING_SOURCES) {
      const byIdentity = streamSourcesForIdentity(readingIdentity(s.canonical));
      expect(streamSourcesForIdentity(s.canonical)).toEqual(byIdentity);
      expect(byIdentity).toContainEqual(s);
    }
    // Surrounding whitespace and casing are spelling, not identity.
    expect(streamSourcesForIdentity("  resting HEART rate ")).toEqual([RHR]);
    expect(streamSourcesForIdentity("   ")).toEqual([]);
  });
});

describe("the Reading mapping from each store's row shape", () => {
  it("maps a body_metrics row (wide, per-day, no instant, no provenance)", () => {
    const r = readingFromBodyMetric(
      {
        id: 3,
        date: "2026-07-02",
        value: 57,
        source: "oura",
        edited: 1,
        notes: "post-illness",
      },
      RHR
    );
    expect(r).toEqual({
      identity: "Resting Heart Rate",
      value: 57,
      unit: "bpm",
      date: "2026-07-02",
      measuredAt: null,
      source: "wearable",
      store: "body_metrics",
      rowId: 3,
      sourceKey: "oura",
      edited: true,
      notes: "post-illness",
    });
    expect(r.provenance).toBeUndefined();
  });

  it("maps a metric_samples row, keeping its absolute instant", () => {
    const r = readingFromMetricSample(
      {
        id: 5,
        date: "2026-07-02",
        value: 44,
        source: "health-connect",
        start_time: "2026-07-02T03:11:00Z",
      },
      HRV_SAMPLE
    );
    expect(r.store).toBe("metric_samples");
    expect(r.measuredAt).toBe("2026-07-02T03:11:00Z");
    expect(r.source).toBe("wearable");
    expect(r.edited).toBe(false);
    expect(r.provenance).toBeUndefined();
  });

  it("maps a medical_records row with its clinical provenance", () => {
    const r = readingFromObservation({
      id: 11,
      date: "2026-06-30",
      value_num: 72,
      unit: "bpm",
      name: "PULSE",
      canonical_name: "Resting Heart Rate",
      source: "document:4",
      flag: "high",
      reference_range: "60-100",
      document_id: 4,
      encounter_id: 7,
      provider_id: 2,
      notes: "seated",
    });
    expect(r?.provenance).toEqual({
      documentId: 4,
      encounterId: 7,
      providerId: 2,
      reportedName: "PULSE",
      reportedRange: "60-100",
      flag: "high",
    });
    // Clinical provenance, so the reading reads as a lab/clinic measurement even
    // though its source stamp names the import.
    expect(r?.source).toBe("lab");
    expect(r?.store).toBe("medical_records");
  });

  it("refuses a qualitative observation (no numeric value, no reading)", () => {
    expect(
      readingFromObservation({
        id: 12,
        date: "2026-06-30",
        value_num: null,
        name: "Blood Culture",
      })
    ).toBeNull();
  });

  it("attaches no provenance apparatus to an observation that has none", () => {
    const r = readingFromObservation({
      id: 13,
      date: "2026-06-29",
      value_num: 96,
      unit: "%",
      canonical_name: "Oxygen Saturation",
      source: "manual",
    });
    expect(r?.provenance).toBeUndefined();
    expect(r?.source).toBe("manual");
  });
});

describe("source classification is about provenance, not about the table", () => {
  it.each([
    [{ sourceKey: null }, "manual"],
    [{ sourceKey: "manual" }, "manual"],
    [{ sourceKey: "oura" }, "wearable"],
    [{ sourceKey: "document:12" }, "import"],
    [{ sourceKey: "health-connect", documentId: 3 }, "lab"],
    [{ sourceKey: null, encounterId: 8 }, "lab"],
    [{ sourceKey: null, providerId: 2 }, "lab"],
  ])("%o → %s", (input, expected) => {
    expect(readingSourceFor(input)).toBe(expected);
  });
});

describe("series assembly", () => {
  const base = {
    identity: "Resting Heart Rate",
    unit: "bpm",
    measuredAt: null,
    edited: false,
    notes: null,
  } as const;

  it("collapses one reading presented from two stores, keeping the richer one", () => {
    const stream: Reading = {
      ...base,
      value: 61,
      date: "2026-07-01",
      source: "manual",
      store: "body_metrics",
      rowId: 1,
      sourceKey: "manual",
    };
    const observed: Reading = {
      ...base,
      value: 61,
      date: "2026-07-01",
      source: "manual",
      store: "medical_records",
      rowId: 2,
      sourceKey: "manual",
      provenance: { documentId: 9 },
    };
    const out = dedupeReadings([stream, observed]);
    expect(out).toHaveLength(1);
    expect(out[0].store).toBe("medical_records");
    expect(out[0].provenance).toEqual({ documentId: 9 });
  });

  // #2005. The stores spell "the user typed it" differently — `body_metrics` leaves
  // `source` NULL, `medical_records` writes the literal 'manual' — and every other
  // reader in the codebase already treats those as ONE provenance. Keying the
  // collapse on the RAW column made two readings out of one, which is the
  // double-count that would have shipped with the first phase-2 caller.
  it("collapses a NULL-source stream row into a 'manual' observation", () => {
    const stream: Reading = {
      ...base,
      value: 61,
      date: "2026-07-01",
      source: readingSourceFor({ sourceKey: null }),
      store: "body_metrics",
      rowId: 1,
      sourceKey: null,
    };
    const observed: Reading = {
      ...base,
      value: 61,
      date: "2026-07-01",
      source: readingSourceFor({ sourceKey: "manual" }),
      store: "medical_records",
      rowId: 2,
      sourceKey: "manual",
    };
    // Same provenance by the model's own classifier — so the same reading.
    expect(stream.source).toBe(observed.source);
    expect(dedupeReadings([stream, observed])).toHaveLength(1);
    // …and in the other order, because a collapse is not order-dependent.
    expect(dedupeReadings([observed, stream])).toHaveLength(1);
  });

  // The stated consequence of keying on the normalized source: two DEVICES agreeing
  // on a day are one reading of that day for a SERIES. "Which device said what" is a
  // different question, with its own reader.
  it("collapses two devices reporting the same value on the same day", () => {
    const twice: Reading[] = ["oura", "withings"].map((sourceKey, i) => ({
      ...base,
      value: 52,
      date: "2026-07-01",
      source: readingSourceFor({ sourceKey }),
      store: "body_metrics" as const,
      rowId: i + 1,
      sourceKey,
    }));
    expect(twice.every((r) => r.source === "wearable")).toBe(true);
    expect(dedupeReadings(twice)).toHaveLength(1);
    // Different values are different readings, whoever reported them.
    expect(dedupeReadings([twice[0], { ...twice[1], value: 55 }])).toHaveLength(
      2
    );
  });

  it("keeps a clinic reading beside a wearable one on the same day", () => {
    const wearable: Reading = {
      ...base,
      value: 58,
      date: "2026-07-01",
      source: "wearable",
      store: "body_metrics",
      rowId: 1,
      sourceKey: "oura",
    };
    const clinic: Reading = {
      ...base,
      value: 71,
      date: "2026-07-01",
      source: "lab",
      store: "medical_records",
      rowId: 2,
      sourceKey: "document:4",
      provenance: { documentId: 4 },
    };
    expect(dedupeReadings([wearable, clinic])).toHaveLength(2);
  });

  it("keeps a same-day, same-source fever curve intact", () => {
    // Several genuinely different readings on one date from one source (#800/#843).
    // A (date, source) key alone would drop two of the three.
    const curve: Reading[] = [99.1, 100.4, 101.2].map((value, i) => ({
      ...base,
      identity: "Body Temperature",
      unit: "degF",
      value,
      date: "2026-07-01",
      source: "manual",
      store: "medical_records",
      rowId: i + 1,
      sourceKey: "manual",
    }));
    expect(dedupeReadings(curve)).toHaveLength(3);
  });

  it("folds observations into a stream series, marking them", () => {
    const stream = [
      { date: "2026-07-01", value: 58 },
      { date: "2026-07-02", value: 59 },
    ];
    const observations: Reading[] = [
      {
        ...base,
        value: 71,
        date: "2026-07-02",
        source: "lab",
        store: "medical_records",
        rowId: 5,
        sourceKey: "document:4",
        provenance: { documentId: 4 },
      },
    ];
    expect(foldObservationPoints(stream, observations)).toEqual([
      { date: "2026-07-01", value: 58 },
      { date: "2026-07-02", value: 59 },
      { date: "2026-07-02", value: 71, observed: true },
    ]);
  });

  it("does not chart an observation that IS the stream point", () => {
    // The same manual reading recorded in both stores — the stream's daily fold
    // already carries it, so charting it again would double the day.
    const stream = [{ date: "2026-07-01", value: 62 }];
    const observations: Reading[] = [
      {
        ...base,
        value: 62,
        date: "2026-07-01",
        source: "manual",
        store: "medical_records",
        rowId: 5,
        sourceKey: "manual",
      },
    ];
    expect(foldObservationPoints(stream, observations)).toEqual(stream);
  });

  it("orders oldest first, by day then instant then row", () => {
    const rows: Reading[] = [
      {
        ...base,
        value: 3,
        date: "2026-07-02",
        source: "manual",
        store: "body_metrics",
        rowId: 30,
        sourceKey: null,
      },
      {
        ...base,
        value: 1,
        date: "2026-07-01",
        source: "manual",
        store: "body_metrics",
        rowId: 20,
        sourceKey: null,
      },
      {
        ...base,
        value: 2,
        date: "2026-07-01",
        measuredAt: "2026-07-01T09:00:00Z",
        source: "manual",
        store: "metric_samples",
        rowId: 10,
        sourceKey: null,
      },
    ];
    expect(sortReadings(rows).map((r) => r.value)).toEqual([1, 2, 3]);
    expect(readingPoints(rows)).toEqual([
      { date: "2026-07-01", value: 1 },
      { date: "2026-07-01", value: 2 },
      { date: "2026-07-02", value: 3 },
    ]);
  });
});
