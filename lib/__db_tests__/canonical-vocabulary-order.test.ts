// DB INTEGRATION TIER — getCanonicalVocabulary orders curated names before
// ai-coined ones (#918). The extraction prompt injects only the first VOCAB_CAP
// names, so a DB that has accumulated many ai-coined names must not crowd the
// curated vocabulary out of the prompt; and buildCanonicalIndex resolves a key
// collision to the first spelling, so a curated name must win over an ai-coined one.

import { describe, it, expect } from "vitest";
import {
  getCanonicalVocabulary,
  addCanonicalNames,
} from "@/lib/queries/medical";

describe("getCanonicalVocabulary — curated names first", () => {
  it("places every seeded name ahead of an ai-coined one, regardless of the alphabet", () => {
    // An ai-coined name that sorts alphabetically FIRST. If ordering were plain
    // alphabetical it would head the list (and, past the cap, push curated names
    // out); curated-first must place it after the whole seeded block.
    addCanonicalNames(["Aaa Ai Coined Marker"]);
    const vocab = getCanonicalVocabulary();

    const aiIdx = vocab.indexOf("Aaa Ai Coined Marker");
    expect(aiIdx).toBeGreaterThan(-1);

    // A seeded name that sorts alphabetically AFTER the ai name still comes BEFORE
    // it — proving the order is by source, not the alphabet.
    const seededLate = vocab.indexOf("White Blood Cell Count");
    expect(seededLate).toBeGreaterThan(-1);
    expect(seededLate).toBeLessThan(aiIdx);
  });
});
