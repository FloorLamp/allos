// DB INTEGRATION TIER: the continuous-glucose two-store write path (#2810).
//
// The ruling (docs/internals/reading-model.md, "Where continuous glucose belongs")
// splits continuous glucose at the grain boundary — a raw instant-keyed trace
// OUTSIDE the reading model, plus the once-a-day derivations in `metric_samples`.
// The halves must never disagree, so what is pinned here is the SEAM: one entry
// point writes both, a recompute re-reads the store rather than the batch, and the
// day the derivation is filed under is the profile-LOCAL one.
//
// THE PROFILE IS DELIBERATELY NOT IN UTC. Under `America/New_York` a wall clock and
// its instant differ by four or five hours, which is exactly the margin a
// day-attribution bug hides in: a UTC-profile fixture passes whether the reader
// converts or not. Every assertion below names the instant AND the local day.

import { beforeEach, describe, expect, it } from "vitest";
import { db } from "@/lib/db";
import { setTimezone } from "@/lib/settings";
import { zonedWallTimeToUtc, utcInstant } from "@/lib/date";
import { recordGlucoseTrace, getGlucoseTraceDay } from "@/lib/glucose-trace-db";
import {
  GLUCOSE_MEAN_METRIC,
  GLUCOSE_TIME_IN_RANGE_METRIC,
  GLUCOSE_TRACE_POINTS_METRIC,
} from "@/lib/glucose-trace";
import { OWNED_TABLES } from "@/lib/owned-tables";
import { DATASETS } from "@/lib/export";

const TZ = "America/New_York";
const SOURCE = "manual";
const DAY = "2026-07-15";

let profileId: number;

/** A profile-local wall clock as the canonical instant the store keys on. */
function at(day: string, hhmm: string): string {
  return utcInstant(zonedWallTimeToUtc(TZ, day, hhmm)!);
}

/** The derived metric_samples rows of one profile-local day, metric → value. */
function derived(day: string): Record<string, number> {
  const rows = db
    .prepare(
      `SELECT metric, value FROM metric_samples
        WHERE profile_id = ? AND date = ? AND metric LIKE 'glucose%'
        ORDER BY metric`
    )
    .all(profileId, day) as { metric: string; value: number }[];
  return Object.fromEntries(rows.map((r) => [r.metric, r.value]));
}

beforeEach(() => {
  profileId = Number(
    db.prepare("INSERT INTO profiles (name) VALUES ('GLUCOSE-TRACE')").run()
      .lastInsertRowid
  );
  setTimezone(profileId, TZ);
});

describe("the trace store", () => {
  it("keys on the minute-truncated instant, so a re-push is unchanged", () => {
    const first = recordGlucoseTrace(
      profileId,
      [
        { ts: at(DAY, "08:00"), mgdl: 112 },
        { ts: at(DAY, "08:05"), mgdl: 148 },
      ],
      SOURCE
    );
    expect(first.trace.inserted).toBe(2);

    // The identical window again: the pre-image compare has to see equality, not
    // better-sqlite3's "a row matched" — otherwise every rolling-window re-push
    // reads as two writes forever.
    const again = recordGlucoseTrace(
      profileId,
      [
        { ts: at(DAY, "08:00"), mgdl: 112 },
        { ts: at(DAY, "08:05"), mgdl: 148 },
      ],
      SOURCE
    );
    expect(again.trace).toMatchObject({
      inserted: 0,
      updated: 0,
      unchanged: 2,
    });

    // A corrected value on the same minute is an UPDATE, not a second row.
    const fixed = recordGlucoseTrace(
      profileId,
      [{ ts: at(DAY, "08:00"), mgdl: 118 }],
      SOURCE
    );
    expect(fixed.trace).toMatchObject({ inserted: 0, updated: 1 });
    expect(getGlucoseTraceDay(profileId, DAY, SOURCE)).toEqual([
      { ts: at(DAY, "08:00"), mgdl: 118 },
      { ts: at(DAY, "08:05"), mgdl: 148 },
    ]);
  });

  it("lets two sources describe the same minute instead of clobbering", () => {
    // Migration 014's hr_minutes lesson, taken at birth: `source` is in the key, so
    // a vendor integration and a Health Connect push of the same sensor coexist.
    recordGlucoseTrace(
      profileId,
      [{ ts: at(DAY, "08:00"), mgdl: 112 }],
      SOURCE
    );
    recordGlucoseTrace(
      profileId,
      [{ ts: at(DAY, "08:00"), mgdl: 119 }],
      "health-connect"
    );
    expect(getGlucoseTraceDay(profileId, DAY, SOURCE)).toEqual([
      { ts: at(DAY, "08:00"), mgdl: 112 },
    ]);
    expect(getGlucoseTraceDay(profileId, DAY, "health-connect")).toEqual([
      { ts: at(DAY, "08:00"), mgdl: 119 },
    ]);
  });

  it("refuses a value outside the physiologic bound rather than storing it", () => {
    // An mmol/L number arriving unconverted reads as 5.4 — a parse error with no
    // band to look wrong against, so it would silently poison the day's mean.
    const write = recordGlucoseTrace(
      profileId,
      [
        { ts: at(DAY, "08:00"), mgdl: 5.4 },
        { ts: at(DAY, "08:05"), mgdl: 112 },
      ],
      SOURCE
    );
    expect(write.skipped).toBe(1);
    expect(write.trace.inserted).toBe(1);
    expect(derived(DAY)[GLUCOSE_MEAN_METRIC]).toBe(112);
  });
});

