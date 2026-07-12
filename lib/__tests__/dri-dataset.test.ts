import { describe, it, expect } from "vitest";
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { buildDriDataset } from "@/scripts/gen-dri";
import driJson from "@/lib/dri.json";
import { MATCHER_KEYS, nutrientByKey } from "@/lib/dri";

// Anti-drift pins for the baked NIH DRI dataset (issue #148): the committed
// lib/dri.json must be a FIXED POINT of the generator, every nutrient the summer's
// name→nutrient matchers reference must resolve in the dataset, and each nutrient's
// bands must be structurally sane. Pure — reads the generator + the committed JSON,
// no DB/network.

const REPO = path.resolve(fileURLToPath(new URL("../..", import.meta.url)));
const OUT = path.join(REPO, "lib/dri.json");

describe("dri.json dataset", () => {
  it("is a fixed point of buildDriDataset() (regenerate with `npm run gen:dri`)", () => {
    const generated = JSON.stringify(buildDriDataset(), null, 2) + "\n";
    const committed = fs.readFileSync(OUT, "utf8");
    expect(committed).toBe(generated);
  });

  it("resolves EVERY nutrient key the name matchers reference (anti-drift)", () => {
    const missing = MATCHER_KEYS.filter((k) => !nutrientByKey(k));
    expect(
      missing,
      `matcher keys with no dri.json nutrient: ${missing}`
    ).toEqual([]);
  });

  it("gives every nutrient a canonical unit, basis, and at least one band", () => {
    for (const n of driJson.nutrients) {
      expect(["mg", "mcg"], n.key).toContain(n.unit);
      expect(["supplemental", "total"], n.key).toContain(n.basis);
      expect(n.bands.length, n.key).toBeGreaterThan(0);
    }
  });

  it("bands are ordered, half-open, and carry a positive UL where present", () => {
    for (const n of driJson.nutrients) {
      for (const b of n.bands) {
        expect(b.min_age, n.key).toBeGreaterThanOrEqual(0);
        if (b.max_age != null)
          expect(b.max_age, n.key).toBeGreaterThan(b.min_age);
        if (b.ul != null) expect(b.ul, n.key).toBeGreaterThan(0);
        if (b.rda != null) expect(b.rda, n.key).toBeGreaterThan(0);
      }
      // Every nutrient has at least one open-ended adult band (max_age null).
      expect(
        n.bands.some((b) => b.max_age == null),
        `${n.key} has no open-ended adult band`
      ).toBe(true);
    }
  });

  it("only nutrients that carry a UL are included (the warning has something to check)", () => {
    for (const n of driJson.nutrients) {
      expect(
        n.bands.some((b) => b.ul != null),
        `${n.key} has no UL in any band`
      ).toBe(true);
    }
  });

  // The RDA-adequacy view (issue #578) consumes the RDA column. Pin that the nutrients
  // whose adequacy the /medicine view links to food sources (the #578↔#577 overlap)
  // carry a positive RDA in an adult band — so the adequacy read has something to
  // compare against, and the committed dataset can't silently drop the RDA half.
  it("the RDA-linked nutrients carry an adult RDA (the adequacy read has a target)", () => {
    for (const key of ["iron", "folate", "magnesium", "vitamin_d"]) {
      const n = nutrientByKey(key);
      expect(n, `${key} missing from dri.json`).toBeTruthy();
      const adult = n!.bands.filter((b) => b.max_age == null);
      expect(
        adult.some((b) => b.rda != null && b.rda > 0),
        `${key} has no positive adult RDA`
      ).toBe(true);
    }
  });
});
