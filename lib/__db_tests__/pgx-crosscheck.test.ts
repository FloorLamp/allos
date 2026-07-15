// DB INTEGRATION TIER — the pharmacogenomics cross-check builder (#710), per the
// #448 findings-builder-test discipline.
//
// getPgxWarnings is a findings BUILDER: it GATHERS DB state (the profile's stored
// pharmacogenomic variants + the shared active-med gather getIntakeSafetyContext) and
// hands it to the pure engine (crossCheckPgx). The pure tier (lib/__tests__/pgx.test
// .ts) takes pre-gathered arrays and structurally can't see a gather bug (the wrong
// variant set, the wrong med set, an unfiltered result_type) — so this seeds a
// realistic fixture and asserts the END-TO-END finding, exactly like the #448
// builders.
//
// It also pins "one question, one computation": the SAME fixture yields the SAME
// finding on BOTH surfaces — the getPgxWarnings gather (the /medicine row notice) and
// the Upcoming finding (collectUpcoming) — so they can't drift.
//
// Fixtures are 100% synthetic (a throwaway per-file DB via setup.ts; obviously-fake
// variants). No AI, no network.

import { describe, it, expect } from "vitest";
import { db, today } from "@/lib/db";
import { getPgxWarnings, collectUpcoming, dismissFinding } from "@/lib/queries";
import { pgxSignalKey, pgxTitle, pgxDetail } from "@/lib/pgx";

function makeProfile(name: string): { profileId: number; todayStr: string } {
  const profileId = Number(
    db.prepare("INSERT INTO profiles (name) VALUES (?)").run(name)
      .lastInsertRowid
  );
  return { profileId, todayStr: today(profileId) };
}

// Insert an ACTIVE medication (kind='medication'), returning its id.
function addMedication(
  profileId: number,
  name: string,
  rxcui: string | null = null
): number {
  const id = Number(
    db
      .prepare(
        `INSERT INTO intake_items (profile_id, name, active, kind, priority)
         VALUES (?, ?, 1, 'medication', 'high')`
      )
      .run(profileId, name).lastInsertRowid
  );
  if (rxcui) {
    db.prepare("UPDATE intake_items SET rxcui = ? WHERE id = ?").run(rxcui, id);
  }
  return id;
}

// Insert a genomic variant, returning its id.
function addVariant(
  profileId: number,
  v: {
    gene: string;
    star_allele?: string | null;
    genotype?: string | null;
    significance?: string | null;
    result_type?: string;
    interpretation?: string | null;
  }
): number {
  return Number(
    db
      .prepare(
        `INSERT INTO genomic_variants
           (profile_id, gene, star_allele, genotype, significance, result_type, interpretation)
         VALUES (?, ?, ?, ?, ?, ?, ?)`
      )
      .run(
        profileId,
        v.gene,
        v.star_allele ?? null,
        v.genotype ?? null,
        v.significance ?? null,
        v.result_type ?? "pharmacogenomic",
        v.interpretation ?? null
      ).lastInsertRowid
  );
}

