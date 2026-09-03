import { describe, expect, it } from "vitest";
import {
  clinicalResultDetailHref,
  clinicalResultAddHref,
  historyDayHref,
  historyDayIntradayHref,
  trainingLogDayHref,
  dayHistoryAddHref,
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

describe("clinicalResultAddHref", () => {
  it("links the result form prefilled with the analyte name (#662/#1083)", () => {
    expect(clinicalResultAddHref("LDL Cholesterol")).toBe(
      "/results/clinical-results?new=1&name=LDL%20Cholesterol"
    );
  });

  it("falls back to the unprefilled add form without a name", () => {
    expect(clinicalResultAddHref(null)).toBe("/results/clinical-results?new=1");
    expect(clinicalResultAddHref(undefined)).toBe(
      "/results/clinical-results?new=1"
    );
    expect(clinicalResultAddHref("  ")).toBe("/results/clinical-results?new=1");
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

describe("clinicalResultDetailHref", () => {
  // #1932: one helper, two destinations, chosen by CADENCE. A call site asks for
  // "the detail page for this reading" and can't decide the renderer for itself.
  it("sends a CONTINUOUS vital to the metric detail surface", () => {
    expect(clinicalResultDetailHref("Oxygen Saturation")).toBe(
      "/trends/metric/spo2"
    );
    expect(clinicalResultDetailHref("Blood Pressure Systolic")).toBe(
      "/trends/metric/systolic"
    );
    expect(clinicalResultDetailHref("Body Temperature")).toBe(
      "/trends/metric/temperature"
    );
  });

  it("sends a continuous vital there even when the raw name differs", () => {
    // The produced-rows drilldown (#1333) passes both; the canonical decides.
    expect(
      clinicalResultDetailHref("Oxygen Saturation", "SpO2 (arterial)")
    ).toBe("/trends/metric/spo2");
  });

  it("keeps EPISODIC readings on the reference-range page, vitals or not", () => {
    // A domain vital is `category = 'vitals'` too, and belongs on the lab renderer:
    // it arrives a few times a year and is read against a band / a percentile.
    expect(clinicalResultDetailHref("Grip Strength")).toBe(
      "/results/clinical-results/view?name=Grip%20Strength"
    );
    expect(clinicalResultDetailHref("Intraocular Pressure")).toBe(
      "/results/clinical-results/view?name=Intraocular%20Pressure"
    );
  });

  it("links to the view page with the CANONICAL name when one is present", () => {
    // The #283 bug 5 fix: the view page resolves ?name= as the canonical name, so
    // a canonicalized reading links to its series under the canonical spelling.
    expect(clinicalResultDetailHref("LDL Cholesterol", "LDL-C")).toBe(
      "/results/clinical-results/view?name=LDL%20Cholesterol"
    );
  });

  it("falls back to the Clinical results list when there is no canonical name", () => {
    // An uncanonicalized reading has no ?name= the view can resolve.
    expect(clinicalResultDetailHref(null, "Some Raw Analyte")).toBe(
      "/results/clinical-results"
    );
    expect(clinicalResultDetailHref(undefined)).toBe(
      "/results/clinical-results"
    );
    expect(clinicalResultDetailHref("   ")).toBe("/results/clinical-results");
  });

  it("encodes query-unsafe characters in the canonical name", () => {
    expect(clinicalResultDetailHref("Vitamin D (25-OH)")).toBe(
      "/results/clinical-results/view?name=Vitamin%20D%20(25-OH)"
    );
  });
});

describe("historyDayHref", () => {
  // The record's day view IS the day, so there is no feed left to scroll and no
  // `#timeline-day-…` fragment to carry — the two things that died with `/timeline`.
  it("selects the day on the record", () => {
    expect(historyDayHref("2026-07-12")).toBe("/history?day=2026-07-12");
  });
});

describe("historyDayIntradayHref", () => {
  // The panel is a POSITION ON the page `?day=` already selects — the thing
  // `/data#integrations` is — not the feed fragment `/timeline` retired with its route.
  it("lands the receipt doors on the day view's intraday panel", () => {
    expect(historyDayIntradayHref("2026-07-12")).toBe(
      "/history?day=2026-07-12#day-at-a-glance"
    );
  });
});

describe("trainingLogDayHref", () => {
  // The day is a READ BOUND, not a fragment. The retired `#day-` anchor resolved only
  // while the day happened to fall inside whatever window the Log had drawn; `?day=`
  // is a question the page answers.
  it("bounds the Training Log to the workout day", () => {
    expect(trainingLogDayHref("2026-07-12")).toBe(
      "/training?tab=log&day=2026-07-12"
    );
  });
});

describe("dayHistoryAddHref", () => {
  it("uses each destination's declared date parameter (#2420)", () => {
    expect(dayHistoryAddHref("/nutrition?tab=food", "food", "2026-07-12")).toBe(
      "/nutrition?tab=food&date=2026-07-12"
    );
    expect(
      dayHistoryAddHref("/nutrition?tab=supplements", "dose", "2026-07-12")
    ).toBe("/nutrition?tab=supplements&backfill=2026-07-12");
    expect(dayHistoryAddHref("/wellness", "practice", "2026-07-12")).toBe(
      "/wellness?log=2026-07-12"
    );
    expect(
      dayHistoryAddHref("/training?tab=log", "workout", "2026-07-12")
    ).toBe("/training?tab=log&date=2026-07-12");
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
    expect(currentPathHref("/results/clinical-results?sort=date")).toBe(
      "/results/clinical-results?sort=date"
    );
  });
});
