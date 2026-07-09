import { describe, it, expect } from "vitest";
import canonical from "@/lib/canonical-biomarkers.json";
import descriptionsJson from "@/lib/biomarker-descriptions.json";
import { getBiomarkerInfo } from "@/lib/biomarker-info";

const descriptions = (
  descriptionsJson as {
    descriptions: Record<
      string,
      { abbreviation?: string; full_name: string; description: string }
    >;
  }
).descriptions;

const canonicalNames = (
  canonical as { biomarkers: { name: string }[] }
).biomarkers.map((b) => b.name);

describe("biomarker-descriptions coverage", () => {
  // The build-failing guard: every canonical biomarker must have a description,
  // so adding a biomarker to canonical-biomarkers.json without documenting it
  // here trips CI and keeps the two datasets in sync.
  it("has an entry for every canonical biomarker (exact key)", () => {
    const missing = canonicalNames.filter((name) => !descriptions[name]);
    expect(missing).toEqual([]);
  });

  it("resolves every canonical biomarker via getBiomarkerInfo", () => {
    for (const name of canonicalNames) {
      const info = getBiomarkerInfo(name);
      expect(info, `no info for ${name}`).not.toBeNull();
    }
  });
});

describe("biomarker-descriptions integrity", () => {
  it("has no empty full_name or description, and round-trips", () => {
    for (const [name, info] of Object.entries(descriptions)) {
      expect(typeof info.full_name, name).toBe("string");
      expect(info.full_name.trim().length, name).toBeGreaterThan(0);
      expect(typeof info.description, name).toBe("string");
      expect(
        info.description.trim().length,
        `${name} description`
      ).toBeGreaterThan(20);
      if (info.abbreviation !== undefined) {
        expect(
          info.abbreviation.trim().length,
          `${name} abbreviation`
        ).toBeGreaterThan(0);
      }
    }
  });

  it("survives a JSON round-trip", () => {
    const round = JSON.parse(JSON.stringify(descriptionsJson));
    expect(round).toEqual(descriptionsJson);
  });

  it("has no orphan keys not present in the canonical set", () => {
    const canonicalSet = new Set(canonicalNames);
    const orphans = Object.keys(descriptions).filter(
      (k) => !canonicalSet.has(k)
    );
    expect(orphans).toEqual([]);
  });
});

describe("getBiomarkerInfo", () => {
  it("matches case-insensitively", () => {
    const upper = getBiomarkerInfo("rdw");
    expect(upper?.full_name).toBe("Red Cell Distribution Width");
  });

  it("returns null for unknown names and empty input", () => {
    expect(getBiomarkerInfo("Definitely Not A Biomarker")).toBeNull();
    expect(getBiomarkerInfo("")).toBeNull();
    expect(getBiomarkerInfo(null)).toBeNull();
    expect(getBiomarkerInfo(undefined)).toBeNull();
  });

  it("trims surrounding whitespace", () => {
    expect(getBiomarkerInfo("  RDW  ")?.abbreviation).toBe("RDW");
  });
});
