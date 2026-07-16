import { describe, it, expect } from "vitest";
import {
  illnessThresholdEntries,
  illnessThresholdFor,
  allThresholdSlugsAreCurated,
} from "@/lib/illness-thresholds";
import { isCuratedSymptom, symptomSlugs } from "@/lib/symptoms";

// Dataset test for the curated, CITED illness-care thresholds (#805) — the #798
// prn-defaults treatment: every entry cites a source, is keyed by a real #799
// curated symptom slug, and carries at least one firing rule. The load-bearing
// safety invariants: no entry outside the vocabulary (a threshold that can never
// match a logged row), and the age band is present ONLY where the source publishes
// one (fever's infant rule) with its OWN source.

describe("illness-thresholds dataset", () => {
  const entries = illnessThresholdEntries();

  it("has entries and every one cites a source + a real curated slug + a label", () => {
    expect(entries.length).toBeGreaterThan(0);
    for (const e of entries) {
      expect(e.source, `${e.slug} must cite a source`).toBeTruthy();
      expect(e.label, `${e.slug} must have a label`).toBeTruthy();
      expect(isCuratedSymptom(e.slug), `${e.slug} is a #799 slug`).toBe(true);
    }
  });

  it("every dataset slug is inside the #799 vocabulary", () => {
    expect(allThresholdSlugsAreCurated()).toBe(true);
    const vocab = new Set(symptomSlugs());
    for (const e of entries) expect(vocab.has(e.slug)).toBe(true);
  });

  it("every entry carries at least one firing rule with valid numbers", () => {
    for (const e of entries) {
      const hasRule = !!(e.duration || e.trajectory || e.infantRule);
      expect(
        hasRule,
        `${e.slug} must have a duration/trajectory/infant rule`
      ).toBe(true);
      if (e.duration) {
        expect(e.duration.days, `${e.slug} duration.days`).toBeGreaterThan(0);
        expect(e.duration.line, `${e.slug} duration.line`).toBeTruthy();
      }
      if (e.trajectory) {
        expect(e.trajectory.days, `${e.slug} trajectory.days`).toBeGreaterThan(
          0
        );
        expect(e.trajectory.line, `${e.slug} trajectory.line`).toBeTruthy();
      }
    }
  });

  it("fever is age-banded with its OWN infant-rule source (the source's band, not ours)", () => {
    const fever = entries.find((e) => e.slug === "fever");
    expect(fever, "fever entry present").toBeTruthy();
    expect(fever!.duration, "fever has an adult duration line").toBeTruthy();
    expect(fever!.infantRule, "fever has an infant band").toBeTruthy();
    expect(fever!.infantRule!.maxAgeMonths).toBeGreaterThan(0);
    expect(fever!.infantRule!.line).toBeTruthy();
    // The band cites its OWN source (a stricter pediatric guideline), not the
    // adult label — age bands are the source's, never computed.
    expect(fever!.infantRule!.source).toBeTruthy();
  });

  it("no entry for a symptom outside the dataset ⇒ lookup is null (no finding, ever)", () => {
    // A curated slug the dataset intentionally omits.
    expect(illnessThresholdFor("headache")).toBeNull();
    // A custom free-text symptom.
    expect(illnessThresholdFor("weird custom symptom")).toBeNull();
    // A present slug resolves.
    expect(illnessThresholdFor("fever")?.slug).toBe("fever");
  });
});
