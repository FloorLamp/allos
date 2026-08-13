import { describe, expect, it } from "vitest";
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import {
  BIO_CONTINUITY_DAYS,
  METRIC_CONTINUITY_DAYS,
  METRIC_GAP,
  continuityDaysForSeriesKey,
  medianIntervalDays,
  sparseSeriesCaption,
  sparseSeriesVerdict,
} from "../trend-sparkline";
import { TREND_METRIC_PRESENTATION_FLOORS } from "../trend-metric-freshness";
import {
  TREND_METRIC_SLUGS,
  savedMetricIdForTrendSlug,
} from "../trend-metrics";

// THE DENSITY FLOOR (issue #2653, state 5).
//
// Three readings over three years plot as the same confident 2px stroke a series
// measured every morning gets. This file guards the decision that stops that, and
// — just as hard — the two ways the fix could itself become a lie:
//
//   • by demoting a series that is DENSE WITH AN OUTAGE, which is a different
//     state of the same issue and must not be relabelled as this one; and
//   • by DECORATING. A state treatment that makes the chart look more considered
//     buys the thin line more trust than it had before. The demotion must be a
//     demotion on every axis, which is the inequality pinned at the bottom.

const REPO = path.resolve(fileURLToPath(new URL("../..", import.meta.url)));

// A dated series `n` readings long with a fixed interval, starting at `start`.
function everyNDays(start: string, gap: number, n: number) {
  const out: { date: string; value: number | null }[] = [];
  let t = Date.parse(`${start}T00:00:00Z`);
  for (let i = 0; i < n; i++) {
    out.push({ date: new Date(t).toISOString().slice(0, 10), value: 70 + i });
    t += gap * 86400000;
  }
  return out;
}

describe("medianIntervalDays", () => {
  it("is the middle gap, not the mean — one huge gap does not move it", () => {
    // Four daily readings then a two-year silence: mean interval is ~183 days,
    // median is 1. The distinction is the whole reason this uses a median.
    expect(
      medianIntervalDays([
        "2026-01-01",
        "2026-01-02",
        "2026-01-03",
        "2026-01-04",
        "2028-01-04",
      ])
    ).toBe(1);
  });

  it("sorts its input rather than trusting the caller", () => {
    expect(medianIntervalDays(["2026-03-01", "2026-01-01", "2026-02-01"])).toBe(
      28
    );
  });

  it("takes the lower middle gap on an even count", () => {
    // Gaps of 2 and 10 → the lower of the two middles.
    expect(medianIntervalDays(["2026-01-01", "2026-01-03", "2026-01-13"])).toBe(
      2
    );
  });

  it("is null below two datable readings", () => {
    expect(medianIntervalDays([])).toBeNull();
    expect(medianIntervalDays(["2026-01-01"])).toBeNull();
    expect(medianIntervalDays(["nonsense", "2026-01-01"])).toBeNull();
  });
});

describe("continuityDaysForSeriesKey", () => {
  it("answers a registered metric from the registry", () => {
    expect(continuityDaysForSeriesKey("metric:weight")).toBe(60);
    expect(continuityDaysForSeriesKey("metric:temperature")).toBe(30);
    expect(continuityDaysForSeriesKey("metric:steps")).toBe(14);
    expect(continuityDaysForSeriesKey("metric:height")).toBe(730);
    expect(continuityDaysForSeriesKey("metric:systolic")).toBe(365);
  });

  it("answers the whole bio: namespace with one number", () => {
    expect(continuityDaysForSeriesKey("bio:ApoB")).toBe(BIO_CONTINUITY_DAYS);
    expect(continuityDaysForSeriesKey("bio:LDL Cholesterol")).toBe(540);
  });

  it("declines an unregistered id and an unknown namespace", () => {
    // Null means "draw it exactly as before" — never a guessed span.
    expect(continuityDaysForSeriesKey("metric:not-a-metric")).toBeNull();
    expect(continuityDaysForSeriesKey("cycle:length")).toBeNull();
    expect(continuityDaysForSeriesKey("")).toBeNull();
  });
});

