import { describe, it, expect } from "vitest";
import {
  bareOptimalHitRate,
  buildPillars,
  optimalCoverage,
  optimalPillarDetail,
  optimalRangeHitRate,
  optimalShareRows,
  optimalTone,
  type BiomarkerReading,
  type NamedBiomarkerReading,
} from "@/lib/longevity-pillars";
import type { CanonicalBiomarker } from "@/lib/types";

// #2023 — the optimal-biomarker pillar's freshness and coverage context. The pillar keeps
// its ratio and every marker's existing canonical judgment; what these tests pin is that
// the ratio now says what it describes: how many markers, how current they are, and that
// an old-only panel never renders as a current green result.

const TODAY = "2026-08-05";

function cb(
  partial: Partial<CanonicalBiomarker> & {
    name: string;
    unit: string;
    direction: CanonicalBiomarker["direction"];
  }
): CanonicalBiomarker {
  return partial as unknown as CanonicalBiomarker;
}

const totalChol = cb({
  name: "Total Cholesterol",
  unit: "mg/dL",
  direction: "lower_better",
  ref_low: 125,
  ref_high: 200,
  optimal_low: null,
  optimal_high: 180,
});

// A judged lab reading on a 365-day retest clock. `daysAgo` places its date.
function lab(
  value: number | null,
  daysAgo: number,
  name = "Total Cholesterol"
): NamedBiomarkerReading {
  const d = new Date(Date.parse(`${TODAY}T00:00:00Z`) - daysAgo * 86400000);
  return {
    name,
    canonicalName: name,
    value_num: value,
    unit: "mg/dL",
    cb: totalChol,
    date: d.toISOString().slice(0, 10),
    category: "lab",
    retestDays: 365,
  };
}

describe("optimalCoverage bands the denominator", () => {
  it("distinguishes a narrow sample from a broad panel", () => {
    expect(optimalCoverage(0)).toBe("narrow");
    expect(optimalCoverage(4)).toBe("narrow");
    expect(optimalCoverage(5)).toBe("moderate");
    expect(optimalCoverage(14)).toBe("moderate");
    expect(optimalCoverage(15)).toBe("broad");
    expect(optimalCoverage(40)).toBe("broad");
  });

  it("2-of-2 and 32-of-40 are no longer the same claim", () => {
    const narrow = optimalRangeHitRate([lab(170, 10), lab(175, 10)], null, null, TODAY);
    const broad = optimalRangeHitRate(
      Array.from({ length: 20 }, (_, i) => lab(170, 10, `Marker ${i}`)),
      null,
      null,
      TODAY
    );
    expect(narrow.coverage).toBe("narrow");
    expect(broad.coverage).toBe("broad");
    expect(optimalPillarDetail(narrow)).toContain("narrow panel");
    expect(optimalPillarDetail(broad)).toContain("broad panel");
  });
});

describe("optimalRangeHitRate carries freshness from the existing retest computation", () => {
  it("all-current: every judged reading inside its retest window", () => {
    const rate = optimalRangeHitRate(
      [lab(170, 10), lab(175, 30), lab(195, 60)],
      null,
      null,
      TODAY
    );
    expect(rate).toMatchObject({ optimal: 2, total: 3, currentOptimal: 2 });
    expect(rate.freshness).toEqual({ current: 3, due: 0, notApplicable: 0 });
    expect(optimalPillarDetail(rate)).toBe("3 markers (narrow panel) · all current");
  });

  it("mixed: the stale count is explicit and the ratio is unchanged", () => {
    const rate = optimalRangeHitRate(
      [lab(170, 10), lab(175, 900), lab(195, 20)],
      null,
      null,
      TODAY
    );
    expect(rate).toMatchObject({ optimal: 2, total: 3 });
    expect(rate.freshness).toEqual({ current: 2, due: 1, notApplicable: 0 });
    // The optimal reading that is past its clock does not count as currently optimal.
    expect(rate.currentOptimal).toBe(1);
    expect(optimalPillarDetail(rate)).toContain("1 based on older results");
  });

  it("all-stale: names the latest result rather than implying currency", () => {
    const rate = optimalRangeHitRate(
      [lab(170, 900), lab(175, 1200)],
      null,
      null,
      TODAY
    );
    expect(rate.freshness).toEqual({ current: 0, due: 2, notApplicable: 0 });
    expect(rate.latestDate).toBe("2024-02-17");
    expect(rate.oldestDate).toBe("2023-04-23");
    expect(optimalPillarDetail(rate)).toContain("all based on older results");
    expect(optimalPillarDetail(rate)).toContain("2024-02-17");
  });

  it("unjudgeable latest readings leave the ratio alone but are counted", () => {
    const rate = optimalRangeHitRate(
      [
        lab(170, 10),
        { ...lab(5, 10), cb: null }, // no canonical row
        { ...lab(null, 10) }, // no numeric value
      ],
      null,
      null,
      TODAY
    );
    expect(rate).toMatchObject({ optimal: 1, total: 1, unjudged: 2 });
  });

  it("without dates the freshness is UNKNOWN, never assumed stale", () => {
    const readings: BiomarkerReading[] = [
      { value_num: 170, unit: "mg/dL", cb: totalChol },
      { value_num: 195, unit: "mg/dL", cb: totalChol },
    ];
    const rate = optimalRangeHitRate(readings, null, null, TODAY);
    expect(rate.freshness).toEqual({ current: 0, due: 0, notApplicable: 2 });
    expect(optimalPillarDetail(rate)).toBe(
      "Tracked markers inside their optimal range"
    );
  });
});

