// DB INTEGRATION TIER: the Health Connect glucose routing of #3182, end to end.
//
// Two things are pinned here that a pure parser test cannot reach.
//
// 1. THE ROUTING THROUGH THE REAL INGEST, in both directions. An interstitial record
//    lands in `glucose_trace` and NOT in `medical_records`; a capillary record and an
//    unset one land in `medical_records` under `Glucose` and NOT in the trace; the
//    connection's switch turns all three into traces. A test asserting only that the
//    unset default stays an observation is green on a tree where nothing ever becomes
//    a trace, so both halves are one table.
//
// 2. THE LATE-`data_origin` RECONCILIATION. The exporter emits record metadata
//    CONDITIONALLY, so the same sensor's readings arrive bare and then qualified. The
//    ruling says the later record UPDATES that source rather than opening a second
//    trace, and the shape that proves it is a count: ONE source afterwards, not two,
//    and the re-pushed reading counted as a re-push rather than a new point.
//
// The profile is deliberately not in UTC, for the reason glucose-trace.test.ts gives.

import { beforeEach, describe, expect, it } from "vitest";
import { db } from "@/lib/db";
import { setTimezone } from "@/lib/settings";
import { HEALTH_CONNECT_ID } from "@/lib/integrations/health-connect";
import { parseHealthConnectPayload } from "@/lib/integrations/health-connect";
import { ingestHealthConnectPayload } from "@/lib/integrations/health-connect-ingest";
import {
  getHealthConnectCgmGlucose,
  setHealthConnectCgmGlucose,
  upsertConnection,
} from "@/lib/integrations/connections";
import { GLUCOSE_MEAN_METRIC } from "@/lib/glucose-trace";

const TZ = "America/New_York";
const ORIGIN = "com.example.sensor";

let profileId: number;

beforeEach(() => {
  profileId = Number(
    db.prepare("INSERT INTO profiles (name) VALUES ('GLUCOSE-ROUTE')").run()
      .lastInsertRowid
  );
  setTimezone(profileId, TZ);
});

/** Drive the real ingest over one `blood_glucose` push. */
function push(records: Record<string, unknown>[]) {
  const parsed = parseHealthConnectPayload({ blood_glucose: records }, TZ, {
    cgmConnection: getHealthConnectCgmGlucose(profileId),
  });
  return ingestHealthConnectPayload(profileId, parsed, HEALTH_CONNECT_ID);
}

function traceRows(): { ts: string; mgdl: number; source: string }[] {
  return db
    .prepare(
      "SELECT ts, mgdl, source FROM glucose_trace WHERE profile_id = ? ORDER BY source, ts"
    )
    .all(profileId) as { ts: string; mgdl: number; source: string }[];
}

function glucoseObservations(): number {
  return (
    db
      .prepare(
        "SELECT COUNT(*) AS n FROM medical_records WHERE profile_id = ? AND canonical_name = 'Glucose'"
      )
      .get(profileId) as { n: number }
  ).n;
}

describe("Health Connect glucose routing (#3182)", () => {
  it.each([
    ["interstitial fluid", { specimen_source: "interstitial_fluid" }, "trace"],
    ["capillary", { specimen_source: "capillary_blood" }, "observation"],
    ["unset", {}, "observation"],
  ])("switch off — %s lands as a %s", (_name, rec, expected) => {
    push([{ time: "2026-06-15T12:00:00Z", mmol_per_liter: 5.5, ...rec }]);
    expect({
      trace: traceRows().length,
      observations: glucoseObservations(),
    }).toEqual(
      expected === "trace"
        ? { trace: 1, observations: 0 }
        : { trace: 0, observations: 1 }
    );
  });

  it.each([
    ["interstitial fluid", { specimen_source: "interstitial_fluid" }],
    ["capillary", { specimen_source: "capillary_blood" }],
    ["unset", {}],
  ])("switch on — %s lands as a trace", (_name, rec) => {
    upsertConnection(profileId, HEALTH_CONNECT_ID, { status: "connected" });
    setHealthConnectCgmGlucose(profileId, true);
    push([{ time: "2026-06-15T12:00:00Z", mmol_per_liter: 5.5, ...rec }]);
    expect({
      trace: traceRows().length,
      observations: glucoseObservations(),
    }).toEqual({ trace: 1, observations: 0 });
  });

  it("qualifies the trace source with the writing app, and keeps two sensors apart", () => {
    upsertConnection(profileId, HEALTH_CONNECT_ID, { status: "connected" });
    setHealthConnectCgmGlucose(profileId, true);
    push([
      {
        time: "2026-06-15T12:00:00Z",
        mmol_per_liter: 5.5,
        metadata: { data_origin: ORIGIN },
      },
      {
        time: "2026-06-15T12:05:00Z",
        mmol_per_liter: 6,
        metadata: { data_origin: "com.example.other" },
      },
    ]);
    // Ordered by source — two writing apps, two traces, neither absorbing the other.
    expect(traceRows().map((r) => r.source)).toEqual([
      `${HEALTH_CONNECT_ID}:com.example.other`,
      `${HEALTH_CONNECT_ID}:${ORIGIN}`,
    ]);
  });
});

