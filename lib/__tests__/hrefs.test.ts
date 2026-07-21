import { describe, expect, it } from "vitest";
import {
  biomarkerViewHref,
  timelineDayHref,
  dataSectionHref,
  DATA_SECTIONS,
  importHref,
  encounterHref,
  protocolHref,
  immunizationHref,
  integrationDetailHref,
  currentPathHref,
} from "@/lib/hrefs";

describe("biomarkerViewHref", () => {
  it("links to the view page with the CANONICAL name when one is present", () => {
    // The #283 bug 5 fix: the view page resolves ?name= as the canonical name, so
    // a canonicalized reading links to its series under the canonical spelling.
    expect(biomarkerViewHref("LDL Cholesterol", "LDL-C")).toBe(
      "/biomarkers/view?name=LDL%20Cholesterol"
    );
  });

  it("prefers the canonical name over the raw display name (the bug it fixes)", () => {
    // flaggedToAttention used to encode the RAW name (b.name) while gating on the
    // canonical — so a raw≠canonical reading linked to a name the view can't resolve.
    // The helper always encodes the canonical when gated on it.
    const canonical = "Hemoglobin A1c";
    const raw = "HbA1c";
    expect(biomarkerViewHref(canonical, raw)).toBe(
      "/biomarkers/view?name=Hemoglobin%20A1c"
    );
  });

  it("falls back to the biomarkers list when there is no canonical name", () => {
    // An uncanonicalized reading has no ?name= the view can resolve.
    expect(biomarkerViewHref(null, "Some Raw Analyte")).toBe(
      "/results/biomarkers"
    );
    expect(biomarkerViewHref(undefined)).toBe("/results/biomarkers");
    expect(biomarkerViewHref("   ")).toBe("/results/biomarkers");
  });

  it("encodes query-unsafe characters in the canonical name", () => {
    expect(biomarkerViewHref("Vitamin D (25-OH)")).toBe(
      "/biomarkers/view?name=Vitamin%20D%20(25-OH)"
    );
  });
});

describe("timelineDayHref", () => {
  it("filters the feed to one day and anchors to that day", () => {
    expect(timelineDayHref("2026-07-12")).toBe(
      "/timeline?from=2026-07-12&to=2026-07-12#timeline-day-2026-07-12"
    );
  });
});

describe("dataSectionHref", () => {
  it("links to a section of the Data hub", () => {
    expect(dataSectionHref("review")).toBe("/data?section=review");
    expect(dataSectionHref("import")).toBe("/data?section=import");
    expect(dataSectionHref("manage")).toBe("/data?section=manage");
  });

  it("appends an optional in-page hash", () => {
    expect(dataSectionHref("import", "paste-import")).toBe(
      "/data?section=import#paste-import"
    );
  });

  it("DATA_SECTIONS is the source-of-truth union the page mirrors", () => {
    expect([...DATA_SECTIONS]).toEqual(["import", "review", "manage"]);
  });
});

describe("dynamic-route helpers", () => {
  it("build the detail path for each dynamic route", () => {
    expect(importHref(42)).toBe("/import/42");
    expect(encounterHref(7)).toBe("/encounters/7");
    expect(protocolHref(3)).toBe("/protocols/3");
    expect(immunizationHref("influenza")).toBe("/immunizations/influenza");
  });
});

describe("integrationDetailHref", () => {
  it("maps each page-backed provider to its static detail page", () => {
    expect(integrationDetailHref("health-connect")).toBe(
      "/integrations/health-connect"
    );
    expect(integrationDetailHref("strava")).toBe("/integrations/strava");
    expect(integrationDetailHref("oura")).toBe("/integrations/oura");
    expect(integrationDetailHref("withings")).toBe("/integrations/withings");
    expect(integrationDetailHref("calendar-feed")).toBe(
      "/integrations/calendar-feed"
    );
  });

  it("returns null for a planned provider with no page (Garmin) — no dead link", () => {
    expect(integrationDetailHref("garmin")).toBeNull();
  });
});

describe("currentPathHref", () => {
  it("passes a runtime pathname+query through unchanged", () => {
    expect(currentPathHref("/biomarkers?sort=date")).toBe(
      "/biomarkers?sort=date"
    );
  });
});
