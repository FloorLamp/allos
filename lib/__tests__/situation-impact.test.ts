import { describe, it, expect } from "vitest";
import {
  compareOutcomePooled,
  compareProtocol,
  baselineFor,
  type DuringWindow,
  type OutcomeSeries,
} from "../protocol-compare";
import {
  situationWindows,
  duringDayCount,
  buildSituationImpact,
  declaredSituationNames,
  impactChipLabel,
  impactWindowSummary,
} from "../situation-impact";
import type { SituationEvent } from "../trend-annotations";

// Situation-window analytics (#1297): the pure pooling + window derivation over the
// declared transition log. The pooling reuses the protocol-compare engine — a one-window
// situation must reproduce compareProtocol exactly (the reuse pin).

const ev = (
  date: string,
  situation: string,
  change: "start" | "stop"
): SituationEvent => ({ date, situation, change });

function flatSeries(
  values: Record<string, number>,
  meta: Partial<OutcomeSeries> = {}
): OutcomeSeries {
  return {
    key: meta.key ?? "index:sri",
    label: meta.label ?? "SRI",
    unit: meta.unit ?? null,
    direction: meta.direction ?? "higher_better",
    samples: Object.entries(values).map(([date, value]) => ({ date, value })),
  };
}

describe("situationWindows", () => {
  it("pairs a start with its stop, ending the day before the stop (active span)", () => {
    const events = [
      ev("2026-06-10", "Travel", "start"),
      ev("2026-06-15", "Travel", "stop"),
    ];
    expect(situationWindows("Travel", events, "2026-06-30")).toEqual([
      { start: "2026-06-10", end: "2026-06-14" },
    ]);
  });

  it("runs an open (never-stopped) window to today", () => {
    const events = [ev("2026-06-10", "Travel", "start")];
    expect(situationWindows("Travel", events, "2026-06-20")).toEqual([
      { start: "2026-06-10", end: "2026-06-20" },
    ]);
  });

  it("skips a stop with no open start (situation active before the log began — no baseline)", () => {
    const events = [ev("2026-06-15", "Travel", "stop")];
    expect(situationWindows("Travel", events, "2026-06-30")).toEqual([]);
  });

  it("derives multiple windows and folds case/space variants of the name (#560)", () => {
    const events = [
      ev("2026-06-10", "Travel", "start"),
      ev("2026-06-13", "travel", "stop"),
      ev("2026-06-20", " Travel ", "start"),
      ev("2026-06-24", "Travel", "stop"),
    ];
    expect(situationWindows("Travel", events, "2026-06-30")).toEqual([
      { start: "2026-06-10", end: "2026-06-12" },
      { start: "2026-06-20", end: "2026-06-23" },
    ]);
  });

  it("collapses a same-day start+stop to nothing (no spurious window)", () => {
    const events = [
      ev("2026-06-10", "Travel", "start"),
      ev("2026-06-10", "Travel", "stop"),
    ];
    expect(situationWindows("Travel", events, "2026-06-30")).toEqual([]);
  });
});

describe("duringDayCount", () => {
  it("unions overlapping windows so a shared day is not double-counted", () => {
    const windows: DuringWindow[] = [
      { start: "2026-06-10", end: "2026-06-14" }, // 5
      { start: "2026-06-13", end: "2026-06-16" }, // adds 15,16 (13,14 shared)
    ];
    expect(duringDayCount(windows)).toBe(7);
  });
});

describe("compareOutcomePooled — reuse pin (#221)", () => {
  it("a single clean window reproduces compareProtocol's stats exactly", () => {
    const start = "2026-06-10";
    const end = "2026-06-14"; // 5-day window; baseline 2026-06-05..2026-06-09
    const series = flatSeries(
      {
        "2026-06-05": 10,
        "2026-06-06": 10,
        "2026-06-07": 12,
        "2026-06-08": 10,
        "2026-06-09": 8,
        "2026-06-10": 8,
        "2026-06-11": 8,
        "2026-06-12": 6,
        "2026-06-13": 8,
        "2026-06-14": 10,
      },
      { direction: "higher_better" }
    );
    const proto = compareProtocol([series], {
      startDate: start,
      endDate: end,
      today: "2026-06-30",
      baselineNearestFallback: false,
    }).outcomes[0];
    const pooled = compareOutcomePooled(series, [{ start, end }], {
      minDuring: 1,
      minBaseline: 1,
    });
    expect(pooled.baseline.n).toBe(proto.baseline.n);
    expect(pooled.baseline.mean).toBe(proto.baseline.mean);
    expect(pooled.intervention.n).toBe(proto.intervention.n);
    expect(pooled.intervention.mean).toBe(proto.intervention.mean);
    expect(pooled.meanDelta).toBe(proto.meanDelta);
    expect(pooled.medianDelta).toBe(proto.medianDelta);
    expect(pooled.betterness).toBe(proto.betterness);
  });
});

