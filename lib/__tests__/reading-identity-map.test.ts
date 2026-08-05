// PURE TIER — the ONE identity declaration (issue #2086 §3).
//
// `STREAM_READING_SOURCES` (which stream store holds this quantity) and
// `CONTINUOUS_READING_METRIC` (which surface renders it) are two halves of one
// bijection. They used to be two literals in two files, consistency-tested but
// separately edited — so an entry could be half-added, and a half-added entry is a live
// defect: a name routed to a metric surface with no stream registered folds no
// observations in, and a stream registered with no surface answer renders its clinical
// readings on the wrong page.
//
// This test pins the fold: both tables are DERIVED from `READING_IDENTITY_MAP`, they
// agree with it in both directions, and no entry claims nothing at all.
//
// It also pins the #482 EXCLUSION discipline the fold must not erode: every canonical
// name in the map is a real curated entry, and widening the map is not a way to invent
// vocabulary.

import { describe, it, expect } from "vitest";
import {
  CONTINUOUS_READING_METRIC,
  READING_IDENTITY_MAP,
  STREAM_READING_SOURCES,
} from "@/lib/reading-identity-map";
import { canonicalBiomarkerForName } from "@/lib/datasets/canonical-biomarkers";
import { readingIdentity } from "@/lib/reading-model";
import { continuousReadingSlug } from "@/lib/reading-cadence";
import { BODY_METRIC_SLUGS } from "@/lib/trends-body-metrics";

describe("the reading identity map is one declaration", () => {
  it("declares each canonical name exactly once", () => {
    const names = READING_IDENTITY_MAP.map((e) => e.canonical);
    expect(new Set(names).size).toBe(names.length);
  });

  it("never registers a name that claims NEITHER a surface nor a stream", () => {
    // Such an entry would be a canonical name asserting nothing — the map's whole job
    // is to answer at least one of the two questions.
    const empty = READING_IDENTITY_MAP.filter(
      (e) => e.surface == null && e.stream == null
    ).map((e) => e.canonical);
    expect(empty, `entries answering neither question: ${empty}`).toEqual([]);
  });

  it("names a REAL canonical entry every time (#482: no invented vocabulary)", () => {
    for (const e of READING_IDENTITY_MAP) {
      expect(
        canonicalBiomarkerForName(e.canonical),
        `"${e.canonical}" is not in the canonical vocabulary`
      ).not.toBeNull();
    }
  });

  it("routes only to REGISTERED metric slugs", () => {
    for (const e of READING_IDENTITY_MAP) {
      if (!e.surface) continue;
      expect(
        (BODY_METRIC_SLUGS as readonly string[]).includes(e.surface),
        `${e.canonical} routes to "${e.surface}", which is not a metric slug`
      ).toBe(true);
    }
  });
});

describe("both halves derive from it, and agree in both directions", () => {
  it("the STREAM half is exactly the entries carrying a stream", () => {
    expect(STREAM_READING_SOURCES.map((s) => s.canonical).sort()).toEqual(
      READING_IDENTITY_MAP.filter((e) => e.stream)
        .map((e) => e.canonical)
        .sort()
    );
    for (const src of STREAM_READING_SOURCES) {
      const entry = READING_IDENTITY_MAP.find(
        (e) => e.canonical === src.canonical
      );
      expect(entry?.stream).toMatchObject({
        store: src.store,
        key: src.key,
        unit: src.unit,
      });
    }
  });

  it("the SURFACE half is exactly the entries carrying a surface", () => {
    expect(Object.keys(CONTINUOUS_READING_METRIC).sort()).toEqual(
      READING_IDENTITY_MAP.filter((e) => e.surface)
        .map((e) => e.canonical)
        .sort()
    );
    for (const [name, slug] of Object.entries(CONTINUOUS_READING_METRIC)) {
      expect(
        READING_IDENTITY_MAP.find((e) => e.canonical === name)?.surface
      ).toBe(slug);
      // …and the live lookup, which resolves by #482 family, agrees with the table.
      expect(continuousReadingSlug(name)).toBe(slug);
    }
  });

  it("keeps the membership #1932/#1996/#2032 settled — a change here is deliberate", () => {
    // Spelled out so growing or shrinking either half is an edit to this list rather
    // than a silent consequence of touching the map.
    expect(Object.keys(CONTINUOUS_READING_METRIC).sort()).toEqual([
      "Blood Pressure Diastolic",
      "Blood Pressure Systolic",
      "Body Temperature",
      "Oxygen Saturation",
      "Respiratory Rate",
      "Resting Heart Rate",
    ]);
    expect(STREAM_READING_SOURCES.map((s) => s.canonical).sort()).toEqual([
      "Body Fat Percentage",
      "Resting Heart Rate",
    ]);
  });

  it("resting heart rate is the entry that carries BOTH halves", () => {
    // The #1996 reported instance: it streams into body_metrics AND its clinical
    // readings render on the metric surface that charts the stream (#2032).
    const rhr = READING_IDENTITY_MAP.find(
      (e) =>
        readingIdentity(e.canonical) === readingIdentity("Resting Heart Rate")
    );
    expect(rhr?.surface).toBe("resting-hr");
    expect(rhr?.stream).toMatchObject({
      store: "body_metrics",
      key: "resting_hr",
    });
  });
});
