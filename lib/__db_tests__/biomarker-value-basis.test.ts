// DB INTEGRATION TIER — a coloured biomarker value can point at its basis (#2340).
//
// THE DEFECT. The biomarker detail page colours its latest value from the stored
// flag, but builds its range display exclusively from the CURATED catalog entry. For
// an analyte the catalog deliberately declines to band, that list is empty and no
// range renders — while the range the flag actually came from sits on the row, in
// `medical_records.reference_range`, unread by that surface.
//
// WHY THIS TIER. The decision is pure (lib/biomarker-value-basis, unit-tested), but
// the thing that was wrong is the JOIN: which range is stored on which row, and which
// flag survives reconciliation for an analyte the canonical catalog cannot judge. So
// these fixtures store readings the way ingest does, run `reconcileFlags` over them —
// which is what proves the flag on a band-less analyte is the extractor's, derived
// from the printed range and never re-derived from a canonical band — and then read
// them back through the very gather the page uses.
//
// The three states are the issue's own: curated band, no curated band + a source
// range, and neither.
//
// PHI: a synthetic profile under a reserved-looking name; every value and printed
// range here is invented for the fixture.

import { describe, expect, it, beforeAll, vi } from "vitest";

// This suite is about the query layer, not about auth; restore the real module the
// shared action setup mocks.
vi.mock("@/lib/auth", async () => vi.importActual("@/lib/auth"));

import { db } from "@/lib/db";
import {
  getBiomarkerSeriesWithDerived,
  getCanonicalBiomarker,
  reconcileFlags,
} from "@/lib/queries";
import { optimalBand, referenceRange } from "@/lib/reference-range";
import type { CanonicalBiomarker, ClinicalObservation } from "@/lib/types";
import {
  biomarkerValueBasis,
  REPORTED_RANGE_LABEL,
} from "@/lib/biomarker-value-basis";

// An analyte the catalog bands (ref 200–1100, optimal 500–700) and one it
// deliberately does not — the issue's own example, because labs band leptin by sex
// and body composition, so no single population band is publishable.
const BANDED = "Vitamin B12";
const UNBANDED = "Leptin";
const DRAW = "2026-02-17";

/**
 * Whether the detail page would render ANY curated band for this analyte: the
 * subject's reference/optimal band, or the both-sexes adult fallback it shows when
 * sex is unknown. The fixtures are chosen so every one of those agrees — B12
 * publishes a generic band, Leptin publishes none at all — so this stands in for the
 * page's `referenceEntries`/`optimalEntries` without re-implementing their labelling.
 */
function curatedBandShown(cb: CanonicalBiomarker | undefined): boolean {
  const ref = referenceRange(cb, null, null, null);
  const opt = optimalBand(cb, null, null);
  return [
    ref.low,
    ref.high,
    opt.low,
    opt.high,
    cb?.ref_low_male,
    cb?.ref_high_male,
    cb?.ref_low_female,
    cb?.ref_high_female,
    cb?.optimal_low_male,
    cb?.optimal_high_male,
    cb?.optimal_low_female,
    cb?.optimal_high_female,
  ].some((v) => v != null);
}

let profileId: number;

function insertReading(r: {
  canonical: string;
  value: number;
  unit: string;
  printed: string | null;
  flag: string | null;
  date: string;
}): void {
  db.prepare(
    `INSERT INTO medical_records
       (profile_id, date, category, name, canonical_name, value, value_num, unit,
        reference_range, flag)
     VALUES (?, ?, 'lab', ?, ?, ?, ?, ?, ?, ?)`
  ).run(
    profileId,
    r.date,
    r.canonical,
    r.canonical,
    String(r.value),
    r.value,
    r.unit,
    r.printed,
    r.flag
  );
}

function seriesFor(canonicalName: string): ClinicalObservation[] {
  return getBiomarkerSeriesWithDerived(profileId, canonicalName);
}

