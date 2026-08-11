// PURE TIER — the respiratory domain's ONE zone decision, and its registration
// (issue #1850).
//
// Two things are pinned here, and the second is the more important one:
//
//  1. THE BAND EDGES. Green ≥80%, yellow 50–80%, red <50% of the profile's own best,
//     taken on the rounded percentage the card prints — so a card can never read
//     "80% of your best" beside a yellow dot.
//  2. NO PERSONAL BEST → NO VERDICT. Never a population fallback, never a substituted
//     default. This is the safety half of the divergence argued in lib/peak-flow.ts:
//     a borrowed band here would put a green light on a number that is red for the
//     person holding the meter.
//
// Everything comes from the committed registries; no DB, no network.

import { describe, it, expect } from "vitest";
import {
  peakFlowZone,
  peakFlowRangeError,
  personalBestRangeError,
  suggestedPersonalBest,
  PEAK_FLOW_CANONICAL,
  PEAK_FLOW_METRIC,
  PEAK_FLOW_MAX,
  PEAK_FLOW_MIN,
  PEAK_FLOW_SLUG,
  PEAK_FLOW_UNIT,
  PEAK_FLOW_ZONE_COPY,
  PEAK_FLOW_ZONES,
  SPIROMETRY_CANONICAL_NAMES,
} from "@/lib/peak-flow";
import { canonicalBiomarkerForName } from "@/lib/datasets/canonical-biomarkers";
import { snapCanonicalName } from "@/lib/canonical-name";
import { panelForCanonicalName } from "@/lib/biomarker-panels";
import { METRIC_KNOWLEDGE, quantityKnowledge } from "@/lib/metric-judgment";
import { placeReading } from "@/lib/reading-placement";
import { readingCadence } from "@/lib/reading-cadence";
import { metricAggregation } from "@/lib/metric-buckets";
import { TREND_METRIC_SLUGS } from "@/lib/trend-metrics";
import { measurementFieldGroup } from "@/lib/measurements-deeplink";

describe("the zone decision — band edges", () => {
  const best = 600;

  it.each([
    // [reading, expected zone, expected percent]
    [600, "green", 100],
    [660, "green", 110], // above your best is still green, not an error
    [480, "green", 80], // the green FLOOR is inclusive
    [477, "green", 80], // 79.5% — it PRINTS 80, so it is banded at 80 (see below)
    [476, "yellow", 79],
    [450, "yellow", 75],
    [300, "yellow", 50], // the yellow FLOOR is inclusive
    [297, "yellow", 50], // 49.5% — same rule at the other edge
    [296, "red", 49],
    [290, "red", 48],
    [60, "red", 10],
  ] as const)("%i L/min of a 600 best is %s (%i%%)", (value, zone, percent) => {
    const verdict = peakFlowZone(value, best);
    expect(verdict).not.toBeNull();
    expect(verdict?.zone).toBe(zone);
    expect(verdict?.percent).toBe(percent);
    expect(verdict?.personalBest).toBe(best);
  });

  it("bands on the ROUNDED percentage the card prints", () => {
    // 477/600 = 79.5%, which rounds to 80. A RAW-ratio band would call this yellow
    // while the card printed "80% of your best" — one number, two answers, and the
    // exact contradiction #221 is about. The rounded band keeps them one answer.
    expect(peakFlowZone(477, 600)).toMatchObject({
      percent: 80,
      zone: "green",
    });
    // …and one litre-per-minute lower prints 79 and reads yellow, so the boundary is
    // visible in the number rather than hidden behind it.
    expect(peakFlowZone(476, 600)).toMatchObject({
      percent: 79,
      zone: "yellow",
    });
  });

  it("names a copy line for every zone", () => {
    for (const zone of PEAK_FLOW_ZONES) {
      expect(PEAK_FLOW_ZONE_COPY[zone].label.length).toBeGreaterThan(0);
      expect(PEAK_FLOW_ZONE_COPY[zone].blurb.length).toBeGreaterThan(20);
    }
  });
});

