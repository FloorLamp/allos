import { describe, expect, it } from "vitest";
import { IMPORT_FOOTPRINT_TABLES } from "@/lib/import-footprint";
import { producedTotal, type DocumentProducedCounts } from "@/lib/import-log";

// Binds DocumentProducedCounts (the "what this import produced" per-kind breakdown,
// lib/import-log.ts) to IMPORT_FOOTPRINT_TABLES (#453 item 3, folding in #422 item 2).
// The struct is a hand-mirrored field-per-table copy of the footprint list — exactly
// the shape the conventions call a drift risk. Rather than restructure every consumer,
// this test generates the agreement's expected set FROM the list: every footprint
// table maps to exactly one produced-counts field, and producedTotal sums precisely
// those fields — so a footprint table added without a matching count field (or a
// producedTotal that forgets one) fails here. The runtime numeric agreement
// (producedTotal === extracted_count === countImportedDocumentRows) is pinned
// separately in the DB tier (lib/__db_tests__/imports.test.ts).

// A stable key per footprint entry (metric_samples appears twice — height + head
// circ — distinguished by its `extra` metric filter).
function footprintKey(t: (typeof IMPORT_FOOTPRINT_TABLES)[number]): string {
  return t.extra ? `${t.table}|${t.extra}` : t.table;
}

// The ONE mapping from a footprint entry to the DocumentProducedCounts field that
// tallies it. `recordsByCategory` is the medical_records array (summed by
// producedTotal); every other entry maps to a scalar count field. Keep this in lock
// step with IMPORT_FOOTPRINT_TABLES — the completeness test below fails if it drifts.
const FOOTPRINT_TO_COUNT_FIELD: Record<string, keyof DocumentProducedCounts> = {
  medical_records: "recordsByCategory",
  allergies: "allergies",
  conditions: "conditions",
  encounters: "encounters",
  procedures: "procedures",
  family_history: "familyHistory",
  care_plan_items: "carePlanItems",
  care_goals: "careGoals",
  genomic_variants: "genomicVariants",
  imaging_studies: "imagingStudies",
  appointments: "appointments",
  "intake_items|source = 'extracted'": "medications",
  body_metrics: "bodyMetrics",
  immunizations: "immunizations",
  "metric_samples|metric = 'height_cm'": "heightSamples",
  "metric_samples|metric = 'head_circumference_cm'": "headCircSamples",
};

describe("DocumentProducedCounts binds to IMPORT_FOOTPRINT_TABLES", () => {
  it("maps every footprint entry to exactly one produced-counts field", () => {
    const keys = IMPORT_FOOTPRINT_TABLES.map(footprintKey);
    // No two footprint entries collapse to the same key (would hide a table).
    expect(new Set(keys).size).toBe(keys.length);
    for (const k of keys) {
      expect(
        FOOTPRINT_TO_COUNT_FIELD[k],
        `footprint entry '${k}' has no DocumentProducedCounts field`
      ).toBeTruthy();
    }
    // And no stale mapping entry for a footprint table that no longer exists.
    for (const k of Object.keys(FOOTPRINT_TO_COUNT_FIELD)) {
      expect(keys, `mapping key '${k}' is not a footprint entry`).toContain(k);
    }
  });

  it("producedTotal sums exactly the footprint-mapped fields", () => {
    // Give each mapped field a DISTINCT non-zero value; producedTotal must equal
    // their sum. A field producedTotal forgets (or an extra field it counts) breaks
    // this — pinning that the total's addends are precisely the footprint kinds.
    const fields = new Set(Object.values(FOOTPRINT_TO_COUNT_FIELD));
    const counts: DocumentProducedCounts = {
      recordsByCategory: [],
      immunizations: 0,
      allergies: 0,
      conditions: 0,
      encounters: 0,
      procedures: 0,
      familyHistory: 0,
      carePlanItems: 0,
      careGoals: 0,
      genomicVariants: 0,
      imagingStudies: 0,
      appointments: 0,
      medications: 0,
      bodyMetrics: 0,
      heightSamples: 0,
      headCircSamples: 0,
      providers: 0,
    };

    let n = 1;
    let expected = 0;
    for (const field of fields) {
      if (field === "recordsByCategory") {
        counts.recordsByCategory = [{ category: "lab", count: n }];
      } else {
        (counts[field] as number) = n;
      }
      expected += n;
      n += 1;
    }
    // providers is deliberately NOT a footprint row (global registry) — set it
    // non-zero to prove producedTotal excludes it.
    counts.providers = 999;

    expect(producedTotal(counts)).toBe(expected);
  });
});
