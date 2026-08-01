import { describe, expect, it } from "vitest";
import {
  COMMON_SPECIALTIES,
  curatedSpecialtyOptions,
  rankProvidersByUse,
  rankedSpecialtyOptions,
  type ProviderUse,
} from "../provider-rank";
import { NUCC_LABEL_OPTIONS } from "../nucc-taxonomy";

const TODAY = "2026-08-01";

// A registry as `getPickerProviders()` hands it over: alphabetical by name.
const REGISTRY = [
  { id: 1, name: "Aaronson, Dana" },
  { id: 2, name: "Bell Street Physical Therapy" },
  { id: 3, name: "Cortez, Ruth (Family Medicine)" },
  { id: 4, name: "Delgado Imaging" },
];

const names = (rows: { name: string }[]) => rows.map((r) => r.name);

describe("rankProvidersByUse", () => {
  it("returns the alphabetical list when the profile has no links", () => {
    expect(names(rankProvidersByUse(REGISTRY, [], TODAY))).toEqual(
      names(REGISTRY)
    );
  });

  it("leads with the provider this profile actually sees, not with 'Aaronson'", () => {
    // A family's PCP: four visits this year against one stale link to the alphabet's
    // first name.
    const uses: ProviderUse[] = [
      { providerId: 3, date: "2026-07-20" },
      { providerId: 3, date: "2026-04-11" },
      { providerId: 3, date: "2026-01-30" },
      { providerId: 3, date: "2025-10-02" },
      { providerId: 1, date: "2021-03-05" },
    ];
    const ranked = names(rankProvidersByUse(REGISTRY, uses, TODAY));
    expect(ranked[0]).toBe("Cortez, Ruth (Family Medicine)");
    expect(ranked).toHaveLength(REGISTRY.length);
    expect(new Set(ranked)).toEqual(new Set(names(REGISTRY)));
  });

  it("weights recency: this year's clinician leads one seen more, long ago", () => {
    // A runner's PT, seen weekly for the last two months, leads an imaging centre with
    // more total links spread across old years.
    const uses: ProviderUse[] = [
      { providerId: 2, date: "2026-07-25" },
      { providerId: 2, date: "2026-07-11" },
      { providerId: 2, date: "2026-06-27" },
      { providerId: 4, date: "2019-02-01" },
      { providerId: 4, date: "2019-05-01" },
      { providerId: 4, date: "2019-08-01" },
      { providerId: 4, date: "2019-11-01" },
      { providerId: 4, date: "2020-02-01" },
    ];
    const ranked = names(rankProvidersByUse(REGISTRY, uses, TODAY));
    expect(ranked[0]).toBe("Bell Street Physical Therapy");
  });

  it("keeps alphabetical order among the providers with no links", () => {
    const ranked = names(
      rankProvidersByUse(
        REGISTRY,
        [{ providerId: 4, date: "2026-07-01" }],
        TODAY
      )
    );
    expect(ranked).toEqual([
      "Delgado Imaging",
      "Aaronson, Dana",
      "Bell Street Physical Therapy",
      "Cortez, Ruth (Family Medicine)",
    ]);
  });

  it("ignores a link to a provider that is not offered (archived, other registry)", () => {
    const ranked = names(
      rankProvidersByUse(
        REGISTRY,
        [{ providerId: 99, date: "2026-07-01" }],
        TODAY
      )
    );
    expect(ranked).toEqual(names(REGISTRY));
  });

  it("ranks by id, so two same-named providers stay distinct", () => {
    const twins = [
      { id: 10, name: "Nguyen, Mai" },
      { id: 11, name: "Nguyen, Mai" },
    ];
    const ranked = rankProvidersByUse(
      twins,
      [{ providerId: 11, date: "2026-07-01" }],
      TODAY
    );
    expect(ranked.map((p) => p.id)).toEqual([11, 10]);
  });
});

describe("the curated specialty head", () => {
  it("names only curated NUCC labels", () => {
    const known = new Set(NUCC_LABEL_OPTIONS);
    for (const label of COMMON_SPECIALTIES) expect(known.has(label)).toBe(true);
  });

  it("changes ORDER only — membership matches the NUCC label set", () => {
    expect(curatedSpecialtyOptions()).toHaveLength(NUCC_LABEL_OPTIONS.length);
    expect(new Set(curatedSpecialtyOptions())).toEqual(
      new Set(NUCC_LABEL_OPTIONS)
    );
  });

  it("opens on primary care instead of on 'Allergy & Immunology'", () => {
    expect(NUCC_LABEL_OPTIONS[0]).toBe("Allergy & Immunology");
    expect(curatedSpecialtyOptions().slice(0, 5)).toEqual([
      "Family Medicine",
      "Internal Medicine",
      "Pediatrics",
      "Dentistry",
      "Optometry",
    ]);
  });
});

describe("rankedSpecialtyOptions", () => {
  it("is the curated order byte for byte with no recorded specialties", () => {
    expect(rankedSpecialtyOptions([])).toEqual(curatedSpecialtyOptions());
  });

  it("leads with the specialties this profile's own providers carry", () => {
    const ranked = rankedSpecialtyOptions(["Rheumatology", "Rheumatology"]);
    expect(ranked[0]).toBe("Rheumatology");
    expect(ranked[1]).toBe(curatedSpecialtyOptions()[0]);
  });

  it("orders recorded specialties by how many providers carry them", () => {
    const ranked = rankedSpecialtyOptions([
      "Nephrology",
      "Rheumatology",
      "Rheumatology",
    ]);
    expect(ranked.slice(0, 2)).toEqual(["Rheumatology", "Nephrology"]);
  });

  it("normalizes a recorded specialty onto the curated label's casing", () => {
    const ranked = rankedSpecialtyOptions(["cardiology"]);
    expect(ranked[0]).toBe("Cardiology");
    expect(ranked).toHaveLength(curatedSpecialtyOptions().length);
  });

  it("floats a free-text specialty without dropping a curated label", () => {
    const ranked = rankedSpecialtyOptions(["Lactation Consultant"]);
    expect(ranked[0]).toBe("Lactation Consultant");
    expect(ranked).toHaveLength(curatedSpecialtyOptions().length + 1);
  });
});