/** The page's own per-row decision, over a stored row. */
function basisFor(row: ClinicalObservation, canonicalName: string) {
  return biomarkerValueBasis({
    flag: row.flag,
    hasCuratedBand: curatedBandShown(getCanonicalBiomarker(canonicalName)),
    reportedRange: row.reference_range,
  });
}

beforeAll(() => {
  profileId = Number(
    db.prepare("INSERT INTO profiles (name) VALUES (?)").run("basis_subject")
      .lastInsertRowid
  );
  // Under the canonical band, so reconcileFlags derives "low" from the app's own
  // reference range — the flag whose basis the page has always shown.
  insertReading({
    canonical: BANDED,
    value: 150,
    unit: "pg/mL",
    printed: "200-1100 pg/mL",
    flag: null,
    date: DRAW,
  });
  // Two readings of ONE band-less analyte carrying DIFFERENT printed ranges — the
  // issue's evidence that the source's range is the only range that ever applied to
  // that draw. Each carries the flag the extractor derived from its own printed
  // range; nothing canonical can judge them.
  insertReading({
    canonical: UNBANDED,
    value: 1.8,
    unit: "ng/mL",
    printed: "3.0-15.0 ng/mL",
    flag: "low",
    date: "2026-01-06",
  });
  insertReading({
    canonical: UNBANDED,
    value: 1.8,
    unit: "ng/mL",
    printed: "0.5-13.8 ng/mL",
    flag: "low",
    date: DRAW,
  });
  // The same analyte from a source that printed no range at all: a stored flag with
  // nothing anywhere on the page to justify it.
  insertReading({
    canonical: UNBANDED,
    value: 1.4,
    unit: "ng/mL",
    printed: null,
    flag: "low",
    date: "2026-03-30",
  });
  reconcileFlags(profileId);
});

describe("a curated band is on screen", () => {
  it("keeps the flag and adds no second, competing range", () => {
    const rows = seriesFor(BANDED);
    expect(rows).toHaveLength(1);
    const row = rows[0];
    // The flag is the app's own derivation, not the document's — this is the state
    // the page already displayed correctly.
    expect(row.flag).toBe("low");
    const basis = basisFor(row, BANDED);
    expect(basis.kind).toBe("curated");
    expect(basis.displayFlag).toBe("low");
    expect(basis.reportedEntry).toBeNull();
  });
});

describe("no curated band, but the source printed its own range", () => {
  it("leaves the extractor's flag in place — nothing canonical can judge it", () => {
    // If reconcileFlags had re-derived here, the flag would have been cleared and
    // there would be no unexplained colour to explain. It does not: the catalog has
    // no band for this analyte, so the stored flag stays the document's.
    for (const row of seriesFor(UNBANDED)) expect(row.flag).toBe("low");
  });

  it("shows the source's range, attributed, and keeps the colour", () => {
    const rows = seriesFor(UNBANDED);
    const printed = rows.filter((r) => r.reference_range != null);
    expect(printed).toHaveLength(2);
    // The two readings disagree about the band — which is exactly why the catalog
    // publishes none, and why the range must be attributed to the draw it came from
    // rather than presented as the app's.
    expect(new Set(printed.map((r) => r.reference_range)).size).toBe(2);
    for (const row of printed) {
      const basis = basisFor(row, UNBANDED);
      expect(basis.kind).toBe("reported");
      expect(basis.displayFlag).toBe("low");
      expect(basis.reportedEntry).toEqual({
        label: REPORTED_RANGE_LABEL,
        range: row.reference_range,
      });
    }
  });
});

describe("neither a curated band nor a source range", () => {
  it("renders the value neutral rather than red with nothing to point at", () => {
    const row = seriesFor(UNBANDED).find((r) => r.reference_range == null);
    expect(row).toBeDefined();
    // The row still STORES its flag — this changes what the page claims, never the
    // data underneath it.
    expect(row!.flag).toBe("low");
    const basis = basisFor(row!, UNBANDED);
    expect(basis.kind).toBe("none");
    expect(basis.reportedEntry).toBeNull();
    expect(basis.displayFlag).toBeNull();
  });
});
