// DB INTEGRATION TIER — issue #132. Drives the REAL Health Connect ingest path
// (parseHealthConnectPayload → upserts → summarizeSplit → recordSyncEvent) against a
// mixed batch of good and physiologically-impossible rows, and proves:
//   (1) the good rows import and the absurd ones are dropped;
//   (2) the sync-event accounting (received / inserted / skipped) is accurate, with
//       the rejects folded into `skipped` (visible as "· N skipped" in Review);
//   (3) a rejected value never overwrites or deletes an existing good row (the
//       ingest stays idempotent and edit-safe).

import { describe, it, expect, beforeAll } from "vitest";
import { db } from "@/lib/db";
import { parseHealthConnectPayload } from "@/lib/integrations/health-connect";
import {
  upsertBodyMetrics,
  upsertMetricSamples,
  upsertVitals,
} from "@/lib/integrations/normalize";
import { summarizeSplit, foldCounts } from "@/lib/integrations/sync-log";
import { recordSyncEvent } from "@/lib/integrations/connections";
import { getLatestSyncEvent } from "@/lib/queries";

const SRC = "health-connect";
let profile: number;

beforeAll(() => {
  profile = Number(
    db.prepare("INSERT INTO profiles (name) VALUES ('BOUNDS')").run()
      .lastInsertRowid
  );
});

// Dates in the recent past so the parser's timestamp-sanity window accepts them.
const D1 = "2026-06-14";
const D2 = "2026-06-15";
const D3 = "2026-06-16";

describe("ingest bounds: mixed absurd/good batch accounting", () => {
  it("imports the good rows, skips the absurd, and records accurate counts", () => {
    const payload = {
      weight: [
        { time: `${D1}T08:00:00Z`, kilograms: 80 }, // good
        { time: `${D2}T08:00:00Z`, kilograms: 5000 }, // absurd → skip
        { time: `${D3}T08:00:00Z`, kilograms: -3 }, // absurd → skip
      ],
      resting_heart_rate: [
        { time: `${D1}T07:00:00Z`, bpm: 52 }, // good
        { time: `${D2}T07:00:00Z`, bpm: 500 }, // absurd → skip
      ],
      steps: [
        {
          start_time: `${D1}T00:00:00Z`,
          end_time: `${D1}T23:59:00Z`,
          count: 8000,
        }, // good
        {
          start_time: `${D2}T00:00:00Z`,
          end_time: `${D2}T23:59:00Z`,
          count: -100,
        }, // absurd → skip
      ],
      oxygen_saturation: [
        { time: `${D1}T09:00:00Z`, percentage: 98 }, // good
        { time: `${D2}T09:00:00Z`, percentage: 900 }, // absurd → skip
      ],
    };

    const parsed = parseHealthConnectPayload(payload, "UTC");
    // 5 absurd rows dropped by the parser (2 weight, 1 RHR, 1 steps, 1 SpO2).
    expect(parsed.skipped).toBe(5);

    // Persist inside one transaction, exactly like the route.
    const split = db.transaction(() => {
      const bm = upsertBodyMetrics(profile, parsed.bodyMetrics, SRC);
      const ms = upsertMetricSamples(profile, parsed.samples, SRC);
      const vt = upsertVitals(profile, parsed.vitals, SRC);
      return foldCounts([bm, ms, vt.counts]);
    })();

    // Good rows that survived: D1 body_metrics (weight+RHR merged into one day),
    // D1 steps sample, D1 SpO2 vital = 3 inserts.
    expect(split).toEqual({
      inserted: 3,
      updated: 0,
      unchanged: 0,
      suppressed: 0,
    });

    const tally = summarizeSplit(split, parsed.skipped);
    expect(tally.skipped).toBe(5);
    expect(tally.received).toBe(3 + 5);

    recordSyncEvent(profile, SRC, {
      ok: true,
      received: tally.received,
      written: tally.inserted + tally.updated + tally.unchanged,
      inserted: tally.inserted,
      updated: tally.updated,
      unchanged: tally.unchanged,
      skipped: tally.skipped,
    });
    const ev = getLatestSyncEvent(profile, SRC)!;
    expect(ev.received).toBe(8);
    expect(ev.written).toBe(3);
    expect(ev.skipped).toBe(5);

    // The good rows actually landed, scoped to this profile...
    const bm = db
      .prepare(
        "SELECT date, weight_kg, resting_hr FROM body_metrics WHERE profile_id = ? ORDER BY date"
      )
      .all(profile) as {
      date: string;
      weight_kg: number | null;
      resting_hr: number | null;
    }[];
    expect(bm).toEqual([{ date: D1, weight_kg: 80, resting_hr: 52 }]);
    // ...and the absurd weights (5000 / -3) are nowhere in the table.
    const bad = db
      .prepare(
        "SELECT COUNT(*) AS n FROM body_metrics WHERE profile_id = ? AND (weight_kg > 650 OR weight_kg < 2)"
      )
      .get(profile) as { n: number };
    expect(bad.n).toBe(0);

    const steps = db
      .prepare(
        "SELECT value FROM metric_samples WHERE profile_id = ? AND metric = 'steps'"
      )
      .all(profile) as { value: number }[];
    expect(steps).toEqual([{ value: 8000 }]);
  });

  it("a rejected value never overwrites an existing good row (idempotent + safe)", () => {
    // A good weight is already stored for D1 (from the batch above). A later push
    // whose ONLY weight reading for D1 is absurd must leave the stored 80 kg intact:
    // the parser drops the absurd reading, so D1 never re-enters the upsert.
    const before = db
      .prepare(
        "SELECT weight_kg FROM body_metrics WHERE profile_id = ? AND date = ?"
      )
      .get(profile, D1) as { weight_kg: number };
    expect(before.weight_kg).toBe(80);

    const parsed = parseHealthConnectPayload(
      { weight: [{ time: `${D1}T21:00:00Z`, kilograms: 99999 }] },
      "UTC"
    );
    expect(parsed.skipped).toBe(1);
    expect(parsed.bodyMetrics).toHaveLength(0); // nothing to upsert for D1

    const split = db.transaction(() =>
      upsertBodyMetrics(profile, parsed.bodyMetrics, SRC)
    )();
    expect(split).toEqual({
      inserted: 0,
      updated: 0,
      unchanged: 0,
      suppressed: 0,
    });

    const after = db
      .prepare(
        "SELECT weight_kg FROM body_metrics WHERE profile_id = ? AND date = ?"
      )
      .get(profile, D1) as { weight_kg: number };
    expect(after.weight_kg).toBe(80); // untouched
  });
});