describe("sparseSeriesVerdict", () => {
  it("demotes three weigh-ins spread over three years", () => {
    const v = sparseSeriesVerdict(
      "metric:weight",
      everyNDays("2023-01-01", 500, 3)
    );
    expect(v).toEqual({
      readings: 3,
      spanDays: 1001,
      medianGapDays: 500,
      continuityDays: 60,
    });
  });

  it("leaves a DENSE series with one long outage alone (#2653 states 3/4)", () => {
    // Ten daily weigh-ins, then three years of silence, then one more. The MEAN
    // interval here is ~110 days — comfortably past weight's 60-day span, so a
    // mean or a rate would demote this. It is not sparse: it is a dense series
    // with an outage, which is a different state of this issue with a different
    // treatment (day-fill's kept holes), and calling it sparse would relabel the
    // one thing the reader most needs told apart.
    const dense = everyNDays("2023-01-01", 1, 10);
    dense.push({ date: "2026-01-10", value: 77 });
    expect(sparseSeriesVerdict("metric:weight", dense)).toBeNull();
  });

  it("is strictly past the declared span, never at it", () => {
    // Weight's span is 60 days. Exactly 60 apart draws its normal stroke.
    expect(
      sparseSeriesVerdict("metric:weight", everyNDays("2026-01-01", 60, 3))
    ).toBeNull();
    // Sixty-one is over.
    expect(
      sparseSeriesVerdict("metric:weight", everyNDays("2026-01-01", 61, 3))
    ).not.toBeNull();
  });

  it("counts REAL readings and ignores densified holes", () => {
    const v = sparseSeriesVerdict("metric:weight", [
      { date: "2026-01-01", value: 80 },
      { date: "2026-02-01", value: null },
      { date: "2026-03-01", value: null },
      { date: "2026-06-01", value: 78 },
    ]);
    // Two readings, 151 days apart — the two nulls are neither readings nor
    // endpoints of the span.
    expect(v).toEqual({
      readings: 2,
      spanDays: 152,
      medianGapDays: 151,
      continuityDays: 60,
    });
  });

  it("says nothing about a series with fewer than two readings", () => {
    // One reading draws no line at all — it has its own mark (`loneReading`).
    expect(
      sparseSeriesVerdict("metric:weight", [{ date: "2026-01-01", value: 80 }])
    ).toBeNull();
    expect(sparseSeriesVerdict("metric:weight", [])).toBeNull();
  });

  it("says nothing about a series that declares no span", () => {
    expect(
      sparseSeriesVerdict("cycle:length", everyNDays("2023-01-01", 500, 3))
    ).toBeNull();
  });

  it("holds a lab panel to the lab cadence, not the body cadence", () => {
    // Two draws a year apart is an ordinary panel cadence and keeps its stroke…
    expect(
      sparseSeriesVerdict("bio:ApoB", everyNDays("2024-01-01", 365, 3))
    ).toBeNull();
    // …while the same spacing on a bathroom scale is three facts, not a line.
    expect(
      sparseSeriesVerdict("metric:weight", everyNDays("2024-01-01", 365, 3))
    ).not.toBeNull();
  });
});

describe("sparseSeriesCaption", () => {
  const caption = (readings: number, spanDays: number) =>
    sparseSeriesCaption({
      readings,
      spanDays,
      medianGapDays: 999,
      continuityDays: 60,
    });

  it("states the count and the span, in the coarsest honest unit", () => {
    expect(caption(3, 1001)).toBe("3 readings in 3 years");
    expect(caption(2, 87)).toBe("2 readings in 3 months");
    expect(caption(4, 45)).toBe("4 readings in 45 days");
    expect(caption(5, 200)).toBe("5 readings in 7 months");
  });

  it("never rounds a span down to a unit that reads as one", () => {
    // 61 days is "2 months", never "1 month" — a caption that says one month
    // over a two-month span makes the series sound tighter than it is.
    expect(caption(2, 61)).toBe("2 readings in 2 months");
    // 545 days is where the phrase steps to years, and 1.5 years rounds to 1 —
    // the clamp is what stops the caption saying "1 year" over eighteen months.
    expect(caption(2, 545)).toBe("2 readings in 2 years");
    expect(caption(2, 800)).toBe("2 readings in 2 years");
  });

  it("carries no verdict word — the reader prices the stroke, not a badge", () => {
    for (const text of [caption(3, 1001), caption(2, 87), caption(4, 45)]) {
      expect(text).not.toMatch(/sparse|thin|limited|only|few|insufficient/i);
    }
  });
});

