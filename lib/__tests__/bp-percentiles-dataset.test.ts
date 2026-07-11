import { describe, expect, it } from "vitest";
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { buildBpPercentiles } from "@/scripts/gen-bp-percentiles";
import bpJson from "@/lib/bp-percentiles.json";

// Anti-drift pins for the baked pediatric BP dataset (issue #150): the committed
// lib/bp-percentiles.json must be a FIXED POINT of the generator, and the AAP 2017
// normative grid must be complete and internally monotone. Pure — reads the
// generator + committed JSON, no DB.

const REPO = path.resolve(fileURLToPath(new URL("../..", import.meta.url)));
const OUT = path.join(REPO, "lib/bp-percentiles.json");

describe("bp-percentiles.json dataset", () => {
  it("is a fixed point of buildBpPercentiles() (regenerate with `npm run gen:bp-percentiles`)", () => {
    const generated = JSON.stringify(buildBpPercentiles(), null, 2) + "\n";
    const committed = fs.readFileSync(OUT, "utf8");
    expect(committed).toBe(generated);
  });

  it("covers ages 1-17 × {50,90,95} for both sexes with 7-wide height vectors", () => {
    expect(bpJson.heightPercentiles).toEqual([5, 10, 25, 50, 75, 90, 95]);
    expect(bpJson.bpPercentiles).toEqual([50, 90, 95]);
    for (const sex of ["male", "female"] as const) {
      const rows = bpJson.sexes[sex];
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
      const rows = bpJson.sexes[sex];
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
});
