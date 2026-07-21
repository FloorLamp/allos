import { describe, it, expect } from "vitest";
import {
  buildImportTabs,
  resolveImportTab,
  recordCategoryLabel,
  recordNameLink,
  visitItem,
  conditionItem,
  allergyItem,
  immunizationItem,
  procedureItem,
  familyHistoryItem,
  carePlanItemRow,
  careGoalItem,
  genomicVariantItem,
  imagingStudyItem,
  medicationItem,
  bodyItems,
} from "../import-browser";
import type { DocumentProducedCounts } from "../import-log";
import { EMPTY_PRODUCED_COUNTS } from "./produced-counts-fixture";

const counts = (
  over: Partial<DocumentProducedCounts>
): DocumentProducedCounts => ({ ...EMPTY_PRODUCED_COUNTS, ...over });

describe("buildImportTabs", () => {
  it("returns no tabs for an empty import", () => {
    const strip = buildImportTabs(EMPTY_PRODUCED_COUNTS);
    expect(strip.tabs).toEqual([]);
    expect(strip.providers).toBe(0);
  });

  it("builds one tab per NON-EMPTY produced type, categories first in canonical order", () => {
    const strip = buildImportTabs(
      counts({
        // Deliberately alphabetical (the GROUP BY order) — the strip must
        // re-order to the canonical category order (vitals, lab, …).
        recordsByCategory: [
          { category: "lab", count: 12 },
          { category: "prescription", count: 2 },
          { category: "vitals", count: 4 },
        ],
        encounters: 1,
        conditions: 3,
        procedures: 1,
        familyHistory: 2,
        carePlanItems: 1,
        careGoals: 1,
        medications: 2,
        bodyMetrics: 1,
        heightSamples: 1,
        headCircSamples: 1,
        providers: 4,
      })
    );
    expect(strip.tabs.map((t) => t.key)).toEqual([
      "vitals",
      "lab",
      "prescription",
      "visits",
      "conditions",
      "procedures",
      "family-history",
      "care-plan",
      "care-goals",
      "medications",
      "body",
    ]);
    const byKey = Object.fromEntries(strip.tabs.map((t) => [t.key, t]));
    expect(byKey["lab"]).toMatchObject({
      label: "Labs",
      count: 12,
      kind: "records",
      category: "lab",
    });
    expect(byKey["visits"]).toMatchObject({
      label: "Visits",
      count: 1,
      kind: "visits",
    });
    // The Body tab merges body-metric rows + height + head-circ samples.
    expect(byKey["body"].count).toBe(3);
    // Providers are a chip, NOT a tab (nothing to link to pre-#275) — and never
    // part of the tab list.
    expect(byKey["providers"]).toBeUndefined();
    expect(strip.providers).toBe(4);
  });

  it("drops zero-count kinds and zero-count categories", () => {
    const strip = buildImportTabs(
      counts({
        recordsByCategory: [{ category: "scan", count: 0 }],
        allergies: 2,
      })
    );
    expect(strip.tabs.map((t) => t.key)).toEqual(["allergies"]);
  });

  it("gives an unknown record category a fallback tab after the known ones", () => {
    const strip = buildImportTabs(
      counts({
        recordsByCategory: [
          { category: "weird", count: 1 },
          { category: "lab", count: 1 },
        ],
      })
    );
    expect(strip.tabs.map((t) => t.key)).toEqual(["lab", "weird"]);
    expect(strip.tabs[1]).toMatchObject({
      label: "weird",
      kind: "records",
      category: "weird",
    });
  });
});

describe("resolveImportTab", () => {
  const strip = buildImportTabs(
    counts({
      recordsByCategory: [{ category: "lab", count: 2 }],
      encounters: 1,
    })
  );

  it("selects the tab matching ?tab=", () => {
    expect(resolveImportTab(strip.tabs, "visits")?.kind).toBe("visits");
  });
  it("falls back to the FIRST non-empty tab for absent/unknown params", () => {
    expect(resolveImportTab(strip.tabs, undefined)?.key).toBe("lab");
    expect(resolveImportTab(strip.tabs, "nope")?.key).toBe("lab");
  });
  it("returns undefined only for an empty strip", () => {
    expect(resolveImportTab([], "lab")).toBeUndefined();
  });
});

