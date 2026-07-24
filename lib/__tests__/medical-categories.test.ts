import { describe, expect, it } from "vitest";
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import {
  MEDICAL_CATEGORIES,
  BIOMARKER_CATEGORIES,
  MEDICAL_FLAGS,
} from "@/lib/medical-categories";

// Guards against re-declaration drift (issue #305). The category enum and the
// clinical-flag whitelist live in ONE place (lib/medical-categories.ts); the
// medical write action and the AI extractor MUST import them, not re-declare
// their own literals. The failure mode this pins is silent: a category or flag
// accepted by one path but rejected by the other.

const REPO = path.resolve(fileURLToPath(new URL("../..", import.meta.url)));

describe("medical-categories: single source of truth", () => {
  it("MEDICAL_CATEGORIES is the full record enum", () => {
    expect([...MEDICAL_CATEGORIES]).toEqual([
      "vitals",
      "lab",
      "genomics",
      "biomarker",
      "scan",
      "prescription",
      // #1076 non-lab analyte classes split out of the old "has a range" bucket.
      "instrument",
      "derived",
      "reference",
      // #708 narrative diagnostic reports (micro/path report bodies).
      "report",
    ]);
  });

  it("BIOMARKER_CATEGORIES is the flat-catalog browsable set (#1076)", () => {
    // The Biomarkers browser (/results/biomarkers, a flat catalog) lists `lab` + the
    // out-of-scope `genomics`/`scan` stores, and KEEPS `vitals` (the domain vitals —
    // audiogram/IOP/acuity — have no dedicated chart home, so removing them would
    // strand them). The re-homed classes with a home — instruments, derived bio-age,
    // immutable facts — and the emptied legacy `biomarker` bucket are excluded.
    expect([...BIOMARKER_CATEGORIES]).toEqual([
      "lab",
      "vitals",
      "genomics",
      "scan",
    ]);
    for (const excluded of [
      "prescription",
      "biomarker",
      "instrument",
      "derived",
      "reference",
    ]) {
      expect(BIOMARKER_CATEGORIES as readonly string[]).not.toContain(excluded);
    }
  });

  it("MEDICAL_FLAGS is the clinical subset, excluding the derived non-optimal flags", () => {
    expect([...MEDICAL_FLAGS]).toEqual(["normal", "high", "low", "abnormal"]);
    // The "non-optimal*" variants are reconciled in code from the canonical
    // optimal band and must never be model-emitted / user-accepted.
    for (const derived of [
      "non-optimal",
      "non-optimal-high",
      "non-optimal-low",
    ]) {
      expect(MEDICAL_FLAGS as readonly string[]).not.toContain(derived);
    }
  });
});

describe("medical-categories: importers do not re-declare the enums", () => {
  const read = (rel: string) => fs.readFileSync(path.join(REPO, rel), "utf8");

  const ACTION = "app/(app)/medical/actions.ts";
  // The AI extractor was barrel-split (#597); the shared-constant import now
  // lives in the extraction constants submodule rather than the barrel.
  const EXTRACT = "lib/medical-extract/constants.ts";

  it("the medical write action imports the shared constants", () => {
    const src = read(ACTION);
    expect(src).toMatch(
      /import\s*\{[^}]*\bMEDICAL_CATEGORIES\b[^}]*\bMEDICAL_FLAGS\b[^}]*\}\s*from\s*["']@\/lib\/medical-categories["']/s
    );
    // No local re-declaration of either enum.
    expect(src).not.toMatch(/const\s+MEDICAL_CATEGORIES\s*=/);
    expect(src).not.toMatch(/const\s+MEDICAL_FLAGS\s*=/);
  });

  it("the AI extractor imports the shared constants", () => {
    const src = read(EXTRACT);
    expect(src).toMatch(
      /import\s*\{[^}]*\bMEDICAL_CATEGORIES\b[^}]*\bMEDICAL_FLAGS\b[^}]*\}\s*from\s*["']\.\.\/medical-categories["']/s
    );
    // The extractor may alias to local CATEGORIES/FLAGS names, but must not
    // build them from a fresh array literal.
    expect(src).not.toMatch(/const\s+CATEGORIES[^=]*=\s*\[/);
    expect(src).not.toMatch(/const\s+FLAGS[^=]*=\s*\[/);
  });
});
