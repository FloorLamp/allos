import { describe, it, expect } from "vitest";
import {
  prnDefaultEntries,
  prnDefaultsFor,
  prnLabelIdentityFor,
  prnProductsNamedIn,
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
    const hit = prnDefaultsFor({ name: "Advil 200mg", rxcui: "5640" });
    expect(hit?.slug).toBe("ibuprofen");
  });

  it("matches by ingredient CUI in the cached ingredient list (#279)", () => {
    const hit = prnDefaultsFor({
      name: "Resolved product",
      rxcui: "99999",
      rxcuiIngredients: ["161"],
    });
    expect(hit?.slug).toBe("acetaminophen");
  });

  it("distinguishes an unresolved bottle link from an unlinked display name", () => {
    const base = {
      name: "Acetaminophen",
      rxcui: null,
      rxcuiIngredients: null,
    };
    expect(
      prnLabelIdentityFor({ ...base, supplyId: null, supplyName: null }).name
    ).toBe("Acetaminophen");
    expect(
      prnLabelIdentityFor({ ...base, supplyId: "99", supplyName: null }).name
    ).toBe("");
    expect(
      prnLabelIdentityFor({
        ...base,
        supplyId: "99",
        supplyName: "Acetaminophen with Codeine",
      }).name
    ).toBe("Acetaminophen with Codeine");

    const confirmed = prnLabelIdentityFor({
      ...base,
      supplyId: "99",
      supplyName: null,
      rxcui: "5640",
      rxcuiIngredients: ["5640"],
    });
    expect(confirmed.name).toBe("");
    expect(prnDefaultsFor(confirmed)?.slug).toBe("ibuprofen");
  });

  it("falls back to a name/synonym match when no CUI", () => {
    expect(prnDefaultsFor({ name: "Advil", rxcui: null })?.slug).toBe(
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
    { name: "Tylenol with Codeine", rxcui: null },
    { name: "Tylenol 300 mg / Codeine 30 mg", rxcui: null },
    { name: "Tylenol PM", rxcui: null },
    { name: "Tylenol+", rxcui: null },
    { name: "Advil 200mg", rxcui: null },
    { name: "Tylenol", rxcui: "99999", rxcuiIngredients: ["161", "2670"] },
    { name: "Tylenol", rxcui: "2670" },
  ])(
    "declines label defaults without a matching complete identity: $name",
    (item) => {
      expect(prnDefaultsFor(item)).toBeNull();
    }
  );

  it("returns null for an unknown ingredient", () => {
    expect(prnDefaultsFor({ name: "Metformin", rxcui: null })).toBeNull();
  });
});

// ── #5230 ruling 9's IDENTITY detector ──────────────────────────────────────────
//
// A different question from `prnDefaultsFor` above. Derivation asks "what may this
// bottle's dose be taken from" and keeps its strict whole-name match; DETECTION asks
// "what does this name say the bottle IS", and it has to answer for a name nobody typed
// exactly — `Kirkland Ibuprofen 200 mg` detects ibuprofen and derives nothing.
//
// Every row below names the wrong implementation it rules out. A control that cannot
// tell the correct rule from a specific broken one is not a control, and the pairing
// this issue kept prescribing (`Aspirin-free pain relief` with a `Sugar-free ibuprofen`
// control) is green under a rule with no `-free` leg AND under a rule with no
// `no`/`without` leg — which is why N1, N2, N3, N6 and N7 exist.
describe("prnProductsNamedIn — what the name says the bottle is (#5230)", () => {
  const slugs = (name: string): string[] =>
    prnProductsNamedIn(name).map((e) => e.slug);

  it.each([
    {
      id: "N1",
      name: "Non-Aspirin Pain Reliever",
      expected: [],
      rulesOut:
        "a `free`-only guard: returns aspirin on an acetaminophen product",
    },
    {
      id: "N2",
      name: "No aspirin formula",
      expected: [],
      rulesOut: "a guard honouring `non` and `free` but dropping `no`",
    },
    {
      id: "N3",
      name: "Cold relief without acetaminophen",
      expected: [],
      rulesOut: "a guard honouring `non` and `free` but dropping `without`",
    },
    {
      id: "N4",
      name: "Aspirin-free pain relief",
      expected: [],
      rulesOut: "a preceded-only guard, with no trailing `free` leg at all",
    },
    {
      id: "N5",
      name: "Sugar-free ibuprofen",
      expected: ["ibuprofen"],
      rulesOut:
        "a symmetric `free anywhere negates` guard — it kills the commonest shelf modifier there is",
    },
    {
      id: "N6",
      name: "Non-aspirin pain reliever with ibuprofen",
      expected: ["ibuprofen"],
      rulesOut:
        "a `negator anywhere in the name` guard; nothing else here tells adjacency from presence",
    },
    {
      id: "N7",
      name: "Acetylsalicylic acid-free rub",
      expected: [],
      rulesOut:
        "adjacency read off the synonym's FIRST token instead of its last — the one multi-token synonym with no shorter sibling inside it",
    },
    {
      id: "N8",
      name: "Ibuprofen 200 mg",
      expected: ["ibuprofen"],
      rulesOut: "a detector that never matches — ruling 9's own control",
    },
  ])("$id $name → $expected (rules out $rulesOut)", ({ name, expected }) => {
    expect(slugs(name)).toEqual(expected);
  });

  // Ruling 10 has to COUNT the products a name lists, which a boolean cannot do.
  it("returns entries, and a combination name returns two of them", () => {
    const hits = prnProductsNamedIn("Advil Dual Action with Acetaminophen");
    expect(hits.map((e) => e.slug).sort()).toEqual([
      "acetaminophen",
      "ibuprofen",
    ]);
    expect(hits[0].label).toBeTruthy();
  });

  // Rules out carrying `isAntipyreticIntakeItem`'s CUI leg into the detector: the
  // mismatch check would compare the source's stored code to itself, and #5230's state B
  // would be unreachable. The detector reads the NAME and nothing else.
  it("detects from the name only — a stored code is not a detection", () => {
    expect(slugs("Mira's painkillers")).toEqual([]);
    expect(
      prnDefaultsFor({ name: "Mira's painkillers", rxcui: "5640" })?.slug
    ).toBe("ibuprofen");
  });

  // Detection is looser than derivation, deliberately, and neither loosens the other.
  it("detects a name the strict dose matcher declines", () => {
    expect(slugs("Kirkland Ibuprofen 200 mg")).toEqual(["ibuprofen"]);
    expect(
      prnDefaultsFor({ name: "Kirkland Ibuprofen 200 mg", rxcui: null })
    ).toBeNull();
  });
});