describe("recordCategoryLabel", () => {
  it("labels the known categories and passes unknowns through", () => {
    expect(recordCategoryLabel("lab")).toBe("Labs");
    expect(recordCategoryLabel("prescription")).toBe("Prescriptions");
    expect(recordCategoryLabel("weird")).toBe("weird");
  });
});

describe("recordNameLink (category-correct row links)", () => {
  it("links series categories to the biomarker series view", () => {
    for (const cat of ["lab", "biomarker", "vitals", "genomics"]) {
      const link = recordNameLink(cat, "LDL Cholesterol");
      expect(link?.href).toBe("/biomarkers/view?name=LDL%20Cholesterol");
    }
  });
  it("gives a series category with no canonical name NO link", () => {
    expect(recordNameLink("lab", null)).toBeNull();
    expect(recordNameLink("lab", "  ")).toBeNull();
  });
  it("REGRESSION: a prescription row links to /medications, never a biomarker page", () => {
    const link = recordNameLink("prescription", "Lisinopril 10 mg");
    expect(link?.href).toBe("/medications");
    expect(link?.href).not.toContain("/biomarkers");
    // Even with no canonical name, prescriptions still point at medications.
    expect(recordNameLink("prescription", null)?.href).toBe("/medications");
  });
  it("gives scans and unknown categories NO link rather than a wrong one", () => {
    expect(recordNameLink("scan", "Chest X-ray")).toBeNull();
    expect(recordNameLink("note", "Progress note")).toBeNull();
  });
});

describe("row shapers", () => {
  it("visit rows deep-link to the visit detail page", () => {
    const item = visitItem({
      id: 42,
      date: "2026-01-05",
      end_date: null,
      type: "Office Visit",
      reason: "Annual physical",
    });
    expect(item).toMatchObject({
      title: "Office Visit",
      detail: "Annual physical",
      date: "2026-01-05",
      href: "/encounters/42",
    });
  });
  it("a typeless visit still gets a title, and a stay shows its date range", () => {
    const item = visitItem({
      id: 7,
      date: "2026-01-05",
      end_date: "2026-01-07",
      type: null,
      reason: null,
    });
    expect(item.title).toBe("Visit");
    expect(item.date).toBe("2026-01-05 – 2026-01-07");
    expect(item.detail).toBeNull();
  });
  it("each domain kind links to its own page", () => {
    expect(
      conditionItem({
        id: 1,
        name: "Hypertension",
        status: "active",
        onset_date: null,
        code: "I10",
      })
    ).toMatchObject({ href: "/records/problems", detail: "active · I10" });
    expect(
      allergyItem({
        id: 1,
        substance: "Penicillin",
        reaction: "Hives",
        severity: "moderate",
        status: "active",
      })
    ).toMatchObject({ href: "/records/problems", title: "Penicillin" });
    expect(
      immunizationItem({
        id: 1,
        date: "2020-05-01",
        vaccine: "MMR",
        dose_label: "1",
      })
    ).toMatchObject({
      href: "/records/history/immunizations",
      date: "2020-05-01",
    });
    expect(
      procedureItem({ id: 1, name: "Appendectomy", code: "44970", date: null })
    ).toMatchObject({ href: "/records/history/procedures" });
    expect(
      familyHistoryItem({
        id: 1,
        relation: "Father",
        condition: "Type 2 diabetes",
        onset_age: 55,
      })
    ).toMatchObject({
      href: "/records/care/overview",
      detail: "Father · onset age 55",
    });
    expect(
      carePlanItemRow({
        id: 1,
        description: "Colonoscopy",
        category: "procedure",
        planned_date: "2026-09-01",
        status: "planned",
      })
    ).toMatchObject({ href: "/records/care/overview", date: "2026-09-01" });
    expect(
      careGoalItem({
        id: 1,
        description: "A1c under 7%",
        target_date: null,
        status: "active",
      })
    ).toMatchObject({ href: "/records/care/overview" });
    expect(
      medicationItem({ id: 1, name: "Lisinopril", kind: "medication" })
    ).toMatchObject({ href: "/medications", detail: "medication" });
  });
});

