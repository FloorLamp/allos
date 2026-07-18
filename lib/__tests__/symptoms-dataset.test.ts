import { describe, it, expect } from "vitest";
import {
  SYMPTOMS,
  symptomSlugs,
  symptomSlugsInDomain,
  symptomLabel,
  isCuratedSymptom,
  isCustomSymptomKey,
  resolveSymptomKey,
  normalizeSymptomName,
  severityLabel,
  isValidSeverity,
  SYMPTOM_SEVERITY_LEVELS,
  SYMPTOM_DOMAINS,
} from "@/lib/symptoms";

// Dataset test (the #799 "dataset-test treatment"): the curated symptom vocabulary is a
// committed, human-reviewable catalog, so this pins its structural invariants (every
// slug unique + snake_case + labelled) and the pure resolver/label discipline the write
// path and every surface depend on. No DB/network — pure tier.

describe("symptoms.json dataset", () => {
  it("has unique, snake_case slugs and a non-empty label per symptom", () => {
    const slugs = symptomSlugs();
    expect(new Set(slugs).size).toBe(slugs.length);
    for (const s of SYMPTOMS) {
      expect(s.slug, s.slug).toMatch(/^[a-z][a-z0-9_]*$/);
      expect(s.label.trim().length, s.slug).toBeGreaterThan(0);
      // icon is optional, but a present one must be a non-empty string.
      if (s.icon !== undefined) {
        expect(typeof s.icon).toBe("string");
        expect(s.icon.trim().length, s.slug).toBeGreaterThan(0);
      }
    }
  });

  it("tags every curated symptom with a valid domain (issue #714)", () => {
    for (const s of SYMPTOMS) {
      expect(SYMPTOM_DOMAINS, s.slug).toContain(s.domain);
    }
  });

  it("covers each context, and symptomSlugsInDomain partitions the catalog", () => {
    // Every domain leads with at least one slug (the per-mount "lead with these" list).
    for (const d of SYMPTOM_DOMAINS) {
      expect(symptomSlugsInDomain(d).length, d).toBeGreaterThan(0);
    }
    // The cycle context carries the everyday menstrual symptoms.
    expect(symptomSlugsInDomain("cycle")).toEqual(
      expect.arrayContaining([
        "cramps",
        "bloating",
        "breast_tenderness",
        "mood_swings",
        "low_back_pain",
      ])
    );
    // The domains partition the whole catalog with no overlap.
    const union = SYMPTOM_DOMAINS.flatMap((d) => symptomSlugsInDomain(d));
    expect(union.slice().sort()).toEqual(symptomSlugs().slice().sort());
    expect(new Set(union).size).toBe(union.length);
  });

  it("is a sensible size for a one-tap shortcut list", () => {
    expect(SYMPTOMS.length).toBeGreaterThanOrEqual(12);
    expect(SYMPTOMS.length).toBeLessThanOrEqual(40);
  });

  it("labels every curated slug and falls back to the key for an unknown one (#203)", () => {
    for (const s of SYMPTOMS) expect(symptomLabel(s.slug)).toBe(s.label);
    // A retired/custom key still renders — never throws.
    expect(symptomLabel("earache_custom")).toBe("earache_custom");
    expect(isCuratedSymptom("fever")).toBe(true);
    expect(isCuratedSymptom("earache_custom")).toBe(false);
    expect(isCustomSymptomKey("earache_custom")).toBe(true);
  });
});

describe("resolveSymptomKey", () => {
  it("collapses a curated slug or label (case-insensitive) onto the slug", () => {
    expect(resolveSymptomKey("fever")).toBe("fever");
    expect(resolveSymptomKey("Fever")).toBe("fever");
    expect(resolveSymptomKey("  SORE THROAT ")).toBe("sore_throat");
    expect(resolveSymptomKey("Sore throat")).toBe("sore_throat");
  });

  it("keeps a genuine custom name (normalized) and rejects empty", () => {
    expect(resolveSymptomKey("Migraine")).toBe("Migraine");
    expect(resolveSymptomKey("  Kid   fussy ")).toBe("Kid fussy");
    expect(resolveSymptomKey("")).toBeNull();
    expect(resolveSymptomKey("   ")).toBeNull();
  });

  it("normalizeSymptomName collapses whitespace and caps length", () => {
    expect(normalizeSymptomName(" a  b ")).toBe("a b");
    expect(normalizeSymptomName("x".repeat(200)).length).toBe(80);
  });
});

describe("symptom severity scale", () => {
  it("is the ordinal 1–4 scale with labels", () => {
    expect(SYMPTOM_SEVERITY_LEVELS.map((l) => l.value)).toEqual([1, 2, 3, 4]);
    expect(severityLabel(1)).toBe("Mild");
    expect(severityLabel(4)).toBe("Very severe");
    expect(severityLabel(9)).toBe("Level 9");
  });

  it("validates the range", () => {
    expect(isValidSeverity(1)).toBe(true);
    expect(isValidSeverity(4)).toBe(true);
    expect(isValidSeverity(0)).toBe(false);
    expect(isValidSeverity(5)).toBe(false);
    expect(isValidSeverity(2.5)).toBe(false);
  });
});
