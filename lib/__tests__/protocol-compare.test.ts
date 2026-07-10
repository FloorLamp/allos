import { describe, it, expect } from "vitest";
import {
  compareProtocol,
  spanLabel,
  type OutcomeSeries,
} from "@/lib/protocol-compare";
import {
  normalizeOutcomeKeys,
  parseOutcomeKey,
  outcomeMetricLabel,
} from "@/lib/protocol-metrics";

// A resting-HR series (lower is better).
function hr(samples: [string, number][]): OutcomeSeries {
  return {
    key: "metric:resting_hr",
    label: "Resting heart rate",
    unit: "bpm",
    direction: "lower_better",
    samples: samples.map(([date, value]) => ({ date, value })),
  };
}

describe("compareProtocol", () => {
  it("computes mean/median shift with n per window and honest framing", () => {
    const cmp = compareProtocol(
      [
        hr([
          ["2026-04-22", 60],
          ["2026-04-28", 62],
          ["2026-05-02", 57],
          ["2026-05-08", 57],
        ]),
      ],
      { startDate: "2026-05-01", endDate: "2026-05-10", today: "2026-05-10" }
    );
    const o = cmp.outcomes[0];
    expect(o.baseline.n).toBe(2);
    expect(o.baseline.mean).toBe(61);
    expect(o.baseline.median).toBe(61);
    expect(o.intervention.n).toBe(2);
    expect(o.intervention.mean).toBe(57);
    expect(o.meanDelta).toBe(-4);
    expect(o.betterness).toBe("better"); // lower resting HR is better
    expect(o.insufficient).toBe(false);
    expect(o.framing).toContain("−4 bpm");
    expect(o.framing).toContain("n=2 during vs 2 before");
  });

  it("window edges: a sample ON the start date is intervention; the day before is baseline", () => {
    const cmp = compareProtocol(
      [
        hr([
          ["2026-04-30", 20], // start − 1 → baseline
          ["2026-05-01", 10], // start → intervention
        ]),
      ],
      { startDate: "2026-05-01", endDate: "2026-05-10", today: "2026-05-10" }
    );
    const o = cmp.outcomes[0];
    expect(o.baseline.n).toBe(1);
    expect(o.baseline.mean).toBe(20);
    expect(o.intervention.n).toBe(1);
    expect(o.intervention.mean).toBe(10);
    expect(o.meanDelta).toBe(-10);
    expect(o.insufficient).toBe(false);
  });

  it("sparse labs: falls back to the nearest draw before the start when the baseline window is empty", () => {
    const ldl: OutcomeSeries = {
      key: "biomarker:LDL Cholesterol",
      label: "LDL Cholesterol",
      unit: "mg/dL",
      direction: "lower_better",
      samples: [
        { date: "2026-01-15", value: 130 }, // well before the 8-week baseline window
        { date: "2026-05-20", value: 110 }, // during
      ],
    };
    const cmp = compareProtocol([ldl], {
      startDate: "2026-05-01",
      endDate: "2026-06-25", // ~8 weeks
      today: "2026-06-25",
    });
    const o = cmp.outcomes[0];
    expect(o.baseline.n).toBe(1); // nearest-before draw
    expect(o.baseline.mean).toBe(130);
    expect(o.intervention.mean).toBe(110);
    expect(o.meanDelta).toBe(-20);
    expect(o.insufficient).toBe(false);
  });

  it("sparse labs: without the nearest-before fallback an empty baseline is insufficient", () => {
    const ldl: OutcomeSeries = {
      key: "biomarker:LDL Cholesterol",
      label: "LDL Cholesterol",
      unit: "mg/dL",
      direction: "lower_better",
      samples: [
        { date: "2026-01-15", value: 130 },
        { date: "2026-05-20", value: 110 },
      ],
    };
    const cmp = compareProtocol([ldl], {
      startDate: "2026-05-01",
      endDate: "2026-06-25",
      today: "2026-06-25",
      baselineNearestFallback: false,
    });
    const o = cmp.outcomes[0];
    expect(o.baseline.n).toBe(0);
    expect(o.insufficient).toBe(true);
    expect(o.framing).toMatch(/Not enough readings/);
  });

  it("no-data metric: emits an insufficient-data note, no fabricated shift", () => {
    const cmp = compareProtocol([hr([])], {
      startDate: "2026-05-01",
      endDate: "2026-05-10",
      today: "2026-05-10",
    });
    const o = cmp.outcomes[0];
    expect(o.insufficient).toBe(true);
    expect(o.meanDelta).toBeNull();
    expect(o.betterness).toBe("unknown");
    expect(o.framing).toMatch(/Not enough readings/);
  });

  it("ongoing protocol uses `today` as the intervention end", () => {
    const cmp = compareProtocol([hr([])], {
      startDate: "2026-05-01",
      endDate: null,
      today: "2026-05-09",
    });
    expect(cmp.interventionWindow).toEqual({
      start: "2026-05-01",
      end: "2026-05-09",
    });
    // baseline is the equal-length window immediately before the start
    expect(cmp.baselineWindow.end).toBe("2026-04-30");
  });

  it("a higher-is-better metric flips the good direction", () => {
    const sri: OutcomeSeries = {
      key: "index:sri",
      label: "Sleep regularity (SRI)",
      unit: null,
      direction: "higher_better",
      samples: [
        { date: "2026-04-25", value: 70 },
        { date: "2026-05-05", value: 82 },
      ],
    };
    const cmp = compareProtocol([sri], {
      startDate: "2026-05-01",
      endDate: "2026-05-10",
      today: "2026-05-10",
    });
    expect(cmp.outcomes[0].betterness).toBe("better");
  });
});

describe("spanLabel", () => {
  it("uses weeks for a multi-week span, days for a short one", () => {
    expect(spanLabel(56)).toBe("8 weeks");
    expect(spanLabel(10)).toBe("10 days");
    expect(spanLabel(1)).toBe("1 day");
  });
});

describe("outcome metric keys", () => {
  it("parses each namespace and rejects garbage", () => {
    expect(parseOutcomeKey("biomarker:LDL Cholesterol")).toEqual({
      kind: "biomarker",
      id: "LDL Cholesterol",
    });
    expect(parseOutcomeKey("metric:resting_hr")).toEqual({
      kind: "body",
      id: "resting_hr",
    });
    expect(parseOutcomeKey("index:phenoage")).toEqual({
      kind: "index",
      id: "phenoage",
    });
    expect(parseOutcomeKey("metric:bogus")).toBeNull();
    expect(parseOutcomeKey("nope")).toBeNull();
    expect(parseOutcomeKey("index:")).toBeNull();
  });

  it("normalizes: drops blanks, dupes, and unparseable keys, order-preserving", () => {
    expect(
      normalizeOutcomeKeys([
        "metric:weight",
        " metric:weight ",
        "biomarker:ApoB",
        "junk",
        "",
      ])
    ).toEqual(["metric:weight", "biomarker:ApoB"]);
  });

  it("labels fixed metrics and falls back to the canonical name for biomarkers", () => {
    expect(outcomeMetricLabel("metric:resting_hr")).toBe("Resting heart rate");
    expect(outcomeMetricLabel("biomarker:ApoB")).toBe("ApoB");
  });
});