describe("bodyItems (merged Body tab)", () => {
  it("merges body metrics + height + head-circ newest-first, weight in the display unit", () => {
    const items = bodyItems(
      {
        bodyMetrics: [
          {
            id: 1,
            date: "2026-01-02",
            weight_kg: 82,
            body_fat_pct: 18,
            resting_hr: null,
          },
        ],
        heights: [{ id: 9, date: "2026-01-03", value: 178 }],
        headCircs: [{ id: 9, date: "2026-01-01", value: 47 }],
      },
      "lb"
    );
    expect(items.map((i) => i.title)).toEqual([
      "Height",
      "Body metrics",
      "Head circumference",
    ]);
    expect(items[1].detail).toBe("Weight 180.8 lb · Body fat 18%");
    expect(items[0].detail).toBe("178 cm");
    // Every merged row lands on the Body trends tab.
    expect(new Set(items.map((i) => i.href))).toEqual(
      new Set(["/trends?tab=body"])
    );
  });
});

describe("genomic variants (#709)", () => {
  it("adds a Genomic variants tab when the import produced any", () => {
    const strip = buildImportTabs(counts({ genomicVariants: 2 }));
    const tab = strip.tabs.find((t) => t.key === "genomic-variants");
    expect(tab).toBeTruthy();
    expect(tab?.label).toBe("Genomic variants");
    expect(tab?.count).toBe(2);
    expect(tab?.kind).toBe("genomic-variants");
  });

  it("omits the tab when none were produced", () => {
    const strip = buildImportTabs(counts({ genomicVariants: 0 }));
    expect(strip.tabs.some((t) => t.key === "genomic-variants")).toBe(false);
  });

  it("shapes a variant row factually, with no risk text and a /genomics link", () => {
    const item = genomicVariantItem({
      id: 7,
      gene: "CYP2C19",
      variant: "rs4244285",
      genotype: null,
      star_allele: "*2/*2",
      zygosity: "homozygous",
      significance: null,
      result_type: "pharmacogenomic",
      report_date: "2024-02-01",
    });
    expect(item.title).toBe("CYP2C19 *2/*2 (rs4244285)");
    // Detail is the reported classification only — no metabolizer/risk commentary.
    expect(item.detail).toBe("Pharmacogenomic");
    expect(item.date).toBe("2024-02-01");
    expect(item.href).toBe("/results/genomics");
  });

  it("shows the ACMG significance for a hereditary-risk variant", () => {
    const item = genomicVariantItem({
      id: 8,
      gene: "BRCA1",
      variant: "c.68_69del",
      genotype: null,
      star_allele: null,
      zygosity: "heterozygous",
      significance: "pathogenic",
      result_type: "hereditary-risk",
      report_date: null,
    });
    expect(item.title).toBe("BRCA1 heterozygous (c.68_69del)");
    expect(item.detail).toBe("Pathogenic · Hereditary risk");
    expect(item.date).toBeNull();
  });
});

describe("imaging studies (#702)", () => {
  it("adds an Imaging studies tab when the import produced any", () => {
    const strip = buildImportTabs(counts({ imagingStudies: 1 }));
    const tab = strip.tabs.find((t) => t.key === "imaging-studies");
    expect(tab).toBeTruthy();
    expect(tab?.label).toBe("Imaging studies");
    expect(tab?.count).toBe(1);
    expect(tab?.kind).toBe("imaging-studies");
  });

  it("omits the tab when none were produced", () => {
    const strip = buildImportTabs(counts({ imagingStudies: 0 }));
    expect(strip.tabs.some((t) => t.key === "imaging-studies")).toBe(false);
  });

  it("shapes a contrast study with modality, laterality, contrast + impression and an /imaging link", () => {
    const item = imagingStudyItem({
      id: 7,
      modality: "mri",
      body_region: "Knee",
      laterality: "left",
      contrast: 1,
      study_date: "2024-03-01",
      impression: "Small joint effusion. No tear.",
    });
    expect(item.title).toBe("MRI Left Knee");
    expect(item.detail).toBe(
      "MRI · Left · with contrast · Small joint effusion. No tear."
    );
    expect(item.date).toBe("2024-03-01");
    expect(item.href).toBe("/results/imaging");
  });

  it("shapes a non-contrast study with 'na' laterality omitted from label + detail", () => {
    const item = imagingStudyItem({
      id: 8,
      modality: "x-ray",
      body_region: "Chest",
      laterality: "na",
      contrast: 0,
      study_date: null,
      impression: null,
    });
    // 'na' laterality (midline/whole study) is not rendered in the label or detail.
    expect(item.title).toBe("X-ray Chest");
    expect(item.detail).toBe("X-ray");
    expect(item.date).toBeNull();
  });
});
