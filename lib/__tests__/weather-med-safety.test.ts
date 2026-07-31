import { describe, expect, it } from "vitest";
import {
  HIGH_UV_INDEX,
  WEATHER_MED_PREFIX,
  crossCheckWeatherMeds,
  decideHeatRiskNote,
  decidePhotosensitizerNote,
  enrichUvDetail,
  weatherMedClause,
  type WeatherMedInput,
} from "@/lib/weather-med-safety";
import { dedupeKeyHasKnownPrefix } from "@/lib/rule-finding-prefixes";

// Pure tests for the med × weather safety composition (#1727). No DB: an active stack
// and the day's conditions in, matched notes out. The properties that matter are that
// the check is KIND-BLIND (a supplement can be a photosensitizer), that enrichment
// produces ONE line rather than a second warning, and that each standalone note
// requires BOTH of its facts.

function item(
  id: number,
  name: string,
  over: Partial<WeatherMedInput> = {}
): WeatherMedInput {
  return { id, name, rxcui: null, ...over };
}

const DATE = "2026-07-20";

describe("attribute lookup by canonical identity (#1727)", () => {
  it("matches a photosensitizer by name", () => {
    const hits = crossCheckWeatherMeds(
      [item(1, "Doxycycline 100mg")],
      "photosensitizing"
    );
    expect(hits).toHaveLength(1);
    expect(hits[0]).toMatchObject({
      itemId: 1,
      entryKey: "tetracycline",
      exposure: "photosensitizing",
    });
    expect(hits[0].citation.length).toBeGreaterThan(0);
  });

  it("is KIND-BLIND — St John's Wort is a supplement and still matches", () => {
    // The check never asks which surface an item was entered on; sunlight doesn't.
    const hits = crossCheckWeatherMeds(
      [item(7, "St. John's Wort 300mg")],
      "photosensitizing"
    );
    expect(hits.map((h) => h.entryKey)).toEqual(["st_johns_wort"]);
  });

  it("matches on a word boundary, never a substring accident", () => {
    expect(
      crossCheckWeatherMeds(
        [item(2, "Environmental support blend")],
        "heat-risk"
      )
    ).toEqual([]);
  });

  it("keeps the two exposures separate", () => {
    const stack = [item(1, "Doxycycline"), item(2, "Metoprolol")];
    expect(
      crossCheckWeatherMeds(stack, "photosensitizing").map((h) => h.itemId)
    ).toEqual([1]);
    expect(
      crossCheckWeatherMeds(stack, "heat-risk").map((h) => h.itemId)
    ).toEqual([2]);
  });

  it("lets one item carry BOTH attributes when it genuinely does", () => {
    // Hydrochlorothiazide is a documented photosensitizer AND a dehydration risk in
    // heat. Two curated facts about one drug, not a duplicate.
    const stack = [item(3, "Hydrochlorothiazide 25mg")];
    expect(crossCheckWeatherMeds(stack, "photosensitizing")).toHaveLength(1);
    expect(crossCheckWeatherMeds(stack, "heat-risk")).toHaveLength(1);
  });

  it("produces nothing for an unrecognized item (absence is not clearance)", () => {
    expect(
      crossCheckWeatherMeds([item(9, "Some Herbal Blend")], "photosensitizing")
    ).toEqual([]);
  });

  it("orders deterministically", () => {
    const hits = crossCheckWeatherMeds(
      [item(2, "Zonisamide"), item(1, "Amiodarone"), item(3, "Doxycycline")],
      "photosensitizing"
    );
    expect(hits.map((h) => h.itemName)).toEqual(["Amiodarone", "Doxycycline"]);
  });
});

describe("enrichment — one line, not a second warning (#1727)", () => {
  const hits = crossCheckWeatherMeds(
    [item(1, "Doxycycline")],
    "photosensitizing"
  );

  it("folds the med fact into the existing UV detail", () => {
    const enriched = enrichUvDetail("High UV until 4pm.", hits);
    expect(enriched).toBe(
      "High UV until 4pm. Note: Doxycycline increases sun sensitivity."
    );
  });

  it("leaves the detail untouched when nothing matched", () => {
    expect(enrichUvDetail("High UV until 4pm.", [])).toBe("High UV until 4pm.");
  });

  it("names up to two items, then collapses to a count", () => {
    const two = crossCheckWeatherMeds(
      [item(1, "Doxycycline"), item(2, "Amiodarone")],
      "photosensitizing"
    );
    expect(weatherMedClause(two)).toBe(
      "note: Amiodarone and Doxycycline increases sun sensitivity"
    );

    const three = crossCheckWeatherMeds(
      [item(1, "Doxycycline"), item(2, "Amiodarone"), item(3, "Isotretinoin")],
      "photosensitizing"
    );
    expect(weatherMedClause(three)).toBe(
      "note: 3 of your active items increases sun sensitivity"
    );
  });

  it("says an item's name once even when it matches two entries", () => {
    const both = crossCheckWeatherMeds(
      [item(3, "Hydrochlorothiazide")],
      "photosensitizing"
    );
    expect(weatherMedClause(both)).toBe(
      "note: Hydrochlorothiazide increases sun sensitivity"
    );
  });
});

