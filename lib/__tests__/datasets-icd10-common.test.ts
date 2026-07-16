import { describe, expect, it } from "vitest";
import {
  icd10Dataset,
  icd10EntryForCode,
  icd10CodeStrategy,
  ICD10_CONDITIONS,
} from "@/lib/datasets/icd10-common";
import { citationPresent, identityResolves, refusalGate } from "@/lib/datasets";

// Framework-contract tests for the icd10-common dataset (issue #860 Track B), migrated
// onto lib/datasets/. These exercise the reusable harness assertions (citation-present,
// identity-resolves, refusal-gate) against the real loaded dataset, and pin the
// behavior-identical code lookup. Pure — no DB, no network. (Anti-drift / fixed-point +
// code-shape pins live in icd10-dataset.test.ts.)

describe("icd10-common dataset on the curated-dataset framework", () => {
  it("carries a citation with a source (CMS / NCHS)", () => {
    const r = citationPresent(icd10Dataset);
    expect(r.problems).toEqual([]);
    expect(r.ok).toBe(true);
    expect(icd10Dataset.citation[0].source).toMatch(/CMS|NCHS|ICD-10/i);
  });

  it("declares its code system in dataset meta", () => {
    expect(icd10Dataset.meta?.system).toBe("ICD-10-CM");
  });

  it("resolves every entry by its own identity (code)", () => {
    const r = identityResolves(icd10Dataset, icd10CodeStrategy);
    expect(r.problems).toEqual([]);
    expect(r.ok).toBe(true);
  });

  it("refuses an absent code (returns null — never a guess)", () => {
    const r = refusalGate(icd10Dataset, icd10CodeStrategy, [
      "Z99.999",
      "not-a-code",
      "",
    ]);
    expect(r.problems).toEqual([]);
    expect(icd10EntryForCode("Z99.999")).toBeNull();
  });

  it("resolves a known code case-insensitively (behavior-identical lookup)", () => {
    const htn = icd10EntryForCode("i10");
    expect(htn).toBeTruthy();
    expect(htn!.code).toBe("I10");
    expect(htn!.name).toMatch(/hypertension/i);
    expect(ICD10_CONDITIONS.length).toBeGreaterThan(100);
  });
});
