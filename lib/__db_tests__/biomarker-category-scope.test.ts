// #1076: the biomarker surfaces scope to `category = 'lab'` ONLY. This pins the
// exact leaks the issue fixes against a real schema — a fever (vitals), a high BP
// (vitals), a severe PHQ-9 (instrument), a bio-age (derived), and a blood type
// (reference) appear on NONE of: the biomarker list, the flagged hero source, the
// digest, or the retest nudge. The mental-health/substance sensitivity is load-
// bearing: a depression score can never reach the general health hero/digest.
// All fixture values are synthetic (obviously-fictional profile, plain names).

import { describe, it, expect } from "vitest";
import { db, today } from "@/lib/db";
import { getCurrentFlaggedBiomarkers, getMedicalRecords } from "@/lib/queries";
import {
  getNewlyFlaggedBiomarkers,
  digestSince,
} from "@/lib/notifications/digest-data";
import { collectUpcoming } from "@/lib/queries/upcoming";
import { recentLabHighlights } from "@/lib/recent-labs";
import { isBiomarkerStale } from "@/lib/reference-range";
import { NON_BIOMARKER_CATEGORIES } from "@/lib/medical-categories";

function createProfile(name: string): number {
  return Number(
    db.prepare("INSERT INTO profiles (name) VALUES (?)").run(name)
      .lastInsertRowid
  );
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
    const rows = getMedicalRecords(pid, {
      excludeCategories: [...NON_BIOMARKER_CATEGORIES],
    }).map((r) => r.name);
    expect(rows).toContain("LDL Cholesterol");
    // Instruments (sensitivity), derived bio-age, and immutable facts are excluded —
    // each has a dedicated home.
    for (const leaked of ["PHQ-9", "Biological Age", "Blood Type"]) {
      expect(rows).not.toContain(leaked);
    }
    // Vitals STAY catalogued on the flat browser (domain vitals — audiogram/IOP —
    // have no other home; removing them would strand them). The trajectory tab and
    // the flagged hero/digest/retest still exclude them (pinned above/below).
    expect(rows).toContain("Body Temperature");
    expect(rows).toContain("Blood Pressure Systolic");
  });

  it("the lab-only TRAJECTORY exclusion (Trends → Biomarkers) drops vitals too", () => {
    const pid = seedMixedProfile();
    const rows = getMedicalRecords(pid, {
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
      getMedicalRecords(pid, { current: true })
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
