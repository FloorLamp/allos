import { describe, it, expect } from "vitest";
import {
  foldVocabularyName,
  matchFoldedVocabulary,
  sameVocabularyName,
} from "../vocabulary-fold";
import { resolveSymptomKey, symptomLabel } from "../symptoms";
import { resolveSubstanceKey, substanceLabel } from "../substance-use";

// The shared fold behind BOTH free-text vocabularies (#3325). The tests that matter
// here are the ones that pin the PAIR — a fold applied to one domain would re-fork the
// model #3323 unified, and a test that only shows "kratom" resolving to "kratom" cannot
// tell a real fold from a lucky lowercase.

describe("foldVocabularyName", () => {
  it("folds case and the whitespace the normalizers already collapse", () => {
    expect(foldVocabularyName("Kratom")).toBe("kratom");
    expect(foldVocabularyName("  KRATOM  ")).toBe("kratom");
    expect(foldVocabularyName("Energy   Drinks")).toBe("energy drinks");
  });

  it("is never a display value — it is only ever compared", () => {
    // The guard against the OTHER bug: folding for display would render "MDMA" as
    // "mdma". Nothing in the fold module returns a key, and the two label functions
    // below prove the stored spelling survives end to end.
    expect(foldVocabularyName("MDMA")).toBe("mdma");
    expect(symptomLabel("MDMA")).toBe("MDMA");
    expect(substanceLabel("MDMA")).toBe("MDMA");
  });
});

describe("sameVocabularyName", () => {
  it("collapses case and spacing, and nothing else", () => {
    expect(sameVocabularyName("Kratom", "kratom")).toBe(true);
    expect(sameVocabularyName(" kava  tea ", "Kava Tea")).toBe(true);
    expect(sameVocabularyName("kratom", "kava")).toBe(false);
    // Exclusion discipline: a fold is not a fuzzy match. Distinct names stay apart.
    expect(sameVocabularyName("kratom", "kratoms")).toBe(false);
  });
});

describe("matchFoldedVocabulary", () => {
  it("hands back the FIRST-SEEN spelling, not the typed one", () => {
    expect(matchFoldedVocabulary("KRATOM", ["Kratom", "kava"])).toBe("Kratom");
    expect(matchFoldedVocabulary("mdma", ["MDMA"])).toBe("MDMA");
  });

  it("is first-match, so vocabulary ORDER decides which spelling wins", () => {
    // The store enumerates oldest ledger row first, which is what makes "first-seen"
    // mean first-seen rather than most-recent.
    expect(matchFoldedVocabulary("kratom", ["Kratom", "KRATOM"])).toBe(
      "Kratom"
    );
    expect(matchFoldedVocabulary("kratom", ["KRATOM", "Kratom"])).toBe(
      "KRATOM"
    );
  });

  it("answers null when the profile has no spelling of it", () => {
    expect(matchFoldedVocabulary("kratom", ["kava"])).toBeNull();
    expect(matchFoldedVocabulary("", ["kratom"])).toBeNull();
    expect(matchFoldedVocabulary("   ", ["kratom"])).toBeNull();
  });
});

// ---- The pair, in three casings, in BOTH vocabularies -----------------------
//
// The acceptance criterion #3325 states: the same word in three casings resolves to ONE
// key with ONE label. Both domains are asserted from one table so neither can be fixed
// or broken alone.

const DOMAINS = [
  {
    name: "symptom",
    resolve: resolveSymptomKey,
    label: symptomLabel,
    curatedTyped: "Fever",
    curatedKey: "fever",
  },
  {
    name: "substance",
    resolve: resolveSubstanceKey,
    label: substanceLabel,
    curatedTyped: "Alcohol",
    curatedKey: "alcohol",
  },
] as const;

describe.each(DOMAINS)(
  "$name vocabulary — fold for matching, preserve for display",
  ({ resolve, label, curatedTyped, curatedKey }) => {
    it("resolves three casings of one custom name to one key with one label", () => {
      const known = ["Kratom"]; // the profile's first-seen spelling
      const keys = ["Kratom", "kratom", "KRATOM"].map((typed) =>
        resolve(typed, known)
      );
      expect(new Set(keys).size).toBe(1);
      expect(keys[0]).toBe("Kratom");
      expect(new Set(keys.map((k) => label(k!))).size).toBe(1);
      expect(label(keys[0]!)).toBe("Kratom");
    });

    it("keeps an all-caps name in capitals, from every casing typed after it", () => {
      // The regression this issue names explicitly: "MDMA" must not become "Mdma".
      const known = ["MDMA"];
      for (const typed of ["MDMA", "mdma", "Mdma"]) {
        expect(resolve(typed, known)).toBe("MDMA");
        expect(label(resolve(typed, known)!)).toBe("MDMA");
      }
    });

    it("stores a brand-new name exactly as typed", () => {
      // Nothing folds into storage: with no existing spelling, the person's own
      // capitalization IS the label.
      expect(resolve("MDMA", [])).toBe("MDMA");
      expect(resolve("Kratom", ["kava"])).toBe("Kratom");
      expect(resolve("Energy   Drinks", [])).toBe("Energy Drinks");
    });

    it("still collapses a typed curated label onto its curated key", () => {
      // The pre-existing curated collapse runs BEFORE the fold is consulted, so a
      // profile's own spelling can never shadow the catalog.
      expect(resolve(curatedTyped, ["Kratom"])).toBe(curatedKey);
      expect(resolve(curatedKey, ["Kratom"])).toBe(curatedKey);
    });

    it("behaves exactly as before when no vocabulary is supplied", () => {
      // The client-side pre-flight has no ledger to consult; it must not start
      // inventing keys of its own.
      expect(resolve("Kratom")).toBe("Kratom");
      expect(resolve("kratom")).toBe("kratom");
      expect(resolve("")).toBeNull();
      expect(resolve("   ")).toBeNull();
    });

    it("does not fold two genuinely different names together", () => {
      expect(resolve("kava", ["Kratom"])).toBe("kava");
      expect(resolve("Kratom tea", ["Kratom"])).toBe("Kratom tea");
    });
  }
);