describe("late data_origin (#3182 source-identity addendum)", () => {
  beforeEach(() => {
    upsertConnection(profileId, HEALTH_CONNECT_ID, { status: "connected" });
    setHealthConnectCgmGlucose(profileId, true);
  });

  it("absorbs the bare trace instead of opening a second one", () => {
    // Push 1: the exporter emitted no metadata at all, so the source is bare.
    push([
      { time: "2026-06-15T12:00:00Z", mmol_per_liter: 5.5 },
      { time: "2026-06-15T12:05:00Z", mmol_per_liter: 6 },
    ]);
    expect(traceRows().map((r) => r.source)).toEqual([
      HEALTH_CONNECT_ID,
      HEALTH_CONNECT_ID,
    ]);

    // Push 2: the rolling window re-carries one of those readings, this time with
    // the writing app on it, plus one new reading.
    const second = push([
      {
        time: "2026-06-15T12:05:00Z",
        mmol_per_liter: 6,
        metadata: { data_origin: ORIGIN },
      },
      {
        time: "2026-06-15T12:10:00Z",
        mmol_per_liter: 6.5,
        metadata: { data_origin: ORIGIN },
      },
    ]);

    // ONE trace, under the qualified source — every point, including the one the
    // qualified push never re-sent.
    const rows = traceRows();
    expect(new Set(rows.map((r) => r.source))).toEqual(
      new Set([`${HEALTH_CONNECT_ID}:${ORIGIN}`])
    );
    expect(rows).toHaveLength(3);

    // And the re-carried reading was an UPDATE of the stored point, not a new one:
    // exactly one insert (12:10), never two.
    expect(second.counts.glucoseTrace).toBe(2);
    expect(
      db
        .prepare(
          "SELECT COUNT(DISTINCT source) AS n FROM glucose_trace WHERE profile_id = ?"
        )
        .get(profileId)
    ).toEqual({ n: 1 });
  });

  it("declines to absorb when the same push still carries bare records", () => {
    push([{ time: "2026-06-15T12:00:00Z", mmol_per_liter: 5.5 }]);
    push([
      { time: "2026-06-15T12:05:00Z", mmol_per_liter: 6 },
      {
        time: "2026-06-15T12:10:00Z",
        mmol_per_liter: 6.5,
        metadata: { data_origin: ORIGIN },
      },
    ]);
    // Two live writers in one push is not late metadata; the bare trace stays its own.
    expect(new Set(traceRows().map((r) => r.source))).toEqual(
      new Set([HEALTH_CONNECT_ID, `${HEALTH_CONNECT_ID}:${ORIGIN}`])
    );
  });

  it("moves the day's derived rows with the trace, leaving no orphan under the bare source", () => {
    push([
      { time: "2026-06-15T12:00:00Z", mmol_per_liter: 5.5 },
      { time: "2026-06-15T12:05:00Z", mmol_per_liter: 6 },
    ]);
    expect(
      db
        .prepare(
          "SELECT DISTINCT source FROM metric_samples WHERE profile_id = ? AND metric = ?"
        )
        .pluck()
        .all(profileId, GLUCOSE_MEAN_METRIC)
    ).toEqual([HEALTH_CONNECT_ID]);

    push([
      {
        time: "2026-06-15T12:10:00Z",
        mmol_per_liter: 6.5,
        metadata: { data_origin: ORIGIN },
      },
    ]);

    // One mean for the day, under the qualified source, computed over ALL THREE
    // points — the absorbed day is recomputed even though this push never mentioned
    // the two instants it carries.
    const means = db
      .prepare(
        `SELECT source, value FROM metric_samples
          WHERE profile_id = ? AND metric = ? ORDER BY source`
      )
      .all(profileId, GLUCOSE_MEAN_METRIC) as {
      source: string;
      value: number;
    }[];
    expect(means).toEqual([
      {
        source: `${HEALTH_CONNECT_ID}:${ORIGIN}`,
        // (99.1 + 108.1 + 117.1) / 3
        value: 108.1,
      },
    ]);
  });
});
