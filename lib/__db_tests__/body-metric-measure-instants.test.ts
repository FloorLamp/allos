// DB INTEGRATION TIER — per-measure body-metric instants (#3950, owner-ruled
// 2026-08-29). Health Connect states a separate instant for weight, body fat and
// resting HR; `body_metrics` now has a nullable column for each, the day-grain natural
// key is untouched, and the archived push bodies can date rows written before the
// columns existed.
//
// The trap this tier exists to catch is an instant that gets decided APART from its
// own measure: the merge keeps the stored weight and the row ends up claiming the
// incoming reading's time for it. Every case below asserts the PAIR.

import { describe, it, expect, beforeEach } from "vitest";
import fs from "node:fs";
import path from "node:path";
import { makeTmpDir } from "@/lib/__tests__/tmp-dir";
import { toKg } from "@/lib/units";
import { db, writeTx } from "@/lib/db";
import {
  upsertBodyMetrics,
  type NormBodyMetric,
} from "@/lib/integrations/normalize";
import { backfillBodyMetricInstants } from "@/lib/integrations/body-metric-instant-backfill";

const SOURCE = "health-connect";
const DAY = "2026-06-15";
const MORNING = "2026-06-15T07:00:00Z";
const EVENING = "2026-06-15T21:00:00Z";

let profileId: number;

function row(over: Partial<NormBodyMetric> = {}): NormBodyMetric {
  return { date: DAY, ...over } as NormBodyMetric;
}

function stored() {
  return db
    .prepare(
      `SELECT weight_kg, body_fat_pct, resting_hr, weight_at, body_fat_at,
              resting_hr_at
         FROM body_metrics WHERE profile_id = ? AND date = ? AND source = ?`
    )
    .get(profileId, DAY, SOURCE) as Record<string, unknown>;
}

function put(rows: NormBodyMetric[]) {
  return writeTx(() => upsertBodyMetrics(profileId, rows, SOURCE));
}

beforeEach(() => {
  db.exec("DELETE FROM body_metrics");
  profileId = Number(
    db.prepare("INSERT INTO profiles (name) VALUES ('BM-INSTANTS')").run()
      .lastInsertRowid
  );
});