describe("registry completeness (#2653 state 5)", () => {
  it("declares a continuity span for every series that declares a gap", () => {
    const missing = Object.keys(METRIC_GAP).filter(
      (id) => METRIC_CONTINUITY_DAYS[id] == null
    );
    expect(
      missing,
      `These series declare what a missing DAY means but not how far apart two ` +
        `readings may sit before the stroke between them over-claims. Add them ` +
        `to METRIC_CONTINUITY_DAYS in lib/trend-sparkline.ts with a named ` +
        `tier:\n${missing.join(", ")}`
    ).toEqual([]);
  });

  it("declares no continuity span for a series that is not in the gap registry", () => {
    const stale = Object.keys(METRIC_CONTINUITY_DAYS).filter(
      (id) => METRIC_GAP[id] == null
    );
    expect(
      stale,
      `These METRIC_CONTINUITY_DAYS entries name no series METRIC_GAP knows ` +
        `about:\n${stale.join(", ")}`
    ).toEqual([]);
  });

  it("every registered trend metric reaches a declared span through its key", () => {
    const missing = TREND_METRIC_SLUGS.filter(
      (slug) =>
        continuityDaysForSeriesKey(
          `metric:${savedMetricIdForTrendSlug(slug)}`
        ) == null
    );
    expect(missing).toEqual([]);
  });
});

describe("the two floor registries stay consistent (#2671 × #2653)", () => {
  it("no series is called sparse while its latest reading is still current", () => {
    // The presentation floor says how old the LATEST reading may be before the
    // headline stops claiming now. If a metric's continuity span were BELOW that
    // floor, one card could demote its stroke for spacing the other registry
    // still calls current — two registries disagreeing about the same quantity.
    const conflicts: string[] = [];
    for (const slug of TREND_METRIC_SLUGS) {
      const floor = TREND_METRIC_PRESENTATION_FLOORS[slug].days;
      const span = continuityDaysForSeriesKey(
        `metric:${savedMetricIdForTrendSlug(slug)}`
      );
      if (span != null && span < floor) {
        conflicts.push(
          `${slug}: continuity ${span}d < presentation floor ${floor}d`
        );
      }
    }
    expect(conflicts).toEqual([]);
  });

  it("the invariant is actually reachable (a guard on the guard)", () => {
    // If every span were astronomically above every floor the test above would
    // pass forever without meaning anything. Pin that the two registries are in
    // the same range: at least one metric sits at or within a factor of two of
    // its own floor.
    const tight = TREND_METRIC_SLUGS.filter((slug) => {
      const floor = TREND_METRIC_PRESENTATION_FLOORS[slug].days;
      const span = continuityDaysForSeriesKey(
        `metric:${savedMetricIdForTrendSlug(slug)}`
      );
      return span != null && span <= floor * 2;
    });
    expect(tight.length).toBeGreaterThan(0);
  });
});

describe("the demotion is a demotion (#2385 deceptive success)", () => {
  // Read the scaffold as TEXT, the repo's source-scan idiom — the pure tier does
  // not import components/. The failure this guards is not a bug but a DRIFT: a
  // later pass that thickens the hint or brightens it turns the honest demotion
  // back into a confident line while every other test still passes.
  const scaffold = fs.readFileSync(
    path.join(REPO, "components/chart-scaffold.tsx"),
    "utf8"
  );

  const num = (name: string): number | null => {
    const m = scaffold.match(
      new RegExp(`export const ${name}\\s*=\\s*([0-9.]+)\\s*;`)
    );
    return m ? Number(m[1]) : null;
  };

  it("finds the constants it is meant to compare", () => {
    // A guard on the guard: a regex that stops matching would make every
    // inequality below vacuously true.
    expect(num("CHART_LINE_STROKE_WIDTH")).not.toBeNull();
    expect(num("CHART_SPARSE_STROKE_WIDTH")).not.toBeNull();
    expect(num("CHART_SPARSE_STROKE_OPACITY")).not.toBeNull();
  });

  it("the hint is thinner and fainter than the line it replaces", () => {
    expect(num("CHART_SPARSE_STROKE_WIDTH")).toBeLessThan(
      num("CHART_LINE_STROKE_WIDTH") as number
    );
    expect(num("CHART_SPARSE_STROKE_OPACITY")).toBeLessThan(1);
  });

  it("the hint's dash spends more of its length on gap than on ink", () => {
    const dash = scaffold.match(/sparse:\s*"([\d\s.]+)"/);
    expect(
      dash,
      "chartDash.sparse must stay a declared pattern"
    ).not.toBeNull();
    const [ink, gap] = (dash as RegExpMatchArray)[1].split(/\s+/).map(Number);
    expect(gap).toBeGreaterThan(ink);
  });
});
