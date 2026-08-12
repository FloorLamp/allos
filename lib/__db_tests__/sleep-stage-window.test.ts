// DB INTEGRATION TIER (not the pure unit suite in lib/__tests__).
//
// Issue #2520 — `getSleepStageComposition(profileId, limitDays)` used to be a
// post-slice: it called `getSleepStageDailyTotals(profileId)` on that function's OWN
// 180-day default and then kept the last `limitDays` rows. The parameter named a
// window the read never had, so the digest's 14-night ask computed half a year of
// per-night stage attribution to read one night.
//
// The correctness of that attribution is pinned by sleep-main-session.test.ts. What
// this file pins is the READ: the window the caller asked for is the window the SQL
// scans. It counts the rows the stage scan actually returns (the statement-spy shape
// weather-uv.test.ts / tick-scoped-gathers.test.ts use for the same class of claim).

import { describe, it, expect, beforeAll, afterEach, vi } from "vitest";
import { db, today } from "@/lib/db";
import { shiftDateStr } from "@/lib/date";
import {
  upsertMetricSamples,
  type NormMetricSample,
} from "@/lib/integrations/normalize";
import { getSleepStageComposition } from "@/lib/queries";
import { setTimezone } from "@/lib/settings";

// Nights of stage history seeded — comfortably past every window under test.
const NIGHTS = 30;
const STAGES_PER_NIGHT = 4;

let profileId: number;
let wakeDays: string[]; // newest first

const sample = (
  metric: string,
  date: string,
  value: number,
  start: string,
  end: string
): NormMetricSample => ({ metric, date, start_time: start, end_time: end, value });

// The raw stage-row scan inside getSleepStageDailyTotals — the read the window is
// supposed to bound. Wrap the prepared statement's `.all` so we see how many rows it
// hands back, which is the only honest measure of "did the bound reach the query".
function countStageRowsRead(): { rows: () => number } {
  let rows = 0;
  const real = db.prepare.bind(db);
  vi.spyOn(db, "prepare").mockImplementation(((sql: string) => {
    const stmt = real(sql);
    if (/sleep_deep_min/.test(sql) && /date >= \?/.test(sql)) {
      const all = stmt.all.bind(stmt);
      stmt.all = ((...args: unknown[]) => {
        const out = all(...args) as unknown[];
        rows += out.length;
        return out;
      }) as typeof stmt.all;
    }
    return stmt;
  }) as typeof db.prepare);
  return { rows: () => rows };
}

beforeAll(() => {
  profileId = Number(
    db.prepare("INSERT INTO profiles (name) VALUES ('StageWindow')").run()
      .lastInsertRowid
  );
  setTimezone(profileId, "UTC");
  const newest = today(profileId);
  wakeDays = Array.from({ length: NIGHTS }, (_, i) => shiftDateStr(newest, -i));

  // One plain 7h overnight per night, with its four stage rows attributed to the
  // same window. Every night therefore yields exactly one composition row.
  for (const day of wakeDays) {
    const start = `${shiftDateStr(day, -1)}T23:00:00Z`;
    const end = `${day}T06:00:00Z`;
    upsertMetricSamples(
      profileId,
      [
        sample("sleep_min", day, 420, start, end),
        sample("sleep_deep_min", day, 60, start, end),
        sample("sleep_rem_min", day, 90, start, end),
        sample("sleep_light_min", day, 250, start, end),
        sample("sleep_awake_min", day, 20, start, end),
      ],
      "health-connect"
    );
  }
});

afterEach(() => {
  vi.restoreAllMocks();
});

describe("getSleepStageComposition is bounded by the window it is asked for (#2520)", () => {
  it("reads only the requested nights' stage rows", () => {
    const counted = countStageRowsRead();
    const composition = getSleepStageComposition(profileId, 5);

    expect(composition).toHaveLength(5);
    // Newest-last, and the five most recent wake-days — the same rows the old
    // post-slice returned, at a fraction of the scan.
    expect(composition.map((row) => row.date)).toEqual(
      wakeDays.slice(0, 5).reverse()
    );
    // The bound is the READ: five nights of stage rows, not thirty.
    expect(counted.rows()).toBe(5 * STAGES_PER_NIGHT);
  });

  it("a wider window reads wider, and the digest's window is genuinely small", () => {
    const wide = countStageRowsRead();
    expect(getSleepStageComposition(profileId, 20)).toHaveLength(20);
    expect(wide.rows()).toBe(20 * STAGES_PER_NIGHT);
    vi.restoreAllMocks();

    // What gatherDigestSleep asks for. Before #2520 this same call scanned every
    // stage row inside 180 days.
    const digest = countStageRowsRead();
    expect(getSleepStageComposition(profileId, 14)).toHaveLength(14);
    expect(digest.rows()).toBe(14 * STAGES_PER_NIGHT);
  });

  it("asking past the history returns everything without reading twice", () => {
    const counted = countStageRowsRead();
    expect(getSleepStageComposition(profileId, 500)).toHaveLength(NIGHTS);
    expect(counted.rows()).toBe(NIGHTS * STAGES_PER_NIGHT);
  });
});