describe("compareOutcomePooled — multi-window pooling", () => {
  it("pools during-days across windows against pooled baselines (hand-computed)", () => {
    const series = flatSeries({
      // window A baseline
      "2026-06-07": 10,
      "2026-06-08": 10,
      "2026-06-09": 10,
      // window A during
      "2026-06-10": 8,
      "2026-06-11": 8,
      "2026-06-12": 8,
      // window B baseline
      "2026-06-17": 12,
      "2026-06-18": 12,
      "2026-06-19": 12,
      // window B during
      "2026-06-20": 6,
      "2026-06-21": 6,
      "2026-06-22": 6,
    });
    const windows: DuringWindow[] = [
      { start: "2026-06-10", end: "2026-06-12" },
      { start: "2026-06-20", end: "2026-06-22" },
    ];
    const out = compareOutcomePooled(series, windows, {
      minDuring: 1,
      minBaseline: 1,
    });
    expect(out.intervention.n).toBe(6);
    expect(out.intervention.mean).toBe(7); // (8*3 + 6*3)/6
    expect(out.baseline.n).toBe(6);
    expect(out.baseline.mean).toBe(11); // (10*3 + 12*3)/6
    expect(out.meanDelta).toBe(-4);
    expect(out.framing).toContain("2 windows");
  });

  it("excludes a during-day from the baseline when adjacent windows overlap", () => {
    // Window B's baseline span == Window A's during span; those during-days must NOT
    // double as baseline (the overlapping/adjacent-window guard).
    const series = flatSeries({
      "2026-06-05": 10,
      "2026-06-06": 10,
      "2026-06-07": 10,
      "2026-06-08": 10,
      "2026-06-09": 10,
      // A during 06-10..06-14
      "2026-06-10": 8,
      "2026-06-11": 8,
      "2026-06-12": 8,
      "2026-06-13": 8,
      "2026-06-14": 8,
      // B during 06-15..06-19
      "2026-06-15": 8,
      "2026-06-16": 8,
      "2026-06-17": 8,
      "2026-06-18": 8,
      "2026-06-19": 8,
    });
    const windows: DuringWindow[] = [
      { start: "2026-06-10", end: "2026-06-14" },
      { start: "2026-06-15", end: "2026-06-19" }, // baseline 06-10..06-14 = A during
    ];
    const out = compareOutcomePooled(series, windows, {
      minDuring: 1,
      minBaseline: 1,
    });
    expect(out.intervention.n).toBe(10);
    // Baseline is ONLY A's 5 pre-days — B's during-day-baseline is excluded.
    expect(out.baseline.n).toBe(5);
    expect(out.baseline.mean).toBe(10);
    expect(out.meanDelta).toBe(-2);
  });

  it("gates on the pooled minimum-data floor (no fake precision)", () => {
    const series = flatSeries({
      "2026-06-09": 10,
      "2026-06-10": 8, // only one during, one baseline
    });
    const out = compareOutcomePooled(
      series,
      [{ start: "2026-06-10", end: "2026-06-14" }],
      { minDuring: 3, minBaseline: 3 }
    );
    expect(out.insufficient).toBe(true);
    expect(out.betterness).toBe("unknown");
  });
});

describe("baselineFor", () => {
  it("is the equal-length span ending the day before the window start", () => {
    expect(baselineFor({ start: "2026-06-10", end: "2026-06-14" })).toEqual({
      start: "2026-06-05",
      end: "2026-06-09",
    });
  });
});

describe("buildSituationImpact — absent-pillar (#489)", () => {
  const series = flatSeries({
    "2026-06-07": 10,
    "2026-06-08": 10,
    "2026-06-09": 10,
    "2026-06-10": 8,
    "2026-06-11": 8,
    "2026-06-12": 8,
  });

  it("returns a card when a situation has enough windowed history + a computable metric", () => {
    const impact = buildSituationImpact({
      situation: "Travel",
      windows: [{ start: "2026-06-10", end: "2026-06-12" }],
      series: [series],
      pooledMin: 3,
    });
    expect(impact).not.toBeNull();
    expect(impact!.windowCount).toBe(1);
    expect(impact!.duringDays).toBe(3);
    expect(impact!.outcomes).toHaveLength(1);
  });

  it("returns null when the during-days floor isn't met", () => {
    const impact = buildSituationImpact({
      situation: "Travel",
      windows: [{ start: "2026-06-10", end: "2026-06-11" }], // 2 days < 3
      series: [series],
      pooledMin: 1,
    });
    expect(impact).toBeNull();
  });

  it("returns null (no empty card) when no metric has enough pooled readings", () => {
    const sparse = flatSeries({ "2026-06-10": 8 });
    const impact = buildSituationImpact({
      situation: "Travel",
      windows: [{ start: "2026-06-10", end: "2026-06-14" }],
      series: [sparse],
      pooledMin: 3,
    });
    expect(impact).toBeNull();
  });
});

describe("declaredSituationNames + formatters", () => {
  it("folds distinct names to first-seen spelling", () => {
    const events = [
      ev("2026-06-10", "Travel", "start"),
      ev("2026-06-13", "travel", "stop"),
      ev("2026-06-20", "High stress", "start"),
    ];
    expect(declaredSituationNames(events)).toEqual(["Travel", "High stress"]);
  });

  it("formats a compact chip label and window summary", () => {
    const out = compareOutcomePooled(
      flatSeries(
        {
          "2026-06-07": 10,
          "2026-06-08": 10,
          "2026-06-09": 10,
          "2026-06-10": 8,
          "2026-06-11": 8,
          "2026-06-12": 8,
        },
        { label: "SRI", direction: "higher_better" }
      ),
      [{ start: "2026-06-10", end: "2026-06-12" }],
      { minDuring: 1, minBaseline: 1 }
    );
    expect(impactChipLabel(out)).toBe("SRI −2");
    expect(
      impactWindowSummary({
        situation: "Travel",
        windowCount: 2,
        duringDays: 6,
        outcomes: [],
      })
    ).toBe("2 windows · 6 days");
  });
});