describe("optimalTone never paints an old-only panel green", () => {
  it("an all-current favorable panel still reads good", () => {
    const rate = optimalRangeHitRate(
      [lab(170, 10), lab(175, 10), lab(170, 10), lab(175, 10), lab(195, 10)],
      null,
      null,
      TODAY
    );
    expect(rate.optimal / rate.total).toBeGreaterThanOrEqual(0.8);
    expect(optimalTone(rate)).toBe("good");
  });

  it("the SAME favorable ratio measured years ago is neutral, not good", () => {
    const rate = optimalRangeHitRate(
      [
        lab(170, 900),
        lab(175, 900),
        lab(170, 900),
        lab(175, 900),
        lab(195, 900),
      ],
      null,
      null,
      TODAY
    );
    expect(rate.optimal / rate.total).toBeGreaterThanOrEqual(0.8);
    expect(optimalTone(rate)).toBe("neutral");
  });

  it("one current reading is enough to judge the share again", () => {
    const rate = optimalRangeHitRate(
      [lab(170, 10), lab(175, 900), lab(170, 900), lab(175, 900), lab(195, 900)],
      null,
      null,
      TODAY
    );
    expect(optimalTone(rate)).toBe("good");
  });

  it("unknown freshness keeps the pre-#2023 tone (no dates ⇒ no claim either way)", () => {
    expect(optimalTone(bareOptimalHitRate(31, 38))).toBe("good");
    expect(optimalTone(bareOptimalHitRate(0, 0))).toBe("neutral");
  });

  it("a changing denominator moves the share but not the marker verdicts", () => {
    const two = optimalRangeHitRate([lab(170, 10), lab(195, 10)], null, null, TODAY);
    const four = optimalRangeHitRate(
      [lab(170, 10), lab(195, 10), lab(170, 10), lab(170, 10)],
      null,
      null,
      TODAY
    );
    expect(two.optimal).toBe(1);
    expect(four.optimal).toBe(3);
    // The share moved without any tracked marker improving — which is exactly why the
    // denominator and its coverage band stay first-class in the model.
    expect(two.optimal / two.total).not.toBe(four.optimal / four.total);
    expect(two.total).toBe(2);
    expect(four.total).toBe(4);
  });
});

describe("expanded rows reconcile exactly with the pillar counts", () => {
  const readings = [
    lab(170, 10, "A"),
    lab(175, 900, "B"),
    lab(195, 20, "C"),
    { ...lab(5, 10, "D"), cb: null },
  ];

  it("row count equals the judged denominator and stale rows equal the stale count", () => {
    const rate = optimalRangeHitRate(readings, null, null, TODAY);
    const rows = optimalShareRows(readings, null, null, TODAY);
    expect(rows.length).toBe(rate.total);
    expect(rows.filter((r) => r.badge === "optimal").length).toBe(rate.optimal);
    expect(rows.filter((r) => r.freshness === "due").length).toBe(
      rate.freshness.due
    );
    expect(rows.filter((r) => r.freshness === "current").length).toBe(
      rate.freshness.current
    );
  });

  it("every row carries its own effective reading date", () => {
    const rows = optimalShareRows(readings, null, null, TODAY);
    for (const r of rows) expect(r.date).toMatch(/^\d{4}-\d{2}-\d{2}$/);
  });
});

describe("the pillar renders the enriched detail", () => {
  it("an old-only pillar states it is based on older results and makes no judgment", () => {
    const rate = optimalRangeHitRate([lab(170, 900), lab(175, 900)], null, null, TODAY);
    const [pillar] = buildPillars({ optimal: rate });
    expect(pillar.value).toBe("2 of 2");
    expect(pillar.tone).toBe("neutral");
    expect(pillar.detail).toContain("older results");
  });

  it("a current pillar names the panel size", () => {
    const rate = optimalRangeHitRate([lab(170, 10), lab(175, 10)], null, null, TODAY);
    const [pillar] = buildPillars({ optimal: rate });
    expect(pillar.detail).toContain("2 markers");
    expect(pillar.detail).toContain("all current");
  });
});
