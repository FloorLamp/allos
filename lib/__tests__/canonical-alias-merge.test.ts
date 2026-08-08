// PURE TIER — the #2306 decision: which canonical biomarker spellings a vocabulary
// has superseded, and what a stored reading of one should say instead.
//
// SYNTHETIC ONLY: every analyte name here is invented, and no value or date appears
// at all — this tier never touches a database.

import { describe, expect, it } from "vitest";
import {
  rewriteBiomarkerOutcomeKeys,
  supersededStoredNames,
  supersededVocabularyRows,
  type CanonicalVocabularyRow,
} from "@/lib/canonical-alias-merge";
import {
  buildCanonicalIndex,
  canonicalAliasRoutes,
  canonicalAliases,
  normalizeCanonicalKey,
  snapCanonicalName,
} from "@/lib/canonical-name";

// A curated route that actually ships, used to exercise the BLOCKED shape against
// the real alias table rather than a mock of it.
const [ALIAS_SOURCE, ALIAS_TARGET] = canonicalAliases()[0];

function seed(name: string): CanonicalVocabularyRow {
  return { name, source: "seed" };
}
function ai(name: string): CanonicalVocabularyRow {
  return { name, source: "ai" };
}

describe("canonicalAliasRoutes — the routes WITHOUT the real-entry block", () => {
  it("still routes a curated alias whose key an ai-coined row has claimed", () => {
    const vocab = [ALIAS_TARGET, ALIAS_SOURCE];
    // buildCanonicalIndex drops the route (the ai row owns the key) …
    expect(snapCanonicalName(ALIAS_SOURCE, vocab)).toBe(ALIAS_SOURCE);
    // … while the route set still knows where it wanted to go. That gap is the bug.
    const routes = canonicalAliasRoutes(vocab);
    expect(routes.get(normalizeCanonicalKey(ALIAS_SOURCE))).toBe(ALIAS_TARGET);
  });

  it("derives both the bare full name and the acronym of a 'Full Name (ABBR)' entry", () => {
    const routes = canonicalAliasRoutes(["Fictional Marker Level (FMLX)"]);
    expect(routes.get(normalizeCanonicalKey("Fictional Marker Level"))).toBe(
      "Fictional Marker Level (FMLX)"
    );
    expect(routes.get(normalizeCanonicalKey("FMLX"))).toBe(
      "Fictional Marker Level (FMLX)"
    );
  });

  it("does not mistake a word parenthetical for an abbreviation", () => {
    const routes = canonicalAliasRoutes(["Fictional Marker (Placeholder)"]);
    expect(routes.get(normalizeCanonicalKey("Fictional Marker"))).toBe(
      "Fictional Marker (Placeholder)"
    );
    expect(routes.has(normalizeCanonicalKey("Placeholder"))).toBe(false);
  });

  it("omits a route whose target is absent from the vocabulary", () => {
    expect(canonicalAliasRoutes([]).size).toBe(0);
  });
});

describe("supersededVocabularyRows", () => {
  it("retires the ai-coined row BLOCKING a curated alias, onto the alias target", () => {
    const merges = supersededVocabularyRows([
      seed(ALIAS_TARGET),
      ai(ALIAS_SOURCE),
    ]);
    expect(merges).toEqual([{ from: ALIAS_SOURCE, to: ALIAS_TARGET }]);
  });

  it("leaves the alias source alone when its TARGET is not in the vocabulary", () => {
    // The guarantee buildCanonicalIndex already makes: an alias can only add a route
    // to an analyte that exists. With no target there is nowhere to merge to, and
    // deleting the row would lose the vocabulary entry for nothing.
    expect(supersededVocabularyRows([ai(ALIAS_SOURCE)])).toEqual([]);
  });

  it("retires an ai-coined row SHADOWED by another entry (the Hyaline Casts shape)", () => {
    // Both spellings normalize to one key; seeds sort first, so the curated entry is
    // the winner and the ai-coined re-ordering of the same words is the loser.
    const merges = supersededVocabularyRows([
      seed("Casts, Fictional, Urine"),
      ai("Fictional Casts, Urine"),
    ]);
    expect(merges).toEqual([
      { from: "Fictional Casts, Urine", to: "Casts, Fictional, Urine" },
    ]);
  });

  it("never touches a curated row, even when it is the one being shadowed", () => {
    // Two seeded spellings of one key: whichever loses, this pass is not allowed to
    // delete it. `source = 'ai'` is the safety property.
    expect(
      supersededVocabularyRows([
        seed("Casts, Fictional, Urine"),
        seed("Fictional Casts, Urine"),
      ])
    ).toEqual([]);
  });

  it("leaves an ai-coined row that owns its key and blocks nothing", () => {
    expect(
      supersededVocabularyRows([seed("Fictional Marker"), ai("Other Marker")])
    ).toEqual([]);
  });

  it("retires a bare-full-name ai row onto its own 'Full Name (ABBR)' sibling", () => {
    // The auto-derived route is a real route, so a vocabulary carrying BOTH spellings
    // supersedes the bare one. The (ABBR) entry owns its own key and blocks nothing,
    // so it survives — and because it survives, the cycle filter (which drops any
    // merge whose target is itself retiring) has nothing to drop here.
    const merges = supersededVocabularyRows([
      ai("Fictional Marker Level (FMLX)"),
      ai("Fictional Marker Level"),
    ]);
    expect(merges).toEqual([
      {
        from: "Fictional Marker Level",
        to: "Fictional Marker Level (FMLX)",
      },
    ]);
  });
});

