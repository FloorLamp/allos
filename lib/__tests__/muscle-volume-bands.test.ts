// Pure unit tier (issue #742). Band-verdict boundaries, the shared palette, the
// cold-start distinct-week gate, and the shortfall engine's gating (cold start +
// guarded deload) over pre-gathered inputs. The DB gather (the builder) is exercised
// in lib/__db_tests__/rule-findings-builders.test.ts.

import { describe, it, expect } from "vitest";
import {
  VOLUME_BANDS,
  bandVerdict,
  bandPresentation,
  volumeBand,
  countDistinctWeeks,
  detectVolumeShortfalls,
  muscleVolumeSignalKey,
  MIN_BAND_HISTORY_WEEKS,
  MUSCLE_VOLUME_PREFIX,
  allBands,
} from "@/lib/muscle-volume-bands";
import { MUSCLE_IDS } from "@/lib/lifts";

describe("VOLUME_BANDS table", () => {
  it("is total over the MuscleId enum with sane, ordered ranges", () => {
    for (const m of MUSCLE_IDS) {
      const b = VOLUME_BANDS[m];
      expect(b, `band for ${m}`).toBeDefined();
      expect(b.low).toBeGreaterThan(0);
      expect(b.high).toBeGreaterThan(b.low);
    }
    expect(allBands()).toHaveLength(MUSCLE_IDS.length);
  });

  it("gives large prime movers a ~10-set floor and smaller muscles lower", () => {
    expect(volumeBand("chest").low).toBe(10);
    expect(volumeBand("quads").low).toBe(10);
    expect(volumeBand("lats").low).toBe(10);
    // Smaller / heavily-indirect muscles carry a lower landmark.
    expect(volumeBand("tibialis").low).toBeLessThan(volumeBand("chest").low);
    expect(volumeBand("front-delts").low).toBeLessThan(volumeBand("chest").low);
  });
});

describe("bandVerdict — boundaries are inclusive on the band", () => {
  // chest band is [10, 20].
  it("zero (or absent) sets → untrained, distinct from below", () => {
    expect(bandVerdict("chest", 0)).toBe("untrained");
    expect(bandVerdict("chest", -1)).toBe("untrained");
  });
  it("just under the floor → below", () => {
    expect(bandVerdict("chest", 9)).toBe("below");
    expect(bandVerdict("chest", 9.5)).toBe("below");
  });
  it("exactly the floor → within (inclusive low)", () => {
    expect(bandVerdict("chest", 10)).toBe("within");
  });
  it("inside the band → within", () => {
    expect(bandVerdict("chest", 15)).toBe("within");
  });
  it("exactly the ceiling → within (inclusive high)", () => {
    expect(bandVerdict("chest", 20)).toBe("within");
  });
  it("past the ceiling → above", () => {
    expect(bandVerdict("chest", 20.5)).toBe("above");
    expect(bandVerdict("chest", 30)).toBe("above");
  });
  it("half-credit fractional totals classify by value", () => {
    // side-delts band [8, 18]: 0.5 credit accrues under the floor.
    expect(bandVerdict("side-delts", 2.5)).toBe("below");
    expect(bandVerdict("side-delts", 8)).toBe("within");
  });
});

describe("bandPresentation — one palette, one entry per verdict", () => {
  it("returns a stable label/color/badge for each verdict", () => {
    for (const v of ["below", "within", "above", "untrained"] as const) {
      const p = bandPresentation(v);
      expect(p.verdict).toBe(v);
      expect(p.label.length).toBeGreaterThan(0);
      expect(p.color).toMatch(/^#[0-9a-f]{6}$/i);
      expect(p.badgeClass).toContain("bg-");
    }
  });
  it("gives untrained a neutral (not amber 'below') tint", () => {
    expect(bandPresentation("untrained").color).not.toBe(
      bandPresentation("below").color
    );
  });
});

describe("countDistinctWeeks — the cold-start history signal", () => {
  it("counts distinct week-start keys, not raw dates", () => {
    // Two dates in the same week + one in another → 2 distinct weeks.
    expect(countDistinctWeeks(["2026-07-13", "2026-07-15", "2026-07-06"])).toBe(
      2
    );
    expect(countDistinctWeeks([])).toBe(0);
    expect(countDistinctWeeks(["2026-07-15", "2026-07-15"])).toBe(1);
  });
});

describe("detectVolumeShortfalls — engine gating", () => {
  const anchor = "2026-07-15";
  const enough = { historyWeeks: MIN_BAND_HISTORY_WEEKS, deloadActive: false };

  it("emits one below-band finding per under-volumed trained muscle", () => {
    const out = detectVolumeShortfalls(
      [
        { muscle: "side-delts", sets: 2 }, // below (floor 8)
        { muscle: "chest", sets: 14 }, // within
        { muscle: "quads", sets: 25 }, // above
      ],
      { ...enough, monthAnchor: anchor.slice(0, 7) }
    );
    expect(out).toHaveLength(1);
    expect(out[0].muscle).toBe("side-delts");
    expect(out[0].key).toBe(muscleVolumeSignalKey("side-delts", "2026-07"));
    expect(out[0].key.startsWith(MUSCLE_VOLUME_PREFIX)).toBe(true);
    expect(out[0].detail).toContain("Side delts");
    expect(out[0].detail).toContain(String(out[0].low));
  });

  it("orders by the size of the shortfall (largest gap first)", () => {
    const out = detectVolumeShortfalls(
      [
        { muscle: "side-delts", sets: 7 }, // gap 1 (floor 8)
        { muscle: "chest", sets: 2 }, // gap 8 (floor 10)
      ],
      { ...enough, monthAnchor: "2026-07" }
    );
    expect(out.map((o) => o.muscle)).toEqual(["chest", "side-delts"]);
  });

  it("never emits for untrained (zero-set) muscles — those are neutral", () => {
    const out = detectVolumeShortfalls([{ muscle: "chest", sets: 0 }], {
      ...enough,
      monthAnchor: "2026-07",
    });
    expect(out).toHaveLength(0);
  });

  it("COLD START: emits nothing below MIN_BAND_HISTORY_WEEKS distinct weeks", () => {
    const out = detectVolumeShortfalls([{ muscle: "side-delts", sets: 1 }], {
      historyWeeks: MIN_BAND_HISTORY_WEEKS - 1,
      deloadActive: false,
      monthAnchor: "2026-07",
    });
    expect(out).toHaveLength(0);
  });

  it("DELOAD (guarded): suppresses the below observation when active", () => {
    const out = detectVolumeShortfalls([{ muscle: "side-delts", sets: 1 }], {
      historyWeeks: 4,
      deloadActive: true,
      monthAnchor: "2026-07",
    });
    expect(out).toHaveLength(0);
  });
});
