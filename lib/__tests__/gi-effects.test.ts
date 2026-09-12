import { describe, expect, it } from "vitest";
import {
  GI_EFFECTS,
  GI_SYMPTOM_EFFECTS,
  LOOSE_STOOLS_EFFECT,
  LOOSE_STOOL_MIN_TYPE,
  giEffectBySlug,
  isGiEffect,
  isLooseStoolType,
} from "@/lib/gi-effects";
import { GI_PANEL_SYMPTOMS } from "@/lib/fiber-symptom-panel";
import { BRISTOL_STOOL_TYPES } from "@/lib/bristol-stool";
import { symptomBySlug } from "@/lib/symptoms";

// The shared GI vocabulary (#5865). The claims worth pinning are the ones that make it
// a SHARED list rather than two lists that happen to agree today.

describe("the vocabulary", () => {
  it("every symptom effect resolves to a curated symptom slug (a rename cannot silently drop one)", () => {
    for (const slug of GI_SYMPTOM_EFFECTS) {
      expect(symptomBySlug(slug), slug).toBeTruthy();
    }
    expect(GI_SYMPTOM_EFFECTS.length).toBeGreaterThan(0);
  });

  it("is the fiber panel's list — one vocabulary, not two that agree", () => {
    // The panel reads the SYMPTOM arm: the stool effect is an instant-grain observation
    // in another store and nothing the panel's symptom input could ever hold.
    expect([...GI_PANEL_SYMPTOMS]).toEqual([...GI_SYMPTOM_EFFECTS]);
  });

  it("takes each symptom's label from the curated catalog rather than retyping it", () => {
    for (const slug of GI_SYMPTOM_EFFECTS) {
      expect(giEffectBySlug(slug)?.label).toBe(symptomBySlug(slug)!.label);
    }
  });

  it("carries the stool effect, which is not a symptom and says so", () => {
    const loose = giEffectBySlug(LOOSE_STOOLS_EFFECT);
    expect(loose?.source).toBe("stool");
    expect(loose?.label).toBe("Loose stools");
    // The distinction that keeps a reader from asking symptom_logs for a Bristol type.
    expect(symptomBySlug(LOOSE_STOOLS_EFFECT)).toBeUndefined();
    expect(GI_SYMPTOM_EFFECTS).not.toContain(LOOSE_STOOLS_EFFECT);
    for (const slug of GI_SYMPTOM_EFFECTS) {
      expect(giEffectBySlug(slug)?.source).toBe("symptom");
    }
  });

  it("holds every member exactly once, and answers for nothing else", () => {
    const slugs = GI_EFFECTS.map((e) => e.slug);
    expect(new Set(slugs).size).toBe(slugs.length);
    expect(slugs).toHaveLength(GI_SYMPTOM_EFFECTS.length + 1);
    for (const slug of slugs) expect(isGiEffect(slug)).toBe(true);
    expect(isGiEffect("heartburn")).toBe(false);
    expect(isGiEffect("")).toBe(false);
    expect(giEffectBySlug("heartburn")).toBeUndefined();
  });
});

describe("what counts as a loose stool (#2785)", () => {
  it("is Bristol 6 and 7, and not the soft-but-normal 5", () => {
    expect(isLooseStoolType(5)).toBe(false);
    expect(isLooseStoolType(6)).toBe(true);
    expect(isLooseStoolType(7)).toBe(true);
  });

  it("names a type the published scale actually has", () => {
    // A threshold above the scale's top would make the effect uncountable and silent.
    expect(
      BRISTOL_STOOL_TYPES.map((t) => t.type).filter(isLooseStoolType)
    ).toEqual([6, 7]);
    expect(
      BRISTOL_STOOL_TYPES.some((t) => t.type === LOOSE_STOOL_MIN_TYPE)
    ).toBe(true);
  });
});
