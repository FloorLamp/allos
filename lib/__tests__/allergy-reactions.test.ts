// PURE TIER (issue #1405) — the allergy manifestation composition and the
// verification-status decision that every safety consumer shares.

import { describe, expect, it } from "vitest";
import {
  allergyCriticalityLabel,
  allergyReactionSummary,
  allergyVerificationLabel,
  composeAllergyReactions,
  isAllergyActionable,
  isHighCriticality,
} from "@/lib/allergy-reactions";
import {
  allergyCriticalityRank,
  buildEmergencyCard,
} from "@/lib/emergency-card";

describe("composeAllergyReactions", () => {
  it("returns the child rows in position order when the allergy has any", () => {
    expect(
      composeAllergyReactions({ reaction: "Hives", severity: "mild" }, [
        { manifestation: "Anaphylaxis", severity: "severe", position: 1 },
        { manifestation: "Hives", severity: "mild", position: 0 },
      ])
    ).toEqual([
      { manifestation: "Hives", severity: "mild" },
      { manifestation: "Anaphylaxis", severity: "severe" },
    ]);
  });

  it("falls back to the parent's cached scalar for a row with no child rows (an imported allergy)", () => {
    expect(
      composeAllergyReactions(
        { reaction: "  Rash  ", severity: "moderate" },
        []
      )
    ).toEqual([{ manifestation: "Rash", severity: "moderate" }]);
  });

  it("is empty when neither the child rows nor the scalar say anything", () => {
    expect(composeAllergyReactions({ reaction: null, severity: null })).toEqual(
      []
    );
    expect(
      composeAllergyReactions({ reaction: "   ", severity: "mild" })
    ).toEqual([]);
  });
});

describe("allergyReactionSummary", () => {
  it("prints a graded manifestation with its grade and an ungraded one bare", () => {
    expect(
      allergyReactionSummary([
        { manifestation: "Hives", severity: "mild" },
        { manifestation: "Swelling", severity: null },
      ])
    ).toBe("Hives (mild) · Swelling");
  });

  it("is empty for no manifestations", () => {
    expect(allergyReactionSummary([])).toBe("");
  });
});

describe("isAllergyActionable — what an allergy is allowed to gate", () => {
  it("treats an UNSTATED verification status as actionable (every legacy row means unstated)", () => {
    expect(isAllergyActionable({ verification_status: null })).toBe(true);
  });

  it("keeps confirmed / suspected / unconfirmed screening", () => {
    for (const v of ["confirmed", "suspected", "unconfirmed"] as const)
      expect(isAllergyActionable({ verification_status: v })).toBe(true);
  });

  it("stops a refuted or entered-in-error allergy from gating anything", () => {
    expect(isAllergyActionable({ verification_status: "refuted" })).toBe(false);
    expect(
      isAllergyActionable({ verification_status: "entered-in-error" })
    ).toBe(false);
  });
});

describe("criticality", () => {
  it("only an explicit 'high' is high — 'unable-to-assess' is not a claim of danger", () => {
    expect(isHighCriticality({ criticality: "high" })).toBe(true);
    expect(isHighCriticality({ criticality: "unable-to-assess" })).toBe(false);
    expect(isHighCriticality({ criticality: null })).toBe(false);
  });

  it("labels an unstated value as null rather than inventing one", () => {
    expect(allergyCriticalityLabel(null)).toBeNull();
    expect(allergyCriticalityLabel("high")).toBe("High criticality");
    expect(allergyVerificationLabel(null)).toBeNull();
    expect(allergyVerificationLabel("refuted")).toBe("Refuted");
  });

  it("ranks a high-criticality allergy ahead of an unstated one on the emergency card", () => {
    expect(allergyCriticalityRank("high")).toBeLessThan(
      allergyCriticalityRank(null)
    );
    expect(allergyCriticalityRank("unable-to-assess")).toBe(
      allergyCriticalityRank("low")
    );
  });
});

describe("emergency card ordering", () => {
  it("leads with a HIGH-criticality allergy even when its reaction text reads mild", () => {
    const card = buildEmergencyCard({
      name: "Test Subject",
      age: null,
      sex: null,
      birthdate: null,
      manualBloodType: null,
      derivedBloodType: null,
      allergies: [
        { substance: "Dust mite", reaction: "Anaphylaxis", severity: "severe" },
        {
          substance: "Penicillin",
          reaction: "Rash",
          severity: "mild",
          criticality: "high",
        },
      ],
      medications: [],
      conditions: [],
      contact: null,
      generatedAt: "2020-01-02T03:04:05.000Z",
    });
    expect(card.allergies.map((a) => a.substance)).toEqual([
      "Penicillin",
      "Dust mite",
    ]);
  });
});
