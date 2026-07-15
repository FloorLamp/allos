import { describe, expect, it } from "vitest";
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import {
  buildContrastDataset,
  normalizeKeyword,
} from "@/scripts/gen-contrast-safety";
import dataset from "@/lib/contrast-safety.json";

// Anti-drift pins for the baked contrast-safety dataset (issue #701): the committed
// lib/contrast-safety.json must be a FIXED POINT of the generator, both classes +
// both gate kinds present, keyword lists normalized + distinct, and every note cited
// to the ACR. Pure — reads the generator constants + the committed JSON.

const REPO = path.resolve(fileURLToPath(new URL("../..", import.meta.url)));
const OUT = path.join(REPO, "lib/contrast-safety.json");

const CLASSES = new Set(["iodinated", "gadolinium"]);
const LEVELS = new Set(["any", "advanced"]);

describe("contrast-safety.json dataset", () => {
  it("is a fixed point of buildContrastDataset() (regenerate with `npm run gen:contrast-safety`)", () => {
    const generated = JSON.stringify(buildContrastDataset(), null, 2) + "\n";
    const committed = fs.readFileSync(OUT, "utf8");
    expect(committed).toBe(generated);
  });

  it("covers both contrast classes with modalities + agents", () => {
    expect(dataset.classes.map((c) => c.class).sort()).toEqual([
      "gadolinium",
      "iodinated",
    ]);
    for (const c of dataset.classes) {
      expect(CLASSES.has(c.class), c.class).toBe(true);
      expect(c.label.trim().length).toBeGreaterThan(0);
      expect(c.modalities.length).toBeGreaterThan(0);
      expect(c.agents.length).toBeGreaterThan(0);
    }
  });

  it("keeps every keyword normalized + distinct", () => {
    for (const c of dataset.classes) {
      for (const kw of [...c.modalities, ...c.agents]) {
        expect(kw, kw).toBe(normalizeKeyword(kw));
      }
      expect(new Set(c.modalities).size).toBe(c.modalities.length);
      expect(new Set(c.agents).size).toBe(c.agents.length);
    }
  });

  it("has an allergy gate per class with the required framing", () => {
    const byClass = new Map(dataset.allergyGates.map((g) => [g.class, g]));
    expect(byClass.get("iodinated")!.note).toBe(
      "You have an iodinated-contrast allergy on file — confirm premedication with your provider."
    );
    expect(byClass.get("gadolinium")!.note).toContain(
      "gadolinium-contrast allergy"
    );
    for (const g of dataset.allergyGates) {
      expect(CLASSES.has(g.class), g.class).toBe(true);
      expect(g.allergens.length).toBeGreaterThan(0);
      for (const a of g.allergens) expect(a).toBe(normalizeKeyword(a));
    }
  });

  it("has an iodinated 'any-CKD' + a gadolinium 'advanced-CKD' renal gate", () => {
    const iod = dataset.renalGates.find((g) => g.class === "iodinated")!;
    const gad = dataset.renalGates.find((g) => g.class === "gadolinium")!;
    expect(iod.level).toBe("any");
    expect(iod.note).toBe(
      "CKD on file — discuss contrast nephropathy risk / hydration with your provider."
    );
    expect(gad.level).toBe("advanced");
    expect(gad.note).toContain("NSF");
    for (const g of dataset.renalGates) expect(LEVELS.has(g.level)).toBe(true);
  });

  it("cites the ACR Manual on every gate (the source discipline)", () => {
    for (const g of [...dataset.allergyGates, ...dataset.renalGates]) {
      expect(/ACR/.test(g.source), g.source).toBe(true);
    }
  });

  it("is emitted sorted for a stable diff", () => {
    const classKeys = dataset.classes.map((c) => c.class);
    expect(classKeys).toEqual([...classKeys].sort());
  });
});
