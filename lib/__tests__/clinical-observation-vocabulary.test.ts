import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";
import {
  READINGS_LIST_HREF,
  readingAddHref,
  readingDetailHref,
} from "@/lib/hrefs";
import { savedRefFromSeriesKey } from "@/lib/saved-items";

const ROOT = path.resolve(fileURLToPath(new URL("../..", import.meta.url)));
const read = (...parts: string[]) =>
  fs.readFileSync(path.join(ROOT, ...parts), "utf8");

function productionTypeScriptFiles(dir: string): string[] {
  return fs.readdirSync(dir, { withFileTypes: true }).flatMap((entry) => {
    if (entry.name.startsWith("__")) return [];
    const full = path.join(dir, entry.name);
    if (entry.isDirectory()) return productionTypeScriptFiles(full);
    return /\.tsx?$/.test(entry.name) ? [full] : [];
  });
}

describe("clinical observation vocabulary (#2482)", () => {
  it("exposes observation/result APIs instead of calling one row a medical record", () => {
    const types = read("lib", "types", "medical.ts");
    const queries = read("lib", "queries", "medical.ts");
    const actions = read("app", "(app)", "results", "reading-actions.ts");

    expect(types).toContain("interface ClinicalObservation");
    expect(types).not.toMatch(/interface MedicalRecord\b/);
    expect(queries).toContain("function getClinicalObservations(");
    expect(queries).not.toMatch(/function getMedicalRecords\b/);
    expect(actions).toContain("function addResult(");
    expect(actions).not.toMatch(/function (?:add|update|delete)Record\b/);
  });

  it("keeps the import boundary on clinical-observation vocabulary", () => {
    const healthImport = read("lib", "health-import.ts");
    const importShape = read("lib", "import-shape.ts");
    expect(healthImport).toContain("interface ImportedClinicalObservation");
    expect(healthImport).toContain(
      "observations: ImportedClinicalObservation[]"
    );
    expect(importShape).toContain("interface PersistClinicalObservation");
    expect(importShape).toContain("observations: PersistClinicalObservation[]");

    const banned = /\b(?:ImportedRecord|PersistRecord)\b/;
    const offenders = productionTypeScriptFiles(path.join(ROOT, "lib"))
      .filter((file) => banned.test(fs.readFileSync(file, "utf8")))
      .map((file) => path.relative(ROOT, file));
    expect(offenders).toEqual([]);
  });

  it("keeps list and episodic detail links in one canonical route family", () => {
    expect(READINGS_LIST_HREF).toBe("/results/readings");
    expect(readingAddHref("LDL Cholesterol")).toBe(
      "/results/readings?new=1&name=LDL%20Cholesterol"
    );
    expect(readingDetailHref("LDL Cholesterol")).toBe(
      "/results/readings/view?name=LDL%20Cholesterol"
    );

    expect(
      fs.existsSync(
        path.join(ROOT, "app", "(app)", "results", "biomarkers", "page.tsx")
      )
    ).toBe(true);
    expect(
      fs.existsSync(
        path.join(ROOT, "app", "(app)", "biomarkers", "view", "page.tsx")
      )
    ).toBe(true);
  });

  it("preserves the stored saved-item vocabulary across the route rename", () => {
    expect(savedRefFromSeriesKey("bio:LDL Cholesterol")).toEqual({
      kind: "biomarker",
      key: "LDL Cholesterol",
    });
  });
});
