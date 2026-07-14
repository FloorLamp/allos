// DB INTEGRATION TIER — structured genomic variants (#709).
//
// Drives a synthetic clinical-genetics/PGx report extraction through the REAL
// adapter (extractionToPersistInput) and the ONE persist core
// (persistDocumentImport), then reads it back through the document queries the UI
// uses. Pins that (a) genomic variants land as structured rows with the raw
// result_type/significance/zygosity normalized onto the DB CHECK sets, (b) they
// count toward extracted_count / producedTotal, and (c) they honor the import
// footprint contract — cleared on document delete, MOVED on reassign (#201) — since
// genomic_variants joins IMPORT_FOOTPRINT_TABLES. Also pins the durable-result
// semantics survive: a genomics record never goes stale.
//
// No real AI calls — the fixture is a synthetic ExtractionResult with clearly-fake
// PHI (a fictional "Test Patient"). Runs against a throwaway DB (setup.ts).

import { describe, it, expect, beforeAll } from "vitest";
import {
  getDocumentProduced,
  getDocumentGenomicVariants,
  getGenomicVariants,
  getMedicalDocument,
} from "@/lib/queries";
import {
  persistDocumentImport,
  countImportedDocumentRows,
  clearImportedDocumentRows,
  moveImportedDocumentRows,
} from "@/lib/import-persist";
import { producedTotal } from "@/lib/import-log";
import { extractionToPersistInput } from "@/lib/import-shape";
import { isBiomarkerStale } from "@/lib/reference-range";
import type { ExtractionResult } from "@/lib/medical-extract";
import { db } from "@/lib/db";

// A synthetic PGx + hereditary-cancer report: no numeric analytes, only reported
// variants. Loose result_type/significance/zygosity phrasings to exercise the
// normalizer. One gene-less entry to prove it drops.
function genomicsExtraction(): Extract<ExtractionResult, { status: "done" }> {
  return {
    status: "done",
    model: "claude-test",
    raw: "RAW",
    meta: {
      document_type: "other",
      source: "Test Genetics Lab",
      patient_name: "Test Patient",
      patient_sex: null,
      patient_birthdate: null,
      patient_age: null,
      document_date: "2024-05-10",
    },
    results: [],
    immunizations: [],
    conditions: [],
    allergies: [],
    procedures: [],
    encounters: [],
    familyHistory: [],
    carePlanItems: [],
    careGoals: [],
    genomicVariants: [
      {
        gene: "CYP2C19",
        variant: "rs4244285",
        genotype: null,
        star_allele: "*2/*2",
        zygosity: "Homozygous",
        significance: null, // PGx star-allele: no ACMG call
        result_type: "Pharmacogenomics",
        interpretation: "Poor metabolizer",
        source_lab: "Test Genetics Lab",
        report_date: "2024-05-10",
      },
      {
        gene: "BRCA1",
        variant: "c.68_69del",
        genotype: null,
        star_allele: null,
        zygosity: "heterozygous",
        significance: "Likely Pathogenic",
        result_type: "Hereditary cancer",
        interpretation: "Reported pathogenic per report",
        source_lab: "Test Genetics Lab",
        report_date: "2024-05-10",
      },
      // Gene-less entry — must be dropped (gene is NOT NULL).
      {
        gene: "",
        variant: "rs999",
        genotype: null,
        star_allele: null,
        zygosity: null,
        significance: null,
        result_type: null,
        interpretation: null,
        source_lab: null,
        report_date: null,
      },
    ],
    drops: [],
  };
}

function newProfile(name: string): number {
  return Number(
    db.prepare("INSERT INTO profiles (name) VALUES (?)").run(name)
      .lastInsertRowid
  );
}

function newDocument(profileId: number): number {
  return Number(
    db
      .prepare(
        `INSERT INTO medical_documents
           (profile_id, filename, stored_path, extraction_status, doc_type)
         VALUES (?, 'genetics-report.pdf', '', 'processing', 'other')`
      )
      .run(profileId).lastInsertRowid
  );
}

let profile: number;
let doc: number;

