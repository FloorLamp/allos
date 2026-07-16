import { describe, expect, it } from "vitest";
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { buildScreenings } from "@/scripts/gen-screenings";
import screeningsJson from "@/lib/datasets/data/screenings.json";
import {
  PREVENTIVE_CATALOG,
  SCREENINGS_REVIEWED,
  preventiveRuleByKey,
} from "@/lib/preventive-catalog";

// Anti-drift pins for the baked USPSTF screening dataset (issue #149): the
// committed lib/screenings.json must be a FIXED POINT of the generator, every row
// must be well-formed, and the rows must reconstruct into the catalog's screening
// rules 1:1 (so the baked data is the LIVE source, never dead parallel data).
// Pure — reads the generator + committed JSON + catalog, no DB.

const REPO = path.resolve(fileURLToPath(new URL("../..", import.meta.url)));
const OUT = path.join(REPO, "lib/datasets/data/screenings.json");

// Concrete row type so the JSON import's per-row union doesn't trip optional-field
// access (sex/intervalMonths are present on only some rows).
interface Row {
  key: string;
  name: string;
  description: string;
  sex?: string;
  graceMonths: number;
  riskGated?: boolean;
  bmiGated?: boolean;
  citation: { source: string; summary: string; grade?: string };
  schedule: { startMonths: number; endMonths: number; intervalMonths?: number };
}
const ROWS = screeningsJson.entries as unknown as Row[];

describe("screenings.json dataset", () => {
  it("is a fixed point of buildScreenings() (regenerate with `npm run gen:screenings`)", () => {
    const generated = JSON.stringify(buildScreenings(), null, 2) + "\n";
    const committed = fs.readFileSync(OUT, "utf8");
    expect(committed).toBe(generated);
  });

  it("carries the core USPSTF grade A/B screening set, with depression/anxiety/HIV/hep-B added", () => {
    const keys = ROWS.map((s) => s.key).sort();
    expect(keys).toEqual(
      [
        "aaa_ultrasound",
        "anxiety_screening",
        "blood_pressure",
        "cervical_cancer",
        "colorectal_cancer",
        "depression_screening",
        "diabetes_screening",
        "hepatitis_b",
        "hepatitis_c",
        "hiv_screening",
        "lipid_screening",
        "lung_cancer_ldct",
        "mammography",
        "osteoporosis",
      ].sort()
    );
  });

  it("has unique keys and a well-formed citation + schedule per row", () => {
    const keys = ROWS.map((s) => s.key);
    expect(new Set(keys).size).toBe(keys.length);
    expect(SCREENINGS_REVIEWED).toMatch(/^\d{4}-\d{2}$/);
    expect(screeningsJson.meta.reviewed).toBe(SCREENINGS_REVIEWED);
    for (const s of ROWS) {
      expect(s.name, s.key).toBeTruthy();
      expect(s.description, s.key).toBeTruthy();
      expect(s.citation.source, s.key).toBe("USPSTF");
      expect(s.citation.summary, s.key).toBeTruthy();
      expect(s.graceMonths, s.key).toBeGreaterThan(0);
      // Age window is a positive, ascending month range.
      expect(s.schedule.startMonths, s.key).toBeGreaterThan(0);
      expect(s.schedule.endMonths, s.key).toBeGreaterThan(
        s.schedule.startMonths
      );
      if (s.schedule.intervalMonths != null) {
        expect(s.schedule.intervalMonths, s.key).toBeGreaterThan(0);
      }
      if ("sex" in s && s.sex != null) {
        expect(["male", "female"]).toContain(s.sex);
      }
    }
  });

  it("reconstructs into the catalog's screening rules 1:1 (baked data is the live source)", () => {
    const catalogScreeningKeys = PREVENTIVE_CATALOG.filter(
      (r) => r.kind === "screening"
    )
      .map((r) => r.key)
      .sort();
    expect(catalogScreeningKeys).toEqual(ROWS.map((s) => s.key).sort());
    // Each baked row's data is faithfully carried onto the catalog rule, with the
    // constant kind/schedule.type discriminants and dataset `reviewed` re-attached.
    for (const s of ROWS) {
      const rule = preventiveRuleByKey(s.key);
      expect(rule, s.key).toBeTruthy();
      expect(rule!.kind).toBe("screening");
      expect(rule!.citation.reviewed).toBe(screeningsJson.meta.reviewed);
      expect(rule!.citation.grade).toBe(s.citation.grade);
      if (rule!.schedule.type === "screening") {
        expect(rule!.schedule.startMonths).toBe(s.schedule.startMonths);
        expect(rule!.schedule.endMonths).toBe(s.schedule.endMonths);
      }
    }
  });

  it("keeps depression screening open to adolescents+adults on an annual cadence", () => {
    const dep = ROWS.find((s) => s.key === "depression_screening")!;
    expect(dep.sex).toBeUndefined(); // all sexes
    expect(dep.schedule.startMonths).toBe(12 * 12); // from age 12
    expect(dep.schedule.intervalMonths).toBe(12);
    expect(dep.citation.grade).toBe("B");
  });

  it("adds anxiety screening for ages 8–64 (grade B, ≥65 excluded), annual cadence", () => {
    const anx = ROWS.find((s) => s.key === "anxiety_screening")!;
    expect(anx.sex).toBeUndefined();
    expect(anx.schedule.startMonths).toBe(8 * 12); // from age 8
    expect(anx.schedule.endMonths).toBe(65 * 12); // through 64 (≥65 is an I statement)
    expect(anx.schedule.intervalMonths).toBe(12);
    expect(anx.citation.grade).toBe("B");
    expect(anx.riskGated).toBeFalsy();
  });

  it("adds one-time HIV screening for ages 15–65 (grade A, universal, not risk-gated)", () => {
    const hiv = ROWS.find((s) => s.key === "hiv_screening")!;
    expect(hiv.sex).toBeUndefined();
    expect(hiv.schedule.startMonths).toBe(15 * 12);
    expect(hiv.schedule.endMonths).toBe(65 * 12);
    expect(hiv.schedule.intervalMonths).toBeUndefined(); // once-in-window
    expect(hiv.citation.grade).toBe("A");
    expect(hiv.riskGated).toBeFalsy();
  });

  it("ships hepatitis B risk-gated (risk-defined population, inert until an input exists)", () => {
    const hbv = ROWS.find((s) => s.key === "hepatitis_b")!;
    expect(hbv.riskGated).toBe(true);
    expect(hbv.schedule.intervalMonths).toBeUndefined(); // once-in-window
    expect(hbv.citation.grade).toBe("B");
  });

  it("aligns lipid screening to the honest 40–75 statin-prevention band", () => {
    const lipid = ROWS.find((s) => s.key === "lipid_screening")!;
    expect(lipid.schedule.startMonths).toBe(40 * 12); // from 40, not 35
    expect(lipid.schedule.endMonths).toBe(76 * 12); // through 75
  });
});