describe("with no personal best there is NO verdict (never a population fallback)", () => {
  it.each([null, undefined, 0, -1, Number.NaN])(
    "a best of %s yields no zone at all",
    (best) => {
      expect(peakFlowZone(500, best as number | null | undefined)).toBeNull();
    }
  );

  it("returns null rather than falling back to the canonical entry's band", () => {
    // The load-bearing consequence: the curated entry itself states no band, so
    // there is nothing to fall back TO — which is what makes "no verdict" the only
    // possible answer rather than a policy that could quietly change.
    const entry = canonicalBiomarkerForName(PEAK_FLOW_CANONICAL);
    expect(entry).not.toBeNull();
    expect(entry?.ref_low).toBeNull();
    expect(entry?.ref_high).toBeNull();
    expect(entry?.optimal_low).toBeNull();
    expect(entry?.optimal_high).toBeNull();
    expect(peakFlowZone(500, null)).toBeNull();
  });

  it("also refuses a non-finite reading", () => {
    expect(peakFlowZone(null, 600)).toBeNull();
    expect(peakFlowZone(Number.NaN, 600)).toBeNull();
  });
});

describe("the personal-best suggestion is a suggestion", () => {
  it("is the highest reading on file", () => {
    expect(suggestedPersonalBest([410, 620, 580])).toBe(620);
  });

  it("is null for an empty or unusable series", () => {
    expect(suggestedPersonalBest([])).toBeNull();
    expect(suggestedPersonalBest([Number.NaN])).toBeNull();
  });

  it("never becomes the verdict on its own", () => {
    // The zone is taken against the DECLARED best; a series of readings alone
    // produces no zone, which is the declared-only rule made structural.
    expect(peakFlowZone(600, suggestedPersonalBest([]))).toBeNull();
  });
});

describe("the shared plausibility bounds", () => {
  it("accepts a real blow and refuses a mistyped one", () => {
    expect(peakFlowRangeError(420)).toBeNull();
    expect(peakFlowRangeError(PEAK_FLOW_MIN)).toBeNull();
    expect(peakFlowRangeError(PEAK_FLOW_MAX)).toBeNull();
    expect(peakFlowRangeError(PEAK_FLOW_MIN - 1)).not.toBeNull();
    expect(peakFlowRangeError(5000)).not.toBeNull();
  });

  it("holds the personal best to the same window — a best IS a reading", () => {
    expect(personalBestRangeError(620)).toBeNull();
    expect(personalBestRangeError(5000)).not.toBeNull();
  });
});

describe("registration — the domain is an instance of the substrate", () => {
  it("is a registered metric slug rendering the stream", () => {
    expect(TREND_METRIC_SLUGS as readonly string[]).toContain(PEAK_FLOW_SLUG);
    expect(readingCadence(PEAK_FLOW_CANONICAL)).toBe("continuous");
    expect(placeReading({ name: PEAK_FLOW_CANONICAL }).placed).toEqual({
      table: "metric_samples",
      metric: PEAK_FLOW_METRIC,
    });
  });

  it("keeps a clinic-measured PEF an observation (placement clause 2)", () => {
    // A spirometry report's PEF arrives with a document, and the stream store has no
    // column for that — so provenance still wins over the registered stream.
    expect(
      placeReading({ name: PEAK_FLOW_CANONICAL, provenance: true }).placed
    ).toEqual({ table: "medical_records", canonical: PEAK_FLOW_CANONICAL });
  });

  it("averages a day's blows rather than summing them", () => {
    expect(metricAggregation(PEAK_FLOW_METRIC)).toBe("AVG");
  });

  it("declares its knowledge as the personal best, not a canonical band", () => {
    const knowledge = METRIC_KNOWLEDGE[PEAK_FLOW_SLUG];
    expect(knowledge.source).toBe("personal-best");
    // It resolves through the identity lookup like every other judged quantity, so
    // the completeness guard sees it — the declaration is the answer, not a gap.
    expect(quantityKnowledge(PEAK_FLOW_CANONICAL)).toBe(knowledge);
    if (knowledge.source === "personal-best") {
      expect(knowledge.canonical).toBe(PEAK_FLOW_CANONICAL);
      expect(knowledge.computedBy).toContain("peakFlowZone");
      expect(knowledge.renderedBy.length).toBeGreaterThan(10);
    }
  });

  it("logs through the measurements quick-add's VITALS group", () => {
    // No new one-tap affordance class: the blow rides the form every other vital
    // rides, which is why no #2130 census row is needed for it. Its clock time is
    // the form's ONE shared Time since #2154's fold — the per-measure
    // `m-peak-flow-time` input is gone with the convention it fed.
    expect(measurementFieldGroup("m-peak-flow")).toBe("vitals");
    expect(measurementFieldGroup("m-peak-flow-time")).toBeNull();
  });
});

