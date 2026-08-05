import { describe, it, expect } from "vitest";
import {
  PREFERENCE_SQL,
  REPRESENTATIVE_SPECS,
  inRepresentativeCte,
  medicalDedupSpec,
  medicalLatestSpec,
  representativeCte,
  representativeIds,
  representativeOrderBy,
  type PreferenceAxis,
  type RepresentativeSpec,
} from "@/lib/representative-ids";
import {
  REPO,
  prepareArgs,
  readSource,
  relPath,
  sourceFiles,
} from "./sql-scan";
import fs from "node:fs";
import path from "node:path";

// Issue #2035. The representative-row dedup window used to be hand-written seven
// times (four in lib/queries/clinical.ts, one in medical/encounters.ts, two CTEs in
// queries/medical.ts, one inline in medical/immunizations.ts) — and the seventh spelled
// the manual-beats-imported preference differently. This file pins the extraction:
//
//   1. GOLDEN PIN — the builder emits, for every former site, the EXACT SQL that site
//      carried before the extraction (modulo whitespace and the `--` comments that
//      moved into the registry as TS comments). That makes the swap provably
//      behavior-free: SQLite is parsing the same statement it parsed before.
//   2. REGISTRY INVARIANTS — every site declares exactly one preference axis, every
//      axis is a known one, and the identity is non-empty.
//   3. AN ANTI-DRIFT SCAN — no `ROW_NUMBER() OVER (PARTITION BY profile_id` may appear
//      in a `.prepare` statement outside the builder, so an eighth copy can't be
//      grown by hand (the identity-registry-doc.test.ts pattern).
//
// Pure: SQL TEXT only, no DB. The rows this SQL actually selects are asserted in
// lib/__db_tests__/representative-ids.test.ts.

// Whitespace-collapse. The goldens below were extracted from the pre-#2035 source and
// normalized this way; the builder's own indentation is therefore free to differ, but
// not one token of the SQL may.
const sql = (s: string) => s.replace(/\s+/g, " ").trim();

// The family expression the medical CTEs embed, i.e. what `biomarkerFamilyKey()`
// returns. Spelled out here because this tier cannot import lib/queries/medical.ts
// (it opens the database); the DB-tier test asserts the real helper still returns
// exactly this string, which is what joins the two halves.
const FAMILY_KEY =
  "biomarker_family(COALESCE(NULLIF(TRIM(canonical_name), ''), name))";

// ---------------------------------------------------------------------------
// 1. Golden pin — the pre-extraction SQL of each of the seven sites.
// ---------------------------------------------------------------------------

