import { describe, expect, it } from "vitest";
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { buildBpPercentiles } from "@/scripts/gen-bp-percentiles";
import {
  bpPercentilesDataset,
  bpPercentileKeyStrategy,
  BP_SEXES_MAP,
  BP_META,
} from "@/lib/datasets/bp-percentiles";
import {
  citationPresent,
  identityResolves,
  refusalGate,
  noKeyCollisions,
  runHarness,
} from "@/lib/datasets";
import { BP_PERCENTILE_SOURCE } from "@/lib/bp-percentiles";

// Anti-drift + framework-contract pins for the baked pediatric BP dataset (issue #150,
// migrated onto the curated-dataset framework in #860 Track B — the second nested numeric
// dataset, meta + one entry per normative row). The committed lib/datasets/data JSON must
// be a FIXED POINT of the generator, pass the framework harness (citation / identity /
// refusal / no-collisions), and the AAP 2017 normative grid must be COMPLETE, INTERNALLY
// MONOTONE, and UNCHANGED (values verbatim from Tables 3 & 4). Pure — reads the generator
// + committed JSON, no DB.

const REPO = path.resolve(fileURLToPath(new URL("../..", import.meta.url)));
const OUT = path.join(REPO, "lib/datasets/data/bp-percentiles.json");

describe("bp-percentiles.json dataset", () => {
  it("is a fixed point of buildBpPercentiles() (regenerate with `npm run gen:bp-percentiles`)", () => {
    const generated = JSON.stringify(buildBpPercentiles(), null, 2) + "\n";
    const committed = fs.readFileSync(OUT, "utf8");
    expect(committed).toBe(generated);
  });

  it("passes the framework harness (citation / identity key / refusal / no collisions)", () => {
    const r = runHarness(bpPercentilesDataset, bpPercentileKeyStrategy);
    expect(r.ok, r.problems.join("; ")).toBe(true);
  });

  it("carries a dataset citation with the AAP 2017 source", () => {
    expect(citationPresent(bpPercentilesDataset).problems).toEqual([]);
    expect(bpPercentilesDataset.citation[0].source).toMatch(/AAP|Flynn/);
    // The per-sex-lookup source string (meta) matches the dataset citation.
    expect(BP_PERCENTILE_SOURCE).toBe(BP_META.source);
  });

  it("resolves every normative row by its own composite key, with no collisions", () => {
    expect(
      identityResolves(bpPercentilesDataset, bpPercentileKeyStrategy).problems
    ).toEqual([]);
    expect(
      noKeyCollisions(bpPercentilesDataset, bpPercentileKeyStrategy).problems
    ).toEqual([]);
  });

  it("refuses an absent row key (returns null — never a guess)", () => {
    expect(
      refusalGate(bpPercentilesDataset, bpPercentileKeyStrategy, [
        "male:99:50",
        "",
      ]).problems
    ).toEqual([]);
  });

  it("carries the height/BP grids and age window in meta", () => {
    expect(BP_META.heightPercentiles).toEqual([5, 10, 25, 50, 75, 90, 95]);
    expect(BP_META.bpPercentiles).toEqual([50, 90, 95]);
    expect(BP_META.minAge).toBe(1);
    expect(BP_META.maxAge).toBe(17);
  });

  it("covers ages 1-17 × {50,90,95} for both sexes with 7-wide height vectors", () => {
    for (const sex of ["male", "female"] as const) {
      const rows = BP_SEXES_MAP[sex];
      expect(rows.length, sex).toBe(17 * 3);
      for (let age = 1; age <= 17; age++) {
        for (const pct of [50, 90, 95]) {
          const r = rows.find((x) => x.age === age && x.pct === pct);
          expect(r, `${sex} age ${age} pct ${pct}`).toBeTruthy();
          expect(r!.sbp.length).toBe(7);
          expect(r!.dbp.length).toBe(7);
        }
      }
    }
  });

  it("has BP rising with percentile (50<90<95) at every age/height/component", () => {
    for (const sex of ["male", "female"] as const) {
      const rows = BP_SEXES_MAP[sex];
      for (let age = 1; age <= 17; age++) {
        const r = (pct: number) =>
          rows.find((x) => x.age === age && x.pct === pct)!;
        for (let h = 0; h < 7; h++) {
          for (const k of ["sbp", "dbp"] as const) {
            expect(r(50)[k][h], `${sex} age${age} ${k} h${h}`).toBeLessThan(
              r(90)[k][h]
            );
            expect(r(90)[k][h]).toBeLessThanOrEqual(r(95)[k][h]);
          }
        }
      }
    }
  });

  it("keeps the AAP 2017 boys age-1 50th-percentile row VERBATIM (never altered)", () => {
    // Table 3, boys, age 1, 50th BP percentile — systolic & diastolic across the 7
    // height columns. A value guard on the published anchor.
    const r = BP_SEXES_MAP.male.find((x) => x.age === 1 && x.pct === 50)!;
    expect(r.sbp).toEqual([85, 85, 86, 86, 87, 88, 88]);
    expect(r.dbp).toEqual([40, 40, 40, 41, 41, 42, 42]);
  });
});
