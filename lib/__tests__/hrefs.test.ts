import { describe, expect, it } from "vitest";
import {
  biomarkerViewHref,
  biomarkerAddHref,
  timelineDayHref,
  dataSectionHref,
  DATA_SECTIONS,
  importHref,
  encounterHref,
  protocolHref,
  immunizationHref,
  integrationDetailHref,
  medicationEditHref,
  medicationsFilterHref,
  currentPathHref,
} from "@/lib/hrefs";

describe("biomarkerAddHref", () => {
  it("links the biomarker add form prefilled with the analyte name (#662/#1083)", () => {
    expect(biomarkerAddHref("LDL Cholesterol")).toBe(
      "/results/biomarkers?new=1&name=LDL%20Cholesterol"
    );
  });

  it("falls back to the unprefilled add form without a name", () => {
    expect(biomarkerAddHref(null)).toBe("/results/biomarkers?new=1");
    expect(biomarkerAddHref(undefined)).toBe("/results/biomarkers?new=1");
    expect(biomarkerAddHref("  ")).toBe("/results/biomarkers?new=1");
  });

  it("uses the post-#1079 tabbed base, never the redirect-surviving hash form", () => {
    expect(biomarkerAddHref("hs-CRP").startsWith("/results/biomarkers?")).toBe(
      true
    );
  });
});

describe("medicationEditHref", () => {
  it("opens the medication detail page's edit workflow (the #851 confirm form)", () => {
    expect(medicationEditHref(42)).toBe("/medications/42?action=edit");
  });
});

describe("medicationsFilterHref", () => {
  it("links the medications list narrowed to a maintenance slice", () => {
    expect(medicationsFilterHref("needs-rxcui")).toBe(
      "/medications?filter=needs-rxcui"
    );
  });
});

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
