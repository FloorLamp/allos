import { describe, it, expect } from "vitest";
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { buildBiomarkerSupplementMap } from "@/scripts/gen-biomarker-supplement-map";
import { curatedSupplementBiomarkers } from "@/lib/supplement-suggest-curated";
import canonicalSeed from "@/lib/canonical-biomarkers.json";
import { FOOD_DRUG_INTERACTIONS } from "@/lib/datasets/food-drug-interactions";
import { FOOD_TIMINGS } from "@/lib/intake-schedule";

// Anti-drift pins for the baked biomarker→supplement map (issue #2378), mirroring the
// #577 food-map pins: the committed JSON must be a FIXED POINT of the generator; every
// biomarker name must resolve to a canonical biomarker; every food–drug key must exist.
//
// Plus the pins that are this map's OWN, because this one recommends an ingestible:
// every entry must carry an evidence line and a source, and NO entry anywhere may state
// a dose. Pure — no DB/network.

const REPO = path.resolve(fileURLToPath(new URL("../..", import.meta.url)));
const OUT = path.join(REPO, "lib/datasets/data/biomarker-supplement-map.json");

const CANONICAL_NAMES = new Set(
  ((canonicalSeed as { biomarkers?: { name: string }[] }).biomarkers ?? []).map(
    (b) => b.name.toLowerCase()
  )
);
const DRUG_KEYS = new Set(FOOD_DRUG_INTERACTIONS.map((e) => e.key));

// A dose is a number next to a unit of amount. The map may name a substance and a form;
// it may never say how much.
const DOSE = /\b\d[\d.,]*\s*(mg|mcg|µg|ug|g|iu|ml|units?)\b/i;

describe("biomarker-supplement-map.json dataset", () => {
  it("is a fixed point of buildBiomarkerSupplementMap() (regenerate with `npm run gen:biomarker-supplement-map`)", () => {
    const generated =
      JSON.stringify(buildBiomarkerSupplementMap(), null, 2) + "\n";
    const committed = fs.readFileSync(OUT, "utf8");
    expect(committed).toBe(generated);
  });

  it("every referenced biomarker resolves to a canonical biomarker", () => {
    const missing = curatedSupplementBiomarkers().filter(
      (n) => !CANONICAL_NAMES.has(n.toLowerCase())
    );
    expect(
      missing,
      `biomarker names in the map with no canonical-biomarkers.json entry: ${missing}`
    ).toEqual([]);
  });

  it("every referenced food–drug key exists in food-drug-interactions.json", () => {
    const keys = new Set<string>();
    for (const e of buildBiomarkerSupplementMap().entries)
      for (const s of e.supplements)
        for (const k of s.interactionKeys ?? []) keys.add(k);
    const missing = [...keys].filter((k) => !DRUG_KEYS.has(k));
    expect(
      missing,
      `interactionKeys with no food-drug-interactions.json entry: ${missing}`
    ).toEqual([]);
  });

  it("every entry carries an evidence note, a source, at least one supplement, and direction low", () => {
    const entries = buildBiomarkerSupplementMap().entries;
    expect(entries.length).toBeGreaterThan(0);
    for (const e of entries) {
      expect(e.evidence.trim().length, e.key).toBeGreaterThan(0);
      expect(e.source.trim().length, e.key).toBeGreaterThan(0);
      expect(e.biomarkers.length, e.key).toBeGreaterThan(0);
      expect(e.supplements.length, e.key).toBeGreaterThan(0);
      expect(e.direction, e.key).toBe("low");
      for (const s of [...e.supplements, e.allergyAlternative]) {
        if (!s) continue;
        expect(s.matchTokens.length, `${e.key}/${s.name}`).toBeGreaterThan(0);
        expect(FOOD_TIMINGS, `${e.key}/${s.name}`).toContain(s.foodTiming);
      }
    }
  });

  it("NO entry states a dose, anywhere in its text", () => {
    for (const e of buildBiomarkerSupplementMap().entries) {
      const texts = [
        e.label,
        e.evidence,
        e.caveat ?? "",
        ...e.contraindications.map((c) => c.caution),
        ...[...e.supplements, e.allergyAlternative]
          .filter((s): s is NonNullable<typeof s> => !!s)
          .flatMap((s) => [s.name, s.note ?? ""]),
      ];
      for (const t of texts) {
        expect(DOSE.test(t), `${e.key}: dose-shaped text "${t}"`).toBe(false);
      }
    }
  });

  it("stays deliberately SMALL — a long plausible map is the failure mode", () => {
    // Not a cap on ambition: a bump here should be a deliberate, reviewed act, with
    // each new pair defended in its PR. Coverage grows; it does not creep.
    expect(buildBiomarkerSupplementMap().entries.length).toBeLessThanOrEqual(
      10
    );
  });

  it("has a unique key per entry", () => {
    const keys = buildBiomarkerSupplementMap().entries.map((e) => e.key);
    expect(new Set(keys).size).toBe(keys.length);
  });
});