describe("getPgxWarnings — the CYP2C19 poor × clopidogrel fixture (#710)", () => {
  it("flags the affected medication end-to-end, on both surfaces, with the CPIC note", () => {
    const { profileId, todayStr } = makeProfile("pgx-flag");
    addVariant(profileId, {
      gene: "CYP2C19",
      star_allele: "*2/*2",
      result_type: "pharmacogenomic",
      interpretation: "Poor metabolizer",
    });
    const medId = addMedication(profileId, "Clopidogrel", "32968");

    // Surface 1: the /medicine gather.
    const warnings = getPgxWarnings(profileId);
    expect(warnings).toHaveLength(1);
    const hit = warnings[0];
    expect(hit.gene).toBe("CYP2C19");
    expect(hit.phenotype).toBe("poor");
    expect(hit.medId).toBe(medId);
    expect(hit.severity).toBe("high");
    expect(hit.dedupeKey).toBe(pgxSignalKey(medId, "CYP2C19", "poor"));
    expect(pgxDetail(hit)).toContain(
      "Informational — discuss with your prescriber before any change"
    );
    expect(pgxDetail(hit)).toMatch(/Source: CPIC/);

    // Surface 2: the Upcoming finding — SAME dedupeKey + title/detail (one computation).
    const upcoming = collectUpcoming(profileId, todayStr);
    const item = upcoming.find((i) => i.key === hit.dedupeKey);
    expect(item, "PGx finding present on Upcoming").toBeTruthy();
    expect(item!.domain).toBe("pgx");
    expect(item!.title).toBe(pgxTitle(hit));
    expect(item!.detail).toBe(pgxDetail(hit));
  });

  it("dismissing the finding silences it on Upcoming (shared bus)", () => {
    const { profileId, todayStr } = makeProfile("pgx-dismiss");
    addVariant(profileId, {
      gene: "CYP2C19",
      star_allele: "*2/*2",
      interpretation: "Poor metabolizer",
    });
    const medId = addMedication(profileId, "Clopidogrel");
    const key = pgxSignalKey(medId, "CYP2C19", "poor");

    expect(
      collectUpcoming(profileId, todayStr).some((i) => i.key === key)
    ).toBe(true);
    dismissFinding(profileId, key);
    expect(
      collectUpcoming(profileId, todayStr).some((i) => i.key === key)
    ).toBe(false);
  });

  it("flags HLA-B*57:01 positive × abacavir as a contraindication (care-tier)", () => {
    const { profileId, todayStr } = makeProfile("pgx-hla");
    addVariant(profileId, {
      gene: "HLA-B",
      star_allele: "*57:01",
      result_type: "pharmacogenomic",
      interpretation: "Positive",
    });
    addMedication(profileId, "Abacavir");
    const warnings = getPgxWarnings(profileId);
    expect(warnings).toHaveLength(1);
    expect(warnings[0].severity).toBe("contraindicated");
    // Care-tier: it surfaces on Upcoming banded to Today (→ the attention hero).
    const item = collectUpcoming(profileId, todayStr).find(
      (i) => i.key === warnings[0].dedupeKey
    );
    expect(item?.band).toBe("today");
  });
});

describe("getPgxWarnings — the negative cases (#448 guards)", () => {
  it("a profile WITHOUT the variant gets nothing", () => {
    const { profileId } = makeProfile("pgx-novariant");
    addMedication(profileId, "Clopidogrel", "32968");
    expect(getPgxWarnings(profileId)).toEqual([]);
  });

  it("a hereditary-risk (non-pharmacogenomic) variant is ignored", () => {
    const { profileId } = makeProfile("pgx-othertype");
    // A BRCA1 pathogenic variant — routes to the cadence consumer (#711), NOT PGx.
    addVariant(profileId, {
      gene: "BRCA1",
      significance: "pathogenic",
      result_type: "hereditary-risk",
      interpretation: "Pathogenic variant reported",
    });
    // Even a CYP2C19 poor variant stored as the wrong result_type must not flag.
    addVariant(profileId, {
      gene: "CYP2C19",
      star_allele: "*2/*2",
      result_type: "other",
      interpretation: "Poor metabolizer",
    });
    addMedication(profileId, "Clopidogrel");
    expect(getPgxWarnings(profileId)).toEqual([]);
  });

  it("an INACTIVE (discontinued) medication is not in the stack", () => {
    const { profileId } = makeProfile("pgx-inactive");
    addVariant(profileId, {
      gene: "CYP2C19",
      star_allele: "*2/*2",
      interpretation: "Poor metabolizer",
    });
    const id = addMedication(profileId, "Clopidogrel");
    db.prepare("UPDATE intake_items SET active = 0 WHERE id = ?").run(id);
    expect(getPgxWarnings(profileId)).toEqual([]);
  });

  it("does not flag a supplement (only kind='medication' is in the med gather)", () => {
    const { profileId } = makeProfile("pgx-supplement");
    addVariant(profileId, {
      gene: "CYP2C19",
      star_allele: "*2/*2",
      interpretation: "Poor metabolizer",
    });
    // A supplement literally named to collide — the gather filters kind='medication'.
    db.prepare(
      `INSERT INTO intake_items (profile_id, name, active, kind, priority)
       VALUES (?, 'Clopidogrel', 1, 'supplement', 'low')`
    ).run(profileId);
    expect(getPgxWarnings(profileId)).toEqual([]);
  });

  it("scopes to the profile — another profile's variant does not leak", () => {
    const a = makeProfile("pgx-scope-a");
    const b = makeProfile("pgx-scope-b");
    addVariant(a.profileId, {
      gene: "CYP2C19",
      star_allele: "*2/*2",
      interpretation: "Poor metabolizer",
    });
    addMedication(b.profileId, "Clopidogrel"); // med on B, variant on A
    expect(getPgxWarnings(a.profileId)).toEqual([]);
    expect(getPgxWarnings(b.profileId)).toEqual([]);
  });
});