describe("standalone photosensitizer note (#1727)", () => {
  const hits = crossCheckWeatherMeds(
    [item(1, "Doxycycline")],
    "photosensitizing"
  );

  it("fires on a high-UV day when the overexposure warning is NOT firing", () => {
    const obs = decidePhotosensitizerNote(DATE, {
      peakUvIndex: HIGH_UV_INDEX + 2,
      hits,
      overexposureFiring: false,
    });
    expect(obs).not.toBeNull();
    expect(obs!.title).toContain("Doxycycline");
    expect(obs!.dedupeKey).toContain(WEATHER_MED_PREFIX);
    // The dedupeKey is date-scoped: dismissing today never silences tomorrow.
    expect(obs!.dedupeKey.endsWith(DATE)).toBe(true);
  });

  it("stays silent when the overexposure warning IS firing (that line carries it)", () => {
    expect(
      decidePhotosensitizerNote(DATE, {
        peakUvIndex: HIGH_UV_INDEX + 2,
        hits,
        overexposureFiring: true,
      })
    ).toBeNull();
  });

  it("stays silent below the high-UV threshold", () => {
    expect(
      decidePhotosensitizerNote(DATE, {
        peakUvIndex: HIGH_UV_INDEX - 1,
        hits,
        overexposureFiring: false,
      })
    ).toBeNull();
  });

  it("fires AT the threshold — the boundary is inclusive", () => {
    // HIGH_UV_INDEX is the top of the "moderate" band, i.e. the first index at which
    // public guidance recommends protection, so the day it is exactly reached is a
    // high-UV day. Pinning the boundary keeps a later `>` from silently costing a day.
    expect(
      decidePhotosensitizerNote(DATE, {
        peakUvIndex: HIGH_UV_INDEX,
        hits,
        overexposureFiring: false,
      })
    ).not.toBeNull();
  });

  it("stays silent with no UV data (silence over guessing)", () => {
    expect(
      decidePhotosensitizerNote(DATE, {
        peakUvIndex: null,
        hits,
        overexposureFiring: false,
      })
    ).toBeNull();
  });

  it("stays silent with no photosensitizer in the stack", () => {
    expect(
      decidePhotosensitizerNote(DATE, {
        peakUvIndex: HIGH_UV_INDEX + 4,
        hits: [],
        overexposureFiring: false,
      })
    ).toBeNull();
  });

  it("keeps the informational register and cites its source", () => {
    const obs = decidePhotosensitizerNote(DATE, {
      peakUvIndex: HIGH_UV_INDEX + 2,
      hits,
      overexposureFiring: false,
    })!;
    expect(obs.detail).toContain("Source:");
    expect(obs.detail).toContain("discuss any concern with your prescriber");
    expect(obs.detail).not.toMatch(/stop taking|discontinue/i);
  });
});

describe("standalone heat-risk note (#1727)", () => {
  const hits = crossCheckWeatherMeds([item(2, "Furosemide")], "heat-risk");

  it("requires BOTH facts — the heatwave and the med", () => {
    expect(
      decideHeatRiskNote(DATE, {
        heatwaveActive: true,
        hits,
        tempLabel: "35°C",
      })
    ).not.toBeNull();

    // A merely warm day says nothing, however many diuretics are in the stack.
    expect(
      decideHeatRiskNote(DATE, {
        heatwaveActive: false,
        hits,
        tempLabel: "35°C",
      })
    ).toBeNull();

    expect(
      decideHeatRiskNote(DATE, {
        heatwaveActive: true,
        hits: [],
        tempLabel: "35°C",
      })
    ).toBeNull();
  });

  it("renders without a figure rather than with a wrong one", () => {
    const obs = decideHeatRiskNote(DATE, {
      heatwaveActive: true,
      hits,
      tempLabel: null,
    })!;
    expect(obs.detail).toContain("It's a hot spell");
  });

  it("keys its dedupe under the registered prefix, per item and date", () => {
    const obs = decideHeatRiskNote(DATE, {
      heatwaveActive: true,
      hits,
      tempLabel: "35°C",
    })!;
    expect(obs.dedupeKey).toBe(
      `${WEATHER_MED_PREFIX}heat-risk:2:diuretic_heat:${DATE}`
    );
  });
});

describe("reach registration (#1727)", () => {
  it("is NOT in the rule-finding builder registry — it is an intake-safety engine", () => {
    // The curated safety engines (interaction, PGx, ototoxic, allergy, UV) key outside
    // RULE_FINDING_REGISTRY and are guarded through the suppression-display registry
    // instead. This pins which family the new prefix joined, so a later change has to
    // be deliberate.
    expect(
      dedupeKeyHasKnownPrefix(`${WEATHER_MED_PREFIX}heat-risk:1:x:${DATE}`)
    ).toBe(false);
  });
});
