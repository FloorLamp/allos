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
  it("requires three readings per side before judging a comparison", () => {
    const cmp = compareProtocol(
      [
        hr([
          ["2026-04-30", 60],
          ["2026-05-01", 55],
        ]),
      ],
      { startDate: "2026-05-01", endDate: "2026-05-01", today: "2026-05-01" }
    );

    expect(cmp.outcomes[0].insufficient).toBe(true);
    expect(cmp.outcomes[0].betterness).toBe("unknown");
    expect(cmp.outcomes[0].framing).toBe(
      "Not enough readings to compare (baseline n=1, during n=1)."
    );
  });

  it("computes mean/median shift with n per window and honest framing", () => {
    const cmp = compareProtocol(
      [
        hr([
          ["2026-04-22", 60],
          ["2026-04-28", 62],
          ["2026-04-30", 61],
          ["2026-05-02", 57],
          ["2026-05-08", 57],
          ["2026-05-10", 57],
        ]),
      ],
      { startDate: "2026-05-01", endDate: "2026-05-10", today: "2026-05-10" }
    );
    const o = cmp.outcomes[0];
    expect(o.baseline.n).toBe(3);
    expect(o.baseline.mean).toBe(61);
    expect(o.baseline.median).toBe(61);
    expect(o.intervention.n).toBe(3);
    expect(o.intervention.mean).toBe(57);
    expect(o.meanDelta).toBe(-4);
    expect(o.betterness).toBe("better"); // lower resting HR is better
    expect(o.insufficient).toBe(false);
    expect(o.framing).toContain("−4 bpm");
    expect(o.framing).toContain("n=3 during vs 3 before");
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
    expect(o.insufficient).toBe(true);
  });

  it("sparse labs: retains the nearest draw but does not judge one reading", () => {
    const ldl: OutcomeSeries = {
      key: "result:LDL Cholesterol",
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
    expect(o.insufficient).toBe(true);
    expect(o.betterness).toBe("unknown");
  });

  it("keeps the stored unit raw while its framing crosses the display boundary", () => {
    const cmp = compareProtocol(
      [
        {
          key: "result:Selenium",
          label: "Selenium",
          unit: "ug/L",
          direction: "higher_better",
          samples: [
            { date: "2026-04-26", value: 40 },
            { date: "2026-04-28", value: 40 },
            { date: "2026-04-30", value: 40 },
            { date: "2026-05-01", value: 45 },
            { date: "2026-05-03", value: 45 },
            { date: "2026-05-05", value: 45 },
          ],
        },
      ],
      {
        startDate: "2026-05-01",
        endDate: "2026-05-10",
        today: "2026-05-10",
      }
    );

    expect(cmp.outcomes[0].unit).toBe("ug/L");
    expect(cmp.outcomes[0].framing).toContain("+5 µg/L");
    expect(cmp.outcomes[0].framing).not.toContain("ug/L");
  });

  it("sparse labs: without the nearest-before fallback an empty baseline is insufficient", () => {
    const ldl: OutcomeSeries = {
      key: "result:LDL Cholesterol",
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
        { date: "2026-04-27", value: 72 },
        { date: "2026-04-29", value: 71 },
        { date: "2026-05-05", value: 82 },
        { date: "2026-05-07", value: 80 },
        { date: "2026-05-09", value: 81 },
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
    expect(parseOutcomeKey("result:LDL Cholesterol")).toEqual({
      kind: "result",
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
        "result:ApoB",
        "junk",
        "",
      ])
    ).toEqual(["metric:weight", "result:ApoB"]);
  });

  it("collapses legacy biomarker aliases onto one logical outcome key", () => {
    expect(
      normalizeOutcomeKeys([
        "result:Body Weight",
        "metric:weight",
        "result:Resting Heart Rate",
        "metric:resting_hr",
        "result:Body Fat Percentage",
        "metric:body_fat",
        "result:PhenoAge",
        "index:phenoage",
      ])
    ).toEqual([
      "metric:weight",
      "metric:resting_hr",
      "metric:body_fat",
      "index:phenoage",
    ]);
  });

  it("labels fixed metrics and falls back to the canonical name for biomarkers", () => {
    expect(outcomeMetricLabel("metric:resting_hr")).toBe("Resting heart rate");
    expect(outcomeMetricLabel("result:ApoB")).toBe("ApoB");
  });
});
