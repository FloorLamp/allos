import { describe, it, expect } from "vitest";
import {
  activityTombstoneKey,
  medicalRecordTombstoneKey,
  bodyMetricTombstoneKey,
  metricSampleTombstoneKey,
  hrMinuteTombstoneKey,
  importTombstoneForRow,
  TOMBSTONE_TABLES,
} from "@/lib/integrations/tombstone-keys";

// PURE key math for the re-import tombstone (#507/#508). These keys MUST mirror each
// table's upsert dedup key exactly (lib/integrations/normalize.ts), so the write side
// (delete/merge) and the read side (upsert) compose the identical string.

describe("tombstone key composition", () => {
  it("uses external_id verbatim for activities / medical_records", () => {
    expect(activityTombstoneKey("strava:123")).toBe("strava:123");
    expect(medicalRecordTombstoneKey("health-connect:Glucose:t")).toBe(
      "health-connect:Glucose:t"
    );
  });

  it("composes multi-field keys deterministically and unambiguously", () => {
    expect(bodyMetricTombstoneKey("2026-07-12", "withings")).toBe(
      bodyMetricTombstoneKey("2026-07-12", "withings")
    );
    // Distinct (date, source) never collide.
    expect(bodyMetricTombstoneKey("2026-07-12", "withings")).not.toBe(
      bodyMetricTombstoneKey("2026-07-12", "oura")
    );
    expect(
      metricSampleTombstoneKey("steps", "health-connect", "t0", "t1")
    ).not.toBe(metricSampleTombstoneKey("steps", "health-connect", "t0", "t2"));
    expect(hrMinuteTombstoneKey("2026-07-12T07:00", "health-connect")).not.toBe(
      hrMinuteTombstoneKey("2026-07-12T07:01", "health-connect")
    );
  });
});

describe("importTombstoneForRow — derive (table, key) from a captured root row", () => {
  it("activities: keyed by external_id, null for a manual row", () => {
    expect(
      importTombstoneForRow("activities", { external_id: "strava:9" })
    ).toEqual({ table: "activities", key: "strava:9" });
    expect(
      importTombstoneForRow("activities", { external_id: null })
    ).toBeNull();
    expect(importTombstoneForRow("activities", {})).toBeNull();
  });

  it("medical_records: keyed by external_id", () => {
    expect(
      importTombstoneForRow("medical_records", { external_id: "hc:BP:t" })
    ).toEqual({ table: "medical_records", key: "hc:BP:t" });
    expect(
      importTombstoneForRow("medical_records", { external_id: null })
    ).toBeNull();
  });

  it("body_metrics: keyed by (date, source), null when source is manual (NULL)", () => {
    expect(
      importTombstoneForRow("body_metrics", {
        date: "2026-07-12",
        source: "withings",
      })
    ).toEqual({
      table: "body_metrics",
      key: bodyMetricTombstoneKey("2026-07-12", "withings"),
    });
    expect(
      importTombstoneForRow("body_metrics", {
        date: "2026-07-12",
        source: null,
      })
    ).toBeNull();
  });

  it("metric_samples: keyed by (metric, source, start, end); null when a field is missing (#653)", () => {
    expect(
      importTombstoneForRow("metric_samples", {
        metric: "steps",
        source: "health-connect",
        start_time: "t0",
        end_time: "t1",
      })
    ).toEqual({
      table: "metric_samples",
      key: metricSampleTombstoneKey("steps", "health-connect", "t0", "t1"),
    });
    // A missing natural-key field means it isn't a source-owned re-import target.
    expect(
      importTombstoneForRow("metric_samples", {
        metric: "steps",
        source: null,
        start_time: "t0",
        end_time: "t1",
      })
    ).toBeNull();
  });

  it("returns null for tables the sync can't resurrect (intake_items, etc.)", () => {
    expect(
      importTombstoneForRow("intake_items", { external_id: "x" })
    ).toBeNull();
  });
});

describe("TOMBSTONE_TABLES coverage (#653)", () => {
  it("covers metric_samples but NOT hr_minutes (no per-row delete path)", () => {
    expect(TOMBSTONE_TABLES).toContain("metric_samples");
    // hr_minutes is browse/export-only — dormant read coverage was removed so the
    // read side no longer implies a protection with no writer.
    expect(TOMBSTONE_TABLES as readonly string[]).not.toContain("hr_minutes");
    // The key helper stays (future HR delete), but composes distinct keys.
    expect(hrMinuteTombstoneKey("t0", "s")).not.toBe(
      hrMinuteTombstoneKey("t1", "s")
    );
  });
});
