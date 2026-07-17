import { describe, expect, it } from "vitest";
import {
  detectInteractions,
  interactionSignalKey,
  interactionTitle,
  type InteractionItem,
} from "@/lib/drug-interactions";
import {
  crossCheckPgx,
  pgxSignalKey,
  type PgxVariantInput,
  type PgxMedInput,
} from "@/lib/pgx";

// Behavior-preservation pins for the drug-interactions + PGx migration onto the
// curated-dataset framework (issue #860 wave 2, unit 3). These datasets back the #144
// interaction warnings and the #710 PGx cross-check; the migration reshaped the JSON
// into a framework envelope and re-sourced the detectors through it, but the DETECTION
// OUTPUT for representative inputs must be byte-identical. This file pins the exact
// warnings — severity, title/gene, dedupeKey — a representative stack produces, so a
// data reshape that quietly changed a warning fails here. Synthetic items only, no PHI.

function item(
  id: number,
  name: string,
  opts: { rxcui?: string | null; active?: boolean } = {}
): InteractionItem {
  return {
    id,
    name,
    rxcui: opts.rxcui ?? null,
    active: opts.active ?? true,
  };
}

describe("drug-interaction detection is behavior-preserving", () => {
  it("flags the flagship pairs at their exact severities (name-matched)", () => {
    const items = [
      item(1, "Warfarin"),
      item(2, "Ibuprofen 200mg"),
      item(3, "Nitroglycerin"),
      item(4, "Sildenafil"),
      item(5, "Sertraline"),
      item(6, "Phenelzine"),
      item(7, "Simvastatin"),
      item(8, "Clarithromycin"),
      item(9, "St. John's Wort"),
      item(10, "Acetaminophen"),
    ];
    const hits = detectInteractions(items);
    const byPair = new Map(
      hits.map((h) => [interactionSignalKey(h.aId, h.bId), h])
    );
    const sev = (a: number, b: number) =>
      byPair.get(interactionSignalKey(a, b))?.severity;

    expect(sev(1, 2)).toBe("major"); // warfarin × NSAID
    expect(sev(3, 4)).toBe("major"); // nitrate × PDE5 inhibitor
    expect(sev(5, 6)).toBe("major"); // SSRI × MAOI
    expect(sev(7, 8)).toBe("major"); // CYP3A4 statin × macrolide
    expect(sev(1, 9)).toBe("major"); // warfarin × St. John's Wort (supplement)
    expect(sev(1, 10)).toBe("moderate"); // warfarin × acetaminophen (chronic)
    // A pair with no rule stays silent.
    expect(byPair.has(interactionSignalKey(2, 10))).toBe(false); // NSAID × acetaminophen
  });

  it("titles + dedupeKeys are stable and id-pair keyed", () => {
    const hits = detectInteractions([
      item(11, "Warfarin"),
      item(22, "Ibuprofen"),
    ]);
    expect(hits).toHaveLength(1);
    expect(interactionTitle(hits[0])).toBe("Warfarin + Ibuprofen");
    expect(hits[0].dedupeKey).toBe("interaction:11-22");
  });

  it("still resolves by RxCUI when the name is unhelpful", () => {
    const hits = detectInteractions([
      item(1, "Generic tablet A", { rxcui: "11289" }), // warfarin
      item(2, "Generic tablet B", { rxcui: "5640" }), // ibuprofen (an NSAID)
    ]);
    expect(hits).toHaveLength(1);
    expect(hits[0].severity).toBe("major");
  });

  it("excludes inactive items from the stack", () => {
    const hits = detectInteractions([
      item(1, "Warfarin"),
      item(2, "Ibuprofen", { active: false }),
    ]);
    expect(hits).toHaveLength(0);
  });
});

function variant(
  v: Partial<PgxVariantInput> & { id: number; gene: string }
): PgxVariantInput {
  return {
    id: v.id,
    gene: v.gene,
    star_allele: v.star_allele ?? null,
    genotype: v.genotype ?? null,
    variant: v.variant ?? null,
    interpretation: v.interpretation ?? null,
    notes: v.notes ?? null,
  };
}

function med(
  id: number,
  name: string,
  rxcui: string | null = null
): PgxMedInput {
  return { id, name, rxcui, rxcuiIngredients: null };
}

describe("PGx cross-check is behavior-preserving", () => {
  it("flags a stated-phenotype pair at its exact severity + dedupeKey", () => {
    const hits = crossCheckPgx(
      [
        variant({
          id: 5,
          gene: "CYP2C19",
          interpretation: "Intermediate metabolizer",
        }),
      ],
      [med(9, "Clopidogrel")]
    );
    expect(hits).toHaveLength(1);
    expect(hits[0].severity).toBe("high");
    expect(hits[0].gene).toBe("CYP2C19");
    expect(hits[0].medName).toBe("Clopidogrel");
    expect(hits[0].dedupeKey).toBe(pgxSignalKey(9, "CYP2C19", "intermediate"));
  });

  it("derives poor metabolizer from a diplotype and flags it", () => {
    const hits = crossCheckPgx(
      [variant({ id: 1, gene: "CYP2D6", star_allele: "*4/*4" })],
      [med(2, "Codeine")]
    );
    expect(hits).toHaveLength(1);
    expect(hits[0].severity).toBe("high"); // CYP2D6 poor × codeine
    expect(hits[0].phenotype).toBe("poor");
  });

  it("flags a risk MARKER (HLA-B*57:01) as positive/contraindicated", () => {
    const hits = crossCheckPgx(
      [
        variant({
          id: 3,
          gene: "HLA-B",
          interpretation: "HLA-B*57:01 positive",
        }),
      ],
      [med(4, "Abacavir")]
    );
    expect(hits).toHaveLength(1);
    expect(hits[0].severity).toBe("contraindicated");
    expect(hits[0].phenotype).toBeNull();
    expect(hits[0].dedupeKey).toBe(pgxSignalKey(4, "HLA-B", "positive"));
  });

  it("never flags a NEGATED marker report", () => {
    const hits = crossCheckPgx(
      [
        variant({
          id: 3,
          gene: "HLA-B",
          interpretation: "HLA-B*57:01 negative",
        }),
      ],
      [med(4, "Abacavir")]
    );
    expect(hits).toHaveLength(0);
  });

  it("returns nothing when the med isn't in the affected stack", () => {
    const hits = crossCheckPgx(
      [variant({ id: 5, gene: "CYP2C19", interpretation: "Poor metabolizer" })],
      [med(9, "Ibuprofen")]
    );
    expect(hits).toHaveLength(0);
  });
});