describe("supersededStoredNames", () => {
  const index = buildCanonicalIndex([
    "Casts, Fictional, Urine",
    "Fictional Marker Level (FMLX)",
  ]);

  it("re-points a stored spelling onto the vocabulary's spelling of the same key", () => {
    expect(supersededStoredNames(["Fictional Casts, Urine"], index)).toEqual([
      { from: "Fictional Casts, Urine", to: "Casts, Fictional, Urine" },
    ]);
  });

  it("re-points a bare abbreviation onto its spelled-out entry", () => {
    expect(supersededStoredNames(["FMLX"], index)).toEqual([
      { from: "FMLX", to: "Fictional Marker Level (FMLX)" },
    ]);
  });

  it("leaves a name that already IS the vocabulary spelling", () => {
    expect(supersededStoredNames(["Casts, Fictional, Urine"], index)).toEqual(
      []
    );
  });

  it("leaves a pure case variant — case is not a fork", () => {
    // Every SQL grouping over biomarker names is NOCASE or lowercased, so re-spelling
    // one would be churn with no series to unify.
    expect(supersededStoredNames(["casts, fictional, urine"], index)).toEqual(
      []
    );
  });

  it("leaves a name the vocabulary does not know at all", () => {
    expect(supersededStoredNames(["Entirely Unknown Analyte"], index)).toEqual(
      []
    );
  });

  it("de-dupes case variants of one stored spelling into a single merge", () => {
    expect(
      supersededStoredNames(
        ["Fictional Casts, Urine", "fictional casts, urine", "  "],
        index
      )
    ).toEqual([
      { from: "Fictional Casts, Urine", to: "Casts, Fictional, Urine" },
    ]);
  });
});

describe("rewriteBiomarkerOutcomeKeys", () => {
  it("rewrites the biomarker outcome key and leaves every other key alone", () => {
    expect(
      rewriteBiomarkerOutcomeKeys(
        JSON.stringify(["metric:weight", "biomarker:Old Spelling"]),
        "Old Spelling",
        "New Spelling"
      )
    ).toBe(JSON.stringify(["metric:weight", "biomarker:New Spelling"]));
  });

  it("collapses onto a target the protocol already selected instead of duplicating", () => {
    expect(
      rewriteBiomarkerOutcomeKeys(
        JSON.stringify(["biomarker:New Spelling", "biomarker:Old Spelling"]),
        "Old Spelling",
        "New Spelling"
      )
    ).toBe(JSON.stringify(["biomarker:New Spelling"]));
  });

  it("returns null (no UPDATE) when the row never mentioned the old spelling", () => {
    expect(
      rewriteBiomarkerOutcomeKeys(
        JSON.stringify(["index:phenoage"]),
        "Old Spelling",
        "New Spelling"
      )
    ).toBeNull();
  });

  it("returns null for a corrupt or non-array column rather than rewriting it", () => {
    expect(rewriteBiomarkerOutcomeKeys("{", "a", "b")).toBeNull();
    expect(rewriteBiomarkerOutcomeKeys('"nope"', "a", "b")).toBeNull();
  });
});
