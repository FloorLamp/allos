import { describe, expect, it } from "vitest";
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { buildRadiationDoseDataset } from "@/scripts/gen-radiation-dose";
import {
  radiationDoseDataset,
  radiationDoseKeyStrategy,
} from "@/lib/datasets/radiation-dose";
import { runHarness } from "@/lib/datasets";

// Anti-drift + framework-contract pins for the baked typical-radiation-dose dataset
// (issue #703): the committed lib/datasets/data/radiation-dose.json must be a FIXED
// POINT of the generator, every entry on our modality enum with sane non-negative
// doses, and the envelope must pass the framework harness (citation / key identity /
// refusal / no collisions). Pure.

const REPO = path.resolve(fileURLToPath(new URL("../..", import.meta.url)));
const OUT = path.join(REPO, "lib/datasets/data/radiation-dose.json");

const MODALITIES = new Set([
  "x-ray",
  "ct",
  "mri",
  "ultrasound",
  "dexa",
  "pet",
  "nuclear-medicine",
  "fluoroscopy",
  "other",
]);

describe("radiation-dose.json dataset", () => {
  it("is a fixed point of buildRadiationDoseDataset() (regenerate with `npm run gen:radiation-dose`)", () => {
    const generated =
      JSON.stringify(buildRadiationDoseDataset(), null, 2) + "\n";
    const committed = fs.readFileSync(OUT, "utf8");
    expect(committed).toBe(generated);
  });

  it("passes the framework harness (citation / key identity / refusal / no collisions)", () => {
    const r = runHarness(radiationDoseDataset, radiationDoseKeyStrategy);
    expect(r.ok, r.problems.join("; ")).toBe(true);
  });

  it("every entry is on the modality enum with a finite, non-negative dose", () => {
    for (const e of radiationDoseDataset.entries) {
      expect(MODALITIES.has(e.modality), `${e.key}: bad modality`).toBe(true);
      expect(Number.isFinite(e.msv), `${e.key}: non-finite msv`).toBe(true);
      expect(e.msv, `${e.key}: negative msv`).toBeGreaterThanOrEqual(0);
      expect(e.source.length, `${e.key}: missing source`).toBeGreaterThan(0);
    }
  });

  it("non-ionizing modalities are 0 by physics", () => {
    for (const e of radiationDoseDataset.entries) {
      if (e.modality === "mri" || e.modality === "ultrasound") {
        expect(e.msv, `${e.key}: non-ionizing must be 0`).toBe(0);
      }
    }
  });

  it("every ionizing modality has a generic (empty-regions) fallback entry", () => {
    for (const m of [
      "x-ray",
      "ct",
      "dexa",
      "pet",
      "nuclear-medicine",
      "fluoroscopy",
    ]) {
      const hasGeneric = radiationDoseDataset.entries.some(
        (e) => e.modality === m && e.regions.length === 0
      );
      expect(hasGeneric, `${m}: no generic fallback`).toBe(true);
    }
  });

  it("carries a natural-background comparator in meta (for calm framing only)", () => {
    expect(
      radiationDoseDataset.meta?.naturalBackgroundMsvPerYear
    ).toBeGreaterThan(0);
  });
});
