import { describe, expect, it } from "vitest";
import {
  TITER_DISTINCTIVE_TOKENS,
  matchesImmunityMarker,
  markerNameTokens,
} from "../titer-match";
import { IMMUNITY_ANTIBODY_MARKERS } from "../immunization-catalog";

describe("TITER_DISTINCTIVE_TOKENS", () => {
  it("is non-empty and holds only distinctive (non-generic) disease tokens", () => {
    expect(TITER_DISTINCTIVE_TOKENS.length).toBeGreaterThan(0);
    // Every distinctive token is at least 3 chars (SQL prefilter keys on it).
    for (const t of TITER_DISTINCTIVE_TOKENS) {
      expect(t.length).toBeGreaterThanOrEqual(3);
    }
    // Generic tokens shared across every titer are excluded so the prefilter
    // keys on a disease name, not on "antibody".
    for (const generic of [
      "antibody",
      "igg",
      "igm",
      "anti",
      "surface",
      "total",
    ]) {
      expect(TITER_DISTINCTIVE_TOKENS).not.toContain(generic);
    }
  });
});

describe("matchesImmunityMarker", () => {
  it("matches every catalog antibody marker against itself", () => {
    expect(IMMUNITY_ANTIBODY_MARKERS.length).toBeGreaterThan(0);
    for (const marker of IMMUNITY_ANTIBODY_MARKERS) {
      expect(matchesImmunityMarker(markerNameTokens(marker))).toBe(true);
    }
  });

  it("still matches when the record carries extra qualifier tokens", () => {
    // Lab variants like "Tetanus Antibody, Quantitative (Serum)" add tokens but
    // must still credit the "Tetanus Antibody" marker.
    const tokens = markerNameTokens(IMMUNITY_ANTIBODY_MARKERS[0]);
    tokens.add("quantitative");
    tokens.add("serum");
    expect(matchesImmunityMarker(tokens)).toBe(true);
  });

  it("matches a comma-inverted spelling of a marker", () => {
    // Tetanus Antibody is a catalog marker; the inverted phrasing normalizes to
    // the same token set.
    expect(matchesImmunityMarker(markerNameTokens("Antibody, Tetanus"))).toBe(
      true
    );
  });

  it("does not match an unrelated biomarker", () => {
    expect(matchesImmunityMarker(new Set())).toBe(false);
    expect(matchesImmunityMarker(markerNameTokens("Fasting Glucose"))).toBe(
      false
    );
    expect(
      matchesImmunityMarker(markerNameTokens("Comprehensive Metabolic Panel"))
    ).toBe(false);
  });
});
