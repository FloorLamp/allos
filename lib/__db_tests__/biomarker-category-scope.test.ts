// #1076: the biomarker surfaces scope to `category = 'lab'` ONLY. This pins the
// exact leaks the issue fixes against a real schema — a fever (vitals), a high BP
// (vitals), a severe PHQ-9 (instrument), a bio-age (derived), and a blood type
// (reference) appear on NONE of: the biomarker list, the flagged hero source, the
// digest, or the retest nudge. The mental-health/substance sensitivity is load-
// bearing: a depression score can never reach the general health hero/digest.
//
// #2365 refined the `vitals` half from a CATEGORY decision to a PER-ANALYTE one — a
// vital whose quantity owns a /trends/metric/<slug> chart is not catalogued, one with
// no chart anywhere still is — so this suite also pins the browser's own gather over a
// fixture holding both populations in that one category.
// All fixture values are synthetic (obviously-fictional profile, plain names).

import { describe, it, expect, vi } from "vitest";

// The #2365 gather test reads through the browser's own index module under a
// hand-built ProfileScope; it is about the row set, not about auth, so restore the
// real auth module the shared action setup mocks.
vi.mock("@/lib/auth", async () => vi.importActual("@/lib/auth"));

import { db, today } from "@/lib/db";
import {
  getCurrentFlaggedBiomarkers,
  getClinicalObservations,
} from "@/lib/queries";
import {
  getNewlyFlaggedBiomarkers,
  digestSince,
} from "@/lib/notifications/digest-data";
import { collectUpcoming } from "@/lib/queries/upcoming";
import { recentLabHighlights } from "@/lib/recent-labs";
import { isBiomarkerStale } from "@/lib/reference-range";
import { NON_BIOMARKER_CATEGORIES } from "@/lib/medical-categories";
import type { ProfileScope } from "@/lib/scope";
import { METRIC_DOCUMENT_REACH } from "@/lib/trend-metric-analytes";
import { METRIC_READING_STORE } from "@/lib/metric-readings";
import { TREND_METRIC_SLUGS } from "@/lib/trend-metrics";
import {
  readingIndexRows,
  parseReadingFilters,
} from "@/app/(app)/results/reading-index";

function createProfile(name: string): number {
  return Number(
    db.prepare("INSERT INTO profiles (name) VALUES (?)").run(name)
      .lastInsertRowid
  );
}

// A single-profile scope, hand-built: readingIndexRows takes an ALREADY-resolved
// scope and reads only the acting profile + the view set, so no login/grant fixture
// is needed to exercise the gather.
function singleScope(profileId: number): ProfileScope {
  return {
    loginId: 0,
    role: "admin",
    actingProfileId: profileId,
    ownProfileId: profileId,
    profiles: [
      {
        id: profileId,
        name: `p_${profileId}`,
        photo_path: null,
        photo_version: 0,
      },
    ],
    ids: [profileId],
    viewIds: [profileId],
    access: new Map([[profileId, "write" as const]]),
  };
}

function insert(
  profileId: number,
  category: string,
  name: string,
  opts: {
    value?: string;
    valueNum?: number | null;
    unit?: string | null;
    flag?: string | null;
    date?: string;
  } = {}
): void {
  db.prepare(
    `INSERT INTO medical_records
       (profile_id, date, category, name, value, value_num, unit, canonical_name, flag)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`
  ).run(
    profileId,
    opts.date ?? today(profileId),
    category,
    name,
    opts.value ?? null,
    opts.valueNum ?? null,
    opts.unit ?? null,
    name,
    opts.flag ?? null
  );
}

