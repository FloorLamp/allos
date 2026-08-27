import { describe, it, expect } from "vitest";
import {
  paceHrDecouplingPercent,
  sessionSplitIntervalM,
  streamDistanceKm,
} from "@/lib/session-analytics";

describe("sessionSplitIntervalM (#3009)", () => {
  it("cuts at the READER's own unit, so splits are the ones they'd name", () => {
    expect(sessionSplitIntervalM(5, "km")).toBe(1000);
    expect(sessionSplitIntervalM(5, "mi")).toBeCloseTo(1609.344, 3);
  });

  it("steps up once one-per-unit would overflow the table", () => {
    // A 42 km marathon at 1 km is 42 rows nobody reads.
    expect(sessionSplitIntervalM(42, "km")).toBe(5000);
    // 20 is still fine; 21 is not.
    expect(sessionSplitIntervalM(20, "km")).toBe(1000);
    expect(sessionSplitIntervalM(21, "km")).toBe(5000);
  });

  it("keeps stepping up until the table fits — not exactly once", () => {
    // A single ×5 held the bound only to a hundred units: a 150 km ride would
    // still have rendered thirty rows.
    expect(sessionSplitIntervalM(150, "km")).toBe(25000);
    expect(sessionSplitIntervalM(600, "km")).toBe(125000);
  });

  it("reads the distance the splits are actually cut from", () => {
    // An import whose `distance_km` failed its ingest bounds stores null while
    // the stream still carries the session: taking the interval from the column
    // would pick 1 km and render sixty rows.
    expect(
      streamDistanceKm({ distance: { data: [0, 1000, 60000] } })
    ).toBeCloseTo(60);
    // Trailing gaps are skipped rather than read as a distance of nothing.
    expect(
      streamDistanceKm({ distance: { data: [0, 5000, null] } })
    ).toBeCloseTo(5);
    expect(streamDistanceKm({})).toBeNull();
  });

  it("gives a short walk an interval it can actually fill", () => {
    // The ride page's 5 km would yield NO splits for 1.4 km — the core declines
    // anything under a third of an interval — so this is the whole point.
    expect(sessionSplitIntervalM(1.4, "km")).toBe(1000);
    expect(sessionSplitIntervalM(null, "km")).toBe(1000);
  });
});

describe("paceHrDecouplingPercent", () => {
  it("answers only when the recording carries both series, moving, in both halves", () => {
    const time = Array.from({ length: 200 }, (_, i) => i);
    const streams = {
      time: { data: time },
      velocity_smooth: { data: time.map((t) => (t <= 99.5 ? 3 : 2.4)) },
      heartrate: { data: time.map(() => 140) },
    };
    expect(paceHrDecouplingPercent(streams)).toBeCloseTo(20, 1);
    // A walk with no heart rate recorded says nothing rather than guessing.
    expect(
      paceHrDecouplingPercent({ ...streams, heartrate: undefined })
    ).toBeNull();
  });
});