describe("the spirometry half is ordinary observations", () => {
  it("curates all three, and only the RATIO carries a cutoff", () => {
    for (const name of SPIROMETRY_CANONICAL_NAMES) {
      expect(canonicalBiomarkerForName(name), name).not.toBeNull();
      // Episodic: a pulmonology report, read against a band on the reading page.
      expect(readingCadence(name)).toBe("episodic");
      expect(placeReading({ name }).placed).toEqual({
        table: "medical_records",
        canonical: name,
      });
    }
    // FEV1 and FVC in litres have no fixed band — "normal" is percent-predicted
    // against an equation this app does not ship, and borrowing an adult average
    // would mis-judge every child and every tall adult.
    expect(
      canonicalBiomarkerForName("Forced Expiratory Volume in 1 Second (FEV1)")
        ?.ref_low
    ).toBeNull();
    expect(
      canonicalBiomarkerForName("Forced Vital Capacity (FVC)")?.ref_low
    ).toBeNull();
    // The ratio is the one universal cutoff.
    expect(canonicalBiomarkerForName("FEV1/FVC Ratio")?.ref_low).toBe(70);
  });

  it("shares one respiratory panel with peak flow", () => {
    for (const name of [PEAK_FLOW_CANONICAL, ...SPIROMETRY_CANONICAL_NAMES]) {
      expect(panelForCanonicalName(name), name).toBe("respiratory");
    }
  });

  it("resolves the spellings a meter leaflet and a PFT report print", () => {
    const vocabulary = [
      PEAK_FLOW_CANONICAL,
      ...SPIROMETRY_CANONICAL_NAMES,
    ] as string[];
    expect(snapCanonicalName("PEF", vocabulary)).toBe(PEAK_FLOW_CANONICAL);
    expect(snapCanonicalName("PEFR", vocabulary)).toBe(PEAK_FLOW_CANONICAL);
    expect(snapCanonicalName("Peak Flow", vocabulary)).toBe(
      PEAK_FLOW_CANONICAL
    );
    // Since #2335 both long forms are AUTO-derived from the "Full Name (ABBR)"
    // entries rather than hand-aliased, and so are the bare abbreviations.
    expect(
      snapCanonicalName("Forced Expiratory Volume in 1 Second", vocabulary)
    ).toBe("Forced Expiratory Volume in 1 Second (FEV1)");
    expect(snapCanonicalName("FEV1", vocabulary)).toBe(
      "Forced Expiratory Volume in 1 Second (FEV1)"
    );
    expect(snapCanonicalName("Forced Vital Capacity", vocabulary)).toBe(
      "Forced Vital Capacity (FVC)"
    );
    expect(snapCanonicalName("FVC", vocabulary)).toBe(
      "Forced Vital Capacity (FVC)"
    );
    expect(snapCanonicalName("FEV1/FVC", vocabulary)).toBe("FEV1/FVC Ratio");
  });

  it("keeps the three spirometry values as three IDENTITIES", () => {
    // A normal FVC must never mark an obstructed ratio fine — the #482 exclusion
    // discipline, which is the same reason each ear/frequency threshold stays its own
    // series in the audiogram domain.
    const placements = SPIROMETRY_CANONICAL_NAMES.map(
      (name) => placeReading({ name }).identity
    );
    expect(new Set(placements).size).toBe(SPIROMETRY_CANONICAL_NAMES.length);
  });

  it("states its unit on the canonical entry, so a stored row is comparable", () => {
    expect(canonicalBiomarkerForName(PEAK_FLOW_CANONICAL)?.unit).toBe(
      PEAK_FLOW_UNIT
    );
  });
});