describe("the daily derivations", () => {
  it("files the day the PROFILE was in, not the UTC day", () => {
    // 22:00 New York on the 15th is 02:00Z on the 16th. A reader taking the
    // instant's own date prefix files it a day late — the failure a UTC-profile
    // fixture cannot see.
    recordGlucoseTrace(
      profileId,
      [
        { ts: at(DAY, "22:00"), mgdl: 140 },
        { ts: at(DAY, "23:30"), mgdl: 160 },
      ],
      SOURCE
    );
    expect(at(DAY, "22:00")).toBe("2026-07-16T02:00:00Z");
    expect(derived(DAY)).toEqual({
      [GLUCOSE_MEAN_METRIC]: 150,
      [GLUCOSE_TIME_IN_RANGE_METRIC]: 100,
      [GLUCOSE_TRACE_POINTS_METRIC]: 2,
    });
    expect(derived("2026-07-16")).toEqual({});
  });

  it("recomputes from the STORE, so a second push corrects the summary", () => {
    // A rolling window may carry half a day and a later push the rest. Deriving
    // from the batch alone would publish a summary of whatever arrived together.
    recordGlucoseTrace(
      profileId,
      [{ ts: at(DAY, "08:00"), mgdl: 100 }],
      SOURCE
    );
    expect(derived(DAY)).toMatchObject({
      [GLUCOSE_MEAN_METRIC]: 100,
      [GLUCOSE_TIME_IN_RANGE_METRIC]: 100,
      [GLUCOSE_TRACE_POINTS_METRIC]: 1,
    });

    // The rest of the day arrives, including one excursion above 180.
    recordGlucoseTrace(
      profileId,
      [
        { ts: at(DAY, "12:00"), mgdl: 140 },
        { ts: at(DAY, "13:00"), mgdl: 240 },
      ],
      SOURCE
    );
    expect(derived(DAY)).toEqual({
      [GLUCOSE_MEAN_METRIC]: 160,
      [GLUCOSE_TIME_IN_RANGE_METRIC]: 66.7,
      [GLUCOSE_TRACE_POINTS_METRIC]: 3,
    });
    // And the correction is an UPDATE of the same three rows, not three more.
    expect(
      db
        .prepare(
          `SELECT COUNT(*) AS n FROM metric_samples
            WHERE profile_id = ? AND metric LIKE 'glucose%'`
        )
        .get(profileId)
    ).toEqual({ n: 3 });
  });

  it("writes nothing for a day the sensor did not cover", () => {
    // 0% time-in-range would read as a day spent entirely out of range.
    const write = recordGlucoseTrace(profileId, [], SOURCE);
    expect(write.days).toEqual([]);
    expect(derived(DAY)).toEqual({});
  });

  it("derives per source, so two sensors do not average into one day", () => {
    recordGlucoseTrace(
      profileId,
      [{ ts: at(DAY, "08:00"), mgdl: 100 }],
      SOURCE
    );
    recordGlucoseTrace(
      profileId,
      [{ ts: at(DAY, "08:00"), mgdl: 200 }],
      "health-connect"
    );
    const rows = db
      .prepare(
        `SELECT source, value FROM metric_samples
          WHERE profile_id = ? AND metric = ? ORDER BY source`
      )
      .all(profileId, GLUCOSE_MEAN_METRIC);
    expect(rows).toEqual([
      { source: "health-connect", value: 200 },
      { source: "manual", value: 100 },
    ]);
  });
});

describe("the new-table censuses", () => {
  it("is profile-owned, so a profile delete clears it", () => {
    expect(OWNED_TABLES).toContain("glucose_trace");
  });

  it("is exported, and browse-only like hr_minutes", () => {
    const ds = DATASETS.find((d) => d.key === "glucose_trace");
    expect(ds).toBeDefined();
    expect(ds!.deletable).toBe(false);
  });

  it("stores the instant on the canonical convention", () => {
    // BORN canonical (lib/time-columns.ts + the instant-writer registry): the day
    // reader windows this column against canonical UTC bounds, and a bare-shaped
    // value beside a canonical one sorts wrong while the query still looks right.
    recordGlucoseTrace(
      profileId,
      [{ ts: at(DAY, "08:00"), mgdl: 112 }],
      SOURCE
    );
    const row = db
      .prepare("SELECT ts FROM glucose_trace WHERE profile_id = ?")
      .get(profileId) as { ts: string };
    expect(row.ts).toMatch(/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:00Z$/);
  });
});
