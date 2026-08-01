import { describe, expect, it } from "vitest";
import {
  COMMON_SUPPLEMENTS,
  curatedSupplementOptions,
  rankedSupplementOptions,
  supplementCatalogNames,
} from "../supplement-rank";

// The Combobox shows 8 rows and an empty query keeps source order (#1677).
const PICKER_ROWS = 8;

const head = (options: string[]) => options.slice(0, PICKER_ROWS);

describe("the curated supplement head", () => {
  it("names only real catalog entries", () => {
    const known = new Set(
      supplementCatalogNames().map((n) => n.toLowerCase())
    );
    for (const name of COMMON_SUPPLEMENTS) {
      expect(known.has(name.toLowerCase())).toBe(true);
    }
  });

  it("has no duplicates", () => {
    expect(new Set(COMMON_SUPPLEMENTS).size).toBe(COMMON_SUPPLEMENTS.length);
  });

  it("changes ORDER only — membership matches the catalog exactly", () => {
    expect(curatedSupplementOptions()).toHaveLength(
      supplementCatalogNames().length
    );
    expect(new Set(curatedSupplementOptions())).toEqual(
      new Set(supplementCatalogNames())
    );
  });

  it("breaks the all-vitamins first screen the category grouping produced", () => {
    // Category order puts the vitamins block first, so all eight visible rows were
    // vitamins — the picker looked like a vitamin picker.
    expect(head(supplementCatalogNames()).every((n) => /^(Vitamin|B-)/.test(n))).toBe(
      true
    );
    const ranked = head(curatedSupplementOptions());
    expect(ranked[0]).toBe("Vitamin D3");
    expect(ranked).toContain("Magnesium Glycinate");
    expect(ranked).toContain("Omega-3");
    expect(ranked.filter((n) => n.startsWith("Vitamin")).length).toBeLessThan(4);
  });

  it("keeps the non-head catalog in its category order behind the head", () => {
    const tail = curatedSupplementOptions().slice(COMMON_SUPPLEMENTS.length);
    const inHead = new Set(COMMON_SUPPLEMENTS.map((n) => n.toLowerCase()));
    expect(tail).toEqual(
      supplementCatalogNames().filter((n) => !inHead.has(n.toLowerCase()))
    );
  });
});

describe("rankedSupplementOptions", () => {
  it("is the curated order byte for byte for an empty shelf", () => {
    expect(rankedSupplementOptions([])).toEqual(curatedSupplementOptions());
  });

  it("floats the profile's own supplements ahead of the curated head", () => {
    const ranked = rankedSupplementOptions([
      { name: "Creatine Monohydrate", current: true },
    ]);
    expect(ranked[0]).toBe("Creatine Monohydrate");
    expect(ranked[1]).toBe(curatedSupplementOptions()[0]);
  });

  it("ranks an ACTIVE supplement above a retired one", () => {
    const ranked = rankedSupplementOptions([
      { name: "Ashwagandha", current: false },
      { name: "Creatine Monohydrate", current: true },
    ]);
    expect(ranked.slice(0, 2)).toEqual([
      "Creatine Monohydrate",
      "Ashwagandha",
    ]);
  });

  it("still offers a retired supplement ahead of the untouched catalog", () => {
    // A supplement cycled off is far more likely to be re-added than one never taken.
    const ranked = rankedSupplementOptions([
      { name: "Ashwagandha", current: false },
    ]);
    expect(ranked[0]).toBe("Ashwagandha");
  });

  it("does not let duplicate rows outrank a different active item", () => {
    const ranked = rankedSupplementOptions([
      { name: "Ashwagandha", current: false },
      { name: "Ashwagandha", current: false },
      { name: "Ashwagandha", current: false },
      { name: "Zinc", current: true },
    ]);
    expect(ranked.slice(0, 2)).toEqual(["Zinc", "Ashwagandha"]);
  });

  it("matches the catalog case-insensitively and keeps catalog casing", () => {
    const ranked = rankedSupplementOptions([
      { name: "vitamin d3", current: true },
    ]);
    expect(ranked[0]).toBe("Vitamin D3");
    expect(ranked).toHaveLength(curatedSupplementOptions().length);
  });

  it("floats a profile's own off-catalog supplement without dropping anything", () => {
    const ranked = rankedSupplementOptions([
      { name: "Beet Root Powder", current: true },
    ]);
    expect(ranked[0]).toBe("Beet Root Powder");
    expect(ranked).toHaveLength(curatedSupplementOptions().length + 1);
  });
});