const GOLDEN: { site: string; was: string; got: string }[] = [
  {
    site: "conditions — lib/queries/clinical.ts conditionRepresentativeIds(false)",
    was: "SELECT id FROM ( SELECT id, ROW_NUMBER() OVER ( PARTITION BY profile_id, COALESCE( 'code:' || NULLIF(TRIM(code), ''), 'name:' || LOWER(TRIM(name)) ), 'lat:' || COALESCE(laterality, '') ORDER BY (status = 'active') DESC, (document_id IS NULL) DESC, id DESC ) AS rn FROM conditions WHERE profile_id = ? ) WHERE rn = 1",
    got: representativeIds(REPRESENTATIVE_SPECS.conditions),
  },
  {
    site: "conditions — conditionRepresentativeIds(true), the #193 status push-down",
    was: "SELECT id FROM ( SELECT id, ROW_NUMBER() OVER ( PARTITION BY profile_id, COALESCE( 'code:' || NULLIF(TRIM(code), ''), 'name:' || LOWER(TRIM(name)) ), 'lat:' || COALESCE(laterality, '') ORDER BY (status = 'active') DESC, (document_id IS NULL) DESC, id DESC ) AS rn FROM conditions WHERE profile_id = ? AND status = ? ) WHERE rn = 1",
    got: representativeIds(REPRESENTATIVE_SPECS.conditions, {
      where: "status = ?",
    }),
  },
  {
    site: "procedures — lib/queries/clinical.ts PROCEDURE_REPRESENTATIVE_IDS",
    was: "SELECT id FROM ( SELECT id, ROW_NUMBER() OVER ( PARTITION BY profile_id, COALESCE('code:' || NULLIF(TRIM(code), ''), 'name:' || LOWER(TRIM(name))), COALESCE(date, '') ORDER BY (document_id IS NULL) DESC, id DESC ) AS rn FROM procedures WHERE profile_id = ? ) WHERE rn = 1",
    got: representativeIds(REPRESENTATIVE_SPECS.procedures),
  },
  {
    site: "family_history — lib/queries/clinical.ts FAMILY_HISTORY_REPRESENTATIVE_IDS",
    was: "SELECT id FROM ( SELECT id, ROW_NUMBER() OVER ( PARTITION BY profile_id, 'rel:' || LOWER(TRIM(COALESCE(relation, ''))), 'cond:' || LOWER(TRIM(condition)), 'type:' || COALESCE(relation_type, ''), 'line:' || COALESCE(lineage, '') ORDER BY (document_id IS NULL) DESC, id DESC ) AS rn FROM family_history WHERE profile_id = ? ) WHERE rn = 1",
    got: representativeIds(REPRESENTATIVE_SPECS.family_history),
  },
  {
    site: "allergies — lib/queries/clinical.ts ALLERGY_REPRESENTATIVE_IDS",
    was: "SELECT id FROM ( SELECT id, ROW_NUMBER() OVER ( PARTITION BY profile_id, 'sub:' || LOWER(TRIM(substance)), 'rxn:' || LOWER(TRIM(COALESCE(reaction, ''))), 'st:' || COALESCE(status, '') ORDER BY (document_id IS NULL) DESC, id DESC ) AS rn FROM allergies WHERE profile_id = ? ) WHERE rn = 1",
    got: representativeIds(REPRESENTATIVE_SPECS.allergies),
  },
  {
    site: "encounters — lib/queries/medical/encounters.ts ENCOUNTER_REPRESENTATIVE_IDS",
    was: "SELECT id FROM ( SELECT id, ROW_NUMBER() OVER ( PARTITION BY profile_id, COALESCE( CASE WHEN external_id IS NOT NULL THEN substr(external_id, instr(external_id, '|') + 1) END, date || '|' || COALESCE(end_date, '') || '|' || COALESCE(type, '') || '|' || COALESCE(class_code, '') || '|' || COALESCE(reason, '') ) ORDER BY (document_id IS NULL) DESC, id DESC ) AS rn FROM encounters WHERE profile_id = ? ) WHERE rn = 1",
    got: representativeIds(REPRESENTATIVE_SPECS.encounters),
  },
  {
    site: "medical_records — lib/queries/medical.ts DEDUP_IDS_CTE",
    was: `deduped AS ( SELECT id FROM ( SELECT id, ROW_NUMBER() OVER ( PARTITION BY profile_id, ${FAMILY_KEY} COLLATE NOCASE, date, value, value_num, unit ORDER BY (document_id IS NULL) DESC, id DESC ) AS rn FROM medical_records WHERE profile_id = ? ) WHERE rn = 1 )`,
    got: representativeCte("deduped", medicalDedupSpec(FAMILY_KEY)),
  },
  {
    site: "medical_records — lib/queries/medical.ts LATEST_IDS_CTE",
    was: `latest AS ( SELECT id FROM ( SELECT id, ROW_NUMBER() OVER ( PARTITION BY profile_id, ${FAMILY_KEY} COLLATE NOCASE ORDER BY date DESC, id DESC ) AS rn FROM medical_records WHERE profile_id = ? AND id IN (SELECT id FROM deduped) ) WHERE rn = 1 )`,
    got: representativeCte("latest", medicalLatestSpec(FAMILY_KEY), {
      where: inRepresentativeCte("deduped"),
    }),
  },
  {
    site: "immunizations — lib/queries/medical/immunizations.ts imm_deduped",
    was: "imm_deduped AS ( SELECT id FROM ( SELECT id, ROW_NUMBER() OVER ( PARTITION BY profile_id, vaccine, date, COALESCE(dose_label, '') ORDER BY (source IS NULL OR source NOT LIKE 'document:%') DESC, id DESC ) AS rn FROM immunizations WHERE profile_id = ? ) WHERE rn = 1 )",
    got: representativeCte("imm_deduped", REPRESENTATIVE_SPECS.immunizations),
  },
];

describe("representativeIds — golden pin against the pre-#2035 SQL", () => {
  for (const { site, was, got } of GOLDEN) {
    it(`emits the unchanged statement for ${site}`, () => {
      expect(sql(got)).toBe(sql(was));
    });
  }

  it("covers every former hand-written site (seven, nine emitted statements)", () => {
    // Seven sites; conditions contributes two (filtered/unfiltered) and
    // medical_records two (dedup + latest).
    expect(GOLDEN).toHaveLength(9);
  });
});

// ---------------------------------------------------------------------------
// 2. Registry invariants.
// ---------------------------------------------------------------------------

