import { describe, expect, it } from "vitest";
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { buildIcd10Dataset } from "@/scripts/gen-icd10";
import icd10 from "@/lib/icd10-common.json";

// Anti-drift pins for the baked ICD-10-CM common-conditions map (issue #155): the
// committed lib/icd10-common.json must be a FIXED POINT of the generator, codes must
// be unique + well-shaped ICD-10-CM, and every entry must carry a display name. Pure
// — reads the generator constants + the committed JSON, no DB/network.

const REPO = path.resolve(fileURLToPath(new URL("../..", import.meta.url)));
const OUT = path.join(REPO, "lib/icd10-common.json");

// ICD-10-CM tabular code: a letter, two alphanumerics, optionally a dot then up to
// four more alphanumerics (e.g. I10, J45.909, F17.210, C50.919).
const ICD10_CODE = /^[A-Z][0-9A-Z][0-9A-Z](\.[0-9A-Z]{1,4})?$/;

describe("icd10-common.json dataset", () => {
  it("is a fixed point of buildIcd10Dataset() (regenerate with `npm run gen:icd10`)", () => {
    const generated = JSON.stringify(buildIcd10Dataset(), null, 2) + "\n";
    const committed = fs.readFileSync(OUT, "utf8");
    expect(committed).toBe(generated);
  });

  it("declares ICD-10-CM as its code system", () => {
    expect(icd10.system).toBe("ICD-10-CM");
  });

  it("carries a curated common subset (over a hundred, well under the full set)", () => {
    expect(icd10.conditions.length).toBeGreaterThan(100);
    expect(icd10.conditions.length).toBeLessThan(2000);
  });

  it("gives every entry a unique, well-shaped ICD-10-CM code and a display name", () => {
    const codes = new Set<string>();
    for (const c of icd10.conditions) {
      expect(c.code, c.code).toMatch(ICD10_CODE);
      expect(codes.has(c.code), `duplicate ${c.code}`).toBe(false);
      codes.add(c.code);
      expect(c.name.trim().length, c.code).toBeGreaterThan(0);
      expect(Array.isArray(c.synonyms), c.code).toBe(true);
    }
  });

  it("keeps synonyms lowercased and distinct from the name", () => {
    for (const c of icd10.conditions) {
      const nameLower = c.name.toLowerCase();
      for (const s of c.synonyms) {
        expect(s, c.code).toBe(s.toLowerCase());
        expect(s, c.code).not.toBe(nameLower);
      }
      expect(new Set(c.synonyms).size, c.code).toBe(c.synonyms.length);
    }
  });

  it("is emitted sorted by code for a stable diff", () => {
    const codes = icd10.conditions.map((c) => c.code);
    const sorted = [...codes].sort((a, b) => a.localeCompare(b));
    expect(codes).toEqual(sorted);
  });
});