// One profile seeded with a real lab plus the four re-homed classes, each carrying
// a FLAG so the "does it leak into the flagged hero/digest" test is strict (even a
// flagged non-lab must be excluded).
function seedMixedProfile(): number {
  const pid = createProfile("Category Scope Test");
  // The one legitimate flagged LAB — SHOULD surface everywhere a lab does.
  insert(pid, "lab", "LDL Cholesterol", {
    value: "190",
    valueNum: 190,
    unit: "mg/dL",
    flag: "high",
  });
  // A fever — vitals. Flagged high, but must never reach the lab hero/list/retest.
  insert(pid, "vitals", "Body Temperature", {
    value: "102",
    valueNum: 102,
    unit: "degF",
    flag: "high",
  });
  // A high blood pressure — vitals.
  insert(pid, "vitals", "Blood Pressure Systolic", {
    value: "165",
    valueNum: 165,
    unit: "mmHg",
    flag: "high",
  });
  // A severe PHQ-9 — instrument (the sensitivity case). Flagged to prove exclusion.
  insert(pid, "instrument", "PHQ-9", {
    value: "18",
    valueNum: 18,
    flag: "high",
  });
  // A derived bio-age — derived.
  insert(pid, "derived", "Biological Age", {
    value: "55",
    valueNum: 55,
    unit: "years",
    flag: "high",
  });
  // A blood type — reference (immutable).
  insert(pid, "reference", "Blood Type", { value: "O Positive" });
  // #2365's two vitals populations, side by side in one category.
  //
  // A misplaced BMI (#2318), spelled the way a real document import produced it: the
  // quantity has a `/trends/metric/bmi` home, so it is not a catalog analyte.
  insert(pid, "vitals", "Body Mass Index (BMI)", {
    value: "23.4",
    valueNum: 23.4,
  });
  // And the domain vitals with NO chart anywhere — the rows #1076's rule protects.
  insert(pid, "vitals", "Hearing Threshold, Right Ear 4 kHz", {
    value: "40",
    valueNum: 40,
    unit: "dB HL",
    flag: "abnormal",
  });
  // HRV — the case that makes "a chart exists" the WRONG test. `hrv` is a registered
  // slug with a tile and a detail page, and that chart is fed exclusively by
  // `metric_samples`: no canonical entry, so nothing folds, and no import projection
  // writes one. A cardiology report's HRV would reach no surface at all if the catalog
  // dropped it, so it must stay — asserted, not inferred.
  insert(pid, "vitals", "Heart Rate Variability", {
    value: "42",
    valueNum: 42,
    unit: "ms",
  });
  // Its sibling shape, from an indirect-calorimetry report.
  insert(pid, "vitals", "Basal Metabolic Rate", {
    value: "1520",
    valueNum: 1520,
    unit: "kcal/day",
  });
  insert(pid, "vitals", "Intraocular Pressure, Left Eye", {
    value: "16",
    valueNum: 16,
    unit: "mmHg",
  });
  insert(pid, "vitals", "Periodontal Probing Depth", {
    value: "3",
    valueNum: 3,
    unit: "mm",
  });
  // Ruled a body metric on #2322, and the `waist-circ` slug + its import projector
  // landed with that ruling — so this row's quantity is answered by a chart and it is
  // no longer browsable. Kept in the fixture on the LEAVING side (below) rather than
  // deleted: the point of the seed is that the rule is applied to a real stored row.
  insert(pid, "vitals", "Waist Circumference", {
    value: "84",
    valueNum: 84,
    unit: "cm",
  });
  // A QUALIFIED quantity: a peak-exercise systolic is not resting blood pressure, so
  // the word parenthetical must never be stripped down onto the `systolic` metric.
  insert(pid, "vitals", "Blood Pressure Systolic (Peak Exercise)", {
    value: "180",
    valueNum: 180,
    unit: "mmHg",
  });
  return pid;
}