describe("the representative registry", () => {
  const entries = Object.entries(REPRESENTATIVE_SPECS) as [
    string,
    RepresentativeSpec,
  ][];

  it("registers every collapse site with a non-empty identity", () => {
    expect(entries.length).toBeGreaterThan(0);
    for (const [name, spec] of entries) {
      expect(spec.table, `${name} names its table`).toBe(name);
      expect(
        spec.partition.length,
        `${name} declares an identity`
      ).toBeGreaterThan(0);
      for (const p of spec.partition) {
        expect(p.trim(), `${name} identity term is non-empty`).not.toBe("");
      }
    }
  });

  it("declares exactly one preference axis per site, from the known set", () => {
    const known = new Set(Object.keys(PREFERENCE_SQL));
    for (const [name, spec] of [
      ...entries,
      ["medical_records:dedup", medicalDedupSpec("x")] as const,
      ["medical_records:latest", medicalLatestSpec("x")] as const,
    ]) {
      expect(typeof spec.prefer, `${name} declares an axis`).toBe("string");
      expect(known.has(spec.prefer), `${name} axis is registered`).toBe(true);
    }
  });

  it("never puts a second preference axis into the precedence terms", () => {
    // `precede` orders BEFORE the axis (#193's active-first). It must not smuggle in
    // another provenance rule — that would be the two-spellings bug re-grown.
    const axisSql = Object.values(PREFERENCE_SQL);
    for (const [name, spec] of entries) {
      for (const term of spec.precede ?? []) {
        for (const axis of axisSql) {
          expect(
            term.includes(axis),
            `${name} precede term is not an axis`
          ).toBe(false);
        }
      }
    }
  });

  it("always ends the ranking with the id DESC physical tie-break", () => {
    for (const [, spec] of entries) {
      expect(representativeOrderBy(spec).endsWith(", id DESC")).toBe(true);
    }
  });

  it("spells manual-beats-imported exactly two ways, each keyed on a real column", () => {
    // The whole #2035 defect: one rule, two spellings. Both survive — a table with a
    // document_id uses that; immunizations has none and must read `source`. Naming
    // them is what stops a third from being invented.
    expect(PREFERENCE_SQL.document).toContain("document_id");
    expect(PREFERENCE_SQL.source).toContain("source");
    expect(PREFERENCE_SQL.source).not.toContain("document_id IS NULL");
    // Only the table without a document_id column takes the `source` spelling.
    const bySource = Object.values(REPRESENTATIVE_SPECS).filter(
      (s: RepresentativeSpec) => s.prefer === "source"
    );
    expect(bySource.map((s) => s.table)).toEqual(["immunizations"]);
  });

  it("keeps the recency axis byte-identical to the pure latest-per-group rule", () => {
    // lib/latest-per-group.ts isLaterReading: later date wins, equal date breaks on
    // the higher id. The SQL half must say the same thing.
    const axis: PreferenceAxis = "recency";
    expect(
      representativeOrderBy({ table: "t", partition: ["k"], prefer: axis })
    ).toBe("date DESC, id DESC");
    const pure = fs.readFileSync(
      path.join(REPO, "lib/latest-per-group.ts"),
      "utf8"
    );
    expect(pure).toContain("ORDER BY date DESC, id DESC");
  });
});

// ---------------------------------------------------------------------------
// 3. Anti-drift scan — no eighth hand-written copy.
// ---------------------------------------------------------------------------

describe("no hand-written representative window outside the builder", () => {
  it("finds no `ROW_NUMBER() OVER (PARTITION BY profile_id` in any prepared statement", () => {
    // The builder emits this shape; every consumer interpolates the builder's output
    // into its own `.prepare` literal, so the raw shape must never appear as SOURCE
    // TEXT in a prepared statement again. (The scanner reads `.prepare` arguments as
    // text, so an interpolation shows up as `${…}` and does not trip this.)
    const offenders: string[] = [];
    for (const file of sourceFiles()) {
      const rel = relPath(file);
      if (rel === "lib/representative-ids.ts") continue;
      for (const arg of prepareArgs(readSource(file))) {
        if (
          /ROW_NUMBER\(\)\s*OVER\s*\(\s*PARTITION\s+BY\s+profile_id/i.test(
            arg.text
          )
        ) {
          offenders.push(rel);
        }
      }
    }
    expect(
      offenders,
      `hand-written representative window(s) found — build them with representativeIds() (lib/representative-ids.ts, #2035) instead: ${offenders.join(", ")}`
    ).toEqual([]);
  });
});
