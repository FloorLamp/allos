import { describe, expect, it } from "vitest";
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { buildGrowthCharts } from "@/scripts/gen-growth-charts";
import chartsJson from "@/lib/datasets/data/growth-charts.json";
import {
  growthChartsDataset,
  growthChartNameStrategy,
  GROWTH_CHARTS_MAP,
  GROWTH_META,
} from "@/lib/datasets/growth-charts";
import {
  citationPresent,
  identityResolves,
  refusalGate,
  noKeyCollisions,
  runHarness,
} from "@/lib/datasets";
import { chartForAge, MAX_AGE_MONTHS } from "@/lib/growth";

// Anti-drift + framework-contract pins for the pediatric growth-chart LMS dataset (issue
// #158, migrated onto the curated-dataset framework in #860 Track B — a nested numeric
// dataset that carries its dataset-level scalars in `meta` and one entry per metric). The
// committed lib/datasets/data/growth-charts.json must be a FIXED POINT of the generator,
// pass the framework harness (citation / identity / refusal / no-collisions), and the
// LMS values must be UNCHANGED (verbatim from the published WHO/CDC tables). Pure — reads
// the generator + committed JSON, no DB.

const REPO = path.resolve(fileURLToPath(new URL("../..", import.meta.url)));
const OUT = path.join(REPO, "lib/datasets/data/growth-charts.json");

describe("growth-charts.json dataset", () => {
  it("is a fixed point of buildGrowthCharts() (regenerate with `npm run gen:growth`)", () => {
    const generated = JSON.stringify(buildGrowthCharts(), null, 2) + "\n";
    const committed = fs.readFileSync(OUT, "utf8");
    expect(committed).toBe(generated);
  });

  it("passes the framework harness (citation / identity name / refusal / no collisions)", () => {
    const r = runHarness(growthChartsDataset, growthChartNameStrategy);
    expect(r.ok, r.problems.join("; ")).toBe(true);
  });

  it("carries a dataset citation with a WHO/CDC source", () => {
    expect(citationPresent(growthChartsDataset).problems).toEqual([]);
    expect(growthChartsDataset.citation[0].source).toMatch(/WHO|CDC/);
  });

  it("resolves every metric by its own name identity, with no collisions", () => {
    expect(
      identityResolves(growthChartsDataset, growthChartNameStrategy).problems
    ).toEqual([]);
    expect(
      noKeyCollisions(growthChartsDataset, growthChartNameStrategy).problems
    ).toEqual([]);
  });

  it("refuses an absent metric (returns null — never a guess)", () => {
    expect(
      refusalGate(growthChartsDataset, growthChartNameStrategy, [
        "wingspan",
        "",
      ]).problems
    ).toEqual([]);
  });

  it("declares the four metrics with their applicable WHO/CDC sources", () => {
    expect(chartsJson.entries.map((e) => e.name).sort()).toEqual([
      "bmi",
      "head_circumference",
      "height",
      "weight",
    ]);
    // BMI is CDC-only; head circumference is WHO-only; weight/height carry both.
    expect(GROWTH_CHARTS_MAP.bmi.who).toBeUndefined();
    expect(GROWTH_CHARTS_MAP.bmi.cdc).toBeTruthy();
    expect(GROWTH_CHARTS_MAP.head_circumference.cdc).toBeUndefined();
    expect(GROWTH_CHARTS_MAP.head_circumference.who).toBeTruthy();
    expect(
      GROWTH_CHARTS_MAP.weight.who && GROWTH_CHARTS_MAP.weight.cdc
    ).toBeTruthy();
  });

  it("carries the dataset-level scalars in meta", () => {
    expect(GROWTH_META.whoCdcTransitionMonths).toBe(24);
    expect(GROWTH_META.maxAgeMonths).toBe(240);
    expect(GROWTH_META.bandPercentiles).toEqual([
      3, 5, 10, 25, 50, 75, 90, 95, 97,
    ]);
    expect(MAX_AGE_MONTHS).toBe(GROWTH_META.maxAgeMonths);
  });

  it("keeps the WHO weight-for-age BOYS birth LMS row VERBATIM (never altered)", () => {
    // The published anchor pinned in the generator header — a value guard.
    const chart = chartForAge("male", 0, "weight");
    expect(chart?.source).toBe("who");
    expect(chart?.rows[0]).toEqual([0, 0.3487, 3.3464, 0.14602]);
  });

  it("gives every metric/source ascending age rows of [age, L, M, S]", () => {
    for (const [name, sources] of Object.entries(GROWTH_CHARTS_MAP)) {
      for (const source of ["who", "cdc"] as const) {
        const sr = sources[source];
        if (!sr) continue;
        for (const sex of ["male", "female"] as const) {
          const rows = sr[sex];
          expect(rows.length, `${name}/${source}/${sex}`).toBeGreaterThan(0);
          for (let i = 0; i < rows.length; i++) {
            expect(rows[i].length, `${name}/${source}/${sex} row ${i}`).toBe(4);
            if (i > 0) {
              expect(
                rows[i][0],
                `${name}/${source}/${sex} age order`
              ).toBeGreaterThan(rows[i - 1][0]);
            }
          }
        }
      }
    }
  });
});