describe("biomarker surfaces scope to lab only (#1076)", () => {
  it("the flagged-hero source returns ONLY the lab — no fever, BP, PHQ-9, or bio-age", () => {
    const pid = seedMixedProfile();
    const flagged = getCurrentFlaggedBiomarkers(pid).map((r) => r.name);
    expect(flagged).toEqual(["LDL Cholesterol"]);
    for (const leaked of [
      "Body Temperature",
      "Blood Pressure Systolic",
      "PHQ-9",
      "Biological Age",
    ]) {
      expect(flagged).not.toContain(leaked);
    }
  });

  it("the digest's newly-flagged read excludes every non-lab class", () => {
    const pid = seedMixedProfile();
    const names = getNewlyFlaggedBiomarkers(pid, digestSince(pid)).map(
      (r) => r.name
    );
    // Only the lab is eligible for the care-tier digest push.
    expect(names).toContain("LDL Cholesterol");
    for (const leaked of [
      "Body Temperature",
      "Blood Pressure Systolic",
      "PHQ-9",
      "Biological Age",
    ]) {
      expect(names).not.toContain(leaked);
    }
  });

  it("the biomarker browser excludes the re-homed classes with a home (instruments/derived/reference)", () => {
    const pid = seedMixedProfile();
    const rows = getClinicalObservations(pid, {
      excludeCategories: [...NON_BIOMARKER_CATEGORIES],
    }).map((r) => r.name);
    expect(rows).toContain("LDL Cholesterol");
    // Instruments (sensitivity), derived bio-age, and immutable facts are excluded —
    // each has a dedicated home.
    for (const leaked of ["PHQ-9", "Biological Age", "Blood Type"]) {
      expect(rows).not.toContain(leaked);
    }
    // `vitals` is still a browsable CATEGORY — the category exclusion does not decide
    // it. Which vitals ANALYTES the browser lists is #2365's per-analyte rule, applied
    // by the gather and pinned in the next test.
    expect(rows).toContain("Body Temperature");
    expect(rows).toContain("Blood Pressure Systolic");
  });

  it("the browser gather drops a vitals analyte with a metric home and keeps one without (#2365)", () => {
    // The end-to-end shape of the rule against a real schema: the same profile, the
    // same URL, through the module BOTH browser callers gather with. #1076's
    // "nothing stranded" rule is kept and applied per analyte — the flat catalog stops
    // duplicating what /trends/metric/<slug> already charts, and stays the home of the
    // domain vitals that have no chart at all.
    const pid = seedMixedProfile();
    const names = readingIndexRows(singleScope(pid), parseReadingFilters({}))
      .map((r) => r.canonical_name ?? r.name)
      .filter((n): n is string => n !== null);
    // Gone: each is a TrendMetricSlug quantity with its own chart.
    for (const homed of [
      "Blood Pressure Systolic",
      "Body Temperature",
      "Body Mass Index (BMI)",
      // #2322: a body metric with a slug AND a projector that carries an imported
      // reading to its chart, so the catalog is no longer its home.
      "Waist Circumference",
    ]) {
      expect(names).not.toContain(homed);
    }
    // Still here: an imported reading of these reaches NO chart, so the catalog is
    // still their home — a chart existing is not the same question as the reading
    // being able to get to it.
    for (const unreachable of [
      "Heart Rate Variability",
      "Basal Metabolic Rate",
    ]) {
      expect(names).toContain(unreachable);
    }
    // Still here: the domain vitals #1076 was protecting, and the lab control.
    for (const stranded of [
      "Hearing Threshold, Right Ear 4 kHz",
      "Intraocular Pressure, Left Eye",
      "Periodontal Probing Depth",
      "Blood Pressure Systolic (Peak Exercise)",
      "LDL Cholesterol",
    ]) {
      expect(names).toContain(stranded);
    }
  });

  it("the `observations` reachability claim agrees with METRIC_READING_STORE (#2365)", () => {
    // The pure tier checks that claim against the reading model (a canonical identity
    // with no stream), because `lib/metric-readings` opens the database and a pure test
    // may not. This is the other end of the same equality, asked of the hand-written
    // store registry itself — so a metric whose store is edited to or from
    // `medical_records` without revisiting its reachability fails here.
    for (const slug of TREND_METRIC_SLUGS) {
      const claimed = METRIC_DOCUMENT_REACH[slug].reaches === "observations";
      expect(
        METRIC_READING_STORE[slug]?.table === "medical_records",
        slug
      ).toBe(claimed);
    }
  });

  it("the lab-only TRAJECTORY exclusion (Trends → Biomarkers) drops vitals too", () => {
    const pid = seedMixedProfile();
    const rows = getClinicalObservations(pid, {
      excludeCategories: [...NON_BIOMARKER_CATEGORIES, "vitals"],
    }).map((r) => r.name);
    expect(rows).toContain("LDL Cholesterol");
    for (const leaked of [
      "Body Temperature",
      "Blood Pressure Systolic",
      "PHQ-9",
      "Biological Age",
      "Blood Type",
    ]) {
      expect(rows).not.toContain(leaked);
    }
  });

  it("recent-labs highlights only the lab", () => {
    const pid = seedMixedProfile();
    const rows = recentLabHighlights(
      getClinicalObservations(pid, { current: true })
    ).map((r) => r.name);
    expect(rows).toEqual(["LDL Cholesterol"]);
  });

  it("the retest nudge never fires for a blood type or an instrument", () => {
    const pid = seedMixedProfile();
    const td = today(pid);
    const items = collectUpcoming(pid, td).map((i) => i.title + " " + i.key);
    const joined = items.join("\n");
    expect(joined).not.toMatch(/Blood Type/i);
    expect(joined).not.toMatch(/PHQ-9/i);
  });

  it("a blood type ('reference') is never stale — no retest clock", () => {
    // Ten years old, well past any lab cadence — still never stale.
    expect(isBiomarkerStale("2015-01-01", "reference", "2026-01-01")).toBe(
      false
    );
    // A lab the same age IS stale (control).
    expect(isBiomarkerStale("2015-01-01", "lab", "2026-01-01")).toBe(true);
  });
});
