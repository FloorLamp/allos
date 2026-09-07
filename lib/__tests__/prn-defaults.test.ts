import { describe, it, expect } from "vitest";
import {
  prnDefaultEntries,
  prnDefaultsFor,
  isAntipyreticIntakeItem,
} from "@/lib/prn-defaults";
import {
  prnDefaultsDataset,
  prnDefaultSlugStrategy,
} from "@/lib/datasets/prn-defaults";
import { runHarness } from "@/lib/datasets";

// Dataset + framework-contract test for the curated OTC PRN defaults (#798, migrated
// onto the curated-dataset framework in #860 wave 2) — the medication-info /
// food-drug-interactions treatment: every entry is cited, the matcher works by RxNorm
// ingredient CUI AND name fallback, and — the load-bearing safety invariant — ASPIRIN
// structurally has NO pediatric entry (Reye's syndrome). Plus the framework harness
// (citation / slug identity / refusal / no-collisions).

describe("prn-defaults dataset", () => {
  const entries = prnDefaultEntries();

  it("passes the framework harness (citation / slug identity / refusal / no collisions)", () => {
    const r = runHarness(prnDefaultsDataset, prnDefaultSlugStrategy);
    expect(r.ok, r.problems.join("; ")).toBe(true);
  });

  it("every entry carries a citation and valid adult label numbers", () => {
    expect(entries.length).toBeGreaterThan(0);
    for (const e of entries) {
      expect(e.source, `${e.slug} must cite a source`).toBeTruthy();
      expect(e.rxcuis.length).toBeGreaterThan(0);
      expect(e.adult.minIntervalHours).toBeGreaterThan(0);
      expect(e.adult.maxDailyCount).toBeGreaterThan(0);
      expect(e.adult.maxDailyMg).toBeGreaterThan(0);
    }
  });

  it("ibuprofen and acetaminophen carry a pediatric weight-band table", () => {
    for (const slug of ["ibuprofen", "acetaminophen"]) {
      const e = entries.find((x) => x.slug === slug);
      expect(e, `${slug} present`).toBeTruthy();
      expect(e!.pediatric, `${slug} has a pediatric table`).toBeTruthy();
      expect(e!.pediatric!.bands.length).toBeGreaterThan(0);
      expect(e!.pediatric!.minAgeMonths).toBeGreaterThan(0);
      // Bands ascend by minLbs (the lookup relies on picking the highest ≤ weight).
      const mins = e!.pediatric!.bands.map((b) => b.minLbs);
      expect([...mins].sort((a, b) => a - b)).toEqual(mins);
    }
  });

  it("ASPIRIN is structurally excluded from pediatric dosing (Reye's)", () => {
    const aspirin = entries.find((e) => e.slug === "aspirin");
    expect(aspirin, "aspirin is in the dataset (adult only)").toBeTruthy();
    expect(aspirin!.pediatric).toBeUndefined();
    // And NO entry that looks like aspirin may ever carry a pediatric table.
    for (const e of entries) {
      const looksAspirin =
        e.slug === "aspirin" ||
        e.synonyms.some((s) => /aspirin|acetylsalicylic/i.test(s));
      if (looksAspirin) expect(e.pediatric).toBeUndefined();
    }
  });

  it("matches by RxNorm ingredient CUI (authoritative)", () => {
    const hit = prnDefaultsFor({ name: "Some Brand", rxcui: "5640" });
    expect(hit?.slug).toBe("ibuprofen");
  });

  it("matches by ingredient CUI in the cached ingredient list (#279)", () => {
    const hit = prnDefaultsFor({
      name: "Unknown product",
      rxcui: "99999",
      rxcuiIngredients: ["161"],
    });
    expect(hit?.slug).toBe("acetaminophen");
  });

  it("falls back to a name/synonym match when no CUI", () => {
    expect(prnDefaultsFor({ name: "Advil 200mg", rxcui: null })?.slug).toBe(
      "ibuprofen"
    );
    expect(prnDefaultsFor({ name: "Tylenol", rxcui: null })?.slug).toBe(
      "acetaminophen"
    );
  });

  it.each(
    prnDefaultEntries().flatMap((entry) =>
      entry.synonyms.map((name) => ({ name, slug: entry.slug }))
    )
  )("keeps the supported synonym $name", ({ name, slug }) => {
    expect(prnDefaultsFor({ name, rxcui: null })?.slug).toBe(slug);
  });

  it.each([
    ["Children's Tylenol", "acetaminophen"],
    ["Tylenol Extra Strength 500 mg tablets", "acetaminophen"],
    ["Acetaminophen 160 mg / 5 mL oral suspension", "acetaminophen"],
    ["Infants' Motrin drops 50 mg/1.25 mL", "ibuprofen"],
    ["Children’s Advil", "ibuprofen"],
  ])("keeps a plain product: %s", (name, slug) => {
    expect(prnDefaultsFor({ name, rxcui: null })?.slug).toBe(slug);
  });

  it.each([
    { name: "Tylenol with Codeine", rxcui: null },
    { name: "Paracetamol / codeine", rxcui: null },
    { name: "Acetaminophen (with Codeine)", rxcui: null },
    { name: "Acetaminophen 300 mg / codeine 30 mg", rxcui: null },
    { name: "Tylenol #3", rxcui: null },
    { name: "Advil PM", rxcui: null },
    { name: "Motrin Cold & Flu", rxcui: null },
    { name: "Tylenol with Codeine", rxcui: "161" },
    { name: "Tylenol", rxcui: "99999" },
    { name: "Tylenol with Codeine", rxcui: "99999", rxcuiIngredients: ["161"] },
    {
      name: "Unknown product",
      rxcui: "99999",
      rxcuiIngredients: ["161", "2670"],
    },
    {
      name: "Tylenol",
      rxcui: null,
      ingredients: [{ name: "Acetaminophen" }, { name: "Codeine" }],
    },
  ])("refuses plain-label defaults for $name ($rxcui)", (item) => {
    expect(prnDefaultsFor(item)).toBeNull();
    // Refusing a dose chart must not erase the ingredient's fever-reducing identity.
    expect(isAntipyreticIntakeItem(item)).toBe(true);
  });

  it("counts distinct ingredients rather than product and duplicate ingredient CUIs", () => {
    expect(
      prnDefaultsFor({
        name: "Unknown product",
        rxcui: "99999",
        rxcuiIngredients: ["161", "161", " 161 "],
      })?.slug
    ).toBe("acetaminophen");
  });

  it("returns null for an unknown ingredient", () => {
    expect(prnDefaultsFor({ name: "Metformin", rxcui: null })).toBeNull();
  });
});