describe("per-measure instants on the day row (#3950)", () => {
  it("stores each measure's own instant, not one shared time", () => {
    put([
      row({
        weight_kg: toKg(80, "kg"),
        weight_at: MORNING,
        resting_hr: 52,
        resting_hr_at: EVENING,
      }),
    ]);
    expect(stored()).toMatchObject({
      weight_kg: 80,
      weight_at: MORNING,
      resting_hr: 52,
      resting_hr_at: EVENING,
      body_fat_at: null,
    });
  });

  it("stores NULL for a source that states no instant", () => {
    put([row({ weight_kg: toKg(80, "kg") })]);
    expect(stored().weight_at).toBeNull();
  });

  // THE PAIRING GUARANTEE. Each row: what is stored, what arrives, and which instant
  // the surviving VALUE must carry. A gap-filling window must not re-time the measure
  // it did not touch, and a partial day (#606) that keeps the stored average must keep
  // that average's instant too.
  it.each<
    [string, Partial<NormBodyMetric>, Partial<NormBodyMetric>, boolean, unknown]
  >([
    [
      "a later weigh-in brings its own instant",
      { weight_kg: toKg(80, "kg"), weight_at: MORNING },
      { weight_kg: toKg(79, "kg"), weight_at: EVENING },
      false,
      { weight_kg: 79, weight_at: EVENING },
    ],
    [
      "a window carrying only resting HR leaves the weight's instant alone",
      { weight_kg: toKg(80, "kg"), weight_at: MORNING },
      { resting_hr: 52, resting_hr_at: EVENING },
      false,
      { weight_kg: 80, weight_at: MORNING, resting_hr_at: EVENING },
    ],
    [
      "a partial day keeps the stored average AND the stored instant",
      { body_fat_pct: 22.5, body_fat_at: MORNING },
      { body_fat_pct: 25.1, body_fat_at: EVENING },
      true,
      { body_fat_pct: 22.5, body_fat_at: MORNING },
    ],
    [
      "a partial day still FILLS a measure the day did not have",
      { weight_kg: toKg(80, "kg"), weight_at: MORNING },
      { resting_hr: 52, resting_hr_at: EVENING },
      true,
      { resting_hr: 52, resting_hr_at: EVENING, weight_at: MORNING },
    ],
  ])("%s", (_name, first, second, partial, expected) => {
    put([row(first)]);
    put([row({ ...second, partial_day: partial })]);
    expect(stored()).toMatchObject(expected as Record<string, unknown>);
  });

  // The ordinary rolling-window re-send is how an already-stored day acquires its
  // instant. If the no-op comparison ignored the instants this would stay NULL forever
  // and the whole feature would be dead for every day already on disk.
  it("fills an instant on a re-send that restates the same value", () => {
    put([row({ weight_kg: toKg(80, "kg") })]);
    expect(stored().weight_at).toBeNull();
    const counts = put([
      row({ weight_kg: toKg(80, "kg"), weight_at: MORNING }),
    ]);
    expect(stored().weight_at).toBe(MORNING);
    expect(counts.updated).toBe(1);
    // ...and the genuinely identical re-send after that is still a no-op.
    expect(
      put([row({ weight_kg: toKg(80, "kg"), weight_at: MORNING })]).unchanged
    ).toBe(1);
  });

  // Two readings of the same measure on one local day collapse to one row (#605); the
  // instant that survives must be the surviving VALUE's, not the other reading's.
  it("collapses same-day readings carrying each measure's own instant", () => {
    put([
      row({
        weight_kg: toKg(80, "kg"),
        weight_at: MORNING,
        measured_at: MORNING,
      }),
      row({
        weight_kg: toKg(79, "kg"),
        weight_at: EVENING,
        measured_at: EVENING,
      }),
    ]);
    expect(stored()).toMatchObject({ weight_kg: 79, weight_at: EVENING });
  });

  it("leaves the day-grain natural key alone (#608): still one row per source", () => {
    put([row({ weight_kg: toKg(80, "kg"), weight_at: MORNING })]);
    put([row({ weight_kg: toKg(79, "kg"), weight_at: EVENING })]);
    const n = (
      db
        .prepare(
          "SELECT COUNT(*) AS n FROM body_metrics WHERE profile_id = ? AND date = ?"
        )
        .get(profileId, DAY) as { n: number }
    ).n;
    expect(n).toBe(1);
  });
});

describe("archive backfill (#3950 — while the archive still exists)", () => {
  let root: string;

  beforeEach(() => {
    root = makeTmpDir("bm-instants");
  });

  function archive(name: string, body: string) {
    const dir = path.join(root, String(profileId));
    fs.mkdirSync(dir, { recursive: true });
    fs.writeFileSync(path.join(dir, name), body);
  }

  function runBackfill() {
    return backfillBodyMetricInstants(db, () => "UTC", root);
  }

  const payloadFor = (kg: number) =>
    JSON.stringify({ weight: [{ time: MORNING, kilograms: kg }] });

  it("dates a row written before the columns existed", () => {
    put([row({ weight_kg: toKg(80, "kg") })]);
    archive("health-connect-aaa111.json", payloadFor(80));
    const tally = runBackfill();
    expect(stored()).toMatchObject({ weight_kg: 80, weight_at: MORNING });
    expect(tally.filled).toBe(1);
  });

  it("DECLINES when the stored value has since moved on", () => {
    put([row({ weight_kg: toKg(79, "kg") })]);
    archive("health-connect-aaa111.json", payloadFor(80));
    const tally = runBackfill();
    expect(stored().weight_at).toBeNull();
    expect(tally.filled).toBe(0);
    expect(tally.declined).toBeGreaterThan(0);
  });

  it("never overwrites an instant that is already there", () => {
    put([row({ weight_kg: toKg(80, "kg"), weight_at: EVENING })]);
    archive("health-connect-aaa111.json", payloadFor(80));
    const tally = runBackfill();
    expect(stored().weight_at).toBe(EVENING);
    expect(tally.filled).toBe(0);
  });

  // The archive is byte-capped, so a large push is stored truncated mid-string.
  it("counts a truncated archive file unreadable rather than throwing", () => {
    archive(
      "health-connect-bbb222.json",
      '{"weight":[{"time":"2026-06-15T07:00'
    );
    expect(runBackfill().unreadable).toBe(1);
  });
});