beforeAll(() => {
  profile = newProfile("GENOMICS");
  doc = newDocument(profile);
  persistDocumentImport(
    profile,
    doc,
    extractionToPersistInput(genomicsExtraction(), "2024-05-10")
  );
});

describe("AI extraction lands genomic variants through the persist core", () => {
  it("persists each variant with the enum fields normalized to the CHECK sets", () => {
    const rows = getDocumentGenomicVariants(profile, doc);
    expect(rows.map((r) => r.gene)).toEqual(["BRCA1", "CYP2C19"]);

    const cyp = rows.find((r) => r.gene === "CYP2C19")!;
    expect(cyp.star_allele).toBe("*2/*2");
    expect(cyp.zygosity).toBe("homozygous");
    expect(cyp.significance).toBeNull();
    expect(cyp.result_type).toBe("pharmacogenomic");

    const brca = rows.find((r) => r.gene === "BRCA1")!;
    expect(brca.zygosity).toBe("heterozygous");
    expect(brca.significance).toBe("likely-pathogenic");
    expect(brca.result_type).toBe("hereditary-risk");
  });

  it("stores the report's interpretation verbatim and the source/document provenance", () => {
    const all = getGenomicVariants(profile);
    const cyp = all.find((r) => r.gene === "CYP2C19")!;
    expect(cyp.interpretation).toBe("Poor metabolizer");
    expect(cyp.source_lab).toBe("Test Genetics Lab");
    expect(cyp.report_date).toBe("2024-05-10");
    // Import provenance is stamped so the footprint can clear/move/count it.
    expect(cyp.document_id).toBe(doc);
    expect(cyp.source).toBe(`document:${doc}`);
  });

  it("drops a gene-less variant (gene is the required anchor)", () => {
    expect(getDocumentGenomicVariants(profile, doc)).toHaveLength(2);
  });

  it("counts the variants toward extracted_count / producedTotal", () => {
    const counts = getDocumentProduced(profile, doc);
    expect(counts.genomicVariants).toBe(2);
    const total = countImportedDocumentRows(profile, doc);
    expect(producedTotal(counts)).toBe(total);
    const docRow = getMedicalDocument(profile, doc)!;
    expect(docRow.extracted_count).toBe(total);
    // The two variants are part of that total.
    expect(total).toBeGreaterThanOrEqual(2);
  });

  it("keeps the durable-result semantics: a genomics record never goes stale", () => {
    // The genomic_variants table is outside the retest/reference pipeline, and the
    // medical_records 'genomics' category is exempt from staleness — pin the latter
    // so this feature can't regress that (#709 keep-existing requirement).
    expect(isBiomarkerStale("2000-01-01", "genomics", "2024-05-10", 30)).toBe(
      false
    );
  });
});

describe("import footprint: genomic_variants is cleared / moved by document", () => {
  it("clearImportedDocumentRows removes them on document delete", () => {
    const p = newProfile("GENOMICS-CLEAR");
    const d = newDocument(p);
    persistDocumentImport(
      p,
      d,
      extractionToPersistInput(genomicsExtraction(), "2024-05-10")
    );
    expect(getDocumentGenomicVariants(p, d)).toHaveLength(2);
    clearImportedDocumentRows(p, d);
    expect(getDocumentGenomicVariants(p, d)).toHaveLength(0);
  });

  it("moveImportedDocumentRows re-points them to the destination profile (#201)", () => {
    const src = newProfile("GENOMICS-SRC");
    const dest = newProfile("GENOMICS-DEST");
    const d = newDocument(src);
    persistDocumentImport(
      src,
      d,
      extractionToPersistInput(genomicsExtraction(), "2024-05-10")
    );
    expect(getGenomicVariants(src).length).toBeGreaterThanOrEqual(2);

    moveImportedDocumentRows(src, dest, d);
    // The variants now belong to the destination profile.
    expect(getDocumentGenomicVariants(dest, d)).toHaveLength(2);
    expect(getDocumentGenomicVariants(src, d)).toHaveLength(0);
    expect(
      getGenomicVariants(dest)
        .map((r) => r.gene)
        .sort()
    ).toEqual(["BRCA1", "CYP2C19"]);
  });
});
